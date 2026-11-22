package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/agent"
	"github.com/sagart-cactus/sprintfoundry/internal/checks"
	"github.com/sagart-cactus/sprintfoundry/internal/demo"
	"github.com/sagart-cactus/sprintfoundry/internal/evaluate"
	"github.com/sagart-cactus/sprintfoundry/internal/evidence"
	"github.com/sagart-cactus/sprintfoundry/internal/runspec"
	"github.com/sagart-cactus/sprintfoundry/internal/sandbox"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

// memoryStore implements Store in memory.
type memoryStore struct {
	inputs   map[string]string
	runs     []postgres.Run
	evidence []postgres.Evidence
	repairs  map[string]int
}

func newMemoryStore() *memoryStore {
	return &memoryStore{inputs: map[string]string{}, repairs: map[string]int{}}
}

func (m *memoryStore) PutInput(_ context.Context, kind string, content []byte) (string, error) {
	sum := sha256.Sum256(content)
	digest := "sha256:" + hex.EncodeToString(sum[:])
	m.inputs[digest] = kind
	return digest, nil
}

func (m *memoryStore) PutInputAs(_ context.Context, kind, digest string, _ []byte) error {
	m.inputs[digest] = kind
	return nil
}

func (m *memoryStore) BeginRun(_ context.Context, r postgres.Run) error {
	m.runs = append(m.runs, r)
	return nil
}

func (m *memoryStore) PutEvidence(_ context.Context, e postgres.Evidence) error {
	m.evidence = append(m.evidence, e)
	return nil
}

func (m *memoryStore) TakeEvaluation(_ context.Context, repository, criteria string, limit int) (bool, error) {
	if m.repairs[repository+"|"+criteria] >= limit {
		return false, nil
	}
	m.repairs[repository+"|"+criteria]++
	return true, nil
}

// scriptedBuilder plays recorded builders in order and remembers every task
// it was given, so tests can see exactly what a builder learns.
type scriptedBuilder struct {
	t        *testing.T
	dir      string
	store    string
	parent   string
	variants []string
	tasks    []agent.Task
}

func (b *scriptedBuilder) Name() string { return "scripted" }

func (b *scriptedBuilder) Run(ctx context.Context, _ sandbox.Sandbox, _ string, task agent.Task) (agent.Change, error) {
	b.tasks = append(b.tasks, task)
	if len(b.tasks) > len(b.variants) {
		return agent.Change{}, agent.ErrNoMoreChanges
	}
	return demo.Change(ctx, b.dir, b.store, b.parent, b.variants[len(b.tasks)-1])
}

// app describes how the candidate behaves, for the fake evaluation.
type app struct {
	leaky, holdoutBroken, unreachable bool
}

func observations(a app) []checks.Observation {
	csv := "invoice_id,customer,amount,status\nINV-0001,Acme Tools,120.00,paid\nINV-0007,Gable Roofing,2500.00,archived\n"
	denied, signedOut := 403, 401
	if a.leaky {
		denied = 200
	}
	if a.holdoutBroken {
		signedOut = 200
	}
	obs := []checks.Observation{
		{Check: "export-owner", HTTP: &checks.HTTPObservation{Status: 200, Header: map[string]string{"content-type": "text/csv; charset=utf-8"}, Body: csv}},
		{Check: "export-archived", HTTP: &checks.HTTPObservation{Status: 200, Body: csv}},
		{Check: "export-denied", HTTP: &checks.HTTPObservation{Status: denied}},
		{Check: "export-signed-out", HTTP: &checks.HTTPObservation{Status: signedOut}},
		{Check: "page-still-works", HTTP: &checks.HTTPObservation{Status: 200, Body: "<td>INV-0001</td>"}},
	}
	if a.unreachable {
		obs[0] = checks.Observation{Check: "export-owner", Error: "request failed: connection refused"}
	}
	return obs
}

type world struct {
	t       *testing.T
	store   *memoryStore
	builder *scriptedBuilder
	deps    Deps
	req     Request
	builds  int
	evals   []evaluate.Request
}

// newWorld wires a controller to a real Git store and to fakes for the
// container runtime. apps lists how each round's candidate behaves.
func newWorld(t *testing.T, variants []string, apps ...app) *world {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	dir := t.TempDir()
	storeDir := filepath.Join(dir, "store.git")
	parent, err := demo.SeedStore(ctx, storeDir)
	if err != nil {
		t.Fatalf("seed store: %v", err)
	}
	sgn, err := signer.NewDemo()
	if err != nil {
		t.Fatal(err)
	}
	w := &world{t: t, store: newMemoryStore(),
		builder: &scriptedBuilder{t: t, dir: dir, store: storeDir, parent: parent, variants: variants}}
	w.deps = Deps{
		Store: w.store, Signer: sgn, Agent: w.builder,
		Now: func() time.Time { return time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC) },
		Build: func(_ context.Context, _, commit string, _ runspec.Spec) (string, error) {
			w.builds++
			sum := sha256.Sum256([]byte(commit))
			return hex.EncodeToString(sum[:]), nil
		},
		Evaluate: func(_ context.Context, r evaluate.Request) (evaluate.Result, error) {
			w.evals = append(w.evals, r)
			if len(w.evals) > len(apps) {
				t.Fatalf("evaluation %d was not expected", len(w.evals))
			}
			obs := observations(apps[len(w.evals)-1])
			report, err := checks.Grade(r.Suite, obs)
			return evaluate.Result{Report: report, Observations: obs, ServedBefore: r.Candidate, ServedAfter: r.Candidate}, err
		},
	}
	w.req = Request{
		RunID: "run-1", Repository: demo.Repository, StoreDir: storeDir, Parent: parent,
		Criteria: demo.Criteria(), Suite: demo.Checks(), RunSpec: demo.RunSpec(),
		Purpose: signer.PurposeDemo, ImageName: demo.Repository, DigestKind: evidence.ImageConfig,
		RunnerImage: strings.Repeat("5", 64), NameKey: []byte("a controller secret of 32 bytes!"),
	}
	return w
}

func (w *world) run() Result {
	w.t.Helper()
	res, err := Run(context.Background(), w.deps, w.req)
	if err != nil {
		w.t.Fatalf("Run: %v", err)
	}
	return res
}

func TestRunNeedsFrozenInputs(t *testing.T) {
	breakers := map[string]func(*Request){
		"no criteria":         func(r *Request) { r.Criteria = []byte("  \n") },
		"no check suite":      func(r *Request) { r.Suite = nil },
		"invalid check suite": func(r *Request) { r.Suite = []byte("version: 1\nactors: [owner]\nchecks: []\n") },
		"no run spec":         func(r *Request) { r.RunSpec = nil },
		"suite uses an actor the run spec lacks": func(r *Request) {
			r.RunSpec = []byte(strings.Replace(string(demo.RunSpec()), "  visitor: { headers: {} }\n", "", 1))
		},
	}
	for name, breakIt := range breakers {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t, []string{"fixed"}, app{})
			breakIt(&w.req)
			if _, err := Run(context.Background(), w.deps, w.req); !errors.Is(err, ErrInputs) {
				t.Fatalf("err = %v, want ErrInputs", err)
			}
			if len(w.builder.tasks) != 0 || w.builds != 0 || len(w.store.runs) != 0 {
				t.Errorf("work started without frozen inputs: %d builder tasks, %d builds, %d runs", len(w.builder.tasks), w.builds, len(w.store.runs))
			}
		})
	}
}

func TestDefectIsSentBackAndTheRepairPasses(t *testing.T) {
	w := newWorld(t, []string{"defect", "fixed"}, app{leaky: true}, app{})
	res := w.run()

	if res.State != Passed || len(res.Rounds) != 2 {
		t.Fatalf("state = %s (%s), rounds = %d; want passed in 2 rounds", res.State, res.Reason, len(res.Rounds))
	}
	if res.Rounds[0].Outcome != "failed" || res.Rounds[1].Outcome != "passed" {
		t.Errorf("outcomes = %s, %s", res.Rounds[0].Outcome, res.Rounds[1].Outcome)
	}
	if res.Rounds[0].Image == res.Rounds[1].Image {
		t.Error("the repaired candidate has the same image as the defective one")
	}
	// Each candidate that was evaluated is the one that was built for it.
	for i, round := range res.Rounds {
		if w.evals[i].Candidate != round.Image {
			t.Errorf("round %d evaluated %s, built %s", i+1, w.evals[i].Candidate, round.Image)
		}
	}

	// What the builder learned from the failure: the criterion and a symptom.
	if len(w.builder.tasks) != 2 || len(w.builder.tasks[0].Feedback) != 0 {
		t.Fatalf("builder tasks = %+v", w.builder.tasks)
	}
	feedback := w.builder.tasks[1].Feedback
	if len(feedback) != 1 || feedback[0].Criterion != "export-owner-only" || feedback[0].Symptom != "a request that should be refused was allowed" {
		t.Fatalf("feedback = %+v", feedback)
	}
	told, _ := json.Marshal(w.builder.tasks)
	for _, secret := range []string{"export-denied", "export-signed-out", "/invoices/export.csv", "403", "member-session", "body_contains"} {
		if strings.Contains(string(told), secret) {
			t.Errorf("the builder was told %q", secret)
		}
	}

	// Both evaluations left signed evidence bound to their own image.
	if len(w.store.evidence) != 2 {
		t.Fatalf("evidence rows = %d, want 2", len(w.store.evidence))
	}
	for i, row := range w.store.evidence {
		var env signer.Envelope
		_ = json.Unmarshal(row.Envelope, &env)
		payload, err := w.deps.Signer.Verify(env)
		if err != nil {
			t.Fatalf("evidence %d does not verify: %v", i, err)
		}
		st, _, err := evidence.ParseTestResult(payload)
		if err != nil || st.Subject[0].Digest["sha256"] != res.Rounds[i].Image {
			t.Errorf("evidence %d is for %v, want image %s (%v)", i, st.Subject, res.Rounds[i].Image, err)
		}
		if strings.Contains(string(payload), "export-denied") {
			t.Errorf("evidence %d names a check ID", i)
		}
	}
}

func TestRepairCapIsPerCriteriaDigest(t *testing.T) {
	always := []string{"defect", "defect", "defect", "defect"}
	leaky := app{leaky: true}

	w := newWorld(t, always, leaky, leaky, leaky)
	first := w.run()
	if first.State != NeedsOwner || !strings.Contains(first.Reason, "repair limit") || len(first.Rounds) != 3 {
		t.Fatalf("first run: state %s (%s), %d rounds; want needs_owner after the first try and two repairs", first.State, first.Reason, len(first.Rounds))
	}
	if len(w.builder.tasks) != 3 {
		t.Errorf("the builder was asked %d times, want 3", len(w.builder.tasks))
	}

	// A new run for the same criteria gets nothing: no build, no evaluation,
	// no feedback, and above all no chance to pass. Even a correct change is
	// not evaluated once the allowance is gone.
	for i, variants := range [][]string{always, {"fixed"}, {"fixed"}} {
		again := newWorld(t, variants)
		again.store = w.store
		again.deps.Store = w.store
		again.req.RunID = "run-again-" + string(rune('a'+i))
		res := again.run()
		if res.State != NeedsOwner || !strings.Contains(res.Reason, "repair limit") {
			t.Fatalf("run %d after exhaustion: state %s (%s)", i, res.State, res.Reason)
		}
		if len(res.Rounds) != 0 || again.builds != 0 || len(again.evals) != 0 || len(again.builder.tasks) != 0 {
			t.Fatalf("run %d after exhaustion still worked: %d rounds, %d builds, %d evaluations, %d builder tasks",
				i, len(res.Rounds), again.builds, len(again.evals), len(again.builder.tasks))
		}
	}

	// Different criteria have their own allowance.
	other := newWorld(t, []string{"defect", "fixed"}, leaky, app{})
	other.store = w.store
	other.deps.Store = w.store
	other.req.RunID = "run-other"
	other.req.Criteria = append(append([]byte(nil), demo.Criteria()...), []byte("\n- **export-fast**: The export answers within two seconds.\n")...)
	if res := other.run(); res.State != Passed {
		t.Fatalf("run with other criteria: state %s (%s)", res.State, res.Reason)
	}
}

func TestHoldoutFailureGoesToAPersonNotTheBuilder(t *testing.T) {
	w := newWorld(t, []string{"fixed", "fixed"}, app{holdoutBroken: true})
	res := w.run()
	if res.State != NeedsOwner || !strings.Contains(res.Reason, "holdout") {
		t.Fatalf("state %s (%s)", res.State, res.Reason)
	}
	if len(w.builder.tasks) != 1 {
		t.Errorf("the builder was asked %d times; a holdout failure must not start a repair round", len(w.builder.tasks))
	}
	if !res.Rounds[0].HoldoutFailed || len(res.Rounds[0].Feedback) != 0 {
		t.Errorf("round = %+v", res.Rounds[0])
	}
}

func TestProtectedPathsNeedAPersonEvenWhenChecksPass(t *testing.T) {
	w := newWorld(t, []string{"tamper"}, app{})
	res := w.run()
	if res.State != NeedsOwner || !strings.Contains(res.Reason, "protected paths") {
		t.Fatalf("state %s (%s)", res.State, res.Reason)
	}
	round := res.Rounds[0]
	if round.Outcome != "passed" || strings.Join(round.SensitivePaths, ",") != "Dockerfile,test_app.py" {
		t.Fatalf("round = outcome %s, sensitive %v", round.Outcome, round.SensitivePaths)
	}
	if got := w.store.evidence[0].ReviewRequired; !strings.Contains(got, "Dockerfile") || !strings.Contains(got, "test_app.py") {
		t.Errorf("evidence review note = %q", got)
	}
}

func TestInconclusiveEvaluationGoesToAPerson(t *testing.T) {
	w := newWorld(t, []string{"fixed", "fixed"}, app{unreachable: true})
	res := w.run()
	if res.State != NeedsOwner || !strings.Contains(res.Reason, "inconclusive") {
		t.Fatalf("state %s (%s)", res.State, res.Reason)
	}
	if len(w.builder.tasks) != 1 || w.store.evidence[0].Outcome != "inconclusive" {
		t.Errorf("builder asked %d times, evidence outcome %q", len(w.builder.tasks), w.store.evidence[0].Outcome)
	}
}

func TestARefusedImportStopsTheRun(t *testing.T) {
	w := newWorld(t, []string{"fixed"}, app{})
	w.deps.Agent = &agent.Replay{Changes: []agent.Change{{Patch: []byte("not a patch"), TestedTree: strings.Repeat("a", 40)}}}
	res := w.run()
	if res.State != NeedsOwner || !strings.Contains(res.Reason, "refused on import") || w.builds != 0 {
		t.Fatalf("state %s (%s), builds %d", res.State, res.Reason, w.builds)
	}
}

func TestAnUnlistedBaseImageIsRefusedBeforeAnyBuild(t *testing.T) {
	w := newWorld(t, []string{"badbase"})
	res := w.run()
	if res.State != NeedsOwner || !strings.Contains(res.Reason, "Dockerfile was refused") || !strings.Contains(res.Reason, "not in the run spec's list") {
		t.Fatalf("state %s (%s)", res.State, res.Reason)
	}
	if w.builds != 0 || len(w.evals) != 0 || len(w.store.evidence) != 0 {
		t.Errorf("work happened on a refused Dockerfile: %d builds, %d evaluations, %d evidence rows", w.builds, len(w.evals), len(w.store.evidence))
	}
}
