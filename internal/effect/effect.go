// Package effect performs actions that change something outside the
// controller (create a branch, open a pull request, dispatch a release) so
// that a crash at any point never repeats them.
//
// Every action follows the same four steps: record the intent under a stable
// key, look for the effect at the remote by that key, perform it only if it is
// not there, record the result. No workflow engine removes the need for the
// lookup: a step that crashes after its side effect is run again on recovery.
package effect

import (
	"context"
	"errors"
	"fmt"
)

// ErrNoReconciler is returned when an action has no remote lookup.
var ErrNoReconciler = errors.New("effect: action has no Find function")

// Record is the journal's view of one action.
type Record struct {
	Key    string
	Kind   string
	Done   bool
	Result []byte
}

// Journal stores intent and result records. Implementations must make Lock
// exclusive across every controller that shares the journal.
type Journal interface {
	// Lock blocks until the caller holds the key. The returned function
	// releases it.
	Lock(ctx context.Context, key string) (unlock func(), err error)
	// Begin records the intent for key if there is none, and returns the
	// stored record either way.
	Begin(ctx context.Context, key, kind string) (Record, error)
	// Complete stores the result and marks the record done.
	Complete(ctx context.Context, key string, result []byte) error
	// Open lists records that have an intent and no result.
	Open(ctx context.Context) ([]Record, error)
}

// Action is one external effect.
type Action struct {
	// Key is stable for the run and the action, for example
	// "run-42/open-pull-request". The remote must be searchable by it.
	Key string
	// Kind names the action type for the journal and the run page.
	Kind string
	// Find looks for the effect at the remote. It is required.
	Find func(ctx context.Context) (result []byte, found bool, err error)
	// Do performs the effect and returns what Find would return afterwards.
	Do func(ctx context.Context) (result []byte, err error)
}

// Perform runs the action at most once across crashes and across controllers
// that share the journal, and returns its result.
func Perform(ctx context.Context, j Journal, a Action) ([]byte, error) {
	if a.Key == "" || a.Kind == "" {
		return nil, errors.New("effect: key and kind are required")
	}
	if a.Find == nil {
		return nil, ErrNoReconciler
	}
	if a.Do == nil {
		return nil, errors.New("effect: action has no Do function")
	}

	unlock, err := j.Lock(ctx, a.Key)
	if err != nil {
		return nil, fmt.Errorf("effect: lock %s: %w", a.Key, err)
	}
	defer unlock()

	rec, err := j.Begin(ctx, a.Key, a.Kind)
	if err != nil {
		return nil, fmt.Errorf("effect: record intent %s: %w", a.Key, err)
	}
	if rec.Done {
		return rec.Result, nil
	}

	result, found, err := a.Find(ctx)
	if err != nil {
		return nil, fmt.Errorf("effect: look up %s: %w", a.Key, err)
	}
	if !found {
		if result, err = a.Do(ctx); err != nil {
			return nil, fmt.Errorf("effect: perform %s: %w", a.Key, err)
		}
	}
	if err := j.Complete(ctx, a.Key, result); err != nil {
		return nil, fmt.Errorf("effect: record result %s: %w", a.Key, err)
	}
	return result, nil
}
