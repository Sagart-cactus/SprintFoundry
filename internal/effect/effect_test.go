package effect

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

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

var errCrash = errors.New("simulated crash")

func TestEffectNotRepeatedAfterCrash(t *testing.T) {
	ctx, j, r := context.Background(), NewMemory(), newRemote()
	const key = "run-1/open-pull-request"

	crashAfterEffect := Action{Key: key, Kind: "open-pull-request", Find: r.find(key),
		Do: func(context.Context) ([]byte, error) {
			r.create(key)
			return nil, errCrash // the effect happened, the controller died before recording it
		}}
	if _, err := Perform(ctx, j, crashAfterEffect); !errors.Is(err, errCrash) {
		t.Fatalf("first attempt: err = %v, want the simulated crash", err)
	}
	if open, _ := j.Open(ctx); len(open) != 1 {
		t.Fatalf("open intents after crash = %d, want 1", len(open))
	}

	restart := Action{Key: key, Kind: "open-pull-request", Find: r.find(key),
		Do: func(context.Context) ([]byte, error) { return r.create(key), nil }}
	got, err := Perform(ctx, j, restart)
	if err != nil {
		t.Fatalf("after restart: %v", err)
	}
	if string(got) != "object-for-"+key {
		t.Errorf("result = %q", got)
	}
	if r.created != 1 {
		t.Errorf("effect performed %d times, want 1", r.created)
	}
	if open, _ := j.Open(ctx); len(open) != 0 {
		t.Errorf("open intents after recovery = %d, want 0", len(open))
	}
}

func TestEffectPerformedOnceAfterEarlyCrash(t *testing.T) {
	ctx, j, r := context.Background(), NewMemory(), newRemote()
	const key = "run-2/create-branch"

	// The controller recorded the intent and died before touching the remote.
	if _, err := j.Begin(ctx, key, "create-branch"); err != nil {
		t.Fatal(err)
	}

	a := Action{Key: key, Kind: "create-branch", Find: r.find(key),
		Do: func(context.Context) ([]byte, error) { return r.create(key), nil }}
	for i := 0; i < 3; i++ {
		if _, err := Perform(ctx, j, a); err != nil {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	if r.created != 1 {
		t.Errorf("effect performed %d times, want 1", r.created)
	}
}

func TestEffectSingleUnderRace(t *testing.T) {
	ctx, j, r := context.Background(), NewMemory(), newRemote()
	const key = "run-3/dispatch-release"

	a := Action{Key: key, Kind: "dispatch-release", Find: r.find(key),
		Do: func(context.Context) ([]byte, error) {
			time.Sleep(5 * time.Millisecond) // widen the window a race would need
			return r.create(key), nil
		}}

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := Perform(ctx, j, a); err != nil {
				t.Errorf("Perform: %v", err)
			}
		}()
	}
	wg.Wait()
	if r.created != 1 {
		t.Errorf("effect performed %d times under race, want 1", r.created)
	}
}

func TestEffectRequiresReconciler(t *testing.T) {
	ctx, j := context.Background(), NewMemory()
	performed := false
	a := Action{Key: "run-4/comment", Kind: "comment",
		Do: func(context.Context) ([]byte, error) { performed = true; return nil, nil }}

	if _, err := Perform(ctx, j, a); !errors.Is(err, ErrNoReconciler) {
		t.Fatalf("err = %v, want ErrNoReconciler", err)
	}
	if performed {
		t.Error("an effect without a reconciler was performed")
	}
	if open, _ := j.Open(ctx); len(open) != 0 {
		t.Error("an intent was recorded for an action that cannot be reconciled")
	}
}

func TestLockHonoursCancellation(t *testing.T) {
	j := NewMemory()
	unlock, err := j.Lock(context.Background(), "k")
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := j.Lock(ctx, "k"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want deadline exceeded", err)
	}
}
