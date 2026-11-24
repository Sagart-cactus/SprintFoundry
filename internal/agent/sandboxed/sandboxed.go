// Package sandboxed runs an existing command-line coding agent inside a
// sandbox and turns what it did into a change the controller can import: a
// patch against the parent commit and the tree hash it ended with.
//
// The agent gets a fresh sandbox each round with the parent commit's files
// (no history), the previous round's change applied, and a task file
// with the criteria and the feedback, nothing more. It never sees the check
// suite, the run spec or any credential.
package sandboxed

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/sagart-cactus/sprintfoundry/internal/agent"
	"github.com/sagart-cactus/sprintfoundry/internal/gitimport"
	"github.com/sagart-cactus/sprintfoundry/internal/sandbox"
)

// Agent runs one command-line agent in a sandbox per round.
type Agent struct {
	Label   string
	Sandbox sandbox.Sandbox
	// Spec describes the sandbox. Workdir is ignored; the repository is
	// always cloned to /workspace/repo.
	Spec  sandbox.Spec
	Guard sandbox.Guard
	// Store and Parent are the controller's bare repository and the commit
	// the builder starts from.
	Store  string
	Parent string
	// Script is the shell script that runs the agent inside the sandbox, in
	// /workspace/repo, with the task at /sf/task.md. It must not need to
	// write anywhere but /workspace and /home/agent.
	Script string
	// Timeout bounds one round. Zero means 30 minutes.
	Timeout time.Duration
	// Log, when set, receives the tail of the agent's own output after each
	// round, for the person watching.
	Log func(format string, args ...any)

	previous *agent.Change
}

var _ agent.Agent = (*Agent)(nil)

// ErrNoChange is returned when the agent left the repository as it was.
var ErrNoChange = errors.New("sandboxed: the agent made no change")

var objectID = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

func (a *Agent) Name() string { return a.Label }

// Run gives the agent one round.
func (a *Agent) Run(ctx context.Context, _ sandbox.Sandbox, _ string, task agent.Task) (agent.Change, error) {
	if !objectID.MatchString(a.Parent) {
		return agent.Change{}, fmt.Errorf("sandboxed: parent %q is not a full commit ID", a.Parent)
	}
	timeout := a.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	spec := a.Spec
	spec.Workdir = "/workspace"
	validated, err := spec.Validate(a.Guard)
	if err != nil {
		return agent.Change{}, err
	}
	bundle, base, err := a.bundle(ctx)
	if err != nil {
		return agent.Change{}, err
	}

	id, err := a.Sandbox.Create(ctx, validated)
	if err != nil {
		return agent.Change{}, err
	}
	defer a.Sandbox.Destroy(context.WithoutCancel(ctx), id)

	inputs := map[string][]byte{"repo.bundle": bundle, "task.md": []byte(TaskText(task))}
	if task.Previous != nil {
		inputs["previous.patch"] = task.Previous
	} else if a.previous != nil {
		inputs["previous.patch"] = a.previous.Patch
	}
	if err := a.Sandbox.CopyIn(ctx, id, "/sf", tarOf(inputs)); err != nil {
		return agent.Change{}, err
	}

	sh := func(script string) (sandbox.Result, error) {
		return a.Sandbox.Exec(ctx, id, sandbox.Command{Args: []string{"sh", "-c", script}})
	}
	// A clone of a bundle only fetches branches, so fetch the one ref the
	// bundle holds by name.
	setup := "set -e; git init -q /workspace/repo; cd /workspace/repo; " +
		"git fetch -q /sf/repo.bundle refs/sprintfoundry/base; " +
		"git -c advice.detachedHead=false checkout -q --detach " + base + "; " +
		"git config user.name builder; git config user.email builder@sprintfoundry.invalid; " +
		"if [ -s /sf/previous.patch ]; then git apply --binary /sf/previous.patch; fi"
	if res, err := sh(setup); err != nil || res.ExitCode != 0 {
		return agent.Change{}, fmt.Errorf("sandboxed: prepare the repository: %v: %s", err, tail(append(res.Stdout, res.Stderr...), 400))
	}

	// The agent may write without end. Keep only the last part of it.
	res, err := a.Sandbox.Exec(ctx, id, sandbox.Command{Args: []string{"sh", "-c", "cd /workspace/repo && " + a.Script},
		MaxOutput: 64 << 10, KeepTail: true})
	if a.Log != nil && (len(res.Stdout) > 0 || len(res.Stderr) > 0) {
		a.Log("%s output (last lines): %s", a.Label, tail(append(res.Stdout, res.Stderr...), 600))
	}
	if err != nil {
		return agent.Change{}, fmt.Errorf("sandboxed: run %s: %w", a.Label, err)
	}
	if res.ExitCode != 0 {
		return agent.Change{}, fmt.Errorf("sandboxed: %s exited with %d: %s", a.Label, res.ExitCode, tail(res.Stderr, 400))
	}

	treeOut, err := sh("cd /workspace/repo && git add -A && git write-tree")
	if err != nil || treeOut.ExitCode != 0 {
		return agent.Change{}, fmt.Errorf("sandboxed: read the result: %v %s", err, tail(treeOut.Stderr, 400))
	}
	tree := strings.TrimSpace(string(treeOut.Stdout))
	if !objectID.MatchString(tree) {
		return agent.Change{}, fmt.Errorf("sandboxed: the sandbox reported tree %q", tree)
	}
	patchOut, err := a.Sandbox.Exec(ctx, id, sandbox.Command{
		Args:      []string{"sh", "-c", "cd /workspace/repo && git diff --binary --no-renames --cached " + base},
		MaxOutput: gitimport.MaxPatchBytes + 1})
	if err != nil || patchOut.ExitCode != 0 {
		return agent.Change{}, fmt.Errorf("sandboxed: export the change: %v %s", err, tail(patchOut.Stderr, 400))
	}
	if patchOut.Truncated {
		return agent.Change{}, fmt.Errorf("sandboxed: the change is larger than %d bytes", gitimport.MaxPatchBytes)
	}
	if len(bytes.TrimSpace(patchOut.Stdout)) == 0 {
		return agent.Change{}, ErrNoChange
	}
	change := agent.Change{Patch: patchOut.Stdout, TestedTree: tree, Summary: tail(res.Stdout, 2000)}
	// The description is optional: a builder that wrote none still hands
	// over its change.
	desc, err := a.Sandbox.Exec(ctx, id, sandbox.Command{
		Args: []string{"sh", "-c", "if [ -f " + DescriptionPath + " ] && [ ! -L " + DescriptionPath + " ]; then head -c " +
			strconv.Itoa(MaxDescriptionBytes) + " " + DescriptionPath + "; fi"}, MaxOutput: MaxDescriptionBytes})
	if err == nil && desc.ExitCode == 0 {
		change.Title, change.Body = ParseDescription(desc.Stdout)
	}
	a.previous = &change
	return change, nil
}

// bundle packs the parent commit's files into a git bundle, read from the
// controller's store. The bundle holds one commit with no history: the
// parent's tree under a new root commit. Old commits, and whatever they once
// contained, never reach the agent or the model provider. Because the tree
// is the parent's, a patch against the base applies to the parent the same.
func (a *Agent) bundle(ctx context.Context) ([]byte, string, error) {
	dir, err := os.MkdirTemp("", "sprintfoundry-bundle-*")
	if err != nil {
		return nil, "", err
	}
	defer os.RemoveAll(dir)
	date := "2000-01-01T00:00:00Z" // fixed, so the base commit is the same every round
	git := gitimport.Plumbing(a.Store, "", "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
	base, err := git(ctx, nil, "commit-tree", a.Parent+"^{tree}", "-m", "base")
	if err != nil {
		return nil, "", fmt.Errorf("sandboxed: make the base commit: %w", err)
	}
	if _, err := git(ctx, nil, "update-ref", "refs/sprintfoundry/base", base); err != nil {
		return nil, "", fmt.Errorf("sandboxed: mark the base commit: %w", err)
	}
	path := filepath.Join(dir, "repo.bundle")
	if _, err := git(ctx, nil, "bundle", "create", "-q", path, "refs/sprintfoundry/base"); err != nil {
		return nil, "", fmt.Errorf("sandboxed: bundle the repository: %w", err)
	}
	data, err := os.ReadFile(path)
	return data, base, err
}

// TaskText is what the agent is told: the criteria, the feedback from the
// last evaluation, and the rules. It never contains a check.
func TaskText(task agent.Task) string {
	var b strings.Builder
	b.WriteString("You are working in a Git repository, in its root directory.\n")
	b.WriteString("Implement the change described below. Edit the files directly.\n\n")
	b.WriteString("Rules:\n- Do not commit, and do not change Git history or configuration.\n")
	b.WriteString("- Run the project's own tests if it has any.\n")
	b.WriteString("- Changing tests, the Dockerfile, CI or dependency files sends the change to a person for review.\n")
	b.WriteString("- When you are done, describe the whole change for its pull request in " + DescriptionPath + ", outside the\n")
	b.WriteString("  repository: a short title on the first line, a blank line, then the body in Markdown. Write it fresh\n")
	b.WriteString("  every time; it replaces any description you wrote before.\n\n")
	b.WriteString("## What to build\n\n")
	b.WriteString(strings.TrimSpace(task.Criteria))
	b.WriteString("\n")
	if len(task.Feedback) > 0 {
		b.WriteString("\n## Your previous attempt is already applied. An independent check found these problems\n\n")
		for _, f := range task.Feedback {
			fmt.Fprintf(&b, "- %s: %s\n", f.Criterion, f.Symptom)
		}
	}
	return b.String()
}

// DescriptionPath is where the builder describes its change for the pull
// request. It is outside the repository checkout, so it never becomes part
// of the patch.
const DescriptionPath = "/workspace/pull-request.md"

// MaxDescriptionBytes bounds what is read of the description. Anything
// longer is cut, and the controller cuts the body shorter still.
const MaxDescriptionBytes = 64 << 10

// ParseDescription splits a builder's description into a title, its first
// line that is not blank without a leading Markdown heading mark, and a
// body, the rest. Both come back as the builder wrote them otherwise.
func ParseDescription(raw []byte) (title, body string) {
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	text = strings.TrimLeft(text, " \t\n")
	first, rest, _ := strings.Cut(text, "\n")
	title = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(first), "#"))
	return title, strings.Trim(rest, "\n")
}

func tarOf(files map[string][]byte) *bytes.Buffer {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for name, data := range files {
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(data))})
		_, _ = tw.Write(data)
	}
	_ = tw.Close()
	return &buf
}

// tail returns the end of the agent's output, made safe to print: control
// characters, which could rewrite what the person sees in a terminal, are
// replaced.
func tail(b []byte, n int) string {
	s := strings.TrimSpace(string(b))
	if len(s) > n {
		s = s[len(s)-n:]
		for !utf8.ValidString(s) && len(s) > 0 {
			s = s[1:]
		}
		s = "…" + s
	}
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) || r == utf8.RuneError {
			return '?'
		}
		return r
	}, s)
}

// Codex returns the script that runs Codex CLI against the proxy, which
// serves the OpenAI Responses API at proxyURL (for example
// http://sf-run-proxy:8080/v1). Codex's own sandbox is turned off because the
// container is the sandbox; inside it, Codex's sandbox could not start.
func Codex(proxyURL, model string) (string, error) {
	if !regexp.MustCompile(`^http://[a-z0-9-]+:[0-9]+/v1$`).MatchString(proxyURL) {
		return "", fmt.Errorf("sandboxed: proxy URL %q is not of the expected form", proxyURL)
	}
	if !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$`).MatchString(model) {
		return "", fmt.Errorf("sandboxed: model %q is not a model name", model)
	}
	provider := `model_providers.sf={ name = "sprintfoundry proxy", base_url = "` + proxyURL + `", wire_api = "responses" }`
	// Codex refuses to start if its home directory does not exist, and the
	// sandbox's home is a fresh in-memory directory.
	return "mkdir -p \"${CODEX_HOME:-$HOME/.codex}\" && " +
		"codex exec --json --skip-git-repo-check --ephemeral --dangerously-bypass-approvals-and-sandbox " +
		"--cd /workspace/repo -m " + model + " " +
		"-c '" + provider + "' -c 'model_provider=\"sf\"' " +
		"-c 'check_for_update_on_startup=false' -c 'analytics.enabled=false' " +
		// Web search runs on the provider's side; the proxy would refuse
		// every request that offers it.
		"-c 'web_search=\"disabled\"' " +
		"- < /sf/task.md", nil
}

// CodexImageDockerfile is the agent image: Node, Git and a pinned Codex CLI.
// The controller builds it with network access; it contains nothing a
// builder wrote.
const CodexImageDockerfile = `FROM docker.io/library/node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@0.171.0 \
 && npm cache clean --force
USER node
`
