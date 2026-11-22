// Package effecttest holds the tests every effect.Journal must pass. The
// in-memory journal and the Postgres journal both run them.
package effecttest

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/effect"
)

// Factory returns a journal on fresh storage and a function that opens a
// second handle on the same storage, as a restarted or second controller
// would.
type Factory func(t *testing.T) (j effect.Journal, reopen func() effect.Journal)

// remote stands in for a service such as a Git forge. It counts how many
// times an effect was actually performed.
type remote struct {
	mu      sync.Mutex
	objects map[string][]byte
	created int
}

func newRemote() *remote { return &remote{objects: map[string][]byte{}} }

func (r *remote) find(key string) func(context.Context) ([]byte, bool, error) {
	return func(context.Context) ([]byte, bool, error) {
		r.mu.Lock()
		defer r.mu.Unlock()
		v, ok := r.objects[key]
		return v, ok, nil
	}
}

func (r *remote) create(key string) []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.created++
	r.objects[key] = []byte("object-for-" + key)
	return r.objects[key]
}

func (r *remote) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.created
}

var errCrash = errors.New("simulated crash")

// Run runs the conformance tests against journals made by newJournal.
func Run(t *testing.T, newJournal Factory) {
	t.Run("EffectNotRepeatedAfterCrash", func(t *testing.T) {
		ctx, r := context.Background(), newRemote()
		j, reopen := newJournal(t)
		const key = "run-1/open-pull-request"

		crashAfterEffect := effect.Action{Key: key, Kind: "open-pull-request", Find: r.find(key),
			Do: func(context.Context) ([]byte, error) {
				r.create(key)
				return nil, errCrash // the effect happened, the controller died before recording it
			}}
		if _, err := effect.Perform(ctx, j, crashAfterEffect); !errors.Is(err, errCrash) {
			t.Fatalf("first attempt: err = %v, want the simulated crash", err)
		}

		restarted := reopen()
		open, err := restarted.Open(ctx)
		if err != nil || len(open) != 1 || open[0].Key != key {
			t.Fatalf("open intents after crash = %v, %v; want the one key", open, err)
		}
		retry := effect.Action{Key: key, Kind: "open-pull-request", Find: r.find(key),
			Do: func(context.Context) ([]byte, error) { return r.create(key), nil }}
		got, err := effect.Perform(ctx, restarted, retry)
		if err != nil {
			t.Fatalf("after restart: %v", err)
		}
		if string(got) != "object-for-"+key {
			t.Errorf("result = %q", got)
		}
		if r.count() != 1 {
			t.Errorf("effect performed %d times, want 1", r.count())
		}
		if open, _ := restarted.Open(ctx); len(open) != 0 {
			t.Errorf("open intents after recovery = %d, want 0", len(open))
		}

		// A later call returns the recorded result without touching the remote.
		again, err := effect.Perform(ctx, reopen(), effect.Action{Key: key, Kind: "open-pull-request",
			Find: func(context.Context) ([]byte, bool, error) { return nil, false, errors.New("remote must not be asked") },
			Do:   func(context.Context) ([]byte, error) { return nil, errors.New("effect must not run") }})
		if err != nil || string(again) != "object-for-"+key {
			t.Errorf("recorded result = %q, %v", again, err)
		}
	})

	t.Run("EffectPerformedOnceAfterEarlyCrash", func(t *testing.T) {
		ctx, r := context.Background(), newRemote()
		j, reopen := newJournal(t)
		const key = "run-2/create-branch"

		// The controller recorded the intent and died before touching the remote.
		first, err := j.Acquire(ctx, key)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := first.Begin(ctx, "create-branch"); err != nil {
			t.Fatal(err)
		}
		first.Release()
		a := effect.Action{Key: key, Kind: "create-branch", Find: r.find(key),
			Do: func(context.Context) ([]byte, error) { return r.create(key), nil }}
		for i := 0; i < 3; i++ {
			if _, err := effect.Perform(ctx, reopen(), a); err != nil {
				t.Fatalf("attempt %d: %v", i, err)
			}
		}
		if r.count() != 1 {
			t.Errorf("effect performed %d times, want 1", r.count())
		}
	})

	t.Run("EffectSingleUnderRace", func(t *testing.T) {
		ctx, r := context.Background(), newRemote()
		j, reopen := newJournal(t)
		controllers := []effect.Journal{j, reopen(), reopen()}
		const key = "run-3/dispatch-release"

		a := effect.Action{Key: key, Kind: "dispatch-release", Find: r.find(key),
			Do: func(context.Context) ([]byte, error) {
				time.Sleep(10 * time.Millisecond) // widen the window a race would need
				return r.create(key), nil
			}}
		var wg sync.WaitGroup
		for i := 0; i < 12; i++ {
			wg.Add(1)
			go func(c effect.Journal) {
				defer wg.Done()
				if _, err := effect.Perform(ctx, c, a); err != nil {
					t.Errorf("Perform: %v", err)
				}
			}(controllers[i%len(controllers)])
		}
		wg.Wait()
		if r.count() != 1 {
			t.Errorf("effect performed %d times under race, want 1", r.count())
		}
	})

	t.Run("EffectRequiresReconciler", func(t *testing.T) {
		ctx := context.Background()
		j, _ := newJournal(t)
		performed := false
		a := effect.Action{Key: "run-4/comment", Kind: "comment",
			Do: func(context.Context) ([]byte, error) { performed = true; return nil, nil }}

		if _, err := effect.Perform(ctx, j, a); !errors.Is(err, effect.ErrNoReconciler) {
			t.Fatalf("err = %v, want ErrNoReconciler", err)
		}
		if performed {
			t.Error("an effect without a reconciler was performed")
		}
		if open, _ := j.Open(ctx); len(open) != 0 {
			t.Error("an intent was recorded for an action that cannot be reconciled")
		}
	})

	t.Run("KeyCannotChangeKind", func(t *testing.T) {
		ctx := context.Background()
		j, _ := newJournal(t)
		h, err := j.Acquire(ctx, "run-5/x")
		if err != nil {
			t.Fatal(err)
		}
		defer h.Release()
		if _, err := h.Begin(ctx, "comment"); err != nil {
			t.Fatal(err)
		}
		if _, err := h.Begin(ctx, "dispatch-release"); err == nil {
			t.Error("the same key was accepted for a different kind of action")
		}

		other, err := j.Acquire(ctx, "run-5/never-begun")
		if err != nil {
			t.Fatal(err)
		}
		defer other.Release()
		if err := other.Complete(ctx, nil); err == nil {
			t.Error("a result was recorded for a key with no intent")
		}
	})

	t.Run("RecordedResultIsNeverOverwritten", func(t *testing.T) {
		ctx, r := context.Background(), newRemote()
		j, reopen := newJournal(t)
		const key = "run-8/open-pull-request"
		a := effect.Action{Key: key, Kind: "open-pull-request", Find: r.find(key),
			Do: func(context.Context) ([]byte, error) { return r.create(key), nil }}
		if _, err := effect.Perform(ctx, j, a); err != nil {
			t.Fatal(err)
		}

		h, err := reopen().Acquire(ctx, key)
		if err != nil {
			t.Fatal(err)
		}
		if err := h.Complete(ctx, []byte("a different result")); !errors.Is(err, effect.ErrAlreadyDone) {
			t.Errorf("second Complete: err = %v, want ErrAlreadyDone", err)
		}
		rec, err := h.Begin(ctx, "open-pull-request")
		h.Release()
		if err != nil || string(rec.Result) != "object-for-"+key {
			t.Errorf("recorded result = %q, %v; want the first one", rec.Result, err)
		}
	})

	t.Run("HoldIsExclusiveAndReleaseIsIdempotent", func(t *testing.T) {
		j, reopen := newJournal(t)
		const key = "run-6/k"
		first, err := j.Acquire(context.Background(), key)
		if err != nil {
			t.Fatal(err)
		}

		short, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		if _, err := reopen().Acquire(short, key); err == nil {
			t.Fatal("a second controller took a hold that was taken")
		}
		cancel()

		first.Release()
		second, err := reopen().Acquire(context.Background(), key)
		if err != nil {
			t.Fatalf("hold was not free after release: %v", err)
		}
		defer second.Release()

		// Releasing the first hold again must not free the second one.
		first.Release()
		if err := second.Alive(context.Background()); err != nil {
			t.Fatalf("a repeated release took the next holder's hold away: %v", err)
		}
		short, cancel = context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		if _, err := j.Acquire(short, key); err == nil {
			t.Fatal("the key was free while the second holder still held it")
		}
	})
}
