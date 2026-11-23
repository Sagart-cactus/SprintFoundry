package github

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	head = "1111111111111111111111111111111111111111"
	base = "2222222222222222222222222222222222222222"
)

func fakeGitHub(t *testing.T, statuses *[]Status) *Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /repos/o/r/pulls/7", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, `{"message":"Bad credentials"}`, http.StatusUnauthorized)
			return
		}
		io.WriteString(w, `{"number":7,"state":"open","merged":false,"merge_commit_sha":null,"html_url":"https://github.com/o/r/pull/7",
			"head":{"sha":"`+head+`"},"base":{"ref":"main","sha":"`+base+`"}}`)
	})
	mux.HandleFunc("POST /repos/o/r/statuses/"+head, func(w http.ResponseWriter, r *http.Request) {
		var s Status
		_ = json.NewDecoder(r.Body).Decode(&s)
		*statuses = append(*statuses, s)
		w.WriteHeader(http.StatusCreated)
		io.WriteString(w, `{}`)
	})
	mux.HandleFunc("GET /repos/o/r/commits/"+head, func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"parents":[{"sha":"`+base+`"}]}`)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &Client{Base: srv.URL, Token: "tok"}
}

func TestPullRequestAndStatus(t *testing.T) {
	var statuses []Status
	c := fakeGitHub(t, &statuses)
	ctx := context.Background()

	pr, err := c.GetPullRequest(ctx, "o/r", 7)
	if err != nil || pr.HeadSHA != head || pr.BaseSHA != base || pr.Merged {
		t.Fatalf("pull request = %+v, %v", pr, err)
	}
	long := strings.Repeat("x", 300)
	if err := c.SetStatus(ctx, "o/r", head, Status{State: "failure", Context: "sprintfoundry/checks", Description: long}); err != nil {
		t.Fatal(err)
	}
	if len(statuses) != 1 || len(statuses[0].Description) != 140 {
		t.Errorf("statuses = %+v", statuses)
	}
	if parent, err := c.FirstParent(ctx, "o/r", head); err != nil || parent != base {
		t.Errorf("first parent = %s, %v", parent, err)
	}

	bad := &Client{Base: c.Base, Token: "wrong"}
	if _, err := bad.GetPullRequest(ctx, "o/r", 7); err == nil || !strings.Contains(err.Error(), "401") {
		t.Errorf("bad token: err = %v", err)
	}
}

func TestReferencesAreValidated(t *testing.T) {
	c := &Client{Base: "http://127.0.0.1:1", Token: "tok"}
	ctx := context.Background()
	for _, repo := range []string{"", "o", "o/r/x", "../r", "o/r;rm"} {
		if _, err := c.GetPullRequest(ctx, repo, 1); err == nil || !strings.Contains(err.Error(), "not a pull request reference") {
			t.Errorf("repo %q: err = %v", repo, err)
		}
	}
	if err := c.SetStatus(ctx, "o/r", "abc", Status{State: "success"}); err == nil {
		t.Error("an abbreviated commit was accepted")
	}
	if err := c.SetStatus(ctx, "o/r", head, Status{State: "approved"}); err == nil {
		t.Error("an unknown status state was accepted")
	}
	if err := Fetch(ctx, t.TempDir()+"/s.git", "o/r", "main", "tok"); err == nil {
		t.Error("a branch name was accepted where a commit ID is required")
	}
}
