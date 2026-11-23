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
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/sagart-cactus/sprintfoundry/internal/agent"
	"github.com/sagart-cactus/sprintfoundry/internal/agent/sandboxed"
	"github.com/sagart-cactus/sprintfoundry/internal/controller"
	"github.com/sagart-cactus/sprintfoundry/internal/evaluate"
	"github.com/sagart-cactus/sprintfoundry/internal/evidence"
	"github.com/sagart-cactus/sprintfoundry/internal/forge/github"
	"github.com/sagart-cactus/sprintfoundry/internal/proxy"
	"github.com/sagart-cactus/sprintfoundry/internal/runnerimage"
	"github.com/sagart-cactus/sprintfoundry/internal/sandbox"
	"github.com/sagart-cactus/sprintfoundry/internal/sandbox/containerbox"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

// IssueLabel marks an issue as a request for SprintFoundry. It never starts
// a build by itself; the operator approves each issue.
const IssueLabel = "sprintfoundry"

// issueCriteria is the text an approved issue is frozen as. It refuses text
// a terminal could show differently from what is frozen: see hidden.
func issueCriteria(i github.Issue) ([]byte, error) {
	text := fmt.Sprintf("# %s\n\n%s\n", strings.TrimSpace(i.Title), strings.TrimSpace(strings.ReplaceAll(i.Body, "\r\n", "\n")))
	if !utf8.ValidString(text) {
		return nil, errors.New("the issue text is not valid UTF-8")
	}
	for _, r := range text {
		if hidden(r) {
			return nil, fmt.Errorf("the issue text holds the invisible or control character %U, which a terminal may not show as it is; remove it from the issue", r)
		}
	}
	return []byte(text), nil
}

// hidden reports whether a terminal could show r as nothing, or as
// something else: control characters other than newline and tab, format
// characters (direction overrides, zero-width joiners), line and paragraph
// separators, spaces other than the plain space, private-use and unassigned
// code points, variation selectors and the code points that render blank.
func hidden(r rune) bool {
	switch {
	case r == '\n' || r == '\t' || r == ' ':
		return false
	case unicode.IsControl(r), unicode.In(r, unicode.Cf, unicode.Co, unicode.Zl, unicode.Zp, unicode.Zs, unicode.Variation_Selector):
		return true
	case !unicode.In(r, unicode.L, unicode.M, unicode.N, unicode.P, unicode.S):
		return true // unassigned, surrogate, noncharacter
	}
	switch r {
	case 0x034F, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x2800, 0x3164, 0xFFA0, 0x180B, 0x180C, 0x180D, 0x180E, 0x180F,
		0x16FE4, 0x1D159, 0xFFFD:
		return true // grapheme joiner, Hangul, Khmer and Khitan fillers, braille blank, Mongolian selectors, blank notehead, replacement character
	}
	return false
}

// printable makes text from issues, builders and job reasons safe to print
// as one line: everything hidden would refuse, newlines and tabs included,
// becomes \u{...}, and a backslash becomes \\, so an escape in the output
// always means an escaped character and no text can start a line of its own.
func printable(s string) string {
	var b strings.Builder
	for _, r := range strings.ToValidUTF8(s, "\uFFFD") {
		switch {
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\n' || r == '\t' || hidden(r):
			fmt.Fprintf(&b, "\\u{%X}", r)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// shellQuote joins words into a command a shell reads back as the same words.
func shellQuote(words []string) string {
	out := make([]string, len(words))
	for i, w := range words {
		if w != "" && strings.Trim(w, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./:@") == "" {
			out[i] = w
			continue
		}
		out[i] = "'" + strings.ReplaceAll(w, "'", `'\''`) + "'"
	}
	return strings.Join(out, " ")
}

// jobID names a job after its issue, its repository and its criteria.
func jobID(repository string, issue int, criteriaDigest string) string {
	return fmt.Sprintf("job-%d-%s", issue, postgres.Digest([]byte(repository + "\x00" + criteriaDigest))[len("sha256:"):][:8])
}

func approveCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("approve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	home := homeFlag(fs)
	repo := fs.String("repo", "", "the GitHub repository, as owner/name (required)")
	issueNumber := fs.Int("issue", 0, "the issue whose text becomes the criteria (required)")
	checksPath := fs.String("checks", "", "the check suite written for this issue (required)")
	specPath := fs.String("runspec", "", "the run spec (default: the one registered for the repository)")
	digest := fs.String("digest", "", "the criteria digest the first call printed; approves exactly that text")
	again := fs.Bool("again", false, "approve although the issue already has a job (a new job gets a new evaluation allowance)")
	fs.Usage = func() {
		fmt.Fprint(stderr, "Usage: sprintfoundry approve --repo OWNER/NAME --issue N --checks F [--runspec F] [--digest D]\n\n"+
			"Freezes an issue's title and body as the criteria of a job, with the check suite and run spec.\n"+
			"The first call shows the text and its digest; a second call with --digest approves exactly that\n"+
			"text, so an edit to the issue in between is caught. Later edits to the issue change nothing.\n\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if !github.ValidRepo(*repo) || *issueNumber < 1 || *checksPath == "" || fs.NArg() != 0 {
		fs.Usage()
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	fail := func(err error) int { fmt.Fprintf(stderr, "sprintfoundry: %v\n", err); return 1 }

	token, err := github.TokenFromGH(ctx)
	if err != nil {
		return fail(err)
	}
	client := &github.Client{Token: token}
	issue, err := client.GetIssue(ctx, *repo, *issueNumber)
	if err != nil {
		return fail(err)
	}
	if issue.PullRequest || issue.State != "open" {
		return fail(fmt.Errorf("#%d is not an open issue", *issueNumber))
	}
	criteria, err := issueCriteria(issue)
	if err != nil {
		return fail(err)
	}
	got := postgres.Digest(criteria)
	if *digest == "" {
		fmt.Fprintf(stdout, "The criteria for issue #%d on %s would be:\n\n", issue.Number, *repo)
		for _, line := range strings.Split(strings.TrimRight(string(criteria), "\n"), "\n") {
			fmt.Fprintf(stdout, "  | %s\n", line)
		}
		again := []string{"sprintfoundry", "approve", "--repo", *repo, "--issue", strconv.Itoa(issue.Number), "--checks", *checksPath}
		if *specPath != "" {
			again = append(again, "--runspec", *specPath)
		}
		again = append(again, "--digest", got)
		fmt.Fprintf(stdout, "\nCriteria digest: %s\nIf this is what should be built, approve exactly this text:\n  %s\n", got, shellQuote(again))
		return 3
	}
	if *digest != got {
		return fail(fmt.Errorf("the issue changed since its text was shown (digest now %s); read it again", got))
	}

	env, err := open(ctx, *home, func(string, ...any) {})
	if err != nil {
		return fail(err)
	}
	defer env.store.Close()
	repository := githubRepository(*repo)
	// Every new text of an issue would start with a fresh allowance and a
	// fresh request cap. Say so, and ask for it explicitly.
	jobs, err := env.store.Jobs(ctx)
	if err != nil {
		return fail(err)
	}
	var earlier []string
	for _, j := range jobs {
		if j.Repository == repository && j.Issue == issue.Number {
			earlier = append(earlier, fmt.Sprintf("%s (%s)", j.ID, j.State))
		}
	}
	if len(earlier) > 0 && !*again {
		return fail(fmt.Errorf("issue #%d already has jobs: %s. A new job starts with a new evaluation allowance and request cap; pass --again if that is what you want", issue.Number, strings.Join(earlier, ", ")))
	}
	reg, err := env.store.Registered(ctx, repository)
	if err != nil && !errors.Is(err, postgres.ErrNotFound) {
		return fail(err)
	}
	suite, err := os.ReadFile(*checksPath)
	if err != nil {
		return fail(err)
	}
	var spec []byte
	switch {
	case *specPath != "":
		if spec, err = os.ReadFile(*specPath); err != nil {
			return fail(err)
		}
	case reg.RunSpecDigest != "":
		if spec, err = env.store.GetInput(ctx, reg.RunSpecDigest); err != nil {
			return fail(err)
		}
	default:
		return fail(fmt.Errorf("%s has no registered run spec; pass --runspec", repository))
	}
	parsed, err := controller.ParseInputs(criteria, suite, spec)
	if err != nil {
		return fail(err)
	}
	branch := reg.Branch
	if branch == "" {
		if branch, err = client.DefaultBranch(ctx, *repo); err != nil {
			return fail(err)
		}
	}
	gh := &github.Repo{Client: client, Name: *repo, Token: token}
	base, found, err := gh.FindBranch(ctx, branch)
	if err != nil {
		return fail(err)
	}
	if !found {
		return fail(fmt.Errorf("branch %q not found on %s", branch, *repo))
	}
	storeDir := env.home.Path("repos", strings.ToLower(*repo)+".git")
	if err := os.MkdirAll(filepath.Dir(storeDir), 0o700); err != nil {
		return fail(err)
	}
	if err := github.Fetch(ctx, storeDir, *repo, base, token); err != nil {
		return fail(err)
	}

	job := postgres.Job{ID: jobID(repository, issue.Number, got),
		Repository: repository, Issue: issue.Number, Base: base, BaseBranch: branch}
	if job.Inputs.CriteriaDigest, err = env.store.PutInput(ctx, "criteria", criteria); err != nil {
		return fail(err)
	}
	job.Inputs.SuiteDigest, job.Inputs.RunSpecDigest = parsed.SuiteDigest(), parsed.Spec().Digest()
	if err := env.store.PutInputAs(ctx, "check-suite", job.Inputs.SuiteDigest, suite); err != nil {
		return fail(err)
	}
	if err := env.store.PutInputAs(ctx, "run-spec", job.Inputs.RunSpecDigest, spec); err != nil {
		return fail(err)
	}
	if err := env.store.CreateJob(ctx, job); err != nil {
		return fail(err)
	}
	fmt.Fprintf(stdout, "Approved job %s: issue #%d, built on %s at %s.\n`sprintfoundry serve` runs it.\n", job.ID, issue.Number, branch, base[:12])
	return 0
}

func serveCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	home := homeFlag(fs)
	workers := fs.Int("workers", 2, "how many jobs run at once")
	once := fs.Bool("once", false, "stop when no job is left instead of waiting for more")
	model := fs.String("model", "gpt-5", "the model Codex CLI uses")
	upstream := fs.String("upstream", "https://api.openai.com", "the model API the proxy forwards to")
	perAttempt := fs.Int64("max-requests", 40, "the most model requests one builder attempt may make")
	autoPublish := fs.Bool("auto-publish", false, "push a passing change and open its pull request without waiting for `sprintfoundry publish`.\nPushing runs the repository's own CI on the builder's code, with that CI's secrets")
	requestCap := fs.Int("request-cap", 240, "the most model requests reserved for one repository and criteria, across all jobs")
	maxTokens := fs.Int64("max-output-tokens", 32000, "the most output tokens one model request may ask for")
	repairs := fs.Int("repair-rounds", controller.DefaultRepairRounds, "how many times a failure goes back to the builder")
	fs.Usage = func() {
		fmt.Fprint(stderr, "Usage: sprintfoundry serve [--workers N] [--once]\n\n"+
			"Runs approved jobs: the builder in a sandbox, the checks on each candidate's exact image, then a\n"+
			"branch and a pull request for a passing change. It lists issues labelled \"sprintfoundry\" that\n"+
			"wait for `sprintfoundry approve`. A job survives the controller being stopped or killed.\n\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	key := os.Getenv("OPENAI_API_KEY")
	if key == "" {
		if u, err := url.Parse(*upstream); err == nil && u.Scheme == "http" && proxy.PlainHTTPHost(u.Hostname()) {
			key = "no-key-needed-for-a-local-model"
		} else {
			fmt.Fprintln(stderr, "sprintfoundry: set OPENAI_API_KEY; it is given to the proxy only, never to the sandbox")
			return 2
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// Job reasons and builder output can hold text a terminal would act on.
	say := func(format string, args ...any) { fmt.Fprintln(stdout, printable(fmt.Sprintf(format, args...))) }
	fail := func(err error) int { fmt.Fprintf(stderr, "sprintfoundry: %v\n", err); return 1 }

	token, err := github.TokenFromGH(ctx)
	if err != nil {
		return fail(err)
	}
	client := &github.Client{Token: token}
	env, err := open(ctx, *home, say)
	if err != nil {
		return fail(err)
	}
	defer env.store.Close()
	labels := env.home.Labels()
	say("Building the check runner, proxy and Codex CLI images")
	runnerImage, err := runnerimage.Build(ctx, env.cli, labels)
	if err != nil {
		return fail(err)
	}
	proxyImage, err := runnerimage.BuildProgram(ctx, env.cli, runnerimage.Proxy, labels)
	if err != nil {
		return fail(err)
	}
	agentImage, err := buildCodexImage(ctx, env, labels)
	if err != nil {
		return fail(err)
	}
	listWaiting(ctx, env.store, client, say)

	nonce := make([]byte, 3)
	_, _ = rand.Read(nonce)
	w := &controller.Worker{
		Store: env.store, Owner: fmt.Sprintf("serve-%d-%s", os.Getpid(), hex.EncodeToString(nonce)),
		Lease: time.Minute, Concurrency: *workers, Poll: 30 * time.Second, Log: say,
		Prepare: func(ctx context.Context, job postgres.Job, owner string) (controller.JobDeps, controller.JobSettings, error) {
			repo := strings.TrimPrefix(job.Repository, "github.com/")
			if !github.ValidRepo(repo) {
				return controller.JobDeps{}, controller.JobSettings{}, fmt.Errorf("job %s: %s is not a GitHub repository", job.ID, job.Repository)
			}
			storeDir := env.home.Path("repos", repo+".git")
			if err := github.Fetch(ctx, storeDir, repo, job.Base, token); err != nil {
				return controller.JobDeps{}, controller.JobSettings{}, err
			}
			work := env.home.Path("jobs", job.ID)
			if err := os.MkdirAll(work, 0o700); err != nil {
				return controller.JobDeps{}, controller.JobSettings{}, err
			}
			log := func(format string, args ...any) { say("["+job.ID+"] "+format, args...) }
			builder := &attemptAgent{env: env, labels: labels, jobID: job.ID, work: work, storeDir: storeDir, parent: job.Base,
				agentImage: agentImage, proxyCfg: containerbox.ProxyConfig{Image: proxyImage, Preset: "openai-responses",
					Upstream: *upstream, Key: key, MaxRequests: *perAttempt, Model: *model, MaxTokens: *maxTokens, TempDir: env.home.Dir},
				model: *model, log: log}
			deps := controller.JobDeps{
				Deps: controller.Deps{Signer: env.signer, Agent: builder, Build: env.build, Now: time.Now, Log: log,
					Evaluate: func(ctx context.Context, req evaluate.Request) (evaluate.Result, error) {
						return evaluate.Run(ctx, env.cli, req)
					}},
				Store: env.store, Journal: env.store, StoreDir: storeDir,
				Forge: &github.Repo{Client: client, Name: repo, Token: token},
			}
			return deps, controller.JobSettings{
				RepairRounds: *repairs, RequestsPerAttempt: int(*perAttempt), RequestCap: *requestCap, MaxAttempts: 2,
				Purpose: signer.PurposeDemo, ImageName: job.Repository, DigestKind: evidence.ImageConfig,
				RunnerImage: runnerImage, NameKey: env.nameKey, Labels: labels, AutoPublish: *autoPublish,
			}, nil
		},
	}
	say("Serving with %d worker(s); stop with Ctrl-C (jobs resume on the next start)", max(*workers, 1))
	if *once {
		err = w.RunUntilIdle(ctx)
	} else {
		err = w.Serve(ctx)
	}
	if err != nil && !errors.Is(err, context.Canceled) {
		return fail(err)
	}
	return 0
}

// listWaiting shows labelled issues that have no job yet.
func listWaiting(ctx context.Context, store *postgres.Store, client *github.Client, say func(string, ...any)) {
	regs, err := store.Registrations(ctx)
	if err != nil {
		say("Could not list registered repositories: %v", err)
		return
	}
	jobs, _ := store.Jobs(ctx)
	have := map[string]bool{}
	for _, j := range jobs {
		have[fmt.Sprintf("%s#%d", j.Repository, j.Issue)] = true
	}
	for _, r := range regs {
		repo := strings.TrimPrefix(r.Repository, "github.com/")
		issues, err := client.LabeledIssues(ctx, repo, IssueLabel)
		if err != nil {
			say("Could not list issues of %s: %v", repo, err)
			continue
		}
		for _, i := range issues {
			if !have[fmt.Sprintf("%s#%d", r.Repository, i.Number)] {
				say("Waiting for approval: %s#%d %q (sprintfoundry approve --repo %s --issue %d --checks ...)", repo, i.Number, i.Title, repo, i.Number)
			}
		}
	}
}

func jobsCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("jobs", flag.ContinueOnError)
	fs.SetOutput(stderr)
	home := homeFlag(fs)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	env, err := open(ctx, *home, func(string, ...any) {})
	if err != nil {
		fmt.Fprintf(stderr, "sprintfoundry: %v\n", err)
		return 1
	}
	defer env.store.Close()
	jobs, err := env.store.Jobs(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "sprintfoundry: %v\n", err)
		return 1
	}
	if len(jobs) == 0 {
		fmt.Fprintln(stdout, "No jobs.")
	}
	for _, j := range jobs {
		pr := ""
		if j.PullRequest > 0 {
			pr = fmt.Sprintf(" pull request #%d", j.PullRequest)
		}
		fmt.Fprintln(stdout, printable(fmt.Sprintf("%-24s %s#%d  %s%s  %s", j.ID, strings.TrimPrefix(j.Repository, "github.com/"), j.Issue, j.State, pr, j.Reason)))
	}
	return 0
}

// attemptAgent starts a fresh keyless sandbox network for every builder
// attempt, with the proxy's request budget equal to what the controller
// reserved for that attempt.
type attemptAgent struct {
	env              *environment
	labels           map[string]string
	jobID, work      string
	storeDir, parent string
	agentImage       string
	proxyCfg         containerbox.ProxyConfig
	model            string
	log              func(string, ...any)
}

func (a *attemptAgent) Name() string { return "Codex CLI" }

func (a *attemptAgent) Run(ctx context.Context, _ sandbox.Sandbox, _ string, task agent.Task) (agent.Change, error) {
	nonce := make([]byte, 3)
	if _, err := rand.Read(nonce); err != nil {
		return agent.Change{}, err
	}
	net, err := containerbox.StartNetwork(ctx, a.env.cli, a.jobID+"-"+hex.EncodeToString(nonce), a.proxyCfg, a.labels)
	if err != nil {
		return agent.Change{}, err
	}
	defer net.Close(context.WithoutCancel(ctx))
	script, err := sandboxed.Codex("http://"+net.ProxyHost+":8080/v1", a.model)
	if err != nil {
		return agent.Change{}, err
	}
	builder := &sandboxed.Agent{
		Label:   "Codex CLI",
		Sandbox: &containerbox.Backend{CLI: a.env.cli, Network: net.Internal, Labels: a.labels},
		Spec: sandbox.Spec{Image: a.agentImage, Network: sandbox.NetworkProxyOnly,
			Env: map[string]string{"HOME": "/home/agent", "CODEX_HOME": "/home/agent/.codex"}},
		Guard: sandbox.Guard{WorkspaceRoot: a.work, AllowedEnv: []string{"HOME", "CODEX_HOME"}, Secrets: []string{a.proxyCfg.Key}},
		Store: a.storeDir, Parent: a.parent, Script: script, Log: a.log,
	}
	change, err := builder.Run(ctx, nil, "", task)
	a.log("Model requests forwarded by the proxy for this attempt: %d of at most %d", net.Forwarded(context.WithoutCancel(ctx)), a.proxyCfg.MaxRequests)
	return change, err
}

func buildCodexImage(ctx context.Context, env *environment, labels map[string]string) (string, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	_ = tw.WriteHeader(&tar.Header{Name: "Dockerfile", Mode: 0o644, Size: int64(len(sandboxed.CodexImageDockerfile))})
	_, _ = tw.Write([]byte(sandboxed.CodexImageDockerfile))
	_ = tw.Close()
	agentLabels := map[string]string{"sprintfoundry.component": "agent"}
	for k, v := range labels {
		agentLabels[k] = v
	}
	return env.cli.BuildTrusted(ctx, &buf, agentLabels)
}

// publishCommand approves pushing a job's passing change. A running `serve`
// then pushes the branch and opens the pull request.
func publishCommand(args []string, stdout, stderr io.Writer) int {
	return jobAction("publish", "Approves pushing a job's passing change and opening its pull request. Pushing runs the\n"+
		"repository's own CI on the change, so look at the commit first. A running `sprintfoundry serve` does the rest.",
		func(ctx context.Context, s *postgres.Store, id string) error { return s.ApprovePublish(ctx, id) },
		"Approved. `sprintfoundry serve` pushes %s and opens its pull request.\n", args, stdout, stderr)
}

// retryCommand queues a job that went to a person because of errors again.
func retryCommand(args []string, stdout, stderr io.Writer) int {
	return jobAction("retry", "Queues a job that stopped because of errors again, for example after an outage. What was\n"+
		"already evaluated is kept, and counts against the same allowance and request cap.",
		func(ctx context.Context, s *postgres.Store, id string) error { return s.Requeue(ctx, id) },
		"Queued %s again. `sprintfoundry serve` takes it up.\n", args, stdout, stderr)
}

func jobAction(name, help string, act func(context.Context, *postgres.Store, string) error, done string, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	home := homeFlag(fs)
	id := fs.String("job", "", "the job (see `sprintfoundry jobs`)")
	fs.Usage = func() {
		fmt.Fprintf(stderr, "Usage: sprintfoundry %s --job ID\n\n%s\n\n", name, help)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *id == "" || fs.NArg() != 0 {
		fs.Usage()
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	env, err := open(ctx, *home, func(string, ...any) {})
	if err != nil {
		fmt.Fprintf(stderr, "sprintfoundry: %v\n", err)
		return 1
	}
	defer env.store.Close()
	if err := act(ctx, env.store, *id); err != nil {
		fmt.Fprintf(stderr, "sprintfoundry: %s\n", printable(err.Error()))
		return 1
	}
	fmt.Fprintf(stdout, done, printable(*id))
	return 0
}
