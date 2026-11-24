// Package controller runs one change from approved criteria to signed
// evidence: it asks a builder for a change, imports it as data, builds the
// candidate, has it evaluated, signs what was found, and sends a failure back
// to the builder for at most a fixed number of repair rounds.
//
// The controller is ordinary code. The only step with a model in it is the
// builder, and nothing the builder produces is trusted beyond being a patch.
package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/agent"
	"github.com/sagart-cactus/sprintfoundry/internal/checks"
	"github.com/sagart-cactus/sprintfoundry/internal/dockerfile"
	"github.com/sagart-cactus/sprintfoundry/internal/evaluate"
	"github.com/sagart-cactus/sprintfoundry/internal/evidence"
	"github.com/sagart-cactus/sprintfoundry/internal/gitimport"
	"github.com/sagart-cactus/sprintfoundry/internal/runspec"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

// State is where a run ended.
type State string

const (
	// Passed: the last candidate passed every check and needs no review.
	Passed State = "passed"
	// NeedsOwner: a person must decide. Reason says why.
	NeedsOwner State = "needs_owner"
	// AwaitingPublish: a job's change passed and waits for a person to
	// approve pushing it.
	AwaitingPublish State = "awaiting_publish"
)

// DefaultRepairRounds is how many times a failure goes back to the builder
// for one criteria digest. Together with the first attempt that allows three
// evaluations for a set of criteria, across all runs, ever.
const DefaultRepairRounds = 2

// Store is what the controller needs from its store.
type Store interface {
	PutInput(ctx context.Context, kind string, content []byte) (string, error)
	PutInputAs(ctx context.Context, kind, digest string, content []byte) error
	BeginRun(ctx context.Context, r postgres.Run) error
	PutEvidence(ctx context.Context, e postgres.Evidence) error
	TakeEvaluation(ctx context.Context, repository, criteriaDigest string, limit int) (bool, error)
}

// Deps are the controller's collaborators. Build and Evaluate are functions
// so that tests can stand in for a container runtime.
type Deps struct {
	Store  Store
	Signer signer.Signer
	Agent  agent.Agent
	// Build turns a commit in the store into a candidate image and returns
	// its digest.
	Build func(ctx context.Context, storeDir, commit string, spec runspec.Spec) (image string, err error)
	// Evaluate evaluates one candidate.
	Evaluate func(ctx context.Context, req evaluate.Request) (evaluate.Result, error)
	Now      func() time.Time
	// Log receives one line per step for the person watching.
	Log func(format string, args ...any)
}

// Request is one run.
type Request struct {
	RunID      string
	Repository string
	// StoreDir is the bare repository the controller owns. Parent is the
	// commit the builder starts from.
	StoreDir string
	Parent   string

	// The three frozen inputs. All are required before anything is built.
	Criteria []byte
	Suite    []byte
	RunSpec  []byte

	Purpose      signer.Purpose
	ImageName    string
	DigestKind   evidence.DigestKind
	RunnerImage  string
	RepairRounds int
	ReportURL    string
	// NameKey is the controller's secret for naming checks in signed
	// statements.
	NameKey []byte
	// Labels are put on everything the run starts in the container runtime.
	Labels map[string]string
}

// Round is one build and evaluation.
type Round struct {
	Number         int
	Commit, Tree   string
	Image          string
	ChangedPaths   []string
	SensitivePaths []string
	Report         checks.Report
	Outcome        string
	EvidenceDigest string
	// Feedback is exactly what went back to the builder after this round.
	Feedback      []checks.Symptom
	HoldoutFailed bool
	BuilderNote   string
	// evidenceRow is the stored form of the round's evidence, kept when the
	// caller stores it itself (see commitRequest.storeEvidenceLater).
	evidenceRow postgres.Evidence
}

// Result is a finished run.
type Result struct {
	RunID          string
	State          State
	Reason         string
	CriteriaDigest string
	SuiteDigest    string
	RunSpecDigest  string
	Rounds         []Round
	// Incomplete is set when the evaluation could not run at all, for a
	// reason outside the change, so the result says nothing about it.
	Incomplete bool
}

var runIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,30}$`)

// ErrInputs is returned when a run's frozen inputs are missing or invalid.
var ErrInputs = errors.New("controller: the run's inputs are not frozen")

// Run performs the run. It returns an error only when the run could not be
// carried out; a failing or flagged change is a Result, not an error.
func Run(ctx context.Context, d Deps, req Request) (Result, error) {
	logf := d.Log
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if req.RepairRounds <= 0 {
		req.RepairRounds = DefaultRepairRounds
	}

	in, err := freeze(ctx, d, req.RunID, req.Repository, req.Criteria, req.Suite, req.RunSpec)
	if err != nil {
		return Result{}, err
	}
	res := Result{RunID: req.RunID, CriteriaDigest: in.criteria, SuiteDigest: in.suiteDigest, RunSpecDigest: in.specDigest}
	logf("Inputs frozen: criteria %s, checks %s, run spec %s", short(res.CriteriaDigest), short(res.SuiteDigest), short(res.RunSpecDigest))

	var feedback []agent.Feedback
	for number := 1; ; number++ {
		// Every evaluation draws on one allowance per criteria digest, the
		// first attempt of a new run included. Without that, a builder could
		// start run after run and get one more look, or one more lucky try,
		// each time.
		allowed, err := d.Store.TakeEvaluation(ctx, req.Repository, res.CriteriaDigest, 1+req.RepairRounds)
		if err != nil {
			return Result{}, err
		}
		if !allowed {
			res.State = NeedsOwner
			res.Reason = fmt.Sprintf("the repair limit for these criteria is used up (one attempt and %d repair rounds, across all runs)", req.RepairRounds)
			return res, nil
		}

		logf("Round %d: asking the builder (%s) for a change", number, d.Agent.Name())
		change, err := d.Agent.Run(ctx, nil, "", agent.Task{Criteria: string(req.Criteria), Feedback: feedback})
		if err != nil {
			res.State, res.Reason = NeedsOwner, "the builder did not produce a change: "+err.Error()
			return res, nil
		}
		imported, err := gitimport.Import(ctx, gitimport.Request{
			Store: req.StoreDir, Parent: req.Parent, TestedTree: change.TestedTree, Patch: change.Patch,
			Message:    fmt.Sprintf("Change for run %s, round %d\n", req.RunID, number),
			AuthorName: "SprintFoundry builder", AuthorEmail: "builder@sprintfoundry.invalid",
		})
		if err != nil {
			res.State, res.Reason = NeedsOwner, "the builder's change was refused on import: "+err.Error()
			return res, nil
		}
		round, stop, err := evaluateCommit(ctx, d, in, commitRequest{
			RunID: req.RunID, Number: number, Repository: req.Repository, StoreDir: req.StoreDir,
			Base: req.Parent, Commit: imported.Commit, Tree: imported.Tree,
			Purpose: req.Purpose, ImageName: req.ImageName, DigestKind: req.DigestKind,
			RunnerImage: req.RunnerImage, ReportURL: req.ReportURL, NameKey: req.NameKey, Labels: req.Labels,
			Check: evidence.CheckBuilder,
		})
		if err != nil {
			return Result{}, err
		}
		round.BuilderNote = change.Summary
		if stop != "" {
			res.Rounds = append(res.Rounds, round)
			res.State, res.Reason = NeedsOwner, stop
			return res, nil
		}

		switch round.Outcome {
		case evidence.OutcomePassed:
			res.Rounds = append(res.Rounds, round)
			if len(round.SensitivePaths) > 0 {
				res.State = NeedsOwner
				res.Reason = fmt.Sprintf("the checks passed, but the change touches protected paths %v; a person must review it before it can be released", round.SensitivePaths)
				return res, nil
			}
			res.State = Passed
			return res, nil
		case evidence.OutcomeInconclusive:
			res.Rounds = append(res.Rounds, round)
			res.State, res.Reason = NeedsOwner, "some checks could not be completed, so the result is inconclusive"
			return res, nil
		}

		round.Feedback = round.Report.BuilderFeedback()
		res.Rounds = append(res.Rounds, round)
		if len(round.Feedback) == 0 {
			res.State, res.Reason = NeedsOwner, "a holdout check failed; the builder is told nothing and a person must look"
			return res, nil
		}
		feedback = feedback[:0]
		for _, f := range round.Feedback {
			feedback = append(feedback, agent.Feedback{Criterion: f.Criterion, Symptom: f.Text})
			logf("Round %d: feedback to the builder: %s: %s", number, f.Criterion, f.Text)
		}
	}
}

// frozen holds a run's parsed inputs and their digests.
type frozen struct {
	suite                             checks.Suite
	spec                              runspec.Spec
	criteria, suiteDigest, specDigest string
}

// freeze checks the three inputs, stores them by digest and records the run.
// Nothing is built for a run whose inputs are not all frozen.
func freeze(ctx context.Context, d Deps, runID, repository string, criteria, suiteText, specText []byte) (frozen, error) {
	in, err := storeInputs(ctx, d, runID, criteria, suiteText, specText)
	if err != nil {
		return frozen{}, err
	}
	if err := beginRun(ctx, d, runID, repository, postgres.RunBuilder, in); err != nil {
		return frozen{}, err
	}
	return in, nil
}

// storeInputs checks the run ID and the three inputs and stores the inputs
// by digest, without recording a run.
func storeInputs(ctx context.Context, d Deps, runID string, criteria, suiteText, specText []byte) (frozen, error) {
	if !runIDPattern.MatchString(runID) {
		return frozen{}, fmt.Errorf("controller: run ID %q is not allowed", runID)
	}
	in, err := ParseInputs(criteria, suiteText, specText)
	if err != nil {
		return frozen{}, err
	}
	if in.criteria, err = d.Store.PutInput(ctx, "criteria", criteria); err != nil {
		return frozen{}, err
	}
	if err := d.Store.PutInputAs(ctx, "check-suite", in.suiteDigest, suiteText); err != nil {
		return frozen{}, err
	}
	if err := d.Store.PutInputAs(ctx, "run-spec", in.specDigest, specText); err != nil {
		return frozen{}, err
	}
	return in, nil
}

// beginRun records the run. A builder run or a release check supersedes
// older evidence for the same criteria; a pull request check does not.
func beginRun(ctx context.Context, d Deps, runID, repository, kind string, in frozen) error {
	return d.Store.BeginRun(ctx, postgres.Run{ID: runID, Repository: repository, Kind: kind,
		CriteriaDigest: in.criteria, SuiteDigest: in.suiteDigest, RunSpecDigest: in.specDigest})
}

// ParseInputs checks the three inputs: criteria that are not empty, a check
// suite and a run spec that parse, and every actor the suite uses defined in
// the run spec. The returned value's criteria digest is left empty.
func ParseInputs(criteria, suiteText, specText []byte) (frozen, error) {
	if len(bytes.TrimSpace(criteria)) == 0 {
		return frozen{}, fmt.Errorf("%w: no criteria", ErrInputs)
	}
	suite, err := checks.Parse(suiteText)
	if err != nil {
		return frozen{}, fmt.Errorf("%w: %v", ErrInputs, err)
	}
	spec, err := runspec.Parse(specText)
	if err != nil {
		return frozen{}, fmt.Errorf("%w: %v", ErrInputs, err)
	}
	for _, c := range suite.Checks {
		as := ""
		if c.HTTP != nil {
			as = c.HTTP.As
		} else {
			as = c.Browser.As
		}
		if _, ok := spec.Actors[as]; !ok {
			return frozen{}, fmt.Errorf("%w: check suite uses actor %q, which the run spec does not define", ErrInputs, as)
		}
	}
	return frozen{suite: suite, spec: spec, suiteDigest: suite.Digest(), specDigest: spec.Digest()}, nil
}

// Spec returns the parsed run spec.
func (f frozen) Spec() runspec.Spec { return f.spec }

// SuiteDigest returns the check suite's digest.
func (f frozen) SuiteDigest() string { return f.suiteDigest }

// commitRequest is one commit, already in the store, to build and evaluate.
type commitRequest struct {
	RunID, Repository, StoreDir string
	Number                      int
	// Base is the commit the change is measured against, for the protected
	// paths. Commit and Tree are what is built.
	Base, Commit, Tree string
	Purpose            signer.Purpose
	ImageName          string
	DigestKind         evidence.DigestKind
	RunnerImage        string
	ReportURL          string
	NameKey            []byte
	Labels             map[string]string
	Check              evidence.CheckKind
	// storeEvidenceLater leaves storing the evidence to the caller, which
	// stores it together with the round's result.
	storeEvidenceLater bool
}

// evaluateCommit checks the Dockerfile, builds the commit, evaluates the
// image, and signs and stores the evidence. A non-empty stop is the reason a
// person must take over before anything was evaluated.
func evaluateCommit(ctx context.Context, d Deps, in frozen, r commitRequest) (round Round, stop string, err error) {
	logf := d.Log
	if logf == nil {
		logf = func(string, ...any) {}
	}
	round = Round{Number: r.Number, Commit: r.Commit, Tree: r.Tree}
	if round.ChangedPaths, err = gitimport.ChangedPaths(ctx, r.StoreDir, r.Base, r.Commit); err != nil {
		return round, "", err
	}
	round.SensitivePaths = in.spec.Sensitive(round.ChangedPaths)
	logf("Round %d: commit %s, %d file(s) changed", r.Number, r.Commit[:12], len(round.ChangedPaths))
	if len(round.SensitivePaths) > 0 {
		logf("Round %d: the change touches protected paths: %v", r.Number, round.SensitivePaths)
	}

	// The builder wrote the Dockerfile. Check it before the runtime reads it:
	// only listed base images, nothing fetched from outside.
	content, err := gitimport.ReadFile(ctx, r.StoreDir, r.Commit, in.spec.Build.Dockerfile)
	if err == nil {
		err = dockerfile.Check(content, in.spec.Build.BaseImages)
	}
	if err != nil {
		return round, "the Dockerfile was refused before any build: " + err.Error(), nil
	}
	if round.Image, err = d.Build(ctx, r.StoreDir, r.Commit, in.spec); err != nil {
		return round, stopBuildFailed + err.Error(), nil
	}
	logf("Round %d: candidate built, image %s", r.Number, round.Image[:12])

	eval, err := d.Evaluate(ctx, evaluate.Request{
		RunID: fmt.Sprintf("%s-r%d", r.RunID, r.Number), Candidate: round.Image,
		RunnerImage: r.RunnerImage, Spec: in.spec, Suite: in.suite, Labels: r.Labels,
	})
	if err != nil {
		return round, stopEvaluationIncomplete + err.Error(), nil
	}
	round.Report = eval.Report
	round.HoldoutFailed = eval.Report.HoldoutFailed()

	var review []string
	for _, p := range round.SensitivePaths {
		review = append(review, "change touches "+p)
	}
	statement, err := evidence.NewEvidence(evidence.Evaluation{
		ImageName: r.ImageName, ImageDigest: round.Image, DigestKind: r.DigestKind,
		CriteriaDigest: in.criteria, SuiteDigest: in.suiteDigest, RunSpecDigest: in.specDigest,
		RunnerImage: r.RunnerImage, Repository: r.Repository, Commit: r.Commit, Tree: r.Tree,
		RunID: r.RunID, Purpose: r.Purpose, FinishedAt: d.Now(), ReportURL: r.ReportURL,
		ReviewRequired: review, Report: eval.Report, NameKey: r.NameKey, Check: r.Check,
	})
	if err != nil {
		return round, "", err
	}
	payload, err := statement.Marshal()
	if err != nil {
		return round, "", err
	}
	envelope, err := d.Signer.Sign(ctx, payload)
	if err != nil {
		return round, "", fmt.Errorf("controller: sign evidence: %w", err)
	}
	stored, err := json.Marshal(envelope)
	if err != nil {
		return round, "", err
	}
	_, parsed, _ := evidence.ParseTestResult(payload)
	runInfo, _ := parsed.Config("run")
	round.Outcome = runInfo.Annotations["outcome"]
	round.EvidenceDigest = evidence.Digest(payload)
	round.evidenceRow = postgres.Evidence{
		Digest: round.EvidenceDigest, RunID: r.RunID, Round: r.Number, Repository: r.Repository,
		ImageDigest: round.Image, DigestKind: string(r.DigestKind),
		CriteriaDigest: in.criteria, SuiteDigest: in.suiteDigest, RunSpecDigest: in.specDigest,
		Purpose: string(r.Purpose), Outcome: round.Outcome, Check: string(r.Check),
		ReviewRequired: runInfo.Annotations["reviewRequired"], Envelope: stored,
	}
	if !r.storeEvidenceLater {
		if err := d.Store.PutEvidence(ctx, round.evidenceRow); err != nil {
			return round, "", err
		}
	}
	logf("Round %d: evaluation %s, evidence signed (%s)", r.Number, round.Outcome, short(round.EvidenceDigest))
	return round, "", nil
}

// stopEvaluationIncomplete starts the reason when the evaluation itself
// could not run, which says nothing about the commit.
const stopEvaluationIncomplete = "the evaluation could not be completed: "

// stopBuildFailed starts the reason when the candidate could not be built,
// which may be the change or the machine.
const stopBuildFailed = "the candidate could not be built: "

func short(digest string) string {
	if len(digest) > 19 {
		return digest[:19]
	}
	return digest
}
