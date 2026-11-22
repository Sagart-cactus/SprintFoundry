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
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Errors returned by Import. Callers match them with errors.Is.
var (
	ErrTreeMismatch = errors.New("gitimport: applied tree differs from the tested tree")
	ErrEmptyChange  = errors.New("gitimport: patch changes nothing")
	ErrBadPatch     = errors.New("gitimport: patch does not apply")
)

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

	index, err := os.CreateTemp("", "sprintfoundry-index-*")
	if err != nil {
		return Result{}, fmt.Errorf("gitimport: temp index: %w", err)
	}
	indexPath := index.Name()
	index.Close()
	os.Remove(indexPath) // git wants to create the index file itself
	defer os.Remove(indexPath)

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
}

func (r runner) output(ctx context.Context, stdin []byte, args ...string) (string, error) {
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
		"GIT_INDEX_FILE=" + r.index,
		"GIT_AUTHOR_NAME=" + r.name,
		"GIT_AUTHOR_EMAIL=" + r.email,
		"GIT_COMMITTER_NAME=" + r.name,
		"GIT_COMMITTER_EMAIL=" + r.email,
	}
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %v: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(stdout.String()), nil
}
