package evaluate

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/checks"
	"github.com/sagart-cactus/sprintfoundry/internal/container"
	"github.com/sagart-cactus/sprintfoundry/internal/demo"
	"github.com/sagart-cactus/sprintfoundry/internal/gitimport"
	"github.com/sagart-cactus/sprintfoundry/internal/runnerimage"
	"github.com/sagart-cactus/sprintfoundry/internal/runspec"
)

// world is everything the tests share: a runtime, the runner image, and one
// candidate image per recorded builder.
type world struct {
	cli    container.CLI
	runner string
	images map[string]string
	spec   runspec.Spec
	suite  checks.Suite
}

func newWorld(t *testing.T) *world {
	t.Helper()
	cli := container.CLI{}
	probe, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := cli.Available(probe); err != nil {
		if os.Getenv("CI") != "" && os.Getenv("SPRINTFOUNDRY_NO_CONTAINERS") == "" {
			t.Fatalf("no container runtime in CI, and this test must not be skipped silently: %v", err)
		}
		t.Skipf("no container runtime: %v", err)
	}
	ctx, cancelAll := context.WithTimeout(context.Background(), 8*time.Minute)
	t.Cleanup(cancelAll)

	w := &world{cli: cli, images: map[string]string{}}
	var err error
	if w.runner, err = runnerimage.Build(ctx, cli, nil); err != nil {
		if errors.Is(err, runnerimage.ErrNotEmbedded) {
			t.Skipf("%v", err)
		}
		t.Fatalf("build runner image: %v", err)
	}
	if w.spec, err = runspec.Parse(demo.RunSpec()); err != nil {
		t.Fatal(err)
	}
	if w.suite, err = checks.Parse(demo.Checks()); err != nil {
		t.Fatal(err)
	}

	// Build one candidate per recorded builder the way the controller does:
	// import the change as data, archive the commit, build with no network.
	dir := t.TempDir()
	store := filepath.Join(dir, "store.git")
	parent, err := demo.SeedStore(ctx, store)
	if err != nil {
		t.Fatalf("seed store: %v", err)
	}
	for _, variant := range demo.Variants {
		change, err := demo.Change(ctx, dir, store, parent, variant)
		if err != nil {
			t.Fatalf("recorded builder %s: %v", variant, err)
		}
		imported, err := gitimport.Import(ctx, gitimport.Request{
			Store: store, Parent: parent, TestedTree: change.TestedTree, Patch: change.Patch,
			Message: "Export invoices as CSV\n", AuthorName: "Builder", AuthorEmail: "builder@sprintfoundry.invalid",
		})
		if err != nil {
			t.Fatalf("import %s: %v", variant, err)
		}
		var tarball bytes.Buffer
		if err := gitimport.Archive(ctx, store, imported.Commit, &tarball); err != nil {
			t.Fatalf("archive %s: %v", variant, err)
		}
		id, err := cli.Build(ctx, &tarball, container.BuildOptions{Dockerfile: w.spec.Build.Dockerfile, Network: "none"})
		if err != nil {
			t.Fatalf("build %s: %v", variant, err)
		}
		w.images[variant] = id
	}
	// Images are left in place: identical content has the same image ID, so
	// another test package running at the same time may be using them.
	return w
}

func (w *world) request(variant string) Request {
	return Request{
		RunID:       fmt.Sprintf("t%d", time.Now().UnixNano()%100_000_000),
		Candidate:   w.images[variant],
		RunnerImage: w.runner,
		Spec:        w.spec,
		Suite:       w.suite,
	}
}

func TestEvaluationOfTheRecordedBuilders(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	t.Run("the seeded defect is caught on its exact image", func(t *testing.T) {
		req := w.request("defect")
		res, err := Run(ctx, w.cli, req)
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if res.Report.Result != checks.Failed {
			t.Fatalf("result = %s, want failed: %+v", res.Report.Result, res.Report.Checks)
		}
		if res.ServedBefore != req.Candidate || res.ServedAfter != req.Candidate {
			t.Errorf("served %s then %s, want the candidate %s", res.ServedBefore, res.ServedAfter, req.Candidate)
		}
		failed := map[string]bool{}
		for _, g := range res.Report.Checks {
			if g.Outcome == checks.Failed {
				failed[g.ID] = true
			}
		}
		if len(failed) != 1 || !failed["export-denied"] {
			t.Errorf("failed checks = %v, want only export-denied", failed)
		}
		feedback := res.Report.BuilderFeedback()
		if len(feedback) != 1 || feedback[0].Criterion != "export-owner-only" ||
			feedback[0].Text != "a request that should be refused was allowed" {
			t.Errorf("feedback = %+v", feedback)
		}
	})

	t.Run("the repaired change passes", func(t *testing.T) {
		res, err := Run(ctx, w.cli, w.request("fixed"))
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if res.Report.Result != checks.Passed {
			t.Fatalf("result = %s, want passed: %+v", res.Report.Result, res.Report.Checks)
		}
		if len(res.Observations) != len(w.suite.Checks) {
			t.Errorf("%d observations for %d checks", len(res.Observations), len(w.suite.Checks))
		}
	})
}

func TestEvaluationWaitsForCandidateDigest(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	// Something replaces the preview with another image before checks start.
	swap := func(ctx context.Context, preview, network string) {
		_ = w.cli.Remove(ctx, preview)
		if _, err := w.cli.Run(ctx, container.RunOptions{Name: preview, Image: w.images["defect"], Network: network}); err != nil {
			t.Errorf("swap: %v", err)
		}
	}
	_, err := run(ctx, w.cli, w.request("fixed"), hooks{afterPreviewStart: swap})
	if !errors.Is(err, ErrNotServingCandidate) {
		t.Fatalf("err = %v, want ErrNotServingCandidate", err)
	}
}

func TestEvaluationDiscardedIfPreviewChanged(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	t.Run("swapped for another image after the checks ran", func(t *testing.T) {
		swap := func(ctx context.Context, preview, network string) {
			_ = w.cli.Remove(ctx, preview)
			if _, err := w.cli.Run(ctx, container.RunOptions{Name: preview, Image: w.images["defect"], Network: network}); err != nil {
				t.Errorf("swap: %v", err)
			}
		}
		res, err := run(ctx, w.cli, w.request("fixed"), hooks{beforeFinalCheck: swap})
		if !errors.Is(err, ErrPreviewChanged) {
			t.Fatalf("err = %v, want ErrPreviewChanged", err)
		}
		if res.Report.Result != "" || len(res.Report.Checks) != 0 {
			t.Errorf("a discarded evaluation still returned a report: %+v", res.Report)
		}
	})

	t.Run("stopped before the evaluation ended", func(t *testing.T) {
		stop := func(ctx context.Context, preview, _ string) { _ = w.cli.Remove(ctx, preview) }
		if _, err := run(ctx, w.cli, w.request("fixed"), hooks{beforeFinalCheck: stop}); !errors.Is(err, ErrPreviewChanged) {
			t.Fatalf("err = %v, want ErrPreviewChanged", err)
		}
	})
}

// stubRuntime returns a CLI whose binary records every call and succeeds, so
// a test can tell "refused before the runtime was asked" from "the runtime
// happened to fail".
func stubRuntime(t *testing.T) (container.CLI, func() string) {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls.log")
	script := filepath.Join(dir, "runtime")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho \"$@\" >> '"+log+"'\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return container.CLI{Bin: script}, func() string {
		data, _ := os.ReadFile(log)
		return string(data)
	}
}

func TestRunRefusesOddRunIDs(t *testing.T) {
	for _, id := range []string{"", "Run 1", "--rm", "a/b", "x;y"} {
		cli, calls := stubRuntime(t)
		_, err := Run(context.Background(), cli, Request{RunID: id})
		if err == nil || !strings.Contains(err.Error(), "is not allowed") {
			t.Errorf("run ID %q: err = %v, want a refusal", id, err)
		}
		if got := calls(); got != "" {
			t.Errorf("run ID %q reached the container runtime: %s", id, got)
		}
	}
}

func TestEvaluationsWithTheSameRunIDDoNotCollide(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// A second evaluation starts under the same run ID while the first one
	// is between its start and its final check.
	first := w.request("fixed")
	var inner error
	interfere := func(ctx context.Context, _, _ string) {
		second := w.request("fixed")
		second.RunID = first.RunID
		_, inner = Run(ctx, w.cli, second)
	}
	res, err := run(ctx, w.cli, first, hooks{beforeFinalCheck: interfere})
	if inner != nil {
		t.Errorf("the second evaluation failed: %v", inner)
	}
	if err != nil || res.Report.Result != checks.Passed {
		t.Fatalf("the first evaluation was disturbed by the second: %v, result %q", err, res.Report.Result)
	}
}
