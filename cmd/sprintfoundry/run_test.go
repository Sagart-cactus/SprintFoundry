package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/container"
	"github.com/sagart-cactus/sprintfoundry/internal/controller"
	"github.com/sagart-cactus/sprintfoundry/internal/local"
	"github.com/sagart-cactus/sprintfoundry/internal/runnerimage"
)

const stubImage = "docker.io/alpine/git@sha256:29cff25811f790b9f72fc266bf8009a5a911714c0e03c31c47339c50909d9aef"

// TestRunWithAStubAgent drives `sprintfoundry run` through every live piece:
// copying the user's repository, the proxy and its network, a fresh sandbox
// per round, import, build, evaluation, signing and the gate. Only the agent
// is a stub, so no model key is needed: round 1 ships the seeded defect,
// round 2 writes the repaired file after it is told what failed.
func TestRunWithAStubAgent(t *testing.T) {
	cli := container.CLI{}
	probe, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	skip := func(reason string) {
		if os.Getenv("CI") != "" && os.Getenv("SPRINTFOUNDRY_NO_CONTAINERS") == "" {
			t.Fatalf("%s; in CI this test must not be skipped silently", reason)
		}
		t.Skip(reason)
	}
	if err := cli.Available(probe); err != nil {
		skip("no container runtime: " + err.Error())
	}
	if _, err := runnerimage.ProgramBinary(runnerimage.Proxy, cli.Arch(probe)); errors.Is(err, runnerimage.ErrNotEmbedded) {
		skip(err.Error())
	}

	// The user's repository: the demo app, committed.
	repo := filepath.Join(t.TempDir(), "invoices")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"app.py", "test_app.py", "Dockerfile", "README.md"} {
		data, err := os.ReadFile(filepath.Join("..", "..", "internal", "demo", "app", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(repo, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	git := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false"}, args...)...)
		cmd.Dir = repo
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_NOSYSTEM=1")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("init", "-q", "-b", "main")
	git("add", "-A")
	git("commit", "-q", "-m", "invoices")

	b64 := func(path string) string {
		data, err := os.ReadFile(filepath.Join("..", "..", "internal", "demo", "variants", path))
		if err != nil {
			t.Fatal(err)
		}
		return base64.StdEncoding.EncodeToString(data)
	}
	script := `set -e
if grep -q "previous attempt" /sf/task.md; then
  grep -q "export-owner-only" /sf/task.md
  echo ` + b64("fixed/app.py") + ` | base64 -d > app.py
else
  echo ` + b64("defect/app.py") + ` | base64 -d > app.py
fi`

	home := local.Home{Dir: filepath.Join(t.TempDir(), "home")}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		_ = home.Down(ctx, cli, true)
	})
	demoDir := filepath.Join("..", "..", "internal", "demo")
	var out bytes.Buffer
	res, err := runLive(liveOptions{
		Home: home.Dir, RepoPath: repo,
		CriteriaPath: filepath.Join(demoDir, "criteria.md"), ChecksPath: filepath.Join(demoDir, "checks.yaml"),
		SpecPath: filepath.Join(demoDir, "runspec.yaml"), Repository: "local/invoices-run-test",
		Model: "unused", Upstream: "http://127.0.0.1:9", Key: "sk-fake-run-test", MaxRequests: 5, RepairRounds: 2,
		AgentImage: stubImage, AgentScript: script, AgentLabel: "stub agent",
	}, &out)
	transcript := out.String()
	if err != nil {
		t.Fatalf("run failed: %v\n%s", err, transcript)
	}
	if res.State != controller.Passed || len(res.Rounds) != 2 {
		t.Fatalf("state %s (%s) after %d rounds\n%s", res.State, res.Reason, len(res.Rounds), transcript)
	}
	if res.Rounds[0].Outcome != "failed" || res.Rounds[1].Outcome != "passed" {
		t.Errorf("outcomes %s, %s", res.Rounds[0].Outcome, res.Rounds[1].Outcome)
	}
	if strings.Contains(transcript, "sk-fake-run-test") {
		t.Error("the key appears in the run's output")
	}
	m := regexp.MustCompile(`sprintfoundry verify --policy (\S+) ([0-9a-f]{64})`).FindStringSubmatch(transcript)
	if m == nil {
		t.Fatalf("no verify command in the output\n%s", transcript)
	}
	var stdout, stderr bytes.Buffer
	if code := run([]string{"verify", "--home", home.Dir, "--policy", m[1], m[2]}, &stdout, &stderr); code != 0 {
		t.Errorf("the gate refused the passing image: %s%s", stdout.String(), stderr.String())
	}
	if code := run([]string{"verify", "--home", home.Dir, "--policy", m[1], res.Rounds[0].Image}, &stdout, &stderr); code != 1 {
		t.Errorf("the gate did not refuse the defective image (exit %d)", code)
	}

	// The user's repository is untouched: the controller worked on its own copy.
	cmd := exec.Command("git", "status", "--porcelain")
	cmd.Dir = repo
	if status, _ := cmd.Output(); len(bytes.TrimSpace(status)) != 0 {
		t.Errorf("the user's repository was changed:\n%s", status)
	}
}

func TestRunNeedsAKeyAndItsInputs(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	var stdout, stderr bytes.Buffer
	if code := run([]string{"run", "--criteria", "c", "--checks", "x", "--runspec", "y"}, &stdout, &stderr); code != 2 || !strings.Contains(stderr.String(), "OPENAI_API_KEY") {
		t.Errorf("no key: exit %d, %s", code, stderr.String())
	}
	stderr.Reset()
	if code := run([]string{"run"}, &stdout, &stderr); code != 2 {
		t.Errorf("no inputs: exit %d", code)
	}
}
