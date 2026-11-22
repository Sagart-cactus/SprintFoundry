// Package sandbox defines where untrusted work runs: the builder's coding
// agent and the check runner. A backend (local containers first, Agent
// Substrate later) implements Sandbox. The controller validates every Spec
// before a backend sees it.
package sandbox

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Network is what a sandbox may reach.
type Network string

const (
	// NetworkNone gives the sandbox no network at all.
	NetworkNone Network = "none"
	// NetworkProxyOnly puts the sandbox on an internal network whose only
	// peer is the controller's allowlist proxy.
	NetworkProxyOnly Network = "proxy-only"
)

// Mount makes a host directory visible inside the sandbox.
type Mount struct {
	Source   string // host path, must lie inside the run's workspace
	Target   string // path inside the sandbox
	ReadOnly bool
}

// Limits bound what a sandbox can consume.
type Limits struct {
	CPUs     float64
	MemoryMB int
	PIDs     int
	Timeout  time.Duration
}

// Spec describes one sandbox.
type Spec struct {
	Image   string // must be pinned by digest: name@sha256:...
	Workdir string
	Env     map[string]string
	// Placeholders names credential variables an agent refuses to start
	// without. Each is set to PlaceholderValue, never to a real credential:
	// the proxy replaces the header the agent builds from it.
	Placeholders []string
	Mounts       []Mount
	Network      Network
	Limits       Limits
}

// PlaceholderValue is the public constant every placeholder variable holds.
const PlaceholderValue = "placeholder-not-a-key"

// EffectiveEnv returns the environment a backend gives the sandbox: Env plus
// every placeholder name set to PlaceholderValue.
func (s Spec) EffectiveEnv() map[string]string {
	env := make(map[string]string, len(s.Env)+len(s.Placeholders))
	for name, value := range s.Env {
		env[name] = value
	}
	for _, name := range s.Placeholders {
		env[name] = PlaceholderValue
	}
	return env
}

// Guard is what the controller knows about a sandbox role: what it may
// receive and what it must never contain.
type Guard struct {
	// WorkspaceRoot is the only host directory a sandbox may mount from. It
	// must exist.
	WorkspaceRoot string
	// AllowedEnv lists the environment variable names this role may receive.
	// Anything else is refused, whatever its value.
	AllowedEnv []string
	// AllowedPlaceholders lists the credential variable names this role may
	// receive as placeholders.
	AllowedPlaceholders []string
	// Secrets are credential values the controller holds. None may appear in
	// a sandbox environment, raw or in a common encoding.
	Secrets []string
	// NoSecrets states that the controller holds no credentials at all, as
	// in a replay run. Without it an empty Secrets list is an error, so the
	// value check cannot be switched off by forgetting to fill the list.
	NoSecrets bool
}

// ErrUnsafeSpec is returned by Validate. Callers match it with errors.Is.
var ErrUnsafeSpec = errors.New("sandbox: unsafe spec")

var (
	pinned      = regexp.MustCompile(`^[a-zA-Z0-9][^@\s]*@sha256:[0-9a-f]{64}$`)
	secretNames = regexp.MustCompile(`(?i)(token|secret|passw(or)?d|api[_-]?key|credential|private[_-]?key)`)
	envName     = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
)

// Validated is a Spec that passed Validate. Backends accept only this type,
// so an unchecked Spec cannot reach a container runtime.
type Validated struct {
	spec Spec
}

// Spec returns the checked spec.
func (v Validated) Spec() Spec { return v.spec }

// Validate refuses a Spec that could hand a credential to untrusted code or
// reach outside the run's workspace.
func (s Spec) Validate(g Guard) (Validated, error) {
	fail := func(format string, args ...any) (Validated, error) {
		return Validated{}, fmt.Errorf("%w: "+format, append([]any{ErrUnsafeSpec}, args...)...)
	}
	if !pinned.MatchString(s.Image) {
		return fail("image %q is not pinned by digest", s.Image)
	}
	if s.Network != NetworkNone && s.Network != NetworkProxyOnly {
		return fail("network %q is not allowed", s.Network)
	}
	if len(g.Secrets) == 0 && !g.NoSecrets {
		return fail("the guard lists no secrets and does not state that there are none")
	}
	if g.WorkspaceRoot == "" {
		return fail("no workspace root configured")
	}
	// The builder can write inside its workspace, so a path there may be a
	// symbolic link that points outside. Compare real paths.
	root, err := filepath.EvalSymlinks(g.WorkspaceRoot)
	if err != nil {
		return fail("workspace root %q cannot be resolved", g.WorkspaceRoot)
	}
	for _, m := range s.Mounts {
		if strings.ContainsAny(m.Source, ":,") || strings.ContainsAny(m.Target, ":,") {
			return fail("mount %q -> %q contains a character that a runtime reads as an option", m.Source, m.Target)
		}
		if !filepath.IsAbs(m.Target) || filepath.Clean(m.Target) != m.Target {
			return fail("mount target %q must be a clean absolute path", m.Target)
		}
		if !filepath.IsAbs(m.Source) {
			return fail("mount source %q is outside the workspace", m.Source)
		}
		src, err := filepath.EvalSymlinks(m.Source)
		if err != nil {
			return fail("mount source %q is outside the workspace or does not exist", m.Source)
		}
		if src != root && !strings.HasPrefix(src, root+string(filepath.Separator)) {
			return fail("mount source %q is outside the workspace", m.Source)
		}
	}
	allowed := map[string]bool{}
	for _, name := range g.AllowedEnv {
		allowed[name] = true
	}
	for name, value := range s.Env {
		if !envName.MatchString(name) {
			return fail("environment variable name %q is not valid", name)
		}
		if secretNames.MatchString(name) {
			return fail("environment variable %q looks like a credential", name)
		}
		if !allowed[name] {
			return fail("environment variable %q is not on this role's list", name)
		}
		if strings.ContainsAny(value, "\x00\r\n") {
			return fail("environment variable %q holds a control character", name)
		}
		for _, secret := range g.Secrets {
			if secret != "" && carries(value, secret) {
				return fail("environment variable %q carries a credential", name)
			}
		}
	}
	placeholders := map[string]bool{}
	for _, name := range g.AllowedPlaceholders {
		placeholders[name] = true
	}
	for _, name := range s.Placeholders {
		if !envName.MatchString(name) {
			return fail("placeholder %q is not a variable name", name)
		}
		if !placeholders[name] {
			return fail("placeholder %q is not on this role's list", name)
		}
		if _, clash := s.Env[name]; clash {
			return fail("%q is both a placeholder and an environment variable", name)
		}
	}
	return Validated{spec: s}, nil
}

// carries reports whether value contains secret, as it is or in base64 or
// URL encoding. A secret split across several variables is not detected; the
// name list is the defence there.
func carries(value, secret string) bool {
	forms := []string{
		secret,
		base64.StdEncoding.EncodeToString([]byte(secret)),
		base64.RawStdEncoding.EncodeToString([]byte(secret)),
		base64.URLEncoding.EncodeToString([]byte(secret)),
		base64.RawURLEncoding.EncodeToString([]byte(secret)),
		url.QueryEscape(secret),
		url.PathEscape(secret),
	}
	for _, form := range forms {
		if strings.Contains(value, form) {
			return true
		}
	}
	return false
}

// Command is one process to run inside a sandbox.
type Command struct {
	Args  []string
	Stdin io.Reader
}

// Result is what a finished command produced.
type Result struct {
	ExitCode int
	Stdout   []byte
	Stderr   []byte
}

// Sandbox is a backend that runs untrusted work.
type Sandbox interface {
	// Create starts a sandbox and returns its ID. It accepts only a spec that
	// passed Validate. A backend resolves mount sources again when it mounts
	// them, because the workspace can change after validation.
	Create(ctx context.Context, spec Validated) (id string, err error)
	// Exec runs a command to completion.
	Exec(ctx context.Context, id string, cmd Command) (Result, error)
	// CopyIn unpacks a tar stream at dst inside the sandbox.
	CopyIn(ctx context.Context, id, dst string, tar io.Reader) error
	// CopyOut returns a tar stream of src from inside the sandbox.
	CopyOut(ctx context.Context, id, src string) (io.ReadCloser, error)
	// Destroy removes the sandbox and everything in it.
	Destroy(ctx context.Context, id string) error
}
