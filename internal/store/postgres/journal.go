// Package postgres keeps the controller's state in Postgres tables it owns.
// See docs/design/0005-state-in-plain-postgres.md.
package postgres

import (
	"context"
	_ "embed"
	"errors"
	"fmt"

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

// Lock takes a session-level advisory lock on a dedicated connection, so it
// is exclusive across every controller that shares the database and is
// released by Postgres if this controller dies.
func (s *Store) Lock(ctx context.Context, key string) (func(), error) {
	conn, err := s.locks.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("postgres: acquire connection for lock: %w", err)
	}
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock(hashtextextended($1, 0))", key); err != nil {
		// The session may still hold or be waiting for the lock. Drop the
		// connection instead of returning it to the pool.
		raw := conn.Hijack()
		_ = raw.Close(context.Background())
		return nil, fmt.Errorf("postgres: lock %s: %w", key, err)
	}
	return func() {
		_, err := conn.Exec(context.Background(), "SELECT pg_advisory_unlock(hashtextextended($1, 0))", key)
		if err != nil {
			raw := conn.Hijack()
			_ = raw.Close(context.Background())
			return
		}
		conn.Release()
	}, nil
}

func (s *Store) Begin(ctx context.Context, key, kind string) (effect.Record, error) {
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO sf_effects (key, kind) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, key, kind); err != nil {
		return effect.Record{}, fmt.Errorf("postgres: record intent: %w", err)
	}
	rec := effect.Record{Key: key}
	err := s.pool.QueryRow(ctx, `SELECT kind, done, result FROM sf_effects WHERE key = $1`, key).
		Scan(&rec.Kind, &rec.Done, &rec.Result)
	if err != nil {
		return effect.Record{}, fmt.Errorf("postgres: read intent: %w", err)
	}
	if rec.Kind != kind {
		return effect.Record{}, fmt.Errorf("postgres: key %s already used for kind %s", key, rec.Kind)
	}
	return rec, nil
}

func (s *Store) Complete(ctx context.Context, key string, result []byte) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE sf_effects SET done = true, result = $2, completed_at = now() WHERE key = $1`, key, result)
	if err != nil {
		return fmt.Errorf("postgres: record result: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return errors.New("postgres: no intent recorded for " + key)
	}
	return nil
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
