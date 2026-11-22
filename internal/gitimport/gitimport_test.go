package gitimport

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fixture is a bare store holding one parent commit, plus a builder-side
// working clone where a change is made and exported as a patch.
type fixture struct {
	t       *testing.T
	store   string // bare repository the controller owns
	builder string // working clone standing in for the builder's sandbox
	parent  string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	f := &fixture{t: t, store: filepath.Join(root, "store.git"), builder: filepath.Join(root, "builder")}

	f.git(root, "init", "--quiet", "--initial-branch=main", f.builder)
	write(t, filepath.Join(f.builder, "app.txt"), "v1\n")
	f.git(f.builder, "add", "-A")
	f.git(f.builder, "commit", "--quiet", "-m", "parent")
	f.parent = f.git(f.builder, "rev-parse", "HEAD")
	f.git(root, "clone", "--quiet", "--bare", f.builder, f.store)
	return f
}

// change edits the builder's clone and returns the patch and the tree hash,
// the two things a builder hands to the controller.
func (f *fixture) change(name, content string) (patch []byte, tree string) {
	f.t.Helper()
	write(f.t, filepath.Join(f.builder, name), content)
	f.git(f.builder, "add", "-A")
	tree = f.git(f.builder, "write-tree")
	patch = []byte(f.git(f.builder, "diff", "--binary", "--cached", f.parent) + "\n")
	return patch, tree
}

func (f *fixture) request(patch []byte, tree string) Request {
	return Request{
		Store: f.store, Parent: f.parent, TestedTree: tree, Patch: patch,
		Message: "Add a line\n", AuthorName: "Test Builder", AuthorEmail: "builder@example.test",
	}
}

func (f *fixture) git(dir string, args ...string) string {
	f.t.Helper()
	full := append([]string{"-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false"}, args...)
	cmd := exec.Command("git", full...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull)
	out, err := cmd.CombinedOutput()
	if err != nil {
		f.t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestImportAppliesPatchWithoutWorktree(t *testing.T) {
	f := newFixture(t)
	patch, tree := f.change("app.txt", "v1\nv2\n")

	got, err := Import(context.Background(), f.request(patch, tree))
	if err != nil {
		t.Fatalf("Import: %v", err)
	}
	if got.Tree != tree {
		t.Errorf("tree = %s, want the tested tree %s", got.Tree, tree)
	}
	if parent := f.git(filepath.Dir(f.store), "--git-dir", f.store, "rev-parse", got.Commit+"^"); parent != f.parent {
		t.Errorf("commit parent = %s, want %s", parent, f.parent)
	}
	if content := f.git(filepath.Dir(f.store), "--git-dir", f.store, "show", got.Commit+":app.txt"); content != "v1\nv2" {
		t.Errorf("imported content = %q", content)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(f.store), "app.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a working-tree file appeared next to the store: %v", err)
	}
	if bare := f.git(filepath.Dir(f.store), "--git-dir", f.store, "rev-parse", "--is-bare-repository"); bare != "true" {
		t.Errorf("store is not bare")
	}
}

func TestImportRejectsTreeMismatch(t *testing.T) {
	f := newFixture(t)
	patch, _ := f.change("app.txt", "v1\nv2\n")
	wrongTree := f.git(f.builder, "rev-parse", f.parent+"^{tree}")

	if _, err := Import(context.Background(), f.request(patch, wrongTree)); !errors.Is(err, ErrTreeMismatch) {
		t.Fatalf("parent tree as tested tree: err = %v, want ErrTreeMismatch", err)
	}

	other := strings.Repeat("a", len(wrongTree))
	if _, err := Import(context.Background(), f.request(patch, other)); !errors.Is(err, ErrTreeMismatch) {
		t.Fatalf("err = %v, want ErrTreeMismatch", err)
	}
}

func TestImportRejectsEmptyChange(t *testing.T) {
	f := newFixture(t)
	tree := f.git(f.builder, "rev-parse", f.parent+"^{tree}")

	if _, err := Import(context.Background(), f.request(nil, tree)); !errors.Is(err, ErrEmptyChange) {
		t.Fatalf("empty patch: err = %v, want ErrEmptyChange", err)
	}
	if _, err := Import(context.Background(), f.request([]byte("  \n"), tree)); !errors.Is(err, ErrEmptyChange) {
		t.Fatalf("blank patch: err = %v, want ErrEmptyChange", err)
	}
}

func TestImportNeverRunsHooks(t *testing.T) {
	f := newFixture(t)
	marker := filepath.Join(t.TempDir(), "hook-ran")
	script := "#!/bin/sh\ntouch '" + marker + "'\n"
	for _, hook := range []string{"post-index-change", "pre-applypatch", "pre-commit", "post-commit", "reference-transaction"} {
		write(t, filepath.Join(f.store, "hooks", hook), script)
	}

	// Control: prove the planted hook is live when hooks are not disabled.
	controlIndex := filepath.Join(t.TempDir(), "index")
	control := exec.Command("git", "--git-dir", f.store, "read-tree", f.parent)
	control.Env = append(os.Environ(), "GIT_INDEX_FILE="+controlIndex, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull)
	if out, err := control.CombinedOutput(); err != nil {
		t.Fatalf("control read-tree: %v\n%s", err, out)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Skipf("this git does not run post-index-change in a bare repository, so the control is void: %v", err)
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}

	patch, tree := f.change("app.txt", "v1\nv2\n")
	if _, err := Import(context.Background(), f.request(patch, tree)); err != nil {
		t.Fatalf("Import: %v", err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a hook ran during import")
	}
}

func TestImportRejectsPathEscape(t *testing.T) {
	f := newFixture(t)
	tree := strings.Repeat("a", 40)
	for _, path := range []string{"../escape.txt", ".git/hooks/pre-commit", "/abs/escape.txt"} {
		t.Run(path, func(t *testing.T) {
			var patch bytes.Buffer
			patch.WriteString("diff --git a/" + path + " b/" + path + "\n")
			patch.WriteString("new file mode 100755\n--- /dev/null\n+++ b/" + path + "\n@@ -0,0 +1 @@\n+owned\n")
			_, err := Import(context.Background(), f.request(patch.Bytes(), tree))
			if !errors.Is(err, ErrBadPatch) {
				t.Fatalf("err = %v, want ErrBadPatch", err)
			}
		})
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(f.store), "escape.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a file was written outside the store")
	}
}
