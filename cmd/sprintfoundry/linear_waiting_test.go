package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sagart-cactus/sprintfoundry/internal/forge/github"
	"github.com/sagart-cactus/sprintfoundry/internal/forge/linear"
	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres/pgtest"
)

// serve lists labelled Linear issues that have no job, and knows an issue
// by its Linear ID: one that moved to another team after it was approved is
// not offered again under its new identifier.
func TestServeListsLinearIssuesWithoutAJob(t *testing.T) {
	ctx := context.Background()
	store, err := postgres.Open(ctx, pgtest.FreshURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	put := func(kind, content string) string {
		d, err := store.PutInput(ctx, kind, []byte(content))
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	job := postgres.Job{ID: "job-eng-1-x", Repository: "github.com/o/r", Source: postgres.SourceLinear, IssueKey: "ENG-1", IssueUID: "u1",
		Base: strings.Repeat("a", 40), BaseBranch: "main",
		Inputs: postgres.Run{CriteriaDigest: put("criteria", "c"), SuiteDigest: put("check-suite", "s"), RunSpecDigest: put("run-spec", "r")}}
	if err := store.CreateJob(ctx, job); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"data":{"issues":{"nodes":[
			{"id":"u1","identifier":"OPS-3","title":"Moved","url":"x","state":{"type":"started"}},
			{"id":"u2","identifier":"ENG-2","title":"New \u001b[31m","url":"y","state":{"type":"backlog"}}]}}}`)
	}))
	defer srv.Close()
	var lines []string
	say := func(format string, args ...any) { lines = append(lines, printable(fmt.Sprintf(format, args...))) }
	listWaiting(ctx, store, &github.Client{}, &linear.Client{Base: srv.URL, Key: "k"}, say)
	out := strings.Join(lines, "\n")
	if strings.Contains(out, "OPS-3") || !strings.Contains(out, "--linear ENG-2") || strings.Contains(out, "\x1b") {
		t.Errorf("listing:\n%s", out)
	}
}
