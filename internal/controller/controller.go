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
	if !runIDPattern.MatchString(req.RunID) {
		return Result{}, fmt.Errorf("controller: run ID %q is not allowed", req.RunID)
	}
	if req.RepairRounds <= 0 {
		req.RepairRounds = DefaultRepairRounds
	}

	// Freeze the inputs before anything is built. A run without all three
	// digests does not start.
	if len(bytes.TrimSpace(req.Criteria)) == 0 {
		return Result{}, fmt.Errorf("%w: no criteria", ErrInputs)
	}
	suite, err := checks.Parse(req.Suite)
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrInputs, err)
	}
	spec, err := runspec.Parse(req.RunSpec)
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrInputs, err)
	}
	for _, c := range suite.Checks {
		as := ""
		if c.HTTP != nil {
			as = c.HTTP.As
		} else {
			as = c.Browser.As
		}
		if _, ok := spec.Actors[as]; !ok {
			return Result{}, fmt.Errorf("%w: check suite uses actor %q, which the run spec does not define", ErrInputs, as)
		}
	}
	res := Result{RunID: req.RunID, SuiteDigest: suite.Digest(), RunSpecDigest: spec.Digest()}
	if res.CriteriaDigest, err = d.Store.PutInput(ctx, "criteria", req.Criteria); err != nil {
		return Result{}, err
	}
	if err := d.Store.PutInputAs(ctx, "check-suite", res.SuiteDigest, req.Suite); err != nil {
		return Result{}, err
	}
	if err := d.Store.PutInputAs(ctx, "run-spec", res.RunSpecDigest, req.RunSpec); err != nil {
		return Result{}, err
	}
	if err := d.Store.BeginRun(ctx, postgres.Run{ID: req.RunID, Repository: req.Repository,
		CriteriaDigest: res.CriteriaDigest, SuiteDigest: res.SuiteDigest, RunSpecDigest: res.RunSpecDigest}); err != nil {
		return Result{}, err
	}
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
		round := Round{Number: number, Commit: imported.Commit, Tree: imported.Tree, BuilderNote: change.Summary}
		if round.ChangedPaths, err = gitimport.ChangedPaths(ctx, req.StoreDir, req.Parent, imported.Commit); err != nil {
			return Result{}, err
		}
		round.SensitivePaths = spec.Sensitive(round.ChangedPaths)
		logf("Round %d: imported as data, commit %s, %d file(s) changed", number, imported.Commit[:12], len(round.ChangedPaths))
		if len(round.SensitivePaths) > 0 {
			logf("Round %d: the change touches protected paths: %v", number, round.SensitivePaths)
		}

		// The builder wrote the Dockerfile. Check it before the runtime reads
		// it: only listed base images, nothing fetched from outside.
		content, err := gitimport.ReadFile(ctx, req.StoreDir, imported.Commit, spec.Build.Dockerfile)
		if err == nil {
			err = dockerfile.Check(content, spec.Build.BaseImages)
		}
		if err != nil {
			res.Rounds = append(res.Rounds, round)
			res.State, res.Reason = NeedsOwner, "the Dockerfile was refused before any build: "+err.Error()
			return res, nil
		}

		if round.Image, err = d.Build(ctx, req.StoreDir, imported.Commit, spec); err != nil {
			res.Rounds = append(res.Rounds, round)
			res.State, res.Reason = NeedsOwner, "the candidate could not be built: "+err.Error()
			return res, nil
		}
		logf("Round %d: candidate built, image %s", number, round.Image[:12])

		eval, err := d.Evaluate(ctx, evaluate.Request{
			RunID: fmt.Sprintf("%s-r%d", req.RunID, number), Candidate: round.Image,
			RunnerImage: req.RunnerImage, Spec: spec, Suite: suite, Labels: req.Labels,
		})
		if err != nil {
			res.Rounds = append(res.Rounds, round)
			res.State, res.Reason = NeedsOwner, "the evaluation could not be completed: "+err.Error()
			return res, nil
		}
		round.Report = eval.Report
		round.HoldoutFailed = eval.Report.HoldoutFailed()

		var review []string
		for _, p := range round.SensitivePaths {
			review = append(review, "change touches "+p)
		}
		statement, err := evidence.NewEvidence(evidence.Evaluation{
			ImageName: req.ImageName, ImageDigest: round.Image, DigestKind: req.DigestKind,
			CriteriaDigest: res.CriteriaDigest, SuiteDigest: res.SuiteDigest, RunSpecDigest: res.RunSpecDigest,
			RunnerImage: req.RunnerImage, Repository: req.Repository, Commit: imported.Commit, Tree: imported.Tree,
			RunID: req.RunID, Purpose: req.Purpose, FinishedAt: d.Now(), ReportURL: req.ReportURL,
			ReviewRequired: review, Report: eval.Report, NameKey: req.NameKey,
		})
		if err != nil {
			return Result{}, err
		}
		payload, err := statement.Marshal()
		if err != nil {
			return Result{}, err
		}
		envelope, err := d.Signer.Sign(ctx, payload)
		if err != nil {
			return Result{}, fmt.Errorf("controller: sign evidence: %w", err)
		}
		stored, err := json.Marshal(envelope)
		if err != nil {
			return Result{}, err
		}
		_, parsed, _ := evidence.ParseTestResult(payload)
		runInfo, _ := parsed.Config("run")
		round.Outcome = runInfo.Annotations["outcome"]
		round.EvidenceDigest = evidence.Digest(payload)
		if err := d.Store.PutEvidence(ctx, postgres.Evidence{
			Digest: round.EvidenceDigest, RunID: req.RunID, Round: number, Repository: req.Repository,
			ImageDigest: round.Image, DigestKind: string(req.DigestKind),
			CriteriaDigest: res.CriteriaDigest, SuiteDigest: res.SuiteDigest, RunSpecDigest: res.RunSpecDigest,
			Purpose: string(req.Purpose), Outcome: round.Outcome,
			ReviewRequired: runInfo.Annotations["reviewRequired"], Envelope: stored,
		}); err != nil {
			return Result{}, err
		}
		logf("Round %d: evaluation %s, evidence signed (%s)", number, round.Outcome, short(round.EvidenceDigest))

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

		round.Feedback = eval.Report.BuilderFeedback()
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

func short(digest string) string {
	if len(digest) > 19 {
		return digest[:19]
	}
	return digest
}
