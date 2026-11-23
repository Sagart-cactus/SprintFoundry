package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sagart-cactus/sprintfoundry/internal/controller"
	"github.com/sagart-cactus/sprintfoundry/internal/forge/github"
)

const (
	headSHA   = "1111111111111111111111111111111111111111"
	mainSHA   = "2222222222222222222222222222222222222222"
	forkBase  = "3333333333333333333333333333333333333333"
	mergedSHA = "4444444444444444444444444444444444444444"
	strayed   = "5555555555555555555555555555555555555555"
)

func fakeRepo(t *testing.T) *github.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /repos/o/r", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"default_branch":"main"}`)
	})
	pr := func(number, baseRef, baseSHA string) string {
		return `{"number":` + number + `,"state":"open","merged":false,"head":{"sha":"` + headSHA + `"},"base":{"ref":"` + baseRef + `","sha":"` + baseSHA + `"}}`
	}
	mux.HandleFunc("GET /repos/o/r/pulls/1", func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, pr("1", "main", mainSHA)) })
	mux.HandleFunc("GET /repos/o/r/pulls/2", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, pr("2", "holds-my-edit", forkBase))
	})
	mux.HandleFunc("GET /repos/o/r/pulls/3", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"number":3,"state":"closed","merged":true,"merge_commit_sha":"`+mergedSHA+`","head":{"sha":"`+headSHA+`"},"base":{"ref":"main","sha":"`+mainSHA+`"}}`)
	})
	compare := func(status, mergeBase string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) {
			io.WriteString(w, `{"status":"`+status+`","merge_base_commit":{"sha":"`+mergeBase+`"}}`)
		}
	}
	// The pull request head left main at an older commit than the base tip.
	mux.HandleFunc("GET /repos/o/r/compare/main..."+headSHA, compare("diverged", forkBase))
	mux.HandleFunc("GET /repos/o/r/compare/main..."+mergedSHA, compare("identical", mergedSHA))
	mux.HandleFunc("GET /repos/o/r/compare/main..."+strayed, compare("diverged", mainSHA))
	mux.HandleFunc("GET /repos/o/r/commits/"+mergedSHA+"/pulls", func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `[{"number":3}]`)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &github.Client{Base: srv.URL, Token: "tok"}
}

func TestResolveCheck(t *testing.T) {
	c := fakeRepo(t)
	ctx := context.Background()

	got, err := resolveCheck(ctx, c, "o/r", "", 1, "")
	if err != nil || got.Commit != headSHA || got.Base != forkBase || got.Release || got.Context != "sprintfoundry/checks" {
		t.Fatalf("pull request to main: %+v, %v (want the merge base as the base)", got, err)
	}
	if _, err := resolveCheck(ctx, c, "o/r", "", 2, ""); err == nil || !strings.Contains(err.Error(), "only pull requests to the registered branch") {
		t.Fatalf("pull request to another branch: err = %v", err)
	}
	got, err = resolveCheck(ctx, c, "o/r", "", 0, mergedSHA)
	if err != nil || got.Commit != mergedSHA || got.Base != mainSHA || !got.Release || got.Context != "sprintfoundry/release-check" {
		t.Fatalf("merged commit: %+v, %v (want the merged pull request's base as the base)", got, err)
	}
	if _, err := resolveCheck(ctx, c, "o/r", "", 0, strayed); err == nil || !strings.Contains(err.Error(), "not on the registered branch") {
		t.Fatalf("a commit off the default branch: err = %v", err)
	}
	// A registered branch replaces the default branch.
	if _, err := resolveCheck(ctx, c, "o/r", "holds-my-edit", 1, ""); err == nil || !strings.Contains(err.Error(), `registered branch "holds-my-edit"`) {
		t.Fatalf("pull request to main when another branch is registered: err = %v", err)
	}
}

func TestCheckStatus(t *testing.T) {
	image := strings.Repeat("a", 64)
	pr := checkTarget{Context: "sprintfoundry/checks"}
	release := checkTarget{Context: "sprintfoundry/release-check", Release: true}
	failed := controller.Result{State: controller.NeedsOwner, Reason: "the checks failed: export-owner-only: a request that should be refused was allowed",
		Rounds: []controller.Round{{Image: image}}}
	tests := []struct {
		name   string
		res    controller.Result
		target checkTarget
		state  string
		desc   string
	}{
		{"passed", controller.Result{State: controller.Passed, Rounds: []controller.Round{{Image: image}}}, pr, "success", "Checks passed on image aaaaaaaaaaaa"},
		{"failed pull request check", failed, pr, "failure", "export-owner-only"},
		{"failed release check tells nobody what failed", failed, release, "failure", "the operator has the details"},
		{"evaluation could not run", controller.Result{State: controller.NeedsOwner, Incomplete: true, Reason: "the evaluation could not be completed: x"}, pr, "error", "could not be completed"},
		{"a passed result without a round is not a success", controller.Result{State: controller.Passed}, pr, "failure", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := checkStatus(tt.res, tt.target)
			if s.State != tt.state || !strings.Contains(s.Description, tt.desc) || s.Context != tt.target.Context {
				t.Fatalf("status = %+v, want %s containing %q", s, tt.state, tt.desc)
			}
			if tt.target.Release && strings.Contains(s.Description, "export-owner-only") {
				t.Error("a release check status names a criterion")
			}
		})
	}
}
