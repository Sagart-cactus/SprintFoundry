package sandbox_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/sagart-cactus/sprintfoundry/internal/sandbox"
	"github.com/sagart-cactus/sprintfoundry/internal/sandbox/sandboxtest"
)

const image = "registry.example/builder@sha256:" + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func safeSpec() sandbox.Spec {
	return sandbox.Spec{
		Image:   image,
		Workdir: "/workspace",
		Env:     map[string]string{"LANG": "C.UTF-8", "HTTPS_PROXY": "http://proxy:3128"},
		Mounts:  []sandbox.Mount{{Source: "/var/lib/sprintfoundry/runs/run-1/src", Target: "/workspace"}},
		Network: sandbox.NetworkProxyOnly,
	}
}

func TestSandboxRefusesSecrets(t *testing.T) {
	guard := sandbox.Guard{
		WorkspaceRoot: "/var/lib/sprintfoundry/runs/run-1",
		Secrets:       []string{"sk-live-abcdef123456", "ghs_installationtoken"},
	}
	if err := safeSpec().Validate(guard); err != nil {
		t.Fatalf("a safe spec was refused: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*sandbox.Spec)
		want   string
	}{
		{"credential value under an innocent name", func(s *sandbox.Spec) { s.Env["EXTRA"] = "Bearer sk-live-abcdef123456" }, "carries a credential"},
		{"credential-looking variable name", func(s *sandbox.Spec) { s.Env["OPENAI_API_KEY"] = "placeholder" }, "looks like a credential"},
		{"token variable name", func(s *sandbox.Spec) { s.Env["GH_TOKEN"] = "x" }, "looks like a credential"},
		{"mount of the home directory", func(s *sandbox.Spec) { s.Mounts[0].Source = "/Users/someone/.ssh" }, "outside the workspace"},
		{"mount that climbs out of the workspace", func(s *sandbox.Spec) { s.Mounts[0].Source = "/var/lib/sprintfoundry/runs/run-1/../run-2" }, "outside the workspace"},
		{"mount of a sibling with the same prefix", func(s *sandbox.Spec) { s.Mounts[0].Source = "/var/lib/sprintfoundry/runs/run-10" }, "outside the workspace"},
		{"relative mount source", func(s *sandbox.Spec) { s.Mounts[0].Source = "src" }, "outside the workspace"},
		{"image by tag", func(s *sandbox.Spec) { s.Image = "registry.example/builder:latest" }, "not pinned"},
		{"host network", func(s *sandbox.Spec) { s.Network = "host" }, "not allowed"},
		{"network left empty", func(s *sandbox.Spec) { s.Network = "" }, "not allowed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			spec := safeSpec()
			tt.mutate(&spec)
			err := spec.Validate(guard)
			if !errors.Is(err, sandbox.ErrUnsafeSpec) {
				t.Fatalf("err = %v, want ErrUnsafeSpec", err)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("err = %q, want it to mention %q", err, tt.want)
			}
		})
	}
}

func TestPlaceholdersHoldOnlyThePublicConstant(t *testing.T) {
	guard := sandbox.Guard{WorkspaceRoot: "/var/lib/sprintfoundry/runs/run-1"}

	spec := safeSpec()
	spec.Placeholders = []string{"ANTHROPIC_AUTH_TOKEN"}
	if err := spec.Validate(guard); err != nil {
		t.Fatalf("a placeholder was refused: %v", err)
	}
	env := spec.EffectiveEnv()
	if env["ANTHROPIC_AUTH_TOKEN"] != sandbox.PlaceholderValue {
		t.Errorf("placeholder value = %q", env["ANTHROPIC_AUTH_TOKEN"])
	}
	if env["LANG"] != "C.UTF-8" {
		t.Error("EffectiveEnv dropped an ordinary variable")
	}
	if _, leaked := spec.Env["ANTHROPIC_AUTH_TOKEN"]; leaked {
		t.Error("EffectiveEnv changed the spec's own Env")
	}

	// A caller cannot use the placeholder list to pick the value itself.
	clash := safeSpec()
	clash.Placeholders = []string{"HTTPS_PROXY"}
	if err := clash.Validate(guard); !errors.Is(err, sandbox.ErrUnsafeSpec) {
		t.Errorf("a name in both lists: err = %v, want ErrUnsafeSpec", err)
	}
	odd := safeSpec()
	odd.Placeholders = []string{"X=real-secret"}
	if err := odd.Validate(guard); !errors.Is(err, sandbox.ErrUnsafeSpec) {
		t.Errorf("a placeholder that smuggles a value: err = %v, want ErrUnsafeSpec", err)
	}
}

func TestValidateNeedsWorkspaceRoot(t *testing.T) {
	if err := safeSpec().Validate(sandbox.Guard{}); !errors.Is(err, sandbox.ErrUnsafeSpec) {
		t.Fatalf("err = %v, want ErrUnsafeSpec", err)
	}
}

func TestFakeLifecycle(t *testing.T) {
	ctx := context.Background()
	fake := &sandboxtest.Fake{Handler: func(_ string, cmd sandbox.Command) (sandbox.Result, error) {
		return sandbox.Result{Stdout: []byte(strings.Join(cmd.Args, " "))}, nil
	}}
	var sb sandbox.Sandbox = fake

	id, err := sb.Create(ctx, safeSpec())
	if err != nil {
		t.Fatal(err)
	}
	res, err := sb.Exec(ctx, id, sandbox.Command{Args: []string{"echo", "hi"}})
	if err != nil || string(res.Stdout) != "echo hi" {
		t.Fatalf("Exec = %q, %v", res.Stdout, err)
	}
	if err := sb.Destroy(ctx, id); err != nil {
		t.Fatal(err)
	}
	if fake.Live() != 0 {
		t.Errorf("live sandboxes = %d, want 0", fake.Live())
	}
	if _, err := sb.Exec(ctx, id, sandbox.Command{Args: []string{"true"}}); err == nil {
		t.Error("Exec on a destroyed sandbox succeeded")
	}
}
