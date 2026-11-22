// Package sandbox defines where untrusted work runs: the builder's coding
// agent and the check runner. A backend (local containers first, Agent
// Substrate later) implements Sandbox. The controller validates every Spec
// before a backend sees it.
package sandbox

import (
	"context"
	"errors"
	"fmt"
	"io"
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
	Mounts  []Mount
	Network Network
	Limits  Limits
}

// Guard is what the controller knows that a Spec must not contain.
type Guard struct {
	// WorkspaceRoot is the only host directory a sandbox may mount from.
	WorkspaceRoot string
	// Secrets are credential values the controller holds. None may appear in
	// a sandbox environment.
	Secrets []string
}

// ErrUnsafeSpec is returned by Validate. Callers match it with errors.Is.
var ErrUnsafeSpec = errors.New("sandbox: unsafe spec")

var (
	pinned      = regexp.MustCompile(`^[^@\s]+@sha256:[0-9a-f]{64}$`)
	secretNames = regexp.MustCompile(`(?i)(token|secret|passw(or)?d|api[_-]?key|credential|private[_-]?key)`)
)

// Validate refuses a Spec that could hand a credential to untrusted code or
// reach outside the run's workspace.
func (s Spec) Validate(g Guard) error {
	if !pinned.MatchString(s.Image) {
		return fmt.Errorf("%w: image %q is not pinned by digest", ErrUnsafeSpec, s.Image)
	}
	if s.Network != NetworkNone && s.Network != NetworkProxyOnly {
		return fmt.Errorf("%w: network %q is not allowed", ErrUnsafeSpec, s.Network)
	}
	if g.WorkspaceRoot == "" {
		return fmt.Errorf("%w: no workspace root configured", ErrUnsafeSpec)
	}
	root := filepath.Clean(g.WorkspaceRoot)
	for _, m := range s.Mounts {
		src := filepath.Clean(m.Source)
		if !filepath.IsAbs(src) || (src != root && !strings.HasPrefix(src, root+string(filepath.Separator))) {
			return fmt.Errorf("%w: mount source %q is outside the workspace", ErrUnsafeSpec, m.Source)
		}
	}
	for name, value := range s.Env {
		if secretNames.MatchString(name) {
			return fmt.Errorf("%w: environment variable %q looks like a credential", ErrUnsafeSpec, name)
		}
		for _, secret := range g.Secrets {
			if secret != "" && strings.Contains(value, secret) {
				return fmt.Errorf("%w: environment variable %q carries a credential", ErrUnsafeSpec, name)
			}
		}
	}
	return nil
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
	// Create starts a sandbox and returns its ID. Callers validate the Spec
	// first; backends may validate again.
	Create(ctx context.Context, spec Spec) (id string, err error)
	// Exec runs a command to completion.
	Exec(ctx context.Context, id string, cmd Command) (Result, error)
	// CopyIn unpacks a tar stream at dst inside the sandbox.
	CopyIn(ctx context.Context, id, dst string, tar io.Reader) error
	// CopyOut returns a tar stream of src from inside the sandbox.
	CopyOut(ctx context.Context, id, src string) (io.ReadCloser, error)
	// Destroy removes the sandbox and everything in it.
	Destroy(ctx context.Context, id string) error
}
