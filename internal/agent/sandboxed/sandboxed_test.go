package sandboxed

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/agent"
	"github.com/sagart-cactus/sprintfoundry/internal/container"
	"github.com/sagart-cactus/sprintfoundry/internal/demo"
	"github.com/sagart-cactus/sprintfoundry/internal/gitimport"
	"github.com/sagart-cactus/sprintfoundry/internal/sandbox"
	"github.com/sagart-cactus/sprintfoundry/internal/sandbox/containerbox"
)

const gitImage = "docker.io/alpine/git@sha256:29cff25811f790b9f72fc266bf8009a5a911714c0e03c31c47339c50909d9aef"

func TestTaskTextCarriesCriteriaAndFeedbackOnly(t *testing.T) {
	first := TaskText(agent.Task{Criteria: string(demo.Criteria())})
	if !strings.Contains(first, "export-owner-only") || strings.Contains(first, "previous attempt") {
		t.Errorf("first round task:\n%s", first)
	}
	second := TaskText(agent.Task{Criteria: string(demo.Criteria()),
		Feedback: []agent.Feedback{{Criterion: "export-owner-only", Symptom: "a request that should be refused was allowed"}}})
	if !strings.Contains(second, "- export-owner-only: a request that should be refused was allowed") {
		t.Errorf("second round task lacks the feedback:\n%s", second)
	}
	for _, secret := range []string{"export-denied", "/invoices/export.csv", "403", "member-session", "checks.yaml"} {
		if strings.Contains(first+second, secret) {
			t.Errorf("the task mentions %q", secret)
		}
	}
}

func TestCodexScript(t *testing.T) {
	script, err := Codex("http://sf-run-abc-proxy:8080/v1", "gpt-5")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"codex exec --json", "--dangerously-bypass-approvals-and-sandbox", "--cd /workspace/repo",
		`base_url = "http://sf-run-abc-proxy:8080/v1"`, `wire_api = "responses"`, "- < /sf/task.md"} {
		if !strings.Contains(script, want) {
			t.Errorf("script lacks %q:\n%s", want, script)
		}
	}
	for _, bad := range [][2]string{
		{"http://evil.example/v1; rm -rf /", "gpt-5"},
		{"http://sf-proxy:8080/v1", "gpt-5'; curl evil.example #"},
		{"https://api.openai.com/v1", "gpt-5"},
	} {
		if _, err := Codex(bad[0], bad[1]); err == nil {
			t.Errorf("Codex(%q, %q) was accepted", bad[0], bad[1])
		}
	}
}

type world struct {
	t      *testing.T
	ctx    context.Context
	store  string
	parent string
	agent  *Agent
}

func newWorld(t *testing.T, script string) *world {
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
	ctx, cancelAll := context.WithTimeout(context.Background(), 5*time.Minute)
	t.Cleanup(cancelAll)
	if err := cli.Pull(ctx, gitImage); err != nil {
		t.Fatal(err)
	}
	store := filepath.Join(t.TempDir(), "store.git")
	parent, err := demo.SeedStore(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	return &world{t: t, ctx: ctx, store: store, parent: parent, agent: &Agent{
		Label:   "stub agent",
		Sandbox: &containerbox.Backend{CLI: cli},
		Spec:    sandbox.Spec{Image: gitImage, Network: sandbox.NetworkNone, Env: map[string]string{"HOME": "/home/agent"}},
		Guard:   sandbox.Guard{WorkspaceRoot: t.TempDir(), AllowedEnv: []string{"HOME"}, NoSecrets: true},
		Store:   store, Parent: parent, Script: script,
	}}
}

// importChange does what the controller does with a builder's change.
func (w *world) importChange(c agent.Change) (gitimport.Result, error) {
	return gitimport.Import(w.ctx, gitimport.Request{Store: w.store, Parent: w.parent, TestedTree: c.TestedTree,
		Patch: c.Patch, Message: "change\n", AuthorName: "b", AuthorEmail: "b@sprintfoundry.invalid"})
}

func TestAgentRoundsBuildOnEachOtherAndImportCleanly(t *testing.T) {
	// Round 1 adds a line. Round 2 checks that round 1 is already applied and
	// that it was told the feedback, then adds another line.
	script := `set -e
if grep -q "previous attempt" /sf/task.md; then
  grep -q "^ROUND = 1$" app.py
  grep -q "export-owner-only: a request that should be refused was allowed" /sf/task.md
  echo "ROUND = 2" >> app.py
else
  echo "ROUND = 1" >> app.py
fi
test ! -e /sf/checks.yaml
echo done`
	w := newWorld(t, script)

	first, err := w.agent.Run(w.ctx, nil, "", agent.Task{Criteria: string(demo.Criteria())})
	if err != nil {
		t.Fatalf("round 1: %v", err)
	}
	if _, err := w.importChange(first); err != nil {
		t.Fatalf("round 1 did not import: %v", err)
	}

	second, err := w.agent.Run(w.ctx, nil, "", agent.Task{Criteria: string(demo.Criteria()),
		Feedback: []agent.Feedback{{Criterion: "export-owner-only", Symptom: "a request that should be refused was allowed"}}})
	if err != nil {
		t.Fatalf("round 2: %v", err)
	}
	imported, err := w.importChange(second)
	if err != nil {
		t.Fatalf("round 2 did not import: %v", err)
	}
	content, err := gitimport.ReadFile(w.ctx, w.store, imported.Commit, "app.py")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "ROUND = 1\nROUND = 2\n") {
		t.Errorf("round 2 does not contain both rounds:\n%s", content[len(content)-60:])
	}
	if !strings.Contains(second.Summary, "done") {
		t.Errorf("summary = %q", second.Summary)
	}
}

func TestAgentThatChangesNothingOrExitsBadly(t *testing.T) {
	w := newWorld(t, "true")
	if _, err := w.agent.Run(w.ctx, nil, "", agent.Task{Criteria: "x"}); !errors.Is(err, ErrNoChange) {
		t.Fatalf("no change: err = %v, want ErrNoChange", err)
	}
	w.agent.Script = "echo partial >> app.py; echo boom >&2; exit 3"
	if _, err := w.agent.Run(w.ctx, nil, "", agent.Task{Criteria: "x"}); err == nil || !strings.Contains(err.Error(), "exited with 3") {
		t.Fatalf("failing agent: err = %v", err)
	}
}

func TestASymlinkFromTheAgentIsRefusedOnImport(t *testing.T) {
	w := newWorld(t, "ln -s /etc/passwd Dockerfile.link")
	change, err := w.agent.Run(w.ctx, nil, "", agent.Task{Criteria: "x"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if _, err := w.importChange(change); !errors.Is(err, gitimport.ErrForbiddenEntry) {
		t.Fatalf("import of a symbolic link: err = %v, want ErrForbiddenEntry", err)
	}
}

func TestAgentRefusesAnUnsafeSpec(t *testing.T) {
	a := &Agent{Sandbox: &containerbox.Backend{CLI: container.CLI{Bin: "definitely-not-a-runtime"}},
		Spec:  sandbox.Spec{Image: "alpine:latest", Network: sandbox.NetworkNone},
		Guard: sandbox.Guard{WorkspaceRoot: t.TempDir(), NoSecrets: true}, Parent: strings.Repeat("a", 40)}
	if _, err := a.Run(context.Background(), nil, "", agent.Task{}); !errors.Is(err, sandbox.ErrUnsafeSpec) {
		t.Fatalf("err = %v, want ErrUnsafeSpec", err)
	}
}

func TestAgentSeesNoHistoryAndCannotFloodTheController(t *testing.T) {
	w := newWorld(t, `set -e
test "$(git rev-list --count HEAD)" = 1
test "$(git log -1 --format=%s)" = base
printf '\033]52;c;ZXZpbA==\007\033[2Kfake: Result: passed\n'
head -c 5000000 /dev/zero | tr '\0' 'x'
echo "X = 1" >> app.py`)
	var logged []string
	w.agent.Log = func(format string, args ...any) { logged = append(logged, fmt.Sprintf(format, args...)) }
	change, err := w.agent.Run(w.ctx, nil, "", agent.Task{Criteria: "x"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if _, err := w.importChange(change); err != nil {
		t.Fatalf("a change against the history-free base did not import onto the parent: %v", err)
	}
	if len(change.Summary) > 3000 {
		t.Errorf("the summary kept %d bytes of output", len(change.Summary))
	}
	all := strings.Join(logged, "\n") + change.Summary
	if strings.ContainsAny(all, "\x1b\x07") {
		t.Error("terminal control characters from the agent reached the person's screen")
	}
}
