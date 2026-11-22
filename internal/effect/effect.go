// Package effect performs actions that change something outside the
// controller (create a branch, open a pull request, dispatch a release) so
// that a crash at any point does not repeat them.
//
// Every action follows the same steps: take an exclusive hold on a stable
// key, record the intent, look for the effect at the remote by that key,
// perform it only if it is not there, record the result. No workflow engine
// removes the need for the lookup: a step that crashes after its side effect
// is run again on recovery.
//
// One window cannot be closed from here. If the hold is lost while the effect
// is being performed (the database session dies), another controller may act
// too. Perform detects the loss and returns an error instead of a result, but
// the remote call itself must therefore be safe to repeat for the same key:
// name branches after the key, put the key in a marker, use the remote's own
// idempotency where it has one.
package effect

import (
	"context"
	"errors"
	"fmt"
)

// Errors returned by this package. Callers match them with errors.Is.
var (
	// ErrNoReconciler is returned when an action has no remote lookup.
	ErrNoReconciler = errors.New("effect: action has no Find function")
	// ErrHoldLost is returned when the exclusive hold on a key was lost
	// before the result could be recorded.
	ErrHoldLost = errors.New("effect: the hold on the key was lost")
	// ErrAlreadyDone is returned by Complete for a record that already has a
	// result.
	ErrAlreadyDone = errors.New("effect: the action already has a recorded result")
)

// Record is the journal's view of one action.
type Record struct {
	Key    string
	Kind   string
	Done   bool
	Result []byte
}

// Journal stores intent and result records.
type Journal interface {
	// Acquire blocks until the caller holds key exclusively, across every
	// controller that shares the journal.
	Acquire(ctx context.Context, key string) (Held, error)
	// Open lists records that have an intent and no result.
	Open(ctx context.Context) ([]Record, error)
}

// Held is an exclusive hold on one key. Every method fails with ErrHoldLost
// once the hold is gone, so a holder cannot record anything after losing it.
type Held interface {
	// Begin records the intent if there is none and returns the stored
	// record either way.
	Begin(ctx context.Context, kind string) (Record, error)
	// Alive reports whether the hold is still in place.
	Alive(ctx context.Context) error
	// Complete stores the result and marks the record done. It never
	// overwrites a recorded result.
	Complete(ctx context.Context, result []byte) error
	// Release gives the hold up. It is safe to call more than once.
	Release()
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

// Perform runs the action and returns its result. Across crashes and across
// controllers that share the journal it performs the effect once, as long as
// the hold is not lost while Do runs.
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

	held, err := j.Acquire(ctx, a.Key)
	if err != nil {
		return nil, fmt.Errorf("effect: hold %s: %w", a.Key, err)
	}
	defer held.Release()

	rec, err := held.Begin(ctx, a.Kind)
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
		// The lookup may have taken a while. Do not act on a hold that is gone.
		if err := held.Alive(ctx); err != nil {
			return nil, fmt.Errorf("effect: before performing %s: %w", a.Key, err)
		}
		if result, err = a.Do(ctx); err != nil {
			return nil, fmt.Errorf("effect: perform %s: %w", a.Key, err)
		}
	}
	if err := held.Complete(ctx, result); err != nil {
		return nil, fmt.Errorf("effect: record result %s: %w", a.Key, err)
	}
	return result, nil
}
