package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

func newJob(t *testing.T, s *postgres.Store, id string, issue int, criteria string) postgres.Job {
	t.Helper()
	r := newRun(t, s, "unused-"+id, "github.com/o/r", criteria)
	j := postgres.Job{ID: id, Repository: "github.com/o/r", Issue: issue, Base: "0123456789abcdef0123456789abcdef01234567", BaseBranch: "main",
		Inputs: postgres.Run{CriteriaDigest: r.CriteriaDigest, SuiteDigest: r.SuiteDigest, RunSpecDigest: r.RunSpecDigest}}
	if err := s.CreateJob(context.Background(), j); err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	return j
}

func TestAJobIsCreatedOnceAndIsItsOwnRun(t *testing.T) {
	s := open(t, freshURL(t))
	ctx := context.Background()
	j := newJob(t, s, "job-1", 7, "criteria A")
	if err := s.CreateJob(ctx, j); !errors.Is(err, postgres.ErrJobExists) {
		t.Fatalf("second job for the same issue and criteria: err = %v, want ErrJobExists", err)
	}
	if err := s.BeginRun(ctx, newRun(t, s, "taken", j.Repository, "criteria A")); err != nil {
		t.Fatal(err)
	}
	other := j
	other.ID = "taken"
	other.Issue = 8
	if err := s.CreateJob(ctx, other); !errors.Is(err, postgres.ErrRunExists) {
		t.Fatalf("a job reusing a run ID: err = %v, want ErrRunExists", err)
	}
	// Evidence for the job's run can be stored: the job created the run.
	putEvidence(t, s, postgres.Run{ID: "job-1", Repository: j.Repository, CriteriaDigest: j.Inputs.CriteriaDigest,
		SuiteDigest: j.Inputs.SuiteDigest, RunSpecDigest: j.Inputs.RunSpecDigest}, "sha256:e1", "sha256:img", "passed", "")
}

func TestOnlyOneControllerHoldsAJob(t *testing.T) {
	s := open(t, freshURL(t))
	ctx := context.Background()
	newJob(t, s, "job-1", 1, "A")
	newJob(t, s, "job-2", 2, "B")

	var mu sync.Mutex
	got := map[string]string{}
	var wg sync.WaitGroup
	for _, owner := range []string{"c1", "c2", "c3", "c4"} {
		wg.Add(1)
		go func(owner string) {
			defer wg.Done()
			j, ok, err := s.ClaimJob(ctx, owner, time.Minute)
			if err != nil {
				t.Error(err)
				return
			}
			if ok {
				mu.Lock()
				if prev, dup := got[j.ID]; dup {
					t.Errorf("%s claimed by %s and %s", j.ID, prev, owner)
				}
				got[j.ID] = owner
				mu.Unlock()
			}
		}(owner)
	}
	wg.Wait()
	if len(got) != 2 {
		t.Fatalf("claimed %v, want both jobs", got)
	}
	if _, ok, _ := s.ClaimJob(ctx, "c5", time.Minute); ok {
		t.Fatal("a held job was claimed again")
	}
	owner := got["job-1"]
	if err := s.RenewLease(ctx, "job-1", "someone-else", time.Minute); !errors.Is(err, postgres.ErrLeaseLost) {
		t.Errorf("renewing another controller's lease: err = %v", err)
	}
	if err := s.RenewLease(ctx, "job-1", owner, time.Minute); err != nil {
		t.Errorf("renew: %v", err)
	}
}

func TestAnExpiredLeaseIsTakenOverAndTheOldHolderCannotWrite(t *testing.T) {
	s := open(t, freshURL(t))
	ctx := context.Background()
	newJob(t, s, "job-1", 1, "A")
	if _, ok, err := s.ClaimJob(ctx, "old", 50*time.Millisecond); !ok || err != nil {
		t.Fatalf("claim: %v %v", ok, err)
	}
	if _, err := s.StartRound(ctx, "job-1", "old", 1, 3); err != nil {
		t.Fatalf("StartRound: %v", err)
	}
	if _, err := s.BeginAttempt(ctx, "job-1", "old", 1, 10, 30, 2); err != nil {
		t.Fatalf("BeginAttempt: %v", err)
	}
	time.Sleep(150 * time.Millisecond)
	j, ok, err := s.ClaimJob(ctx, "new", time.Minute)
	if !ok || err != nil || j.ID != "job-1" || j.State != postgres.JobRunning {
		t.Fatalf("take over: %+v %v %v", j, ok, err)
	}
	if _, err := s.SaveChange(ctx, "job-1", "old", 1, postgres.Change{Patch: []byte("patch"), TestedTree: "tree", At: time.Now()}); !errors.Is(err, postgres.ErrLeaseLost) {
		t.Errorf("old holder stored a change: err = %v", err)
	}
	if err := s.FinishJob(ctx, "job-1", "old", postgres.JobPassed, ""); !errors.Is(err, postgres.ErrLeaseLost) {
		t.Errorf("old holder finished the job: err = %v", err)
	}
	if err := s.RenewLease(ctx, "job-1", "old", time.Minute); !errors.Is(err, postgres.ErrLeaseLost) {
		t.Errorf("old holder renewed: err = %v", err)
	}
	// The new holder sees the round the old one started and takes nothing again.
	r, err := s.StartRound(ctx, "job-1", "new", 1, 3)
	if err != nil || r.Number != 1 || r.Attempts != 1 || r.HasChange {
		t.Fatalf("StartRound again: %+v %v", r, err)
	}
	if used, _ := s.EvaluationsUsed(ctx, j.Repository, j.Inputs.CriteriaDigest); used != 1 {
		t.Errorf("evaluations used = %d, want 1", used)
	}
	// The new holder asks the builder again; that attempt is counted too,
	// and a third is refused.
	if r, err = s.BeginAttempt(ctx, "job-1", "new", 1, 10, 30, 2); err != nil || r.Attempts != 2 || r.Requests != 20 {
		t.Fatalf("second attempt: %+v %v", r, err)
	}
	if _, err := s.BeginAttempt(ctx, "job-1", "new", 1, 10, 30, 2); !errors.Is(err, postgres.ErrAttemptsUsed) {
		t.Fatalf("third attempt: err = %v, want ErrAttemptsUsed", err)
	}
	if spent, _ := s.Spend(ctx, j.Repository, j.Inputs.CriteriaDigest); spent != 20 {
		t.Errorf("requests reserved = %d, want 20", spent)
	}
	if err := s.FinishJob(ctx, "job-1", "new", postgres.JobPassed, ""); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.ClaimJob(ctx, "later", time.Minute); ok {
		t.Error("a finished job was claimed")
	}
}

func TestRoundsKeepTheFirstChangeAndResult(t *testing.T) {
	s := open(t, freshURL(t))
	ctx := context.Background()
	newJob(t, s, "job-1", 1, "A")
	if _, _, err := s.ClaimJob(ctx, "c", time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := s.StartRound(ctx, "job-1", "c", 1, 3); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BeginAttempt(ctx, "job-1", "c", 1, 10, 30, 2); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 11, 23, 10, 0, 0, 0, time.UTC)
	r, err := s.SaveChange(ctx, "job-1", "c", 1, postgres.Change{Patch: []byte("first"), TestedTree: "tree1", Summary: "summary", Title: "Add a thing", Body: "It adds a thing.", At: at})
	if err != nil || string(r.Patch) != "first" || !r.ChangedAt.Equal(at) || r.PRTitle != "Add a thing" || r.PRBody != "It adds a thing." {
		t.Fatalf("SaveChange: %+v %v", r, err)
	}
	r, err = s.SaveChange(ctx, "job-1", "c", 1, postgres.Change{Patch: []byte("second"), TestedTree: "tree2", Title: "Other", At: at.Add(time.Hour)})
	if err != nil || string(r.Patch) != "first" || r.TestedTree != "tree1" || !r.ChangedAt.Equal(at) || r.PRTitle != "Add a thing" {
		t.Fatalf("a second change replaced the first: %+v %v", r, err)
	}
	fb := []postgres.Feedback{{Criterion: "c1", Symptom: "s"}}
	r, err = s.SaveRoundResult(ctx, "job-1", "c", 1, postgres.RoundResult{Commit: "abc", EvidenceDigest: "sha256:e", Outcome: "failed", Feedback: fb})
	if err != nil || r.Outcome != "failed" || len(r.Feedback) != 1 || r.Feedback[0] != fb[0] {
		t.Fatalf("SaveRoundResult: %+v %v", r, err)
	}
	r, err = s.SaveRoundResult(ctx, "job-1", "c", 1, postgres.RoundResult{Outcome: "passed"})
	if err != nil || r.Outcome != "failed" {
		t.Fatalf("a second result replaced the first: %+v %v", r, err)
	}
	rounds, err := s.Rounds(ctx, "job-1")
	if err != nil || len(rounds) != 1 || !rounds[0].Finished() {
		t.Fatalf("Rounds: %+v %v", rounds, err)
	}
}

func TestRoundsDrawOnTheAllowanceAndTheRequestCapAcrossJobs(t *testing.T) {
	s := open(t, freshURL(t))
	ctx := context.Background()
	a := newJob(t, s, "job-a", 1, "same criteria")
	b := newJob(t, s, "job-b", 2, "same criteria")
	if a.Inputs.CriteriaDigest != b.Inputs.CriteriaDigest {
		t.Fatal("test setup: the criteria differ")
	}
	for _, id := range []string{"job-a", "job-b"} {
		if _, _, err := s.ClaimJob(ctx, "c-"+id, time.Minute); err != nil {
			t.Fatal(err)
		}
	}
	// Request cap 25 with 10 per attempt: two attempts fit across the two
	// jobs, the third does not.
	for _, id := range []string{"job-a", "job-b"} {
		if _, err := s.StartRound(ctx, id, "c-"+id, 1, 3); err != nil {
			t.Fatal(err)
		}
		if _, err := s.BeginAttempt(ctx, id, "c-"+id, 1, 10, 25, 2); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.BeginAttempt(ctx, "job-a", "c-job-a", 1, 10, 25, 2); !errors.Is(err, postgres.ErrRequestCapUsed) {
		t.Fatalf("attempt over the cap: err = %v", err)
	}
	if r, _ := s.StartRound(ctx, "job-a", "c-job-a", 1, 3); r.Attempts != 1 {
		t.Errorf("the refused attempt was counted: %+v", r)
	}
	// The allowance of three evaluations stops the fourth round across jobs.
	if _, err := s.StartRound(ctx, "job-a", "c-job-a", 2, 3); err != nil {
		t.Fatal(err)
	}
	if _, err := s.StartRound(ctx, "job-b", "c-job-b", 2, 3); !errors.Is(err, postgres.ErrAllowanceUsed) {
		t.Fatalf("fourth round: err = %v, want ErrAllowanceUsed", err)
	}
	if used, _ := s.EvaluationsUsed(ctx, a.Repository, a.Inputs.CriteriaDigest); used != 3 {
		t.Errorf("evaluations used = %d, want 3", used)
	}
	if spent, _ := s.Spend(ctx, a.Repository, a.Inputs.CriteriaDigest); spent != 20 {
		t.Errorf("requests reserved = %d, want 20", spent)
	}
	if _, err := s.BeginAttempt(ctx, "job-a", "c-job-a", 2, 5, 25, 2); err != nil {
		t.Errorf("an attempt that fits the cap: %v", err)
	}
}

// A controller that lost its lease cannot store anything, even when the new
// holder has already stored the same round.
func TestALostLeaseStoresNothingEvenForAStoredRound(t *testing.T) {
	s := open(t, freshURL(t))
	ctx := context.Background()
	newJob(t, s, "job-1", 1, "A")
	if _, ok, err := s.ClaimJob(ctx, "old", 50*time.Millisecond); !ok || err != nil {
		t.Fatal(ok, err)
	}
	time.Sleep(120 * time.Millisecond)
	if _, ok, err := s.ClaimJob(ctx, "new", time.Minute); !ok || err != nil {
		t.Fatal(ok, err)
	}
	if _, err := s.StartRound(ctx, "job-1", "new", 1, 3); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BeginAttempt(ctx, "job-1", "new", 1, 10, 30, 2); err != nil {
		t.Fatal(err)
	}
	at := time.Now()
	if _, err := s.SaveChange(ctx, "job-1", "new", 1, postgres.Change{Patch: []byte("p"), TestedTree: "t", At: at}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveChange(ctx, "job-1", "old", 1, postgres.Change{Patch: []byte("p"), TestedTree: "t", At: at}); !errors.Is(err, postgres.ErrLeaseLost) {
		t.Errorf("SaveChange by the old holder: err = %v", err)
	}
	if _, err := s.SaveRoundResult(ctx, "job-1", "new", 1, postgres.RoundResult{StopReason: "x"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveRoundResult(ctx, "job-1", "old", 1, postgres.RoundResult{StopReason: "x"}); !errors.Is(err, postgres.ErrLeaseLost) {
		t.Errorf("SaveRoundResult by the old holder: err = %v", err)
	}
	if err := s.SetPullRequest(ctx, "job-1", "old", 5); !errors.Is(err, postgres.ErrLeaseLost) {
		t.Errorf("SetPullRequest by the old holder: err = %v", err)
	}
	if err := s.CheckLease(ctx, "job-1", "old"); !errors.Is(err, postgres.ErrLeaseLost) {
		t.Errorf("CheckLease for the old holder: %v", err)
	}
	if err := s.CheckLease(ctx, "job-1", "new"); err != nil {
		t.Errorf("CheckLease for the holder: %v", err)
	}
}

func TestFailuresSendAJobToAPersonAfterALimit(t *testing.T) {
	s := open(t, freshURL(t))
	ctx := context.Background()
	newJob(t, s, "job-1", 1, "A")
	for i := 1; i <= 3; i++ {
		j, ok, err := s.ClaimJob(ctx, fmt.Sprint("c", i), time.Minute)
		if !ok || err != nil || j.Claims != i {
			t.Fatalf("claim %d: %+v %v %v", i, j, ok, err)
		}
		finished, err := s.RecordFailure(ctx, "job-1", fmt.Sprint("c", i), fmt.Sprint("boom ", i), false, 3, time.Millisecond)
		if err != nil || finished != (i == 3) {
			t.Fatalf("failure %d: finished=%v %v", i, finished, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	j, _ := s.GetJob(ctx, "job-1")
	if j.State != postgres.JobNeedsOwner || j.Reason != "boom 3" || j.Failures != 3 {
		t.Fatalf("after three failures: %+v", j)
	}
	if _, ok, _ := s.ClaimJob(ctx, "c4", time.Minute); ok {
		t.Error("a job that went to a person was claimed")
	}
	// A permanent error sends the job at once, and the backoff holds it.
	newJob(t, s, "job-2", 2, "B")
	if _, _, err := s.ClaimJob(ctx, "d", time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RecordFailure(ctx, "job-2", "someone-else", "x", true, 3, time.Minute); !errors.Is(err, postgres.ErrLeaseLost) {
		t.Errorf("a failure recorded by a non-holder: %v", err)
	}
	if finished, err := s.RecordFailure(ctx, "job-2", "d", "for good", true, 3, time.Minute); err != nil || !finished {
		t.Fatalf("permanent failure: %v %v", finished, err)
	}
	newJob(t, s, "job-3", 3, "C")
	if _, _, err := s.ClaimJob(ctx, "e", time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RecordFailure(ctx, "job-3", "e", "transient", false, 3, time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.ClaimJob(ctx, "f", time.Minute); ok {
		t.Error("a failed job was claimed again before its backoff ended")
	}
}

func TestEvidenceAndRoundResultAreStoredTogether(t *testing.T) {
	s := open(t, freshURL(t))
	ctx := context.Background()
	j := newJob(t, s, "job-1", 1, "A")
	if _, _, err := s.ClaimJob(ctx, "c", time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := s.StartRound(ctx, "job-1", "c", 1, 3); err != nil {
		t.Fatal(err)
	}
	ev := postgres.Evidence{Digest: "sha256:ev", RunID: "job-1", Round: 1, Repository: j.Repository, ImageDigest: strings.Repeat("1", 64),
		DigestKind: "image-config", CriteriaDigest: j.Inputs.CriteriaDigest, SuiteDigest: j.Inputs.SuiteDigest,
		RunSpecDigest: j.Inputs.RunSpecDigest, Purpose: "demo", Outcome: "passed", Envelope: []byte("{}")}
	if _, err := s.SaveRoundEvaluation(ctx, "job-1", "other", 1, ev, postgres.RoundResult{Outcome: "passed"}); !errors.Is(err, postgres.ErrLeaseLost) {
		t.Fatalf("a non-holder stored an evaluation: %v", err)
	}
	if _, err := s.LatestEvidence(ctx, j.Repository, ev.ImageDigest); !errors.Is(err, postgres.ErrNotFound) {
		t.Fatalf("evidence was stored without its round: %v", err)
	}
	r, err := s.SaveRoundEvaluation(ctx, "job-1", "c", 1, ev, postgres.RoundResult{Commit: "abc", EvidenceDigest: ev.Digest, Outcome: "passed"})
	if err != nil || r.Outcome != "passed" || r.EvidenceDigest != ev.Digest {
		t.Fatalf("SaveRoundEvaluation: %+v %v", r, err)
	}
	if e, err := s.LatestEvidence(ctx, j.Repository, ev.ImageDigest); err != nil || e.Digest != ev.Digest {
		t.Fatalf("evidence: %+v %v", e, err)
	}
}

func TestPublishApprovalOnlyFromAwaitingPublishAndWithAFreshBudget(t *testing.T) {
	s := open(t, freshURL(t))
	ctx := context.Background()
	newJob(t, s, "job-1", 1, "A")
	if err := s.ApprovePublish(ctx, "job-1"); !errors.Is(err, postgres.ErrWrongState) {
		t.Errorf("approving a queued job: %v", err)
	}
	for i := range 5 {
		if _, _, err := s.ClaimJob(ctx, fmt.Sprint("c", i), time.Millisecond); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, ok, _ := s.ClaimJob(ctx, "holder", time.Minute); !ok {
		t.Fatal("no claim")
	}
	if err := s.ApprovePublish(ctx, "job-1"); !errors.Is(err, postgres.ErrWrongState) {
		t.Errorf("approving a running job: %v", err)
	}
	if err := s.FinishJob(ctx, "job-1", "holder", postgres.JobAwaitingPublish, "passed"); err != nil {
		t.Fatal(err)
	}
	if err := s.ApprovePublish(ctx, "job-1"); err != nil {
		t.Fatal(err)
	}
	j, ok, _ := s.ClaimJob(ctx, "publisher", time.Minute)
	if !ok || j.Claims != 1 || !j.PublishApproved {
		t.Errorf("after approval: %+v", j)
	}
	for _, final := range []string{postgres.JobNeedsOwner, postgres.JobPassed} {
		newJob(t, s, "job-"+final, 2, final)
		if _, _, err := s.ClaimJob(ctx, "x-"+final, time.Minute); err != nil {
			t.Fatal(err)
		}
		if err := s.FinishJob(ctx, "job-"+final, "x-"+final, final, "done"); err != nil {
			t.Fatal(err)
		}
		if err := s.ApprovePublish(ctx, "job-"+final); !errors.Is(err, postgres.ErrWrongState) {
			t.Errorf("approving a %s job: %v", final, err)
		}
	}
}

func TestRequeueOnlyForJobsThatStoppedBecauseOfErrors(t *testing.T) {
	s := open(t, freshURL(t))
	ctx := context.Background()
	newJob(t, s, "job-1", 1, "A")
	// One transient failure, then the job reaches a result that needs a person.
	if _, _, err := s.ClaimJob(ctx, "a", time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RecordFailure(ctx, "job-1", "a", "network blip", false, 3, time.Millisecond); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	if _, _, err := s.ClaimJob(ctx, "b", time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := s.FinishJob(ctx, "job-1", "b", postgres.JobNeedsOwner, "a holdout check failed"); err != nil {
		t.Fatal(err)
	}
	if err := s.Requeue(ctx, "job-1"); !errors.Is(err, postgres.ErrWrongState) {
		t.Errorf("a job with a result was queued again: %v", err)
	}
	// A job that stopped because of errors can be.
	newJob(t, s, "job-2", 2, "B")
	if _, _, err := s.ClaimJob(ctx, "c", time.Minute); err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("é", 1500) + "\x00 tail" // over 2000 bytes, with a NUL
	if finished, err := s.RecordFailure(ctx, "job-2", "c", long, true, 3, time.Minute); err != nil || !finished {
		t.Fatalf("a long reason with a NUL: %v %v", finished, err)
	}
	j, _ := s.GetJob(ctx, "job-2")
	if len(j.Reason) > 2000 || strings.ContainsRune(j.Reason, 0) || !utf8.ValidString(j.Reason) || j.Reason != j.LastError {
		t.Errorf("stored reason: %d bytes, valid %v", len(j.Reason), utf8.ValidString(j.Reason))
	}
	if err := s.Requeue(ctx, "job-2"); err != nil {
		t.Fatal(err)
	}
	if j, _ := s.GetJob(ctx, "job-2"); j.State != postgres.JobQueued || j.Failures != 0 || j.LastError != "" {
		t.Errorf("after requeue: %+v", j)
	}
}
