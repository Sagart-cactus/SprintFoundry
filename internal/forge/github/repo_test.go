package github

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRepoLooksUpBranchesPullRequestsAndIssues(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /repos/o/r/git/ref/heads/sprintfoundry/job-1", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"ref":"refs/heads/sprintfoundry/job-1","object":{"sha":"`+head+`"}}`)
	})
	// GitHub answers a ref that is only a prefix of others with a list.
	mux.HandleFunc("GET /repos/o/r/git/ref/heads/sprintfoundry/job", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `[{"ref":"refs/heads/sprintfoundry/job-1","object":{"sha":"`+head+`"}}]`)
	})
	mux.HandleFunc("GET /repos/o/r/git/ref/heads/missing", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"message":"Not Found"}`, http.StatusNotFound)
	})
	mux.HandleFunc("GET /repos/o/r/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("head") != "o:sprintfoundry/job-1" || r.URL.Query().Get("state") != "all" {
			io.WriteString(w, `[]`)
			return
		}
		io.WriteString(w, `[{"number":9,"head":{"ref":"sprintfoundry/job-1"}}]`)
	})
	mux.HandleFunc("GET /repos/o/r/issues/4", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"number":4,"title":"Export","body":"As an owner...","state":"open","labels":[{"name":"sprintfoundry"}]}`)
	})
	mux.HandleFunc("GET /repos/o/r/issues", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("labels") != "sprintfoundry" {
			io.WriteString(w, `[]`)
			return
		}
		io.WriteString(w, `[{"number":4,"title":"Export","state":"open"},{"number":5,"title":"A pull request","state":"open","pull_request":{}}]`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := &Client{Base: srv.URL, Token: "tok"}
	r := &Repo{Client: c, Name: "o/r", Token: "tok"}
	ctx := context.Background()

	if commit, found, err := r.FindBranch(ctx, "sprintfoundry/job-1"); err != nil || !found || commit != head {
		t.Errorf("existing branch: %s %v %v", commit, found, err)
	}
	if _, found, err := r.FindBranch(ctx, "sprintfoundry/job"); err != nil || found {
		t.Errorf("a prefix of a branch was taken for the branch: %v %v", found, err)
	}
	if _, found, err := r.FindBranch(ctx, "missing"); err != nil || found {
		t.Errorf("missing branch: %v %v", found, err)
	}
	for _, bad := range []string{"../x", "a..b", "-x", ""} {
		if _, _, err := r.FindBranch(ctx, bad); err == nil {
			t.Errorf("branch %q was accepted", bad)
		}
	}
	if n, found, err := r.FindPullRequest(ctx, "sprintfoundry/job-1"); err != nil || !found || n != 9 {
		t.Errorf("pull request: %d %v %v", n, found, err)
	}
	if _, found, _ := r.FindPullRequest(ctx, "sprintfoundry/job-2"); found {
		t.Error("a pull request was found for a branch without one")
	}
	issue, err := c.GetIssue(ctx, "o/r", 4)
	if err != nil || issue.Title != "Export" || issue.PullRequest || len(issue.Labels) != 1 {
		t.Errorf("issue: %+v %v", issue, err)
	}
	issues, err := c.LabeledIssues(ctx, "o/r", "sprintfoundry")
	if err != nil || len(issues) != 1 || issues[0].Number != 4 {
		t.Errorf("labelled issues (pull requests left out): %+v %v", issues, err)
	}
	if err := r.PushBranch(ctx, t.TempDir(), "abc", "x"); err == nil || !strings.Contains(err.Error(), "not a push") {
		t.Errorf("an abbreviated commit was pushed: %v", err)
	}
}

func TestPushBranchOnlyCreatesTheBranch(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false"}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	work, store, remote := filepath.Join(dir, "w"), filepath.Join(dir, "store.git"), filepath.Join(dir, "remote", "o", "r.git")
	git("init", "--quiet", "-b", "main", work)
	git("-C", work, "commit", "--quiet", "--allow-empty", "-m", "one")
	first := git("-C", work, "rev-parse", "HEAD")
	git("-C", work, "commit", "--quiet", "--allow-empty", "-m", "two")
	second := git("-C", work, "rev-parse", "HEAD")
	git("clone", "--quiet", "--bare", work, store)
	git("init", "--quiet", "--bare", remote)

	r := &Repo{Name: "o/r", Token: "tok", GitURL: filepath.Join(dir, "remote") + "/"}
	ctx := context.Background()
	if err := r.PushBranch(ctx, store, first, "sprintfoundry/job-1"); err != nil {
		t.Fatalf("create: %v", err)
	}
	// The branch exists at an ancestor of second: a plain push would
	// fast-forward it. This one must refuse.
	if err := r.PushBranch(ctx, store, second, "sprintfoundry/job-1"); err == nil {
		t.Fatal("an existing branch was moved")
	}
	if got := git("--git-dir", remote, "rev-parse", "refs/heads/sprintfoundry/job-1"); got != first {
		t.Errorf("branch at %s, want %s", got, first)
	}
}

func TestStoreLockIsExclusiveAndGivesUpWithItsContext(t *testing.T) {
	store := filepath.Join(t.TempDir(), "repos", "o", "r.git")
	unlock, err := lockStore(context.Background(), store)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, err := lockStore(ctx, store); err == nil {
		t.Fatal("a second holder got the lock")
	}
	unlock()
	again, err := lockStore(context.Background(), store)
	if err != nil {
		t.Fatalf("the lock was not given back: %v", err)
	}
	again()
}
