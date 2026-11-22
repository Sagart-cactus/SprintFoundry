// Package demo carries everything the `sprintfoundry demo` command needs and
// nothing it has to download: a small web app, the feature request with its
// approved criteria, check suite and run spec, and three recorded builders.
package demo

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"

	"github.com/sagart-cactus/sprintfoundry/internal/agent"
	"github.com/sagart-cactus/sprintfoundry/internal/gitimport"
)

//go:embed app variants criteria.md checks.yaml runspec.yaml
var files embed.FS

// Repository is the name the demo's evidence uses for the app's repository.
const Repository = "local/invoices"

// Criteria, Checks and RunSpec return the approved inputs of the demo run.
func Criteria() []byte { return mustRead("criteria.md") }
func Checks() []byte   { return mustRead("checks.yaml") }
func RunSpec() []byte  { return mustRead("runspec.yaml") }

func mustRead(name string) []byte {
	data, err := files.ReadFile(name)
	if err != nil {
		panic("demo: embedded file missing: " + name)
	}
	return data
}

// Variants are the recorded builders, in the order the demo plays them.
//
//   - defect: implements the export but lets any signed-in user download it.
//   - fixed: implements the export correctly.
//   - tamper: implements it correctly and also rewrites a test and the
//     Dockerfile, which a builder may not do without a person looking.
var Variants = []string{"defect", "fixed", "tamper"}

// SeedStore creates a bare repository at dir holding the app as one commit,
// and returns that commit. The commit is the same on every machine.
func SeedStore(ctx context.Context, dir string) (parent string, err error) {
	git := gitimport.Plumbing(dir, "")
	if _, err := os.Stat(filepath.Join(dir, "HEAD")); err != nil {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", err
		}
		if _, err := git(ctx, nil, "init", "--bare", "--quiet", "--initial-branch=main", dir); err != nil {
			return "", fmt.Errorf("demo: create store: %w", err)
		}
	}
	tree, err := writeTree(ctx, dir, "", "app")
	if err != nil {
		return "", err
	}
	parent, err = commitTree(ctx, dir, tree, "", "Invoices app")
	if err != nil {
		return "", err
	}
	if _, err := git(ctx, nil, "update-ref", "refs/heads/main", parent); err != nil {
		return "", fmt.Errorf("demo: set main: %w", err)
	}
	return parent, nil
}

// Change plays one recorded builder. It works in a scratch copy of the
// repository, as a builder would in its sandbox, and returns what a builder
// hands over: a patch against parent and the tree hash it ended with.
func Change(ctx context.Context, scratchDir, store, parent, variant string) (agent.Change, error) {
	if _, err := fs.Stat(files, path.Join("variants", variant)); err != nil {
		return agent.Change{}, fmt.Errorf("demo: no recorded builder named %q", variant)
	}
	scratch := filepath.Join(scratchDir, "builder-"+variant+".git")
	if err := os.RemoveAll(scratch); err != nil {
		return agent.Change{}, err
	}
	if _, err := SeedStore(ctx, scratch); err != nil {
		return agent.Change{}, err
	}
	tree, err := writeTree(ctx, scratch, parent, path.Join("variants", variant))
	if err != nil {
		return agent.Change{}, err
	}
	patch, err := gitimport.Plumbing(scratch, "")(ctx, nil, "diff-tree", "-p", "--binary", "--no-renames", parent, tree)
	if err != nil {
		return agent.Change{}, fmt.Errorf("demo: export patch: %w", err)
	}
	return agent.Change{
		Patch:      []byte(patch + "\n"),
		TestedTree: tree,
		Summary:    "Recorded builder: " + variant,
	}, nil
}

// writeTree stores the embedded files under root as blobs on top of base (a
// commit, or "" for an empty tree) and returns the resulting tree.
func writeTree(ctx context.Context, store, base, root string) (string, error) {
	index, err := os.CreateTemp("", "sprintfoundry-demo-index-*")
	if err != nil {
		return "", err
	}
	indexPath := index.Name()
	index.Close()
	os.Remove(indexPath)
	defer os.Remove(indexPath)
	git := gitimport.Plumbing(store, indexPath)

	if base != "" {
		if _, err := git(ctx, nil, "read-tree", base); err != nil {
			return "", fmt.Errorf("demo: read base: %w", err)
		}
	}
	var names []string
	err = fs.WalkDir(files, root, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			names = append(names, p)
		}
		return err
	})
	if err != nil {
		return "", err
	}
	sort.Strings(names)
	for _, name := range names {
		data, err := files.ReadFile(name)
		if err != nil {
			return "", err
		}
		blob, err := git(ctx, data, "hash-object", "-w", "--stdin")
		if err != nil {
			return "", fmt.Errorf("demo: store %s: %w", name, err)
		}
		rel, _ := filepath.Rel(filepath.FromSlash(root), filepath.FromSlash(name))
		if _, err := git(ctx, nil, "update-index", "--add", "--cacheinfo", "100644,"+blob+","+filepath.ToSlash(rel)); err != nil {
			return "", fmt.Errorf("demo: index %s: %w", name, err)
		}
	}
	return git(ctx, nil, "write-tree")
}

// seedDate fixes the commit time of the seed commit, so its ID is the same in
// every store and in every builder's scratch copy.
const seedDate = "2026-01-01T00:00:00Z"

func commitTree(ctx context.Context, store, tree, parent, message string) (string, error) {
	args := []string{"commit-tree", tree, "-m", message}
	if parent != "" {
		args = append(args, "-p", parent)
	}
	git := gitimport.Plumbing(store, "", "GIT_AUTHOR_DATE="+seedDate, "GIT_COMMITTER_DATE="+seedDate)
	return git(ctx, nil, args...)
}
