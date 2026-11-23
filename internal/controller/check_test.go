package controller

import (
	"context"
	"strings"
	"testing"

	"github.com/sagart-cactus/sprintfoundry/internal/demo"
	"github.com/sagart-cactus/sprintfoundry/internal/gitimport"
)

// commitOf puts a recorded builder's change into the store as a commit, as a
// pull request's head would arrive.
func (w *world) commitOf(variant string) string {
	w.t.Helper()
	ctx := context.Background()
	change, err := demo.Change(ctx, w.builder.dir, w.req.StoreDir, w.req.Parent, variant)
	if err != nil {
		w.t.Fatal(err)
	}
	imported, err := gitimport.Import(ctx, gitimport.Request{Store: w.req.StoreDir, Parent: w.req.Parent,
		TestedTree: change.TestedTree, Patch: change.Patch, Message: variant + "\n",
		AuthorName: "someone", AuthorEmail: "someone@example.test"})
	if err != nil {
		w.t.Fatal(err)
	}
	return imported.Commit
}

func (w *world) check(id, commit string, allowance int) Result {
	w.t.Helper()
	res, err := Check(context.Background(), w.deps, CheckRequest{
		RunID: id, Repository: w.req.Repository, StoreDir: w.req.StoreDir, Base: w.req.Parent, Commit: commit,
		Criteria: w.req.Criteria, Suite: w.req.Suite, RunSpec: w.req.RunSpec,
		Purpose: w.req.Purpose, ImageName: w.req.ImageName, DigestKind: w.req.DigestKind,
		RunnerImage: w.req.RunnerImage, NameKey: w.req.NameKey, Allowance: allowance,
	})
	if err != nil {
		w.t.Fatalf("Check: %v", err)
	}
	return res
}

func TestCheckOfAPullRequestHead(t *testing.T) {
	w := newWorld(t, nil, app{}, app{leaky: true}, app{})

	good := w.check("check-good", w.commitOf("fixed"), 10)
	if good.State != Passed || len(good.Rounds) != 1 || good.Rounds[0].Outcome != "passed" {
		t.Fatalf("good change: %s (%s)", good.State, good.Reason)
	}

	bad := w.check("check-bad", w.commitOf("defect"), 10)
	if bad.State != NeedsOwner || !strings.Contains(bad.Reason, "export-owner-only: a request that should be refused was allowed") {
		t.Fatalf("defective change: %s (%s)", bad.State, bad.Reason)
	}
	for _, secret := range []string{"export-denied", "403", "/invoices/export.csv"} {
		if strings.Contains(bad.Reason, secret) {
			t.Errorf("the reason an author would see names %q", secret)
		}
	}

	tampered := w.check("check-tamper", w.commitOf("tamper"), 10)
	if tampered.State != NeedsOwner || !strings.Contains(tampered.Reason, "protected paths") {
		t.Fatalf("tampering change: %s (%s)", tampered.State, tampered.Reason)
	}
	if len(w.store.evidence) != 3 {
		t.Errorf("evidence rows = %d, want one per check", len(w.store.evidence))
	}
}

func TestCheckAllowance(t *testing.T) {
	w := newWorld(t, nil, app{leaky: true}, app{leaky: true}, app{}, app{})
	commit := w.commitOf("defect")
	for i, id := range []string{"a1", "a2"} {
		if res := w.check(id, commit, 2); res.State != NeedsOwner || len(res.Rounds) != 1 {
			t.Fatalf("check %d: %s (%s)", i+1, res.State, res.Reason)
		}
	}
	over := w.check("a3", w.commitOf("fixed"), 2)
	if !strings.Contains(over.Reason, "allowance") || len(over.Rounds) != 0 || len(w.evals) != 2 {
		t.Fatalf("over the allowance: %s (%s), %d rounds, %d evaluations", over.State, over.Reason, len(over.Rounds), len(w.evals))
	}
	// A release check after merge tells no author anything and is not counted.
	release := w.check("release-1", w.commitOf("fixed"), 0)
	if release.State != Passed {
		t.Fatalf("release check: %s (%s)", release.State, release.Reason)
	}
}

func TestCheckRefusesACommitThatIsNotThere(t *testing.T) {
	w := newWorld(t, nil)
	_, err := Check(context.Background(), w.deps, CheckRequest{
		RunID: "missing", Repository: w.req.Repository, StoreDir: w.req.StoreDir, Base: w.req.Parent,
		Commit: strings.Repeat("a", 40), Criteria: w.req.Criteria, Suite: w.req.Suite, RunSpec: w.req.RunSpec,
		Purpose: w.req.Purpose, ImageName: w.req.ImageName, DigestKind: w.req.DigestKind,
		RunnerImage: w.req.RunnerImage, NameKey: w.req.NameKey,
	})
	if err == nil {
		t.Fatal("a commit that is not in the store was checked")
	}
}
