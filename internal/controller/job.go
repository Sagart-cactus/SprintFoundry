package controller

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/sagart-cactus/sprintfoundry/internal/agent"
	"github.com/sagart-cactus/sprintfoundry/internal/checks"
	"github.com/sagart-cactus/sprintfoundry/internal/effect"
	"github.com/sagart-cactus/sprintfoundry/internal/evidence"
	"github.com/sagart-cactus/sprintfoundry/internal/gitimport"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

// JobStore is what a durable job needs from the store.
type JobStore interface {
	Store
	GetInput(ctx context.Context, digest string) ([]byte, error)
	Rounds(ctx context.Context, jobID string) ([]postgres.RoundRecord, error)
	StartRound(ctx context.Context, jobID, owner string, number, evalLimit int) (postgres.RoundRecord, error)
	BeginAttempt(ctx context.Context, jobID, owner string, number, requests, requestCap, maxAttempts int) (postgres.RoundRecord, error)
	SaveChange(ctx context.Context, jobID, owner string, number int, c postgres.Change) (postgres.RoundRecord, error)
	SaveRoundResult(ctx context.Context, jobID, owner string, number int, res postgres.RoundResult) (postgres.RoundRecord, error)
	SaveRoundEvaluation(ctx context.Context, jobID, owner string, number int, e postgres.Evidence, res postgres.RoundResult) (postgres.RoundRecord, error)
	CheckLease(ctx context.Context, jobID, owner string) error
	SetPullRequest(ctx context.Context, jobID, owner string, number int) error
	FinishJob(ctx context.Context, jobID, owner, state, reason string) error
}

// Forge is one repository at the code host, as a job needs it. Every method
// may be called again after a crash; the controller looks before it acts.
type Forge interface {
	// FindBranch returns the commit a branch points at.
	FindBranch(ctx context.Context, branch string) (commit string, found bool, err error)
	// PushBranch creates branch at commit, copying it from storeDir. It
	// must not move a branch that already exists.
	PushBranch(ctx context.Context, storeDir, commit, branch string) error
	// FindPullRequest returns the pull request whose head is branch, open
	// or closed.
	FindPullRequest(ctx context.Context, branch string) (number int, found bool, err error)
	OpenPullRequest(ctx context.Context, branch, base, title, body string) (int, error)
	// SetStatus posts a commit status; posting the same one again is
	// harmless.
	SetStatus(ctx context.Context, commit, state, description string) error
}

// JobDeps are a durable job's collaborators.
type JobDeps struct {
	Deps
	Store   JobStore
	Journal effect.Journal
	Forge   Forge
	// Owner identifies this controller's lease.
	Owner string
	// StoreDir is the controller's bare repository for the job. It must
	// already hold the job's base commit.
	StoreDir string
	// Step is called at every boundary the failure-injection suite kills
	// the controller at. Nil in normal use.
	Step func(name string)
}

// JobSettings are the limits a job runs under.
type JobSettings struct {
	RepairRounds int
	// RequestsPerAttempt is the model request budget of one builder attempt;
	// RequestCap bounds the requests reserved for a repository and criteria
	// across all jobs. MaxAttempts bounds attempts per round.
	RequestsPerAttempt, RequestCap, MaxAttempts int

	// AutoPublish pushes a passing change and opens its pull request
	// without a person approving it first. Pushing a branch into the
	// repository runs the repository's own CI on the builder's code, with
	// whatever secrets that CI has, so it is off by default.
	AutoPublish bool

	Purpose     signer.Purpose
	ImageName   string
	DigestKind  evidence.DigestKind
	RunnerImage string
	ReportURL   string
	NameKey     []byte
	Labels      map[string]string
}

// BranchPrefix starts the name of every branch a job pushes.
const BranchPrefix = "sprintfoundry/"

// RunJob carries a job forward from whatever the store says already
// happened, to a pull request or to a person. It may be called again after
// a crash at any point, by this or another controller holding the lease: no
// round is evaluated twice against the allowance, no recorded builder change
// is asked for again, and no branch or pull request is created twice.
func RunJob(ctx context.Context, d JobDeps, job postgres.Job, s JobSettings) (Result, error) {
	logf := d.Log
	if logf == nil {
		logf = func(string, ...any) {}
	}
	step := d.Step
	if step == nil {
		step = func(string) {}
	}
	if s.RepairRounds <= 0 {
		s.RepairRounds = DefaultRepairRounds
	}
	if s.MaxAttempts <= 0 {
		s.MaxAttempts = 2
	}
	d.Deps.Store = d.Store

	criteria, in, err := loadInputs(ctx, d.Store, job)
	if err != nil {
		return Result{}, err
	}
	res := Result{RunID: job.ID, CriteriaDigest: in.criteria, SuiteDigest: in.suiteDigest, RunSpecDigest: in.specDigest}
	finish := func(state State, reason string) (Result, error) {
		res.State, res.Reason = state, reason
		final := postgres.JobNeedsOwner
		switch state {
		case Passed:
			final = postgres.JobPassed
		case AwaitingPublish:
			final = postgres.JobAwaitingPublish
		}
		if err := d.Store.FinishJob(ctx, job.ID, d.Owner, final, reason); err != nil {
			return res, err
		}
		step("finished")
		return res, nil
	}

	var feedback []agent.Feedback
	var previous []byte
	for number := 1; ; number++ {
		rec, err := d.Store.StartRound(ctx, job.ID, d.Owner, number, 1+s.RepairRounds)
		if errors.Is(err, postgres.ErrAllowanceUsed) {
			return finish(NeedsOwner, fmt.Sprintf("the repair limit for these criteria is used up (one attempt and %d repair rounds, across all runs)", s.RepairRounds))
		}
		if err != nil {
			return res, err
		}
		step("round-started")

		round := Round{Number: number, Commit: rec.Commit}
		if !rec.Finished() {
			if rec, err = buildRound(ctx, d, job, s, in, criteria, rec, feedback, previous, &round, step); err != nil {
				return res, err
			}
		} else {
			logf("Round %d: already evaluated (%s), going on from the stored result", number, rec.Outcome+rec.StopReason)
			round.Outcome, round.EvidenceDigest = rec.Outcome, rec.EvidenceDigest
			for _, f := range rec.Feedback {
				round.Feedback = append(round.Feedback, checks.Symptom{Criterion: f.Criterion, Text: f.Symptom})
			}
		}
		res.Rounds = append(res.Rounds, round)

		if rec.StopReason != "" {
			return finish(NeedsOwner, rec.StopReason)
		}
		switch rec.Outcome {
		case evidence.OutcomePassed:
			// Another controller may have evaluated this round. Make the
			// commit here from the stored change, and make sure it is the
			// commit that was evaluated, before anything looks at it.
			if err := ensureCommit(ctx, d, job, rec); err != nil {
				return res, err
			}
			changed, sensitive, err := sensitivePaths(ctx, d.StoreDir, job.Base, rec.Commit, in)
			if err != nil {
				return res, err
			}
			// A change to a protected path never reaches the repository
			// unreviewed: a workflow file pushed as a branch would already
			// run there, with the repository's secrets.
			if len(sensitive) > 0 {
				return finish(NeedsOwner, fmt.Sprintf("the checks passed, but the change touches protected paths %q; nothing was pushed, and a person must review commit %s", sensitive, short(rec.Commit)))
			}
			if !s.AutoPublish && !job.PublishApproved {
				return finish(AwaitingPublish, fmt.Sprintf("the change passed on its exact image; pushing it runs the repository's CI on it, so a person approves that: sprintfoundry publish --job %s. Commit %s changes %q", job.ID, rec.Commit, changed))
			}
			pr, err := publish(ctx, d, job, rec, step)
			if err != nil {
				return res, err
			}
			logf("Pull request #%d is open for commit %s", pr, short(rec.Commit))
			return finish(Passed, fmt.Sprintf("pull request #%d", pr))
		case evidence.OutcomeInconclusive:
			return finish(NeedsOwner, "some checks could not be completed, so the result is inconclusive")
		}
		if len(rec.Feedback) == 0 {
			return finish(NeedsOwner, "a holdout check failed; the builder is told nothing and a person must look")
		}
		feedback = feedback[:0]
		for _, f := range rec.Feedback {
			feedback = append(feedback, agent.Feedback{Criterion: f.Criterion, Symptom: f.Symptom})
		}
		// The next round starts from this round's change, even when another
		// controller process runs it.
		previous = rec.Patch
	}
}

// buildRound gets the round's change (from the store or the builder),
// imports, builds and evaluates it, and stores the result.
func buildRound(ctx context.Context, d JobDeps, job postgres.Job, s JobSettings, in frozen, criteria []byte,
	rec postgres.RoundRecord, feedback []agent.Feedback, previous []byte, round *Round, step func(string)) (postgres.RoundRecord, error) {
	logf := d.Log
	if logf == nil {
		logf = func(string, ...any) {}
	}
	stop := func(reason string) (postgres.RoundRecord, error) {
		r, err := d.Store.SaveRoundResult(ctx, job.ID, d.Owner, rec.Number, postgres.RoundResult{Commit: round.Commit, StopReason: reason})
		step("round-stored")
		return r, err
	}

	if !rec.HasChange {
		attempt, err := d.Store.BeginAttempt(ctx, job.ID, d.Owner, rec.Number, s.RequestsPerAttempt, s.RequestCap, s.MaxAttempts)
		switch {
		case errors.Is(err, postgres.ErrRequestCapUsed):
			return stop("the model request cap for these criteria is used up")
		case errors.Is(err, postgres.ErrAttemptsUsed):
			reason := fmt.Sprintf("the builder was started %d times in round %d without handing over a change", s.MaxAttempts, rec.Number)
			if job.LastError != "" {
				reason += " (last error: " + job.LastError + ")"
			}
			return stop(reason)
		case err != nil:
			return rec, err
		}
		rec = attempt
		step("attempt-reserved")
		logf("Round %d: asking the builder (%s) for a change, attempt %d", rec.Number, d.Agent.Name(), rec.Attempts)
		change, err := d.Agent.Run(ctx, nil, "", agent.Task{Criteria: string(criteria), Feedback: feedback, Previous: previous})
		if err != nil {
			// The machine may be at fault, not the builder. The attempt is
			// counted; the job is tried again until the round's attempts
			// run out.
			return rec, fmt.Errorf("round %d: the builder did not produce a change: %w", rec.Number, err)
		}
		// The description is cleaned once, here, and stored with the patch:
		// the commit message is made from it, so every import gives the
		// same commit.
		title, body := CleanDescription(change.Title, change.Body, fallbackTitle(job))
		if rec, err = d.Store.SaveChange(ctx, job.ID, d.Owner, rec.Number, postgres.Change{Patch: change.Patch, TestedTree: change.TestedTree,
			Summary: change.Summary, Title: title, Body: body, At: d.Now()}); err != nil {
			return rec, err
		}
		step("change-stored")
	}
	round.BuilderNote = rec.Summary

	imported, err := importRound(ctx, d, job, rec)
	if isPatchRefusal(err) {
		return stop("the builder's change was refused on import: " + err.Error())
	}
	if err != nil {
		// The machine, not the change: try again without spending the round.
		return rec, fmt.Errorf("round %d: import the change: %w", rec.Number, err)
	}
	round.Commit, round.Tree = imported.Commit, imported.Tree
	step("imported")

	evaluated, reason, err := evaluateCommit(ctx, d.Deps, in, commitRequest{
		RunID: job.ID, Number: rec.Number, Repository: job.Repository, StoreDir: d.StoreDir,
		Base: job.Base, Commit: imported.Commit, Tree: imported.Tree,
		Purpose: s.Purpose, ImageName: s.ImageName, DigestKind: s.DigestKind,
		RunnerImage: s.RunnerImage, ReportURL: s.ReportURL, NameKey: s.NameKey, Labels: s.Labels,
		Check: evidence.CheckBuilder, storeEvidenceLater: true,
	})
	if err != nil {
		return rec, err
	}
	evaluated.BuilderNote = rec.Summary
	*round = evaluated
	// A build or an evaluation that could not run may be the machine's
	// fault: try again, counted as a failure, rather than spend the round.
	if strings.HasPrefix(reason, stopEvaluationIncomplete) || strings.HasPrefix(reason, stopBuildFailed) {
		return rec, fmt.Errorf("round %d: %s", rec.Number, reason)
	}
	if reason != "" {
		return stop(reason)
	}
	step("evaluated")

	result := postgres.RoundResult{Commit: evaluated.Commit, EvidenceDigest: evaluated.EvidenceDigest, Outcome: evaluated.Outcome}
	if evaluated.Outcome == evidence.OutcomeFailed {
		round.Feedback = evaluated.Report.BuilderFeedback()
		for _, f := range round.Feedback {
			result.Feedback = append(result.Feedback, postgres.Feedback{Criterion: f.Criterion, Symptom: f.Text})
			logf("Round %d: feedback to the builder: %s: %s", rec.Number, f.Criterion, f.Text)
		}
	}
	// Evidence and result go in together, so no crash leaves a signed
	// evaluation whose round looks unevaluated and is evaluated again.
	rec, err = d.Store.SaveRoundEvaluation(ctx, job.ID, d.Owner, rec.Number, evaluated.evidenceRow, result)
	if err != nil {
		return rec, err
	}
	step("round-stored")
	return rec, nil
}

// publish pushes the passing commit to the job's branch and opens a pull
// request for it, each exactly once.
func publish(ctx context.Context, d JobDeps, job postgres.Job, rec postgres.RoundRecord, step func(string)) (int, error) {
	branch := BranchPrefix + job.ID
	_, err := effect.Perform(ctx, d.Journal, effect.Action{
		Key: job.ID + "/push-branch", Kind: "push-branch",
		Find: func(ctx context.Context) ([]byte, bool, error) {
			commit, found, err := d.Forge.FindBranch(ctx, branch)
			if err != nil || !found {
				return nil, false, err
			}
			if commit != rec.Commit {
				return nil, false, fmt.Errorf("%w: branch %s already points at %s, not at the passing commit %s", ErrPermanent, branch, short(commit), short(rec.Commit))
			}
			return []byte(commit), true, nil
		},
		Do: func(ctx context.Context) ([]byte, error) {
			if err := d.Store.CheckLease(ctx, job.ID, d.Owner); err != nil {
				return nil, err
			}
			step("push-branch")
			if err := d.Forge.PushBranch(ctx, d.StoreDir, rec.Commit, branch); err != nil {
				return nil, err
			}
			// The branch exists and nothing has recorded it yet.
			step("branch-pushed-unrecorded")
			return []byte(rec.Commit), nil
		},
	})
	if err != nil {
		return 0, err
	}
	step("pushed")

	result, err := effect.Perform(ctx, d.Journal, effect.Action{
		Key: job.ID + "/pull-request", Kind: "pull-request",
		Find: func(ctx context.Context) ([]byte, bool, error) {
			n, found, err := d.Forge.FindPullRequest(ctx, branch)
			return []byte(strconv.Itoa(n)), found, err
		},
		Do: func(ctx context.Context) ([]byte, error) {
			if err := d.Store.CheckLease(ctx, job.ID, d.Owner); err != nil {
				return nil, err
			}
			step("open-pull-request")
			builder := ""
			if d.Agent != nil {
				builder = d.Agent.Name()
			}
			n, err := d.Forge.OpenPullRequest(ctx, branch, job.BaseBranch, changeTitle(job, rec), pullRequestBody(job, rec, builder))
			if err != nil {
				return nil, err
			}
			// The pull request exists and nothing has recorded it yet.
			step("pull-request-opened-unrecorded")
			return []byte(strconv.Itoa(n)), nil
		},
	})
	if err != nil {
		return 0, err
	}
	pr, err := strconv.Atoi(string(result))
	if err != nil || pr < 1 {
		return 0, fmt.Errorf("controller: stored pull request number %q", result)
	}
	step("pull-request-opened")
	if err := d.Store.SetPullRequest(ctx, job.ID, d.Owner, pr); err != nil {
		return 0, err
	}
	// The status is advisory; failing to post it does not undo a published
	// job.
	if err := d.Forge.SetStatus(ctx, rec.Commit, "success", "Evaluated: passed. Evidence "+short(rec.EvidenceDigest)); err != nil && d.Log != nil {
		d.Log("Could not post the commit status on %s: %v", short(rec.Commit), err)
	}
	step("status-set")
	return pr, nil
}

// ErrPermanent marks a job error that retrying cannot fix. The job goes to a
// person at once.
var ErrPermanent = errors.New("controller: retrying will not help")

// importRound makes a round's commit from its stored change. The commit
// date comes from the stored round, so every import of the same change, by
// any controller, gives the same commit.
func importRound(ctx context.Context, d JobDeps, job postgres.Job, rec postgres.RoundRecord) (gitimport.Result, error) {
	return gitimport.Import(ctx, gitimport.Request{
		Store: d.StoreDir, Parent: job.Base, TestedTree: rec.TestedTree, Patch: rec.Patch,
		Message:    fmt.Sprintf("%s\n\nSprintFoundry job %s, round %d.\n", changeTitle(job, rec), job.ID, rec.Number),
		AuthorName: "SprintFoundry builder", AuthorEmail: "builder@sprintfoundry.invalid", Date: rec.ChangedAt,
	})
}

// isPatchRefusal reports whether an import failed because of the change
// itself, which importing again cannot fix.
func isPatchRefusal(err error) bool {
	return errors.Is(err, gitimport.ErrBadPatch) || errors.Is(err, gitimport.ErrTreeMismatch) || errors.Is(err, gitimport.ErrEmptyChange) ||
		errors.Is(err, gitimport.ErrForbiddenEntry) || errors.Is(err, gitimport.ErrPatchTooLarge)
}

// ensureCommit makes a finished round's commit in this controller's store
// and checks it is the commit that was evaluated.
func ensureCommit(ctx context.Context, d JobDeps, job postgres.Job, rec postgres.RoundRecord) error {
	imported, err := importRound(ctx, d, job, rec)
	if isPatchRefusal(err) {
		return fmt.Errorf("%w: round %d's stored change no longer imports: %v", ErrPermanent, rec.Number, err)
	}
	if err != nil {
		return fmt.Errorf("round %d: import the stored change: %w", rec.Number, err)
	}
	if imported.Commit != rec.Commit {
		return fmt.Errorf("%w: round %d's stored change imports as %s, but %s was evaluated", ErrPermanent, rec.Number, short(imported.Commit), short(rec.Commit))
	}
	return nil
}

// loadInputs reads a job's frozen inputs back from the store and checks they
// still hash to the digests the job was approved with.
func loadInputs(ctx context.Context, s JobStore, job postgres.Job) ([]byte, frozen, error) {
	criteria, err := s.GetInput(ctx, job.Inputs.CriteriaDigest)
	if err != nil {
		return nil, frozen{}, fmt.Errorf("controller: job %s criteria: %w", job.ID, err)
	}
	suite, err := s.GetInput(ctx, job.Inputs.SuiteDigest)
	if err != nil {
		return nil, frozen{}, fmt.Errorf("controller: job %s check suite: %w", job.ID, err)
	}
	spec, err := s.GetInput(ctx, job.Inputs.RunSpecDigest)
	if err != nil {
		return nil, frozen{}, fmt.Errorf("controller: job %s run spec: %w", job.ID, err)
	}
	in, err := ParseInputs(criteria, suite, spec)
	if err != nil {
		return nil, frozen{}, err
	}
	in.criteria = job.Inputs.CriteriaDigest
	if in.suiteDigest != job.Inputs.SuiteDigest || in.specDigest != job.Inputs.RunSpecDigest || postgres.Digest(criteria) != job.Inputs.CriteriaDigest {
		return nil, frozen{}, fmt.Errorf("%w: job %s inputs do not match their digests", ErrInputs, job.ID)
	}
	return criteria, in, nil
}

// sensitivePaths returns the changed paths a person must review: those the
// run spec protects, and always the configuration of CI systems, which would
// run as soon as the branch is pushed.
func sensitivePaths(ctx context.Context, storeDir, base, commit string, in frozen) (changed, sensitive []string, err error) {
	changed, err = gitimport.ChangedPaths(ctx, storeDir, base, commit)
	if err != nil {
		return nil, nil, err
	}
	sensitive = in.spec.Sensitive(changed)
	seen := map[string]bool{}
	for _, p := range sensitive {
		seen[p] = true
	}
	for _, p := range changed {
		if !seen[p] && IsCIConfig(p) {
			sensitive = append(sensitive, p)
		}
	}
	return changed, sensitive, nil
}

// IsCIConfig reports whether a path configures a CI system that may run when
// a branch is pushed. It is a deny list of the systems known to read their
// configuration from the repository; the run spec's sensitive paths cover
// anything else a repository needs.
func IsCIConfig(p string) bool {
	lower := strings.ToLower(p)
	for _, dir := range []string{".github/", ".gitlab/", ".circleci/", ".buildkite/", ".gitea/", ".forgejo/", ".woodpecker/",
		".azure-pipelines/", ".azuredevops/", ".tekton/", ".semaphore/", ".harness/", ".bitrise/", ".codebuild/", ".teamcity/", ".concourse/"} {
		if strings.HasPrefix(lower, dir) {
			return true
		}
	}
	base := lower[strings.LastIndex(lower, "/")+1:]
	if base == "jenkinsfile" || strings.HasPrefix(base, "jenkinsfile.") || strings.HasPrefix(lower, ".cirrus.") {
		return true
	}
	name := strings.TrimSuffix(strings.TrimSuffix(lower, ".yml"), ".yaml")
	if name == lower {
		return false
	}
	switch name {
	case ".gitlab-ci", "azure-pipelines", ".azure-pipelines", ".travis", "bitbucket-pipelines", ".drone", "appveyor", ".appveyor",
		".woodpecker", "cloudbuild", "buildspec", "codemagic", ".codemagic", "bitrise", "wercker", ".pre-commit-config", "renovate", ".mergify":
		return true
	}
	return false
}
