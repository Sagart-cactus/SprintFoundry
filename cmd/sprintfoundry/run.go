package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/agent/sandboxed"
	"github.com/sagart-cactus/sprintfoundry/internal/controller"
	"github.com/sagart-cactus/sprintfoundry/internal/evaluate"
	"github.com/sagart-cactus/sprintfoundry/internal/evidence"
	"github.com/sagart-cactus/sprintfoundry/internal/gitimport"
	"github.com/sagart-cactus/sprintfoundry/internal/proxy"
	"github.com/sagart-cactus/sprintfoundry/internal/report"
	"github.com/sagart-cactus/sprintfoundry/internal/runnerimage"
	"github.com/sagart-cactus/sprintfoundry/internal/sandbox"
	"github.com/sagart-cactus/sprintfoundry/internal/sandbox/containerbox"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
	"github.com/sagart-cactus/sprintfoundry/internal/verify"
)

// liveOptions is one run of a real coding agent.
type liveOptions struct {
	Home                                         string
	RepoPath, CriteriaPath, ChecksPath, SpecPath string
	Repository                                   string
	Model, Upstream, Key                         string
	MaxRequests, MaxOutputTokens                 int64
	RepairRounds                                 int
	// AgentImage and AgentScript replace the Codex image and script. Tests
	// use them to run a stub agent; they are not offered as flags.
	AgentImage, AgentScript, AgentLabel string
}

func runCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	opts := liveOptions{}
	home := homeFlag(fs)
	fs.StringVar(&opts.RepoPath, "repo", ".", "the Git repository to change; its HEAD commit is the starting point")
	fs.StringVar(&opts.CriteriaPath, "criteria", "", "the approved criteria, in plain words (required)")
	fs.StringVar(&opts.ChecksPath, "checks", "", "the frozen check suite (required)")
	fs.StringVar(&opts.SpecPath, "runspec", "", "the run spec: how to build and preview the app (required)")
	fs.StringVar(&opts.Repository, "repository", "", "name for this repository in the evidence (default local/<directory name>)")
	fs.StringVar(&opts.Model, "model", "gpt-5", "the model Codex CLI uses")
	fs.StringVar(&opts.Upstream, "upstream", "https://api.openai.com", "the model API the proxy forwards to")
	fs.Int64Var(&opts.MaxRequests, "max-requests", 60, "the most model requests the run may make, across all rounds")
	fs.Int64Var(&opts.MaxOutputTokens, "max-output-tokens", 32000, "the most output tokens one model request may ask for")
	fs.IntVar(&opts.RepairRounds, "repair-rounds", controller.DefaultRepairRounds, "how many times a failure goes back to the builder")
	fs.Usage = func() {
		fmt.Fprint(stderr, `Usage: sprintfoundry run --criteria FILE --checks FILE --runspec FILE [--repo DIR]

Runs Codex CLI in a sandbox that holds no key, has the change checked on its
exact image, and signs the evidence. The model key is read from the
OPENAI_API_KEY environment variable and is only ever given to the proxy,
which also pins the model and caps each request's output.

A model served on this machine, for example by Ollama, needs no key:
  --upstream http://host.containers.internal:11434 --model qwen2.5-coder:7b
(use host.docker.internal with Docker).

`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if opts.CriteriaPath == "" || opts.ChecksPath == "" || opts.SpecPath == "" || fs.NArg() != 0 {
		fs.Usage()
		return 2
	}
	opts.Home = *home
	opts.Key = os.Getenv("OPENAI_API_KEY")
	if opts.Key == "" {
		// A model served on this machine needs no key.
		if u, err := url.Parse(opts.Upstream); err == nil && u.Scheme == "http" && proxy.PlainHTTPHost(u.Hostname()) {
			opts.Key = "no-key-needed-for-a-local-model"
		} else {
			fmt.Fprintln(stderr, "sprintfoundry: set OPENAI_API_KEY; it is given to the proxy only, never to the sandbox")
			return 2
		}
	}
	res, err := runLive(opts, stdout)
	if err != nil {
		fmt.Fprintf(stderr, "\nsprintfoundry: the run could not finish: %v\n", err)
		return 1
	}
	if res.State != controller.Passed {
		return 1
	}
	return 0
}

var repositoryName = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]{0,120}$`)

func runLive(opts liveOptions, out io.Writer) (controller.Result, error) {
	started := time.Now()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 3*time.Hour)
	defer cancel()
	say := func(format string, args ...any) { fmt.Fprintf(out, format+"\n", args...) }
	step := func(format string, args ...any) { fmt.Fprintf(out, "  "+format+"\n", args...) }

	if opts.MaxRequests < 1 {
		return controller.Result{}, errors.New("--max-requests must be at least 1")
	}
	if opts.MaxOutputTokens < 1 {
		opts.MaxOutputTokens = 32000
	}
	inputs := map[string][]byte{}
	for name, path := range map[string]string{"criteria": opts.CriteriaPath, "checks": opts.ChecksPath, "runspec": opts.SpecPath} {
		data, err := os.ReadFile(path)
		if err != nil {
			return controller.Result{}, fmt.Errorf("read the %s: %w", name, err)
		}
		inputs[name] = data
	}
	repoAbs, err := filepath.Abs(opts.RepoPath)
	if err != nil {
		return controller.Result{}, err
	}
	if opts.Repository == "" {
		opts.Repository = "local/" + strings.ToLower(filepath.Base(repoAbs))
	}
	if !repositoryName.MatchString(opts.Repository) {
		return controller.Result{}, fmt.Errorf("repository name %q: use lower-case letters, digits, dots, dashes and slashes", opts.Repository)
	}

	env, err := open(ctx, opts.Home, step)
	if err != nil {
		return controller.Result{}, err
	}
	defer env.store.Close()

	nonce := make([]byte, 3)
	if _, err := rand.Read(nonce); err != nil {
		return controller.Result{}, err
	}
	runID := "run-" + strconv.FormatInt(started.Unix(), 36) + "-" + hex.EncodeToString(nonce)
	work := env.home.Path("runs", runID)
	if err := os.MkdirAll(work, 0o700); err != nil {
		return controller.Result{}, err
	}
	storeDir := filepath.Join(work, "store.git")
	parent, err := gitimport.CloneBare(ctx, repoAbs, storeDir)
	if err != nil {
		return controller.Result{}, err
	}
	say("SprintFoundry run %s on %s at %s", runID, opts.Repository, parent[:12])

	labels := env.home.Labels()
	step("Building the check runner and proxy images")
	runnerImage, err := runnerimage.Build(ctx, env.cli, labels)
	if err != nil {
		return controller.Result{}, err
	}
	proxyImage, err := runnerimage.BuildProgram(ctx, env.cli, runnerimage.Proxy, labels)
	if err != nil {
		return controller.Result{}, err
	}
	agentImage, agentLabel := opts.AgentImage, opts.AgentLabel
	if agentImage == "" {
		step("Building the Codex CLI image (the first time this downloads Node and Codex CLI)")
		var buf bytes.Buffer
		tw := tar.NewWriter(&buf)
		_ = tw.WriteHeader(&tar.Header{Name: "Dockerfile", Mode: 0o644, Size: int64(len(sandboxed.CodexImageDockerfile))})
		_, _ = tw.Write([]byte(sandboxed.CodexImageDockerfile))
		_ = tw.Close()
		agentLabels := map[string]string{"sprintfoundry.component": "agent"}
		for k, v := range labels {
			agentLabels[k] = v
		}
		if agentImage, err = env.cli.BuildTrusted(ctx, &buf, agentLabels); err != nil {
			return controller.Result{}, err
		}
		agentLabel = "Codex CLI"
	} else if strings.Contains(agentImage, "@sha256:") {
		if err := env.cli.Pull(ctx, agentImage); err != nil {
			return controller.Result{}, err
		}
	}

	step("Starting the sandbox network; the proxy is the only way out and holds the key")
	net, err := containerbox.StartNetwork(ctx, env.cli, runID, containerbox.ProxyConfig{
		Image: proxyImage, Preset: "openai-responses", Upstream: opts.Upstream, Key: opts.Key,
		MaxRequests: opts.MaxRequests, Model: opts.Model, MaxTokens: opts.MaxOutputTokens, TempDir: env.home.Dir,
	}, labels)
	if err != nil {
		return controller.Result{}, err
	}
	defer net.Close(context.WithoutCancel(ctx))

	script := opts.AgentScript
	if script == "" {
		if script, err = sandboxed.Codex("http://"+net.ProxyHost+":8080/v1", opts.Model); err != nil {
			return controller.Result{}, err
		}
	}
	builder := &sandboxed.Agent{
		Label:   agentLabel,
		Sandbox: &containerbox.Backend{CLI: env.cli, Network: net.Internal, Labels: labels},
		Spec: sandbox.Spec{Image: agentImage, Network: sandbox.NetworkProxyOnly,
			Env: map[string]string{"HOME": "/home/agent", "CODEX_HOME": "/home/agent/.codex"}},
		Guard: sandbox.Guard{WorkspaceRoot: work, AllowedEnv: []string{"HOME", "CODEX_HOME"}, Secrets: []string{opts.Key}},
		Store: storeDir, Parent: parent, Script: script, Log: step,
	}

	result, err := controller.Run(ctx, controller.Deps{
		Store: env.store, Signer: env.signer, Agent: builder, Build: env.build,
		Evaluate: func(ctx context.Context, req evaluate.Request) (evaluate.Result, error) {
			return evaluate.Run(ctx, env.cli, req)
		},
		Now: time.Now, Log: step,
	}, controller.Request{
		RunID: runID, Repository: opts.Repository, StoreDir: storeDir, Parent: parent,
		Criteria: inputs["criteria"], Suite: inputs["checks"], RunSpec: inputs["runspec"],
		Purpose: signer.PurposeDemo, ImageName: opts.Repository, DigestKind: evidence.ImageConfig,
		RunnerImage: runnerImage, RepairRounds: opts.RepairRounds, NameKey: env.nameKey, Labels: labels,
	})
	if err != nil {
		return controller.Result{}, err
	}
	forwarded := net.Forwarded(context.WithoutCancel(ctx))
	if result.Reason != "" {
		step("Result: %s. %s", result.State, result.Reason)
	} else {
		step("Result: %s", result.State)
	}
	step("Model requests forwarded by the proxy: %d of at most %d", forwarded, opts.MaxRequests)

	reportPath := filepath.Join(work, "report.html")
	f, err := os.Create(reportPath)
	if err != nil {
		return result, err
	}
	err = report.Write(f, report.Page{Generated: time.Now(), Criteria: string(inputs["criteria"]),
		SignerID: env.signer.Identity(), Runs: []report.Run{{Title: agentLabel + " on " + opts.Repository, Result: result}}})
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return result, err
	}
	say("")
	say("Done in %s. Evidence report: %s", time.Since(started).Round(time.Second), reportPath)
	if result.State == controller.Passed && len(result.Rounds) > 0 {
		policyPath := filepath.Join(work, "verify-policy.yaml")
		policy := demoPolicy(env.signer, opts.Repository, result.CriteriaDigest, result.SuiteDigest, result.RunSpecDigest)
		if err := os.WriteFile(policyPath, policy, 0o600); err != nil {
			return result, err
		}
		image := result.Rounds[len(result.Rounds)-1].Image
		say("Ask the release gate about the passing image:")
		say("  sprintfoundry verify --policy %s %s", policyPath, image)
		// Sanity check: the gate must accept what the controller just passed.
		if p, err := verify.ParsePolicy(policy); err == nil {
			if ok, reason, err := env.decide(ctx, p, policyPath, verify.Image{Digest: image}, time.Now()); err == nil && !ok {
				return result, fmt.Errorf("the release gate refused an image that just passed: %s", reason)
			}
		}
	}
	return result, nil
}
