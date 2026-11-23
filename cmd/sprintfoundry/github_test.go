package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/container"
	"github.com/sagart-cactus/sprintfoundry/internal/controller"
	"github.com/sagart-cactus/sprintfoundry/internal/forge/github"
	"github.com/sagart-cactus/sprintfoundry/internal/local"
	"github.com/sagart-cactus/sprintfoundry/internal/runspec"
)

// TestGitHubExit is the milestone 2 exit test against a real repository. It
// runs only when SPRINTFOUNDRY_GITHUB_TESTBED names a repository the
// operator's `gh` login may push to, for example
//
//	SPRINTFOUNDRY_GITHUB_TESTBED=owner/sprintfoundry-v1-testbed go test -run TestGitHubExit ./cmd/sprintfoundry/
//
// It works on new branches and never changes the repository's main branch.
func TestGitHubExit(t *testing.T) {
	repo := os.Getenv("SPRINTFOUNDRY_GITHUB_TESTBED")
	if repo == "" {
		t.Skip("SPRINTFOUNDRY_GITHUB_TESTBED is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	token, err := github.TokenFromGH(ctx)
	if err != nil {
		t.Fatal(err)
	}
	client := &github.Client{Token: token}
	home := local.Home{Dir: filepath.Join(t.TempDir(), "home")}
	t.Cleanup(func() { _ = home.Down(context.Background(), container.CLI{}, true) })

	// A base branch holding the demo app, and two pull requests against it.
	stamp := fmt.Sprintf("sf-m2-%d", time.Now().Unix())
	work := filepath.Join(t.TempDir(), "clone")
	git := func(args ...string) string {
		t.Helper()
		out, err := github.GitWithToken(ctx, work, token, append([]string{"-c", "user.name=SprintFoundry test", "-c", "user.email=test@sprintfoundry.invalid"}, args...)...)
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(out))
	}
	if _, err := github.GitWithToken(ctx, filepath.Dir(work), token, "clone", "--quiet", "https://github.com/"+repo+".git", work); err != nil {
		t.Fatal(err)
	}
	copyDemo := func(variant string) {
		t.Helper()
		for _, name := range []string{"app.py", "test_app.py", "Dockerfile", "README.md"} {
			src := filepath.Join("..", "..", "internal", "demo", "app", name)
			if variant != "" {
				if _, err := os.Stat(filepath.Join("..", "..", "internal", "demo", "variants", variant, name)); err == nil {
					src = filepath.Join("..", "..", "internal", "demo", "variants", variant, name)
				}
			}
			data, err := os.ReadFile(src)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(work, name), data, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	git("checkout", "--quiet", "-b", stamp+"-base")
	copyDemo("")
	git("add", "-A")
	git("commit", "--quiet", "-m", "Invoices app")
	git("push", "--quiet", "origin", stamp+"-base")
	t.Cleanup(func() {
		for _, b := range []string{"-base", "-fixed", "-defect"} {
			_, _ = github.GitWithToken(context.Background(), work, token, "push", "--quiet", "--delete", "origin", stamp+b)
		}
	})
	openPR := func(variant string) int {
		t.Helper()
		git("checkout", "--quiet", "-b", stamp+"-"+variant, stamp+"-base")
		copyDemo(variant)
		git("add", "-A")
		git("commit", "--quiet", "-m", "Export invoices as CSV ("+variant+")")
		git("push", "--quiet", "origin", stamp+"-"+variant)
		n, err := client.CreatePullRequest(ctx, repo, stamp+"-"+variant, stamp+"-base", "Export invoices as CSV ("+variant+")")
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	fixedPR, defectPR := openPR("fixed"), openPR("defect")

	// The operator registers the inputs; nothing in the repository changes them.
	demoDir := filepath.Join("..", "..", "internal", "demo")
	var out bytes.Buffer
	if code := run([]string{"register", "--home", home.Dir, "--repo", repo, "--criteria", filepath.Join(demoDir, "criteria.md"),
		"--checks", filepath.Join(demoDir, "checks.yaml"), "--runspec", filepath.Join(demoDir, "runspec.yaml"),
		"--branch", stamp + "-base"}, &out, &out); code != 0 {
		t.Fatalf("register: %s", out.String())
	}

	// statusOf returns the newest status of a context, waiting a little for
	// GitHub's list to catch up with a status that was just posted.
	statusOf := func(commit, context string) github.Status {
		t.Helper()
		var found github.Status
		for attempt := 0; attempt < 20; attempt++ {
			statuses, err := client.GetStatuses(ctx, repo, commit)
			if err != nil {
				t.Fatal(err)
			}
			for _, s := range statuses { // newest first
				if s.Context == context {
					found = s
					break
				}
			}
			if found.State != "" && found.State != "pending" {
				return found
			}
			time.Sleep(time.Second)
		}
		t.Fatalf("no final %s status on %s (last seen %+v)", context, commit[:12], found)
		return found
	}

	// 1. Each pull request gets an advisory status.
	out.Reset()
	good, err := runCheck(home.Dir, repo, fixedPR, "", 10, &out)
	if err != nil || good.State != controller.Passed {
		t.Fatalf("check of the good pull request: %v, %s (%s)\n%s", err, good.State, good.Reason, out.String())
	}
	prHead, _ := client.GetPullRequest(ctx, repo, fixedPR)
	if s := statusOf(prHead.HeadSHA, "sprintfoundry/checks"); s.State != "success" {
		t.Errorf("status on the good pull request = %+v", s)
	}
	policy := regexp.MustCompile(`--policy (\S+) `).FindStringSubmatch(out.String())[1]

	out.Reset()
	bad, err := runCheck(home.Dir, repo, defectPR, "", 10, &out)
	if err != nil || bad.State == controller.Passed {
		t.Fatalf("check of the defective pull request: %v, %s", err, bad.State)
	}
	badHead, _ := client.GetPullRequest(ctx, repo, defectPR)
	s := statusOf(badHead.HeadSHA, "sprintfoundry/checks")
	if s.State != "failure" || !strings.Contains(s.Description, "export-owner-only") || strings.Contains(s.Description, "export-denied") {
		t.Errorf("status on the defective pull request = %+v", s)
	}

	// 2. Squash-merge the good one. The merge commit is new, and so is any
	// image built from it.
	mergeSHA, err := client.SquashMerge(ctx, repo, fixedPR)
	if err != nil {
		t.Fatal(err)
	}
	verify := func(image string) int {
		var vout bytes.Buffer
		return run([]string{"verify", "--home", home.Dir, "--policy", policy, image}, &vout, &vout)
	}

	// 3. An image built from the merge commit with no verdict of its own is
	// refused, even though the pull request passed.
	env, err := open(ctx, home.Dir, func(string, ...any) {})
	if err != nil {
		t.Fatal(err)
	}
	storeDir := home.Path("repos", strings.ToLower(repo)+".git")
	if err := github.Fetch(ctx, storeDir, repo, mergeSHA, token); err != nil {
		t.Fatal(err)
	}
	spec, _ := runspec.Parse(mustRead(t, filepath.Join(demoDir, "runspec.yaml")))
	rebuilt, err := env.build(ctx, storeDir, mergeSHA, spec)
	env.store.Close()
	if err != nil {
		t.Fatal(err)
	}
	if code := verify(rebuilt); code != 1 {
		t.Errorf("a rebuilt merge image without its own verdict: verify exit %d, want 1", code)
	}

	// 4. The release check after merge gives the release candidate its own
	// verdict, and only that image is accepted.
	out.Reset()
	release, err := runCheck(home.Dir, repo, 0, mergeSHA, 0, &out)
	if err != nil || release.State != controller.Passed {
		t.Fatalf("release check: %v, %s (%s)\n%s", err, release.State, release.Reason, out.String())
	}
	if s := statusOf(mergeSHA, "sprintfoundry/release-check"); s.State != "success" {
		t.Errorf("release status = %+v", s)
	}
	candidate := release.Rounds[0].Image
	if code := verify(candidate); code != 0 {
		t.Errorf("the release candidate: verify exit %d, want 0", code)
	}
	// A verdict covers an image by its content. If the build cache made the
	// release check's image identical to the earlier rebuild, the verdict
	// covers it too; a rebuild with any other content is refused.
	if want := map[bool]int{true: 0, false: 1}[rebuilt == candidate]; verify(rebuilt) != want {
		t.Errorf("the earlier rebuild (identical to the candidate: %v): want verify exit %d", rebuilt == candidate, want)
	}
	if code := verify(strings.Repeat("e", 64)); code != 1 {
		t.Errorf("an image nobody checked: verify exit %d, want 1", code)
	}

	// 5. A pull request check after the release check neither withdraws the
	// candidate's verdict nor gets its own head image accepted.
	out.Reset()
	again, err := runCheck(home.Dir, repo, defectPR, "", 10, &out)
	if err != nil || again.State == controller.Passed || len(again.Rounds) != 1 {
		t.Fatalf("second check of the defective pull request: %v, %s (%s)", err, again.State, again.Reason)
	}
	if code := verify(candidate); code != 0 {
		t.Errorf("the release candidate after a later pull request check: verify exit %d, want 0", code)
	}
	if code := verify(again.Rounds[0].Image); code != 1 {
		t.Errorf("a pull request head's image: verify exit %d, want 1", code)
	}
	if code := verify(good.Rounds[0].Image); code != 1 && good.Rounds[0].Image != candidate {
		t.Errorf("the good pull request's own image: verify exit %d, want 1", code)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
