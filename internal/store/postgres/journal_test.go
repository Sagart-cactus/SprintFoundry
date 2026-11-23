package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/sagart-cactus/sprintfoundry/internal/effect"
	"github.com/sagart-cactus/sprintfoundry/internal/effect/effecttest"
	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

// These tests need a real Postgres. Set SPRINTFOUNDRY_TEST_DATABASE_URL to a
// database the tests may create schemas in, for example
// postgres://postgres:devonly@127.0.0.1:55433/sprintfoundry_test
const urlEnv = "SPRINTFOUNDRY_TEST_DATABASE_URL"

var schemaCounter atomic.Int64

// freshURL returns a connection URL whose search_path is a new, empty schema,
// so tests never see each other's rows.
func freshURL(t *testing.T) string {
	t.Helper()
	base := os.Getenv(urlEnv)
	if base == "" {
		if os.Getenv("CI") != "" && os.Getenv("SPRINTFOUNDRY_NO_POSTGRES") == "" {
			t.Fatalf("%s is not set in CI; these tests must not be skipped silently", urlEnv)
		}
		t.Skipf("%s is not set", urlEnv)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatalf("connect to test database: %v", err)
	}
	defer conn.Close(ctx)

	name := fmt.Sprintf("sf_test_%d_%d", os.Getpid(), schemaCounter.Add(1))
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+name); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if c, err := pgx.Connect(ctx, base); err == nil {
			_, _ = c.Exec(ctx, "DROP SCHEMA "+name+" CASCADE")
			_ = c.Close(ctx)
		}
	})
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	return base + sep + "search_path=" + name
}

func open(t *testing.T, url string) *postgres.Store {
	t.Helper()
	s, err := postgres.Open(context.Background(), url)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

func TestPostgresJournal(t *testing.T) {
	effecttest.Run(t, func(t *testing.T) (effect.Journal, func() effect.Journal) {
		url := freshURL(t)
		return open(t, url), func() effect.Journal { return open(t, url) }
	})
}

func TestOpenIsSafeToRepeatAndToRace(t *testing.T) {
	url := freshURL(t)
	errs := make(chan error, 6)
	for i := 0; i < 6; i++ {
		go func() {
			s, err := postgres.Open(context.Background(), url)
			if err == nil {
				s.Close()
			}
			errs <- err
		}()
	}
	for i := 0; i < 6; i++ {
		if err := <-errs; err != nil {
			t.Errorf("concurrent Open: %v", err)
		}
	}
}

// lockSessions returns the backend PIDs that hold the advisory lock for key
// in the test database. Other tests share the database and take advisory
// locks of their own at the same time, so only this key counts.
func lockSessions(t *testing.T, url, key string) []int32 {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	rows, err := conn.Query(ctx, `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 1
		AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
		AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`, key)
	if err != nil {
		t.Fatal(err)
	}
	pids, err := pgx.CollectRows(rows, pgx.RowTo[int32])
	if err != nil {
		t.Fatal(err)
	}
	return pids
}

func terminate(t *testing.T, url string, pid int32) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "SELECT pg_terminate_backend($1)", pid); err != nil {
		t.Fatal(err)
	}
}

func TestLockIsReleasedWhenTheHolderDies(t *testing.T) {
	url := freshURL(t)
	holder, waiter := open(t, url), open(t, url)
	const key = "run-7/k"

	h, err := holder.Acquire(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Release()

	blocked, cancelBlocked := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancelBlocked()
	if _, err := waiter.Acquire(blocked, key); err == nil {
		t.Fatal("the lock was granted while another controller held it")
	}

	// The holding controller's database session dies.
	pids := lockSessions(t, url, key)
	if len(pids) != 1 {
		t.Fatalf("expected one session holding an advisory lock, found %d", len(pids))
	}
	terminate(t, url, pids[0])

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	next, err := waiter.Acquire(ctx, key)
	if err != nil {
		t.Fatalf("lock was not released when its holder died: %v", err)
	}
	next.Release()
}

func TestHolderCannotRecordAfterLosingItsSession(t *testing.T) {
	url := freshURL(t)
	a, b := open(t, url), open(t, url)
	const key = "run-9/dispatch-release"
	ctx := context.Background()

	inDo, proceed := make(chan struct{}), make(chan struct{})
	// If the test stops early, let A's Do return, or closing A's store waits
	// forever for the connection A still holds.
	var letGo sync.Once
	release := func() { letGo.Do(func() { close(proceed) }) }
	t.Cleanup(release)
	var performed atomic.Int64
	first := make(chan error, 1)
	go func() {
		_, err := effect.Perform(ctx, a, effect.Action{Key: key, Kind: "dispatch-release",
			Find: func(context.Context) ([]byte, bool, error) { return nil, false, nil },
			Do: func(context.Context) ([]byte, error) {
				performed.Add(1)
				close(inDo)
				<-proceed // the remote call is slow
				return []byte("from-a"), nil
			}})
		first <- err
	}()
	<-inDo

	// Controller A's lock session is killed while it is still inside Do.
	pids := lockSessions(t, url, key)
	if len(pids) != 1 {
		t.Fatalf("expected one session holding an advisory lock, found %d", len(pids))
	}
	terminate(t, url, pids[0])

	// Controller B now gets the hold. Its lookup finds what A already did.
	got, err := effect.Perform(ctx, b, effect.Action{Key: key, Kind: "dispatch-release",
		Find: func(context.Context) ([]byte, bool, error) { return []byte("found-at-remote"), true, nil },
		Do:   func(context.Context) ([]byte, error) { performed.Add(1); return []byte("from-b"), nil }})
	if err != nil || string(got) != "found-at-remote" {
		t.Fatalf("controller B: %q, %v", got, err)
	}

	release()
	if err := <-first; !errors.Is(err, effect.ErrHoldLost) {
		t.Fatalf("controller A returned %v after losing its session, want ErrHoldLost", err)
	}
	if performed.Load() != 1 {
		t.Errorf("effect performed %d times, want 1", performed.Load())
	}

	// A's late result did not replace what B recorded.
	h, err := b.Acquire(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Release()
	rec, err := h.Begin(ctx, "dispatch-release")
	if err != nil || !rec.Done || string(rec.Result) != "found-at-remote" {
		t.Errorf("record = %+v, %v", rec, err)
	}
}
