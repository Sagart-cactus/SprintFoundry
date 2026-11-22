// Package gitimport brings a builder's change into a repository the
// controller owns, as data.
//
// The builder hands over a patch and the tree hash it tested. The controller
// applies the patch to the parent commit inside a bare repository, with hooks
// disabled and without a working tree, and accepts it only if the resulting
// tree hash equals the one the builder reported. No file the builder wrote is
// ever checked out or executed.
package gitimport

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// Errors returned by Import. Callers match them with errors.Is.
var (
	ErrTreeMismatch   = errors.New("gitimport: applied tree differs from the tested tree")
	ErrEmptyChange    = errors.New("gitimport: patch changes nothing")
	ErrBadPatch       = errors.New("gitimport: patch does not apply")
	ErrPatchTooLarge  = errors.New("gitimport: patch is larger than the limit")
	ErrForbiddenEntry = errors.New("gitimport: patch adds a symbolic link, a submodule or a .gitmodules file")
)

// MaxPatchBytes bounds the size of a patch the controller will apply.
const MaxPatchBytes = 32 << 20

// Request describes one change to import.
type Request struct {
	// Store is the path of the bare repository the controller owns. It must
	// already contain Parent.
	Store string
	// Parent is the full commit ID the patch applies to.
	Parent string
	// TestedTree is the tree hash the builder reported after its own tests.
	TestedTree string
	// Patch is the output of `git diff --binary` in the builder's sandbox.
	Patch []byte
	// Message is the commit message. The first line is the title.
	Message string
	// AuthorName and AuthorEmail identify the commit author and committer.
	AuthorName  string
	AuthorEmail string
}

// Result is the imported commit.
type Result struct {
	Commit string
	Tree   string
}

// Import applies req.Patch to req.Parent and returns the new commit.
func Import(ctx context.Context, req Request) (Result, error) {
	if req.Store == "" || req.Parent == "" || req.TestedTree == "" {
		return Result{}, errors.New("gitimport: store, parent and tested tree are required")
	}
	if req.AuthorName == "" || req.AuthorEmail == "" {
		return Result{}, errors.New("gitimport: author name and email are required")
	}

	if len(bytes.TrimSpace(req.Patch)) == 0 {
		return Result{}, ErrEmptyChange
	}

	if len(req.Patch) > MaxPatchBytes {
		return Result{}, fmt.Errorf("%w: %d bytes", ErrPatchTooLarge, len(req.Patch))
	}

	// A private directory, so no other user can guess or pre-create the index.
	scratch, err := os.MkdirTemp("", "sprintfoundry-import-*")
	if err != nil {
		return Result{}, fmt.Errorf("gitimport: temp directory: %w", err)
	}
	defer os.RemoveAll(scratch)
	indexPath := filepath.Join(scratch, "index")

	g := runner{store: req.Store, index: indexPath, name: req.AuthorName, email: req.AuthorEmail}

	parentTree, err := g.output(ctx, nil, "rev-parse", "--verify", req.Parent+"^{tree}")
	if err != nil {
		return Result{}, fmt.Errorf("gitimport: parent %s not in store: %w", req.Parent, err)
	}
	if _, err := g.output(ctx, nil, "read-tree", req.Parent); err != nil {
		return Result{}, fmt.Errorf("gitimport: read parent tree: %w", err)
	}
	if _, err := g.output(ctx, req.Patch, "apply", "--cached", "--binary", "--whitespace=nowarn", "-"); err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrBadPatch, err)
	}
	tree, err := g.output(ctx, nil, "write-tree")
	if err != nil {
		return Result{}, fmt.Errorf("gitimport: write tree: %w", err)
	}
	if tree == parentTree {
		return Result{}, ErrEmptyChange
	}
	if tree != req.TestedTree {
		return Result{}, fmt.Errorf("%w: applied %s, tested %s", ErrTreeMismatch, tree, req.TestedTree)
	}
	if err := g.refuseForbiddenEntries(ctx, req.Parent, tree); err != nil {
		return Result{}, err
	}
	commit, err := g.output(ctx, []byte(req.Message), "commit-tree", tree, "-p", req.Parent, "-F", "-")
	if err != nil {
		return Result{}, fmt.Errorf("gitimport: commit: %w", err)
	}
	return Result{Commit: commit, Tree: tree}, nil
}

// runner runs git against a bare store with a private index and a scrubbed
// environment, so no user, system or repository configuration and no hook can
// change what the commands do.
type runner struct {
	store, index, name, email string
	// env holds extra variables, for example fixed commit dates.
	env []string
}

func (r runner) command(ctx context.Context, args ...string) *exec.Cmd {
	full := append([]string{
		"--git-dir", r.store,
		"-c", "core.hooksPath=" + os.DevNull,
		"-c", "core.fsmonitor=false",
		"-c", "commit.gpgsign=false",
		"-c", "protocol.allow=never",
	}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Dir = filepath.Dir(r.store)
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.DevNull,
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=" + os.DevNull,
		"GIT_TERMINAL_PROMPT=0",
		// A replace ref in the store must not change what a commit ID means.
		"GIT_NO_REPLACE_OBJECTS=1",
		"GIT_AUTHOR_NAME=" + r.name,
		"GIT_AUTHOR_EMAIL=" + r.email,
		"GIT_COMMITTER_NAME=" + r.name,
		"GIT_COMMITTER_EMAIL=" + r.email,
	}
	if r.index != "" {
		cmd.Env = append(cmd.Env, "GIT_INDEX_FILE="+r.index)
	}
	cmd.Env = append(cmd.Env, r.env...)
	return cmd
}

func (r runner) output(ctx context.Context, stdin []byte, args ...string) (string, error) {
	cmd := r.command(ctx, args...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %v: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimRight(stdout.String(), "\n"), nil
}

func (r runner) stream(ctx context.Context, w io.Writer, args ...string) error {
	cmd := r.command(ctx, args...)
	var stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = w, &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git %s: %v: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// refuseForbiddenEntries rejects a change that adds or modifies a symbolic
// link, a submodule or a .gitmodules file. A symbolic link in a build context
// can point outside it, and a submodule can name a transport that runs a
// command.
func (r runner) refuseForbiddenEntries(ctx context.Context, parent, tree string) error {
	raw, err := r.output(ctx, nil, "diff-tree", "-r", "--raw", "--no-renames", "-z", parent, tree)
	if err != nil {
		return fmt.Errorf("gitimport: inspect change: %w", err)
	}
	fields := strings.Split(raw, "\x00")
	for i := 0; i+1 < len(fields); i += 2 {
		meta, path := strings.Fields(strings.TrimPrefix(fields[i], ":")), fields[i+1]
		if len(meta) < 2 {
			continue
		}
		newMode := meta[1]
		if newMode == "120000" || newMode == "160000" || filepath.Base(path) == ".gitmodules" && newMode != "000000" {
			return fmt.Errorf("%w: %s", ErrForbiddenEntry, path)
		}
	}
	return nil
}

var objectID = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

const controllerName, controllerEmail = "sprintfoundry", "controller@sprintfoundry.invalid"

// Archive writes the files of a commit as a tar stream, for use as a build
// context. It reads from the bare store and never creates a working tree.
//
// The archive honours the commit's own .gitattributes (export-ignore,
// export-subst), which the builder controls. That lets a builder leave files
// out of its own build context, which it could also do by not adding them.
func Archive(ctx context.Context, store, commit string, w io.Writer) error {
	if !objectID.MatchString(commit) {
		return fmt.Errorf("gitimport: %q is not a full commit ID", commit)
	}
	g := runner{store: store, name: controllerName, email: controllerEmail}
	return g.stream(ctx, w, "archive", "--format=tar", commit)
}

// ChangedPaths lists the paths that differ between two commits in the store.
func ChangedPaths(ctx context.Context, store, parent, commit string) ([]string, error) {
	if !objectID.MatchString(parent) || !objectID.MatchString(commit) {
		return nil, errors.New("gitimport: parent and commit must be full commit IDs")
	}
	g := runner{store: store, name: controllerName, email: controllerEmail}
	out, err := g.output(ctx, nil, "diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", parent, commit)
	if err != nil {
		return nil, fmt.Errorf("gitimport: list changed paths: %w", err)
	}
	var paths []string
	for _, p := range strings.Split(out, "\x00") {
		if p != "" {
			paths = append(paths, p)
		}
	}
	return paths, nil
}

// Plumbing returns a function that runs git against a bare repository with
// the same scrubbed environment Import uses: no user, system or repository
// configuration, no hooks, no network protocols, no replace refs. A non-empty
// index path makes commands use that private index file. Extra environment
// entries ("NAME=value") are added last.
func Plumbing(store, index string, env ...string) func(ctx context.Context, stdin []byte, args ...string) (string, error) {
	r := runner{store: store, index: index, name: controllerName, email: controllerEmail, env: env}
	return r.output
}

// Plumbing returns a function that runs git against a bare repository with
// the same scrubbed environment Import uses: no user, system or repository
// configuration, no hooks, no network protocols. A non-empty index path makes
// commands use that private index file.
func Plumbing(store, index string) func(ctx context.Context, stdin []byte, args ...string) (string, error) {
	r := runner{store: store, index: index, name: "sprintfoundry", email: "controller@sprintfoundry.invalid"}
	return r.output
}
