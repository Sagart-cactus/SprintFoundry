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
	branch := fs.String("branch", "", "the branch pull requests must target and release checks must be on (default: the repository's default branch)")
	fs.Usage = func() {
		fmt.Fprint(stderr, "Usage: sprintfoundry register --repo OWNER/NAME --criteria F --checks F --runspec F [--branch B]\n\n"+
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
	// The same checks a run makes before anything is built, so a bad
	// registration fails now and not after a pull request was marked pending.
	parsed, err := controller.ParseInputs(data["criteria"], data["checks"], data["runspec"])
	if err != nil {
		fmt.Fprintf(stderr, "sprintfoundry: %v\n", err)
		return 2
	}
	suite, _ := checks.Parse(data["checks"])
	spec := parsed.Spec()
	if len(spec.Sensitive([]string{spec.Build.Dockerfile})) == 0 {
		fmt.Fprintf(stderr, "Warning: %s is not among the run spec's sensitive paths, so a pull request can change how the\n"+
			"candidate is built without a person reviewing it. Add it, and the files that define the check actors.\n", spec.Build.Dockerfile)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	env, err := open(ctx, *home, func(string, ...any) {})
	if err != nil {
		fmt.Fprintf(stderr, "sprintfoundry: %v\n", err)
		return 2
	}
	defer env.store.Close()
	reg := postgres.Registration{Repository: githubRepository(*repo), SuiteDigest: suite.Digest(), RunSpecDigest: spec.Digest(), Branch: *branch}
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
	if reg.Branch != "" {
		fmt.Fprintf(stdout, "Pull requests must target %s\n", reg.Branch)
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

// checkTarget is what a check builds and what it is measured against.
type checkTarget struct {
	Commit string
	// Base is what the protected paths are measured against.
	Base    string
	Context string
	Label   string
	// Release marks a check of a commit on the default branch after merge.
	Release bool
}

// resolveCheck works out what a check of a pull request, or of a commit
// after merge, builds and what it measures the change against.
//
// A pull request must target the default branch, and its change is
// measured from where it left that branch, so a pull request aimed at a
// branch that already holds its edit cannot hide a protected path.
//
// A release check must be of a commit on the default branch that a merged
// pull request produced. Its change is measured from that pull request's
// base, so every commit the pull request brought in counts, not only the
// last one.
func resolveCheck(ctx context.Context, client *github.Client, repo, branch string, pr int, commit string) (checkTarget, error) {
	defaultBranch := branch
	if defaultBranch == "" {
		var err error
		if defaultBranch, err = client.DefaultBranch(ctx, repo); err != nil {
			return checkTarget{}, err
		}
	}
	if pr > 0 {
		p, err := client.GetPullRequest(ctx, repo, pr)
		if err != nil {
			return checkTarget{}, err
		}
		if p.BaseRef != defaultBranch {
			return checkTarget{}, fmt.Errorf("pull request #%d targets %q; only pull requests to the registered branch %q are checked", pr, p.BaseRef, defaultBranch)
		}
		cmp, err := client.Compare(ctx, repo, defaultBranch, p.HeadSHA)
		if err != nil {
			return checkTarget{}, err
		}
		return checkTarget{Commit: p.HeadSHA, Base: cmp.MergeBase, Context: "sprintfoundry/checks",
			Label: fmt.Sprintf("pull request #%d", pr)}, nil
	}
	cmp, err := client.Compare(ctx, repo, defaultBranch, commit)
	if err != nil {
		return checkTarget{}, err
	}
	if cmp.Status != "behind" && cmp.Status != "identical" {
		return checkTarget{}, fmt.Errorf("commit %s is not on the registered branch %q (it is %s); only merged commits get a release check", commit[:12], defaultBranch, cmp.Status)
	}
	merged, found, err := client.MergedPullRequest(ctx, repo, commit)
	if err != nil {
		return checkTarget{}, err
	}
	if !found {
		return checkTarget{}, fmt.Errorf("commit %s was not produced by merging a pull request, so what it changed cannot be measured; a person must review it", commit[:12])
	}
	return checkTarget{Commit: commit, Base: merged.BaseSHA, Context: "sprintfoundry/release-check",
		Label: "commit " + commit[:12], Release: true}, nil
}

// checkStatus is the commit status a finished check posts. A release check
// tells nobody what failed: its result goes to the operator, not to an
// author, and is not counted against the allowance.
func checkStatus(res controller.Result, target checkTarget) github.Status {
	s := github.Status{Context: target.Context}
	switch {
	case res.State == controller.Passed && len(res.Rounds) > 0:
		s.State, s.Description = "success", "Checks passed on image "+res.Rounds[0].Image[:12]
	case res.Incomplete:
		s.State, s.Description = "error", "The check could not be completed"
	case target.Release:
		s.State, s.Description = "failure", "The release check did not pass; the operator has the details"
	default:
		s.State, s.Description = "failure", res.Reason
	}
	return s
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

	target, err := resolveCheck(ctx, client, repo, reg.Branch, pr, commit)
	if err != nil {
		return controller.Result{}, err
	}
	commit = target.Commit
	if !target.Release {
		allowance = max(allowance, 1)
	}
	fmt.Fprintf(out, "SprintFoundry check of %s on %s\n", target.Label, repository)

	storeDir := env.home.Path("repos", strings.ToLower(repo)+".git")
	if err := os.MkdirAll(filepath.Dir(storeDir), 0o700); err != nil {
		return controller.Result{}, err
	}
	for _, c := range []string{target.Base, commit} {
		if err := github.Fetch(ctx, storeDir, repo, c, token); err != nil {
			return controller.Result{}, err
		}
	}
	// From here on a status is always posted: pending now, and a final one
	// when the check ends, however it ends.
	final := context.WithoutCancel(ctx)
	if err := client.SetStatus(ctx, repo, commit, github.Status{State: "pending", Context: target.Context, Description: "Building and checking this commit"}); err != nil {
		return controller.Result{}, err
	}
	posted := false
	defer func() {
		if !posted {
			ctx, cancel := context.WithTimeout(final, 30*time.Second)
			defer cancel()
			_ = client.SetStatus(ctx, repo, commit, github.Status{State: "error", Context: target.Context, Description: "The check did not finish"})
		}
	}()

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
		RunID: runID, Repository: repository, StoreDir: storeDir, Base: target.Base, Commit: commit,
		Criteria: inputs["criteria"], Suite: inputs["checks"], RunSpec: inputs["runspec"],
		Purpose: signer.PurposeDemo, ImageName: repository, DigestKind: evidence.ImageConfig,
		RunnerImage: runnerImage, NameKey: env.nameKey, Labels: labels, Allowance: allowance,
		PullRequest: !target.Release,
	})
	if err != nil {
		return controller.Result{}, err
	}

	var image string
	if len(res.Rounds) > 0 {
		image = res.Rounds[0].Image
	}
	status := checkStatus(res, target)
	statusCtx, cancelStatus := context.WithTimeout(final, 30*time.Second)
	defer cancelStatus()
	if err := client.SetStatus(statusCtx, repo, commit, status); err != nil {
		return res, err
	}
	posted = true
	step("Result: %s. %s", res.State, res.Reason)
	step("Status %q posted on %s: %s", target.Context, commit[:12], status.State)

	policyPath := env.home.Path("repos", strings.ToLower(repo)+".verify-policy.yaml")
	if err := os.WriteFile(policyPath, demoPolicy(env.signer, repository, reg.CriteriaDigest, reg.SuiteDigest, reg.RunSpecDigest), 0o600); err != nil {
		return res, err
	}
	if image != "" {
		fmt.Fprintf(out, "\nAsk the release gate about this image:\n  sprintfoundry verify --policy %s %s\n", policyPath, image)
	}
	return res, nil
}
