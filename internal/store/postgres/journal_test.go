package postgres_test

import (
	"context"
	"fmt"
	"os"
	"strings"
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

func TestLockIsReleasedWhenTheHolderDies(t *testing.T) {
	url := freshURL(t)
	store := open(t, url)

	// A second controller holds the lock on its own session.
	holder, err := pgx.Connect(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := holder.Exec(context.Background(), "SELECT pg_advisory_lock(hashtextextended($1, 0))", "run-7/k"); err != nil {
		t.Fatal(err)
	}

	blocked, cancelBlocked := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancelBlocked()
	if _, err := store.Lock(blocked, "run-7/k"); err == nil {
		t.Fatal("the lock was granted while another session held it")
	}

	// That controller dies without unlocking: its socket just closes.
	if err := holder.PgConn().Conn().Close(); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	unlock, err := store.Lock(ctx, "run-7/k")
	if err != nil {
		t.Fatalf("lock was not released when its holder died: %v", err)
	}
	unlock()
}
