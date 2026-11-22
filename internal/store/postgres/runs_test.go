package postgres_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

// inputs stores three frozen inputs and returns a run bound to them.
func newRun(t *testing.T, s *postgres.Store, id, repository, criteria string) postgres.Run {
	t.Helper()
	ctx := context.Background()
	r := postgres.Run{ID: id, Repository: repository}
	var err error
	if r.CriteriaDigest, err = s.PutInput(ctx, "criteria", []byte(criteria)); err != nil {
		t.Fatal(err)
	}
	if r.SuiteDigest, err = s.PutInput(ctx, "check-suite", []byte("suite")); err != nil {
		t.Fatal(err)
	}
	if r.RunSpecDigest, err = s.PutInput(ctx, "run-spec", []byte("spec")); err != nil {
		t.Fatal(err)
	}
	return r
}

func putEvidence(t *testing.T, s *postgres.Store, r postgres.Run, digest, image, outcome, review string) {
	t.Helper()
	err := s.PutEvidence(context.Background(), postgres.Evidence{
		Digest: digest, RunID: r.ID, Round: 1, Repository: r.Repository, ImageDigest: image, DigestKind: "image-config",
		CriteriaDigest: r.CriteriaDigest, SuiteDigest: r.SuiteDigest, RunSpecDigest: r.RunSpecDigest,
		Purpose: "demo", Outcome: outcome, ReviewRequired: review, Envelope: []byte("{}"),
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSupersessionIsWorkedOutWhenEvidenceIsRead(t *testing.T) {
	ctx := context.Background()
	s := open(t, freshURL(t))
	image := strings.Repeat("1", 64)

	older := newRun(t, s, "run-a", "local/app", "criteria v1")
	if err := s.BeginRun(ctx, older); err != nil {
		t.Fatal(err)
	}
	putEvidence(t, s, older, "sha256:e1", image, "passed", "")
	if e, err := s.LatestEvidence(ctx, "local/app", image); err != nil || e.Superseded {
		t.Fatalf("the only run's evidence: superseded=%v, %v", e.Superseded, err)
	}

	// Runs for another repository or for other criteria change nothing.
	elsewhere := newRun(t, s, "run-elsewhere", "local/other", "criteria v1")
	otherCriteria := newRun(t, s, "run-v2", "local/app", "criteria v2")
	for _, r := range []postgres.Run{elsewhere, otherCriteria} {
		if err := s.BeginRun(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	if e, _ := s.LatestEvidence(ctx, "local/app", image); e.Superseded {
		t.Fatal("a run for another repository or other criteria superseded this evidence")
	}

	// A newer run for the same repository and criteria supersedes it.
	newer := newRun(t, s, "run-b", "local/app", "criteria v1")
	if err := s.BeginRun(ctx, newer); err != nil {
		t.Fatal(err)
	}
	if e, _ := s.LatestEvidence(ctx, "local/app", image); !e.Superseded {
		t.Fatal("evidence was not superseded when a newer run began")
	}

	// The older run finishes late and stores a pass for a second image after
	// the newer run began. That evidence is superseded as well.
	late := strings.Repeat("2", 64)
	putEvidence(t, s, older, "sha256:e2", late, "passed", "")
	if e, err := s.LatestEvidence(ctx, "local/app", late); err != nil || !e.Superseded {
		t.Fatalf("evidence stored late by the older run: superseded=%v, %v", e.Superseded, err)
	}

	// The newest run's own evidence is not superseded.
	current := strings.Repeat("3", 64)
	putEvidence(t, s, newer, "sha256:e3", current, "passed", "")
	if e, _ := s.LatestEvidence(ctx, "local/app", current); e.Superseded {
		t.Fatal("the newest run's evidence is superseded")
	}

	if _, err := s.LatestEvidence(ctx, "local/other", image); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("evidence was found under another repository: %v", err)
	}
}

func TestRunIDIsSingleUse(t *testing.T) {
	ctx := context.Background()
	s := open(t, freshURL(t))

	first := newRun(t, s, "run-1", "local/app", "criteria v1")
	if err := s.BeginRun(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := s.BeginRun(ctx, first); !errors.Is(err, postgres.ErrRunExists) {
		t.Fatalf("beginning the same run twice: err = %v, want ErrRunExists", err)
	}
	reused := newRun(t, s, "run-1", "local/app", "other criteria")
	if err := s.BeginRun(ctx, reused); !errors.Is(err, postgres.ErrRunExists) {
		t.Fatalf("reusing a run ID for other criteria: err = %v, want ErrRunExists", err)
	}
}

func TestLatestEvidenceIsTheLastOneWritten(t *testing.T) {
	ctx := context.Background()
	s := open(t, freshURL(t))
	image := strings.Repeat("1", 64)
	r := newRun(t, s, "run-1", "local/app", "criteria v1")
	if err := s.BeginRun(ctx, r); err != nil {
		t.Fatal(err)
	}

	// A pass and then a fail for the same image, written in the same instant.
	// The digest of the pass sorts first, which must not make it win.
	putEvidence(t, s, r, "sha256:0000-pass", image, "passed", "")
	putEvidence(t, s, r, "sha256:ffff-fail", image, "failed", "")
	e, err := s.LatestEvidence(ctx, "local/app", image)
	if err != nil || e.Outcome != "failed" {
		t.Fatalf("latest evidence = %q, %v; want the fail that was written last", e.Outcome, err)
	}
}

func TestEvaluationAllowance(t *testing.T) {
	ctx := context.Background()
	s := open(t, freshURL(t))

	for i := 1; i <= 3; i++ {
		if ok, err := s.TakeEvaluation(ctx, "local/app", "sha256:c1", 3); err != nil || !ok {
			t.Fatalf("evaluation %d of 3: %v, %v", i, ok, err)
		}
	}
	for i := 0; i < 3; i++ {
		if ok, err := s.TakeEvaluation(ctx, "local/app", "sha256:c1", 3); err != nil || ok {
			t.Fatalf("an evaluation beyond the limit was allowed (%v, %v)", ok, err)
		}
	}
	if ok, _ := s.TakeEvaluation(ctx, "local/app", "sha256:c2", 3); !ok {
		t.Error("other criteria did not get their own allowance")
	}
	if ok, _ := s.TakeEvaluation(ctx, "local/other", "sha256:c1", 3); !ok {
		t.Error("another repository did not get its own allowance")
	}
	if _, err := s.TakeEvaluation(ctx, "local/app", "sha256:c1", 0); err == nil {
		t.Error("a limit of zero was accepted")
	}

	// Many controllers at once still share exactly one allowance.
	var granted atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ok, err := s.TakeEvaluation(ctx, "local/app", "sha256:race", 3); err != nil {
				t.Errorf("TakeEvaluation: %v", err)
			} else if ok {
				granted.Add(1)
			}
		}()
	}
	wg.Wait()
	if granted.Load() != 3 {
		t.Errorf("%d evaluations were granted under contention, want 3", granted.Load())
	}
}

func TestReviewApproval(t *testing.T) {
	ctx := context.Background()
	s := open(t, freshURL(t))
	r := newRun(t, s, "run-1", "local/app", "criteria v1")
	if err := s.BeginRun(ctx, r); err != nil {
		t.Fatal(err)
	}
	flagged, clean := strings.Repeat("1", 64), strings.Repeat("2", 64)
	putEvidence(t, s, r, "sha256:flagged", flagged, "passed", "change touches Dockerfile")
	putEvidence(t, s, r, "sha256:clean", clean, "passed", "")

	if err := s.ApproveReview(ctx, "sha256:flagged", ""); err == nil {
		t.Error("an approval without an approver was accepted")
	}
	if err := s.ApproveReview(ctx, "sha256:clean", "olivia"); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("approving evidence that needs no review: err = %v, want ErrNotFound", err)
	}
	if err := s.ApproveReview(ctx, "sha256:missing", "olivia"); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("approving evidence that does not exist: err = %v, want ErrNotFound", err)
	}
	if e, _ := s.LatestEvidence(ctx, "local/app", flagged); e.ReviewApprovedBy != "" {
		t.Fatal("evidence was approved before anyone approved it")
	}
	if err := s.ApproveReview(ctx, "sha256:flagged", "olivia"); err != nil {
		t.Fatal(err)
	}
	if e, _ := s.LatestEvidence(ctx, "local/app", flagged); e.ReviewApprovedBy != "olivia" || e.ReviewRequired == "" {
		t.Errorf("after approval: %+v", e)
	}
}

func TestInputsAreAddressedByContent(t *testing.T) {
	ctx := context.Background()
	s := open(t, freshURL(t))

	a, err := s.PutInput(ctx, "criteria", []byte("export invoices"))
	if err != nil {
		t.Fatal(err)
	}
	again, _ := s.PutInput(ctx, "criteria", []byte("export invoices"))
	other, _ := s.PutInput(ctx, "criteria", []byte("export invoices."))
	if a != again || a == other || !strings.HasPrefix(a, "sha256:") {
		t.Fatalf("digests: %s, %s, %s", a, again, other)
	}
	// Storing other content under an existing digest does not replace it.
	if err := s.PutInputAs(ctx, "criteria", a, []byte("something else")); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetInput(ctx, a)
	if err != nil || string(got) != "export invoices" {
		t.Errorf("a frozen input changed: %q, %v", got, err)
	}
	if _, err := s.GetInput(ctx, "sha256:nope"); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("missing input: err = %v", err)
	}
}
