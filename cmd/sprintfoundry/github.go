package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"crypto/rand"
	"encoding/hex"

	"github.com/sagart-cactus/sprintfoundry/internal/checks"
	"github.com/sagart-cactus/sprintfoundry/internal/controller"
	"github.com/sagart-cactus/sprintfoundry/internal/evaluate"
	"github.com/sagart-cactus/sprintfoundry/internal/evidence"
	"github.com/sagart-cactus/sprintfoundry/internal/forge/github"
	"github.com/sagart-cactus/sprintfoundry/internal/runnerimage"
	"github.com/sagart-cactus/sprintfoundry/internal/runspec"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

func githubRepository(repo string) string { return "github.com/" + strings.ToLower(repo) }

func registerCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("register", flag.ContinueOnError)
	fs.SetOutput(stderr)
	home := homeFlag(fs)
	repo := fs.String("repo", "", "the GitHub repository, as owner/name (required)")
	criteriaPath := fs.String("criteria", "", "the approved criteria (required)")
	checksPath := fs.String("checks", "", "the frozen check suite (required)")
	specPath := fs.String("runspec", "", "the run spec (required)")
	fs.Usage = func() {
		fmt.Fprint(stderr, "Usage: sprintfoundry register --repo OWNER/NAME --criteria F --checks F --runspec F\n\n"+
			"Registers the inputs pull request checks for this repository use. They live with the controller,\n"+
			"never in the repository, so a pull request cannot change how it is checked.\n\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if !github.ValidRepo(*repo) || *criteriaPath == "" || *checksPath == "" || *specPath == "" {
		fs.Usage()
		return 2
	}
	data := map[string][]byte{}
	for name, path := range map[string]string{"criteria": *criteriaPath, "checks": *checksPath, "runspec": *specPath} {
		raw, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintf(stderr, "sprintfoundry: read the %s: %v\n", name, err)
			return 2
		}
		data[name] = raw
	}
	suite, err := checks.Parse(data["checks"])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	spec, err := runspec.Parse(data["runspec"])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	env, err := open(ctx, *home, func(string, ...any) {})
	if err != nil {
		fmt.Fprintf(stderr, "sprintfoundry: %v\n", err)
		return 2
	}
	defer env.store.Close()
	reg := postgres.Registration{Repository: githubRepository(*repo), SuiteDigest: suite.Digest(), RunSpecDigest: spec.Digest()}
	if reg.CriteriaDigest, err = env.store.PutInput(ctx, "criteria", data["criteria"]); err == nil {
		if err = env.store.PutInputAs(ctx, "check-suite", reg.SuiteDigest, data["checks"]); err == nil {
			if err = env.store.PutInputAs(ctx, "run-spec", reg.RunSpecDigest, data["runspec"]); err == nil {
				err = env.store.Register(ctx, reg)
			}
		}
	}
	if err != nil {
		fmt.Fprintf(stderr, "sprintfoundry: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "Registered %s\n  criteria  %s\n  checks    %s\n  run spec  %s\n", reg.Repository, reg.CriteriaDigest, reg.SuiteDigest, reg.RunSpecDigest)
	return 0
}

func checkCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	fs.SetOutput(stderr)
	home := homeFlag(fs)
	repo := fs.String("repo", "", "the GitHub repository, as owner/name (required)")
	pr := fs.Int("pr", 0, "check this pull request's head and post an advisory status on it")
	commit := fs.String("commit", "", "check this commit, for example after a merge; its image is the release candidate")
	allowance := fs.Int("allowance", 10, "how many pull request checks these criteria get in this repository, across all pull requests")
	fs.Usage = func() {
		fmt.Fprint(stderr, "Usage: sprintfoundry check --repo OWNER/NAME (--pr N | --commit SHA)\n\n"+
			"Builds the commit, runs the registered checks on its exact image, signs the evidence and posts\n"+
			"a commit status. Uses the token of your `gh` login; it never reaches a sandbox.\n\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if !github.ValidRepo(*repo) || (*pr > 0) == (*commit != "") {
		fs.Usage()
		return 2
	}
	res, err := runCheck(*home, *repo, *pr, *commit, *allowance, stdout)
	if err != nil {
		fmt.Fprintf(stderr, "\nsprintfoundry: the check could not finish: %v\n", err)
		return 1
	}
	if res.State != controller.Passed {
		return 1
	}
	return 0
}

func runCheck(homeDir, repo string, pr int, commit string, allowance int, out io.Writer) (controller.Result, error) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, time.Hour)
	defer cancel()
	step := func(format string, args ...any) { fmt.Fprintf(out, "  "+format+"\n", args...) }

	token, err := github.TokenFromGH(ctx)
	if err != nil {
		return controller.Result{}, err
	}
	client := &github.Client{Token: token}
	env, err := open(ctx, homeDir, step)
	if err != nil {
		return controller.Result{}, err
	}
	defer env.store.Close()

	repository := githubRepository(repo)
	reg, err := env.store.Registered(ctx, repository)
	if errors.Is(err, postgres.ErrNotFound) {
		return controller.Result{}, fmt.Errorf("%s is not registered; run `sprintfoundry register` first", repository)
	}
	if err != nil {
		return controller.Result{}, err
	}
	inputs := map[string][]byte{}
	for name, digest := range map[string]string{"criteria": reg.CriteriaDigest, "checks": reg.SuiteDigest, "runspec": reg.RunSpecDigest} {
		if inputs[name], err = env.store.GetInput(ctx, digest); err != nil {
			return controller.Result{}, fmt.Errorf("registered %s: %w", name, err)
		}
	}

	var base, statusContext, label string
	if pr > 0 {
		p, err := client.GetPullRequest(ctx, repo, pr)
		if err != nil {
			return controller.Result{}, err
		}
		commit, base, statusContext, label = p.HeadSHA, p.BaseSHA, "sprintfoundry/checks", fmt.Sprintf("pull request #%d", pr)
		allowance = max(allowance, 1)
	} else {
		if base, err = client.FirstParent(ctx, repo, commit); err != nil {
			return controller.Result{}, err
		}
		statusContext, label, allowance = "sprintfoundry/release-check", "commit "+commit[:12], 0
	}
	fmt.Fprintf(out, "SprintFoundry check of %s on %s\n", label, repository)

	storeDir := env.home.Path("repos", strings.ToLower(repo)+".git")
	if err := os.MkdirAll(filepath.Dir(storeDir), 0o700); err != nil {
		return controller.Result{}, err
	}
	for _, c := range []string{base, commit} {
		if err := github.Fetch(ctx, storeDir, repo, c, token); err != nil {
			return controller.Result{}, err
		}
	}
	if err := client.SetStatus(ctx, repo, commit, github.Status{State: "pending", Context: statusContext, Description: "Building and checking this commit"}); err != nil {
		return controller.Result{}, err
	}

	labels := env.home.Labels()
	runnerImage, err := runnerimage.Build(ctx, env.cli, labels)
	if err != nil {
		return controller.Result{}, err
	}
	nonce := make([]byte, 3)
	if _, err := rand.Read(nonce); err != nil {
		return controller.Result{}, err
	}
	runID := "check-" + strconv.FormatInt(time.Now().Unix(), 36) + "-" + hex.EncodeToString(nonce)
	res, err := controller.Check(ctx, controller.Deps{
		Store: env.store, Signer: env.signer, Build: env.build,
		Evaluate: func(ctx context.Context, req evaluate.Request) (evaluate.Result, error) {
			return evaluate.Run(ctx, env.cli, req)
		},
		Now: time.Now, Log: step,
	}, controller.CheckRequest{
		RunID: runID, Repository: repository, StoreDir: storeDir, Base: base, Commit: commit,
		Criteria: inputs["criteria"], Suite: inputs["checks"], RunSpec: inputs["runspec"],
		Purpose: signer.PurposeDemo, ImageName: repository, DigestKind: evidence.ImageConfig,
		RunnerImage: runnerImage, NameKey: env.nameKey, Labels: labels, Allowance: allowance,
	})
	if err != nil {
		_ = client.SetStatus(context.WithoutCancel(ctx), repo, commit, github.Status{State: "error", Context: statusContext, Description: "The check could not finish"})
		return controller.Result{}, err
	}

	status := github.Status{Context: statusContext}
	var image string
	if len(res.Rounds) > 0 {
		image = res.Rounds[0].Image
	}
	switch {
	case res.State == controller.Passed:
		status.State, status.Description = "success", "Checks passed on image "+image[:12]
	default:
		status.State, status.Description = "failure", res.Reason
	}
	if err := client.SetStatus(ctx, repo, commit, status); err != nil {
		return res, err
	}
	step("Result: %s. %s", res.State, res.Reason)
	step("Status %q posted on %s: %s", statusContext, commit[:12], status.State)

	policyPath := env.home.Path("repos", strings.ToLower(repo)+".verify-policy.yaml")
	if err := os.WriteFile(policyPath, demoPolicy(env.signer, repository, reg.CriteriaDigest, reg.SuiteDigest, reg.RunSpecDigest), 0o600); err != nil {
		return res, err
	}
	if image != "" {
		fmt.Fprintf(out, "\nAsk the release gate about this image:\n  sprintfoundry verify --policy %s %s\n", policyPath, image)
	}
	return res, nil
}
