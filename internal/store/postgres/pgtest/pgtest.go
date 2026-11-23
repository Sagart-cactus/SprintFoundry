// Package pgtest gives tests in other packages a private Postgres schema.
package pgtest

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// URLEnv names the variable that points at a database tests may create
// schemas in, for example
// postgres://postgres:devonly@127.0.0.1:55433/sprintfoundry_test
const URLEnv = "SPRINTFOUNDRY_TEST_DATABASE_URL"

var counter atomic.Int64

// FreshURL returns a connection URL whose search_path is a new, empty
// schema that is dropped when the test ends. Without a database it skips
// the test, except in CI, where a skip would hide a gap.
func FreshURL(t testing.TB) string {
	t.Helper()
	base := os.Getenv(URLEnv)
	if base == "" {
		if os.Getenv("CI") != "" && os.Getenv("SPRINTFOUNDRY_NO_POSTGRES") == "" {
			t.Fatalf("%s is not set in CI; these tests must not be skipped silently", URLEnv)
		}
		t.Skipf("%s is not set", URLEnv)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatalf("connect to test database: %v", err)
	}
	defer conn.Close(ctx)
	name := fmt.Sprintf("sf_pgtest_%d_%d_%d", os.Getpid(), time.Now().UnixNano()%1e6, counter.Add(1))
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
