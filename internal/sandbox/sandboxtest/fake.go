// Package sandboxtest provides an in-memory sandbox for tests.
package sandboxtest

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"sync"

	"github.com/sagart-cactus/sprintfoundry/internal/sandbox"
)

// Fake records what was asked of it and answers Exec with Handler.
type Fake struct {
	// Handler answers Exec. A nil Handler returns exit code 0.
	Handler func(id string, cmd sandbox.Command) (sandbox.Result, error)

	mu      sync.Mutex
	next    int
	live    map[string]sandbox.Spec
	Created []sandbox.Spec
	Execs   [][]string
}

var _ sandbox.Sandbox = (*Fake)(nil)

func (f *Fake) Create(_ context.Context, spec sandbox.Spec) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.live == nil {
		f.live = map[string]sandbox.Spec{}
	}
	f.next++
	id := fmt.Sprintf("fake-%d", f.next)
	f.live[id] = spec
	f.Created = append(f.Created, spec)
	return id, nil
}

func (f *Fake) Exec(_ context.Context, id string, cmd sandbox.Command) (sandbox.Result, error) {
	f.mu.Lock()
	_, ok := f.live[id]
	f.Execs = append(f.Execs, cmd.Args)
	handler := f.Handler
	f.mu.Unlock()
	if !ok {
		return sandbox.Result{}, fmt.Errorf("sandboxtest: no sandbox %s", id)
	}
	if handler == nil {
		return sandbox.Result{}, nil
	}
	return handler(id, cmd)
}

func (f *Fake) CopyIn(_ context.Context, id, _ string, tar io.Reader) error {
	if !f.alive(id) {
		return fmt.Errorf("sandboxtest: no sandbox %s", id)
	}
	_, err := io.Copy(io.Discard, tar)
	return err
}

func (f *Fake) CopyOut(_ context.Context, id, _ string) (io.ReadCloser, error) {
	if !f.alive(id) {
		return nil, fmt.Errorf("sandboxtest: no sandbox %s", id)
	}
	return io.NopCloser(bytes.NewReader(nil)), nil
}

func (f *Fake) Destroy(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.live, id)
	return nil
}

// Live reports how many sandboxes have been created and not destroyed.
func (f *Fake) Live() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.live)
}

func (f *Fake) alive(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.live[id]
	return ok
}
