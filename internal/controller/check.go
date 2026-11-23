package controller

import (
	"context"
	"fmt"
	"strings"

	"github.com/sagart-cactus/sprintfoundry/internal/evidence"
	"github.com/sagart-cactus/sprintfoundry/internal/gitimport"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

// CheckRequest is a commit someone else wrote, already in the controller's
// store: a pull request's head, or a commit after merge. It is built and
// evaluated against the registered inputs, with no builder involved.
type CheckRequest struct {
	RunID      string
	Repository string
	StoreDir   string
	// Base is what the change is measured against, for the protected paths:
	// the pull request's base commit, or the merged commit's parent.
	Base, Commit string

	Criteria, Suite, RunSpec []byte

	Purpose     signer.Purpose
	ImageName   string
	DigestKind  evidence.DigestKind
	RunnerImage string
	ReportURL   string
	NameKey     []byte
	Labels      map[string]string

	// PullRequest marks a check of a pull request's head. Otherwise the
	// commit is a release candidate after merge.
	PullRequest bool
	// Allowance bounds how many pull request checks may run for these
	// criteria in this repository, across all pull requests, because each
	// tells its author which criteria failed. A release check tells no
	// author anything and is not counted.
	Allowance int
}

// Check evaluates one commit and returns a result with one round.
//
// A pull request check is recorded only once the allowance granted it, and
// its evidence is marked as such: it never supersedes a release check and
// never backs a release.
func Check(ctx context.Context, d Deps, req CheckRequest) (Result, error) {
	in, err := storeInputs(ctx, d, req.RunID, req.Criteria, req.Suite, req.RunSpec)
	if err != nil {
		return Result{}, err
	}
	res := Result{RunID: req.RunID, CriteriaDigest: in.criteria, SuiteDigest: in.suiteDigest, RunSpecDigest: in.specDigest}
	kind, check := postgres.RunRelease, evidence.CheckRelease
	if req.PullRequest {
		kind, check = postgres.RunPullRequest, evidence.CheckPullRequest
		if req.Allowance < 1 {
			return Result{}, fmt.Errorf("controller: a pull request check needs an allowance")
		}
		allowed, err := d.Store.TakeEvaluation(ctx, req.Repository, in.criteria, req.Allowance)
		if err != nil {
			return Result{}, err
		}
		if !allowed {
			res.State = NeedsOwner
			res.Reason = fmt.Sprintf("the allowance of %d checks for these criteria is used up; a person decides what happens next", req.Allowance)
			return res, nil
		}
	}
	if err := beginRun(ctx, d, req.RunID, req.Repository, kind, in); err != nil {
		return Result{}, err
	}
	tree, err := gitimport.Plumbing(req.StoreDir, "")(ctx, nil, "rev-parse", "--verify", req.Commit+"^{tree}")
	if err != nil {
		return Result{}, fmt.Errorf("controller: %s is not in the store: %w", req.Commit, err)
	}
	round, stop, err := evaluateCommit(ctx, d, in, commitRequest{
		RunID: req.RunID, Number: 1, Repository: req.Repository, StoreDir: req.StoreDir,
		Base: req.Base, Commit: req.Commit, Tree: tree,
		Purpose: req.Purpose, ImageName: req.ImageName, DigestKind: req.DigestKind,
		RunnerImage: req.RunnerImage, ReportURL: req.ReportURL, NameKey: req.NameKey, Labels: req.Labels,
		Check: check,
	})
	if err != nil {
		return Result{}, err
	}
	res.Rounds = []Round{round}
	if stop != "" {
		res.State, res.Reason = NeedsOwner, stop
		res.Incomplete = strings.HasPrefix(stop, stopEvaluationIncomplete)
		return res, nil
	}
	round.Feedback = round.Report.BuilderFeedback()
	res.Rounds[0] = round
	switch {
	case round.Outcome == evidence.OutcomePassed && len(round.SensitivePaths) > 0:
		res.State = NeedsOwner
		res.Reason = fmt.Sprintf("the checks passed, but the change touches protected paths %v; a person must review it", round.SensitivePaths)
	case round.Outcome == evidence.OutcomePassed:
		res.State = Passed
	case round.Outcome == evidence.OutcomeInconclusive:
		res.State, res.Reason = NeedsOwner, "some checks could not be completed, so the result is inconclusive"
	case len(round.Feedback) == 0:
		res.State, res.Reason = NeedsOwner, "a check failed"
	default:
		var failed []string
		for _, f := range round.Feedback {
			failed = append(failed, f.Criterion+": "+f.Text)
		}
		res.State, res.Reason = NeedsOwner, "the checks failed: "+strings.Join(failed, "; ")
	}
	return res, nil
}
