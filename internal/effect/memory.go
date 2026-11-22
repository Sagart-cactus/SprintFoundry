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

func (m *Memory) Lock(ctx context.Context, key string) (func(), error) {
	for {
		m.mu.Lock()
		held, busy := m.locks[key]
		if !busy {
			mine := make(chan struct{})
			m.locks[key] = mine
			m.mu.Unlock()
			return func() {
				m.mu.Lock()
				delete(m.locks, key)
				m.mu.Unlock()
				close(mine)
			}, nil
		}
		m.mu.Unlock()
		select {
		case <-held:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func (m *Memory) Begin(_ context.Context, key, kind string) (Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec, ok := m.records[key]; ok {
		if rec.Kind != kind {
			return Record{}, fmt.Errorf("effect: key %s already used for kind %s", key, rec.Kind)
		}
		return rec, nil
	}
	rec := Record{Key: key, Kind: kind}
	m.records[key] = rec
	return rec, nil
}

func (m *Memory) Complete(_ context.Context, key string, result []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.records[key]
	if !ok {
		return fmt.Errorf("effect: no intent recorded for %s", key)
	}
	rec.Done, rec.Result = true, append([]byte(nil), result...)
	m.records[key] = rec
	return nil
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
