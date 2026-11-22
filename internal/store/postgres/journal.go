// Package postgres keeps the controller's state in Postgres tables it owns.
// See docs/design/0005-state-in-plain-postgres.md.
package postgres

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/sagart-cactus/sprintfoundry/internal/effect"
)

//go:embed schema.sql
var schema string

// migrationLock serialises schema changes across controllers that start at
// the same time. The number is arbitrary and fixed.
const migrationLock int64 = 0x5f5f_7366_0001

// Store is a connection pool on a database that holds the SprintFoundry
// schema.
type Store struct {
	// pool serves reads and writes.
	pool *pgxpool.Pool
	// locks serves advisory locks only. A session that waits for or holds a
	// lock keeps its connection, so sharing one pool would let waiters starve
	// the lock holder of the connection it needs to do its work.
	locks *pgxpool.Pool
}

// Open connects to the database and creates or updates the schema.
func Open(ctx context.Context, url string) (*Store, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("postgres: connect: %w", err)
	}
	locks, err := pgxpool.New(ctx, url)
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("postgres: connect lock pool: %w", err)
	}
	s := &Store{pool: pool, locks: locks}
	if err := s.migrate(ctx); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

// Close releases both pools. It waits for locks still held by this process
// to be released first.
func (s *Store) Close() {
	s.locks.Close()
	s.pool.Close()
}

func (s *Store) migrate(ctx context.Context) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", migrationLock); err != nil {
			return fmt.Errorf("postgres: migration lock: %w", err)
		}
		if _, err := tx.Exec(ctx, schema); err != nil {
			return fmt.Errorf("postgres: apply schema: %w", err)
		}
		return nil
	})
}

var _ effect.Journal = (*Store)(nil)

// lockHeld is true when the current session holds the advisory lock for $1.
// A 64-bit advisory lock shows in pg_locks as two 32-bit halves.
const lockHeld = `EXISTS (
	SELECT 1 FROM pg_locks
	WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid() AND objsubid = 1
	  AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0))`

// Acquire takes a session-level advisory lock on a dedicated connection, so
// the hold is exclusive across every controller that shares the database and
// Postgres releases it if this controller dies. Every later write for the
// key runs on that same connection: if the session is gone, the write fails.
func (s *Store) Acquire(ctx context.Context, key string) (effect.Held, error) {
	conn, err := s.locks.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("postgres: acquire connection for lock: %w", err)
	}
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock(hashtextextended($1, 0))", key); err != nil {
		// The session may still hold or be waiting for the lock. Drop the
		// connection instead of returning it to the pool.
		discard(conn)
		return nil, fmt.Errorf("postgres: lock %s: %w", key, err)
	}
	return &held{conn: conn, key: key}, nil
}

func discard(conn *pgxpool.Conn) {
	raw := conn.Hijack()
	_ = raw.Close(context.Background())
}

type held struct {
	conn    *pgxpool.Conn
	key     string
	release sync.Once
}

func (h *held) Alive(ctx context.Context) error {
	var ok bool
	if err := h.conn.QueryRow(ctx, "SELECT "+lockHeld, h.key).Scan(&ok); err != nil {
		return fmt.Errorf("%w: %v", effect.ErrHoldLost, err)
	}
	if !ok {
		return effect.ErrHoldLost
	}
	return nil
}

func (h *held) Begin(ctx context.Context, kind string) (effect.Record, error) {
	if err := h.Alive(ctx); err != nil {
		return effect.Record{}, err
	}
	if _, err := h.conn.Exec(ctx,
		`INSERT INTO sf_effects (key, kind) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, h.key, kind); err != nil {
		return effect.Record{}, fmt.Errorf("postgres: record intent: %w", err)
	}
	rec := effect.Record{Key: h.key}
	err := h.conn.QueryRow(ctx, `SELECT kind, done, result FROM sf_effects WHERE key = $1`, h.key).
		Scan(&rec.Kind, &rec.Done, &rec.Result)
	if err != nil {
		return effect.Record{}, fmt.Errorf("postgres: read intent: %w", err)
	}
	if rec.Kind != kind {
		return effect.Record{}, fmt.Errorf("postgres: key %s already used for kind %s", h.key, rec.Kind)
	}
	return rec, nil
}

func (h *held) Complete(ctx context.Context, result []byte) error {
	// One statement: the result is stored only if this session still holds
	// the lock and the record has no result yet.
	tag, err := h.conn.Exec(ctx,
		`UPDATE sf_effects SET done = true, result = $2, completed_at = now()
		 WHERE key = $1 AND NOT done AND `+lockHeld, h.key, result)
	if err != nil {
		return fmt.Errorf("%w: %v", effect.ErrHoldLost, err)
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	if err := h.Alive(ctx); err != nil {
		return err
	}
	var done bool
	err = h.conn.QueryRow(ctx, `SELECT done FROM sf_effects WHERE key = $1`, h.key).Scan(&done)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return errors.New("postgres: no intent recorded for " + h.key)
	case err != nil:
		return fmt.Errorf("postgres: read record: %w", err)
	case done:
		return effect.ErrAlreadyDone
	}
	return effect.ErrHoldLost
}

func (h *held) Release() {
	h.release.Do(func() {
		_, err := h.conn.Exec(context.Background(), "SELECT pg_advisory_unlock(hashtextextended($1, 0))", h.key)
		if err != nil {
			discard(h.conn)
			return
		}
		h.conn.Release()
	})
}

func (s *Store) Open(ctx context.Context) ([]effect.Record, error) {
	rows, err := s.pool.Query(ctx, `SELECT key, kind FROM sf_effects WHERE NOT done ORDER BY key`)
	if err != nil {
		return nil, fmt.Errorf("postgres: list open intents: %w", err)
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (effect.Record, error) {
		var rec effect.Record
		err := row.Scan(&rec.Key, &rec.Kind)
		return rec, err
	})
}
