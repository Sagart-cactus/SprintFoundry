package sandbox_test

import (
	"context"
	"encoding/base64"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sagart-cactus/sprintfoundry/internal/sandbox"
	"github.com/sagart-cactus/sprintfoundry/internal/sandbox/sandboxtest"
)

const (
	image  = "registry.example/builder@sha256:" + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	secret = "sk-live-abcdef123456"
)

// layout is a run workspace on disk with a sibling directory the sandbox
// must never see.
type layout struct {
	workspace, src, outside string
}

func newLayout(t *testing.T) layout {
	t.Helper()
	root := t.TempDir()
	l := layout{
		workspace: filepath.Join(root, "runs", "run-1"),
		src:       filepath.Join(root, "runs", "run-1", "src"),
		outside:   filepath.Join(root, "controller-secrets"),
	}
	for _, dir := range []string{l.src, l.outside, filepath.Join(root, "runs", "run-10")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return l
}

func (l layout) guard() sandbox.Guard {
	return sandbox.Guard{
		WorkspaceRoot:       l.workspace,
		AllowedEnv:          []string{"LANG", "HTTPS_PROXY", "EXTRA"},
		AllowedPlaceholders: []string{"ANTHROPIC_AUTH_TOKEN"},
		Secrets:             []string{secret, "ghs_installationtoken"},
	}
}

func (l layout) spec() sandbox.Spec {
	return sandbox.Spec{
		Image:   image,
		Workdir: "/workspace",
		Env:     map[string]string{"LANG": "C.UTF-8", "HTTPS_PROXY": "http://proxy:3128"},
		Mounts:  []sandbox.Mount{{Source: l.src, Target: "/workspace"}},
		Network: sandbox.NetworkProxyOnly,
	}
}

func TestSandboxRefusesSecrets(t *testing.T) {
	l := newLayout(t)
	if _, err := l.spec().Validate(l.guard()); err != nil {
		t.Fatalf("a safe spec was refused: %v", err)
	}

	link := filepath.Join(l.src, "cache")
	if err := os.Symlink(l.outside, link); err != nil {
		t.Skipf("cannot create a symbolic link here: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*sandbox.Spec)
		want   string
	}{
		{"credential value under an allowed name", func(s *sandbox.Spec) { s.Env["EXTRA"] = "Bearer " + secret }, "carries a credential"},
		{"credential in base64", func(s *sandbox.Spec) { s.Env["EXTRA"] = base64.StdEncoding.EncodeToString([]byte(secret)) }, "carries a credential"},
		{"credential in unpadded URL-safe base64", func(s *sandbox.Spec) {
			s.Env["EXTRA"] = "x" + base64.RawURLEncoding.EncodeToString([]byte(secret))
		}, "carries a credential"},
		{"credential URL-encoded", func(s *sandbox.Spec) { s.Env["EXTRA"] = "k=" + url.QueryEscape(secret+"/+") }, "carries a credential"},
		{"credential-looking variable name", func(s *sandbox.Spec) { s.Env["OPENAI_API_KEY"] = "placeholder" }, "looks like a credential"},
		{"token variable name", func(s *sandbox.Spec) { s.Env["GH_TOKEN"] = "x" }, "looks like a credential"},
		{"name that is not on the list", func(s *sandbox.Spec) { s.Env["AWS_ACCESS_KEY_ID"] = "AKIAEXAMPLE" }, "not on this role's list"},
		{"database URL with a password", func(s *sandbox.Spec) { s.Env["DATABASE_URL"] = "postgres://u:p@db/x" }, "not on this role's list"},
		{"agent socket", func(s *sandbox.Spec) { s.Env["SSH_AUTH_SOCK"] = "/run/agent.sock" }, "not on this role's list"},
		{"name with an equals sign", func(s *sandbox.Spec) { s.Env["LANG=x\nEVIL"] = "1" }, "is not valid"},
		{"value with a newline", func(s *sandbox.Spec) { s.Env["EXTRA"] = "a\nb" }, "control character"},
		{"mount of another directory", func(s *sandbox.Spec) { s.Mounts[0].Source = l.outside }, "outside the workspace"},
		{"mount that climbs out of the workspace", func(s *sandbox.Spec) { s.Mounts[0].Source = l.workspace + "/../run-10" }, "outside the workspace"},
		{"mount of a sibling with the same prefix", func(s *sandbox.Spec) { s.Mounts[0].Source = l.workspace + "0" }, "outside the workspace"},
		{"mount through a symbolic link that leaves the workspace", func(s *sandbox.Spec) { s.Mounts[0].Source = link }, "outside the workspace"},
		{"mount source that does not exist", func(s *sandbox.Spec) { s.Mounts[0].Source = l.src + "/missing" }, "does not exist"},
		{"relative mount source", func(s *sandbox.Spec) { s.Mounts[0].Source = "src" }, "outside the workspace"},
		{"mount source with an option", func(s *sandbox.Spec) { s.Mounts[0].Source = l.src + ",source=/" }, "reads as an option"},
		{"mount target with options", func(s *sandbox.Spec) { s.Mounts[0].Target = "/workspace:rw,z" }, "reads as an option"},
		{"relative mount target", func(s *sandbox.Spec) { s.Mounts[0].Target = "workspace" }, "clean absolute path"},
		{"image by tag", func(s *sandbox.Spec) { s.Image = "registry.example/builder:latest" }, "not pinned"},
		{"image that looks like a flag", func(s *sandbox.Spec) { s.Image = "--privileged@sha256:" + strings.Repeat("0", 64) }, "not pinned"},
		{"host network", func(s *sandbox.Spec) { s.Network = "host" }, "not allowed"},
		{"network left empty", func(s *sandbox.Spec) { s.Network = "" }, "not allowed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			spec := l.spec()
			tt.mutate(&spec)
			_, err := spec.Validate(l.guard())
			if !errors.Is(err, sandbox.ErrUnsafeSpec) {
				t.Fatalf("err = %v, want ErrUnsafeSpec", err)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("err = %q, want it to mention %q", err, tt.want)
			}
		})
	}
}

func TestALocalImageIDCountsAsPinned(t *testing.T) {
	l := newLayout(t)
	spec := l.spec()
	spec.Image = strings.Repeat("ab", 32)
	if _, err := spec.Validate(l.guard()); err != nil {
		t.Errorf("an image ID was refused: %v", err)
	}
	for _, bad := range []string{strings.Repeat("ab", 31), "sha256:" + strings.Repeat("ab", 32), strings.Repeat("AB", 32)} {
		spec.Image = bad
		if _, err := spec.Validate(l.guard()); !errors.Is(err, sandbox.ErrUnsafeSpec) {
			t.Errorf("image %q: err = %v", bad, err)
		}
	}
}

func TestGuardCannotBeLeftHalfConfigured(t *testing.T) {
	l := newLayout(t)

	noSecretList := l.guard()
	noSecretList.Secrets = nil
	if _, err := l.spec().Validate(noSecretList); !errors.Is(err, sandbox.ErrUnsafeSpec) {
		t.Errorf("an empty secret list silently disabled the value check: err = %v", err)
	}
	noSecretList.NoSecrets = true
	if _, err := l.spec().Validate(noSecretList); err != nil {
		t.Errorf("a guard that states it has no secrets was refused: %v", err)
	}

	noRoot := l.guard()
	noRoot.WorkspaceRoot = ""
	if _, err := l.spec().Validate(noRoot); !errors.Is(err, sandbox.ErrUnsafeSpec) {
		t.Errorf("no workspace root: err = %v", err)
	}
	missingRoot := l.guard()
	missingRoot.WorkspaceRoot = filepath.Join(l.workspace, "does-not-exist")
	if _, err := l.spec().Validate(missingRoot); !errors.Is(err, sandbox.ErrUnsafeSpec) {
		t.Errorf("a workspace root that does not exist: err = %v", err)
	}
}

func TestPlaceholdersHoldOnlyThePublicConstant(t *testing.T) {
	l := newLayout(t)

	spec := l.spec()
	spec.Placeholders = []string{"ANTHROPIC_AUTH_TOKEN"}
	if _, err := spec.Validate(l.guard()); err != nil {
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

	for name, placeholders := range map[string][]string{
		"a name in both lists":                 {"HTTPS_PROXY"},
		"a placeholder that smuggles a value":  {"X=real-secret"},
		"a placeholder not on the role's list": {"OPENAI_API_KEY"},
	} {
		bad := l.spec()
		bad.Placeholders = placeholders
		if _, err := bad.Validate(l.guard()); !errors.Is(err, sandbox.ErrUnsafeSpec) {
			t.Errorf("%s: err = %v, want ErrUnsafeSpec", name, err)
		}
	}
}

func TestFakeLifecycle(t *testing.T) {
	ctx := context.Background()
	l := newLayout(t)
	fake := &sandboxtest.Fake{Handler: func(_ string, cmd sandbox.Command) (sandbox.Result, error) {
		return sandbox.Result{Stdout: []byte(strings.Join(cmd.Args, " "))}, nil
	}}
	var sb sandbox.Sandbox = fake

	validated, err := l.spec().Validate(l.guard())
	if err != nil {
		t.Fatal(err)
	}
	id, err := sb.Create(ctx, validated)
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
