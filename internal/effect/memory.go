package effect

import (
	"context"
	"fmt"
	"sort"
	"sync"
)

// Memory is an in-process Journal for tests and for the fakes other packages
// build on. It keeps nothing across restarts unless the same value is reused.
type Memory struct {
	mu      sync.Mutex
	records map[string]Record
	locks   map[string]chan struct{}
}

// NewMemory returns an empty journal.
func NewMemory() *Memory {
	return &Memory{records: map[string]Record{}, locks: map[string]chan struct{}{}}
}

var _ Journal = (*Memory)(nil)

func (m *Memory) Acquire(ctx context.Context, key string) (Held, error) {
	for {
		m.mu.Lock()
		held, busy := m.locks[key]
		if !busy {
			mine := make(chan struct{})
			m.locks[key] = mine
			m.mu.Unlock()
			return &memoryHeld{m: m, key: key, token: mine}, nil
		}
		m.mu.Unlock()
		select {
		case <-held:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func (m *Memory) Open(_ context.Context) ([]Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var open []Record
	for _, rec := range m.records {
		if !rec.Done {
			open = append(open, rec)
		}
	}
	sort.Slice(open, func(i, j int) bool { return open[i].Key < open[j].Key })
	return open, nil
}

type memoryHeld struct {
	m       *Memory
	key     string
	token   chan struct{}
	release sync.Once
}

// holding reports whether this value still owns the key. The caller holds
// m.mu.
func (h *memoryHeld) holding() bool { return h.m.locks[h.key] == h.token }

func (h *memoryHeld) Alive(context.Context) error {
	h.m.mu.Lock()
	defer h.m.mu.Unlock()
	if !h.holding() {
		return ErrHoldLost
	}
	return nil
}

func (h *memoryHeld) Begin(_ context.Context, kind string) (Record, error) {
	h.m.mu.Lock()
	defer h.m.mu.Unlock()
	if !h.holding() {
		return Record{}, ErrHoldLost
	}
	if rec, ok := h.m.records[h.key]; ok {
		if rec.Kind != kind {
			return Record{}, fmt.Errorf("effect: key %s already used for kind %s", h.key, rec.Kind)
		}
		return rec, nil
	}
	rec := Record{Key: h.key, Kind: kind}
	h.m.records[h.key] = rec
	return rec, nil
}

func (h *memoryHeld) Complete(_ context.Context, result []byte) error {
	h.m.mu.Lock()
	defer h.m.mu.Unlock()
	if !h.holding() {
		return ErrHoldLost
	}
	rec, ok := h.m.records[h.key]
	if !ok {
		return fmt.Errorf("effect: no intent recorded for %s", h.key)
	}
	if rec.Done {
		return ErrAlreadyDone
	}
	rec.Done, rec.Result = true, append([]byte(nil), result...)
	h.m.records[h.key] = rec
	return nil
}

func (h *memoryHeld) Release() {
	h.release.Do(func() {
		h.m.mu.Lock()
		if h.holding() {
			delete(h.m.locks, h.key)
		}
		h.m.mu.Unlock()
		close(h.token)
	})
}
