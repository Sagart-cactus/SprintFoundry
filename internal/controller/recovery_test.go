package controller_test

// The failure-injection suite (experiment 2 in the plan, the milestone 3
// exit test). The test binary runs itself as the controller with two jobs in
// flight, kills it at one step of one job after another, starts it again
// with a different store directory, and checks that every job ends once: one
// branch, one pull request, no evaluation or builder change paid for twice.
// A kill is aimed at a named step of a named job, so every (job, step) pair
// is covered however the two jobs interleave. Further tests run two
// controllers at once, steal a lease just before a push, and walk every way
// a job can end with a person.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/sagart-cactus/sprintfoundry/internal/agent"
	"github.com/sagart-cactus/sprintfoundry/internal/checks"
	"github.com/sagart-cactus/sprintfoundry/internal/controller"
	"github.com/sagart-cactus/sprintfoundry/internal/demo"
	"github.com/sagart-cactus/sprintfoundry/internal/evaluate"
	"github.com/sagart-cactus/sprintfoundry/internal/evidence"
	"github.com/sagart-cactus/sprintfoundry/internal/forge/github"
	"github.com/sagart-cactus/sprintfoundry/internal/runspec"
	"github.com/sagart-cactus/sprintfoundry/internal/sandbox"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres/pgtest"
)

// Environment of a controller child process.
const (
	envChild       = "SF_RECOVERY_CHILD"
	envDB          = "SF_RECOVERY_DB"
	envDir         = "SF_RECOVERY_DIR"
	envStore       = "SF_RECOVERY_STORE"
	envAPI         = "SF_RECOVERY_API"
	envKillAt      = "SF_RECOVERY_KILL_AT" // job:step:occurrence, job may be *
	envParent      = "SF_RECOVERY_PARENT"
	envPlan        = "SF_RECOVERY_PLAN"
	envAutoPublish = "SF_RECOVERY_AUTO_PUBLISH"
	envConcurrency = "SF_RECOVERY_CONCURRENCY"
	envSteal       = "SF_RECOVERY_STEAL"

	killedExit = 3
	repoName   = "o/r"
	lease      = 1200 * time.Millisecond

	// defaultPlan: round 1 hands over a leaky export, round 2 the fix.
	defaultPlan = "defect:leaky,fixed:pass"
)

func TestMain(m *testing.M) {
	if os.Getenv(envChild) != "" {
		os.Exit(childController())
	}
	os.Exit(m.Run())
}

// plan says, round by round, which change the builder hands over (a demo
// variant; "fail" for a builder that never produces one; "flaky" for one
// whose first attempt fails and whose second hands over the fix) and how the
// candidate behaves (pass, leaky, holdout, unreachable; "broken-once" for an
// evaluation that cannot run the first time and passes the second).
type plan []struct{ variant, app string }

// build returns the build behaviour named in the plan, if any.
func (p plan) build() string {
	for _, r := range p {
		if strings.HasPrefix(r.app, "build-") {
			return r.app
		}
	}
	return ""
}

func parsePlan(s string) plan {
	var p plan
	for _, r := range strings.Split(s, ",") {
		v, a, _ := strings.Cut(r, ":")
		p = append(p, struct{ variant, app string }{v, a})
	}
	return p
}

// childController is the controller process the suite kills. When it ends
// without being killed it prints "STEP job:step:n" for every step it passed.
func childController() int {
	ctx := context.Background()
	store, err := postgres.Open(ctx, os.Getenv(envDB))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer store.Close()
	dir, parent := os.Getenv(envDir), os.Getenv(envParent)
	killAt := os.Getenv(envKillAt)
	p := parsePlan(os.Getenv(envPlan))
	concurrency, _ := strconv.Atoi(os.Getenv(envConcurrency))
	var mu sync.Mutex
	seen := map[string]int{}
	var order []string
	stepFor := func(jobID string) func(string) {
		return func(name string) {
			mu.Lock()
			seen[jobID+":"+name]++
			key := fmt.Sprintf("%s:%s:%d", jobID, name, seen[jobID+":"+name])
			order = append(order, key)
			wild := fmt.Sprintf("*:%s:%d", name, seen[jobID+":"+name])
			mu.Unlock()
			if killAt != "" && (key == killAt || wild == killAt) {
				fmt.Fprintf(os.Stderr, "killed at %s\n", key)
				os.Exit(killedExit)
			}
		}
	}
	sgn, err := signer.NewDemo()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	storeDir := filepath.Join(dir, os.Getenv(envStore))
	var stolen sync.Map
	w := &controller.Worker{
		Store: store, Owner: fmt.Sprintf("child-%d", os.Getpid()), Lease: lease, Concurrency: concurrency, Poll: 100 * time.Millisecond,
		Log: func(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) },
		Prepare: func(ctx context.Context, job postgres.Job, owner string) (controller.JobDeps, controller.JobSettings, error) {
			scratch, err := os.MkdirTemp(dir, "builder-")
			if err != nil {
				return controller.JobDeps{}, controller.JobSettings{}, err
			}
			var forge controller.Forge = &github.Repo{Client: &github.Client{Base: os.Getenv(envAPI), Token: "tok"}, Name: repoName, Token: "tok",
				GitURL: filepath.Join(dir, "remote") + "/"}
			fmt.Printf("HELD %s\n", job.ID)
			if mode := os.Getenv(envSteal); mode != "" {
				forge = &stealingForge{Forge: forge, mode: mode, steal: func() {
					// Another controller takes this job after the lookup and
					// before the remote call.
					if _, done := stolen.LoadOrStore(job.ID, true); done {
						return
					}
					conn, err := pgx.Connect(context.Background(), os.Getenv(envDB))
					if err == nil {
						_, err = conn.Exec(context.Background(),
							`UPDATE sf_jobs SET lease_owner = 'thief', lease_until = now() + interval '1 hour' WHERE id = $1 AND lease_owner = $2`, job.ID, owner)
						conn.Close(context.Background())
					}
					if err != nil {
						fmt.Fprintf(os.Stderr, "steal %s: %v\n", job.ID, err)
					}
				}}
			}
			deps := controller.JobDeps{
				Deps: controller.Deps{
					Signer: sgn, Agent: &planBuilder{scratch: scratch, marks: dir, jobID: job.ID, store: storeDir, parent: parent, plan: p},
					Now: time.Now,
					Build: func(_ context.Context, _, commit string, _ runspec.Spec) (string, error) {
						switch p.build() {
						case "build-broken":
							return "", errors.New("the image builder is not answering")
						case "build-broken-once":
							if firstTime(filepath.Join(dir, "build-"+commit)) {
								return "", errors.New("the image builder is not answering")
							}
						}
						sum := sha256.Sum256([]byte(commit))
						return hex.EncodeToString(sum[:]), nil
					},
					Evaluate: func(ctx context.Context, r evaluate.Request) (evaluate.Result, error) {
						return evaluateByPlan(r, p, dir)
					},
				},
				Store: store, Journal: store, StoreDir: storeDir, Step: stepFor(job.ID), Forge: forge,
			}
			return deps, controller.JobSettings{
				RequestsPerAttempt: 10, RequestCap: 100, MaxAttempts: 2, AutoPublish: os.Getenv(envAutoPublish) == "1",
				Purpose: signer.PurposeDemo, ImageName: "github.com/o/r", DigestKind: evidence.ImageConfig,
				RunnerImage: strings.Repeat("5", 64), NameKey: []byte("a controller secret of 32 bytes!"),
			}, nil
		},
	}
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := w.RunUntilIdle(runCtx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	mu.Lock()
	for _, k := range order {
		fmt.Printf("STEP %s\n", k)
	}
	mu.Unlock()
	return 0
}

// stealingForge lets another controller take the job right after a lookup
// found nothing, so the lease is gone when the push ("push") or the pull
// request ("pr") would start.
type stealingForge struct {
	controller.Forge
	mode  string
	steal func()
}

func (f *stealingForge) FindBranch(ctx context.Context, branch string) (string, bool, error) {
	commit, found, err := f.Forge.FindBranch(ctx, branch)
	if err == nil && !found && f.mode == "push" {
		f.steal()
	}
	return commit, found, err
}

func (f *stealingForge) FindPullRequest(ctx context.Context, branch string) (int, bool, error) {
	n, found, err := f.Forge.FindPullRequest(ctx, branch)
	if err == nil && !found && f.mode == "pr" {
		f.steal()
	}
	return n, found, err
}

// planBuilder hands over the change the plan names for the round, whichever
// process it runs in. It knows the round from what the controller passes:
// the previous round's patch.
type planBuilder struct {
	scratch, marks, jobID, store, parent string
	plan                                 plan
}

func (b *planBuilder) Name() string { return "plan builder" }

func (b *planBuilder) Run(ctx context.Context, _ sandbox.Sandbox, _ string, task agent.Task) (agent.Change, error) {
	round := 0
	if task.Previous != nil {
		round = 1
	}
	if (round == 1) != (len(task.Feedback) > 0) {
		return agent.Change{}, errors.New("plan builder: feedback and previous patch disagree")
	}
	variant := b.plan[min(round, len(b.plan)-1)].variant
	switch variant {
	case "fail":
		return agent.Change{}, errors.New("the builder gave up")
	case "flaky":
		if firstTime(filepath.Join(b.marks, fmt.Sprintf("flaky-%s-%d", b.jobID, round))) {
			return agent.Change{}, errors.New("the sandbox could not start")
		}
		variant = "fixed"
	}
	dir, err := os.MkdirTemp(b.scratch, variant+"-")
	if err != nil {
		return agent.Change{}, err
	}
	change, err := demo.Change(ctx, dir, b.store, b.parent, variant)
	// A description that would notify someone and close another issue,
	// were it not cleaned.
	change.Title = "Export only what the owner may see (@alice, fixes #99)"
	change.Body = fmt.Sprintf("Round %d for %s.\n\nCloses #98 too.", round+1, b.jobID)
	return change, err
}

// firstTime reports whether the marker did not exist yet, and creates it.
func firstTime(marker string) bool {
	f, err := os.OpenFile(marker, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	f.Close()
	return true
}

// evaluateByPlan grades the candidate as the plan says for its round.
func evaluateByPlan(r evaluate.Request, p plan, marks string) (evaluate.Result, error) {
	round := 1
	if i := strings.LastIndex(r.RunID, "-r"); i >= 0 {
		round, _ = strconv.Atoi(r.RunID[i+2:])
	}
	app := p[min(round, len(p))-1].app
	if strings.HasPrefix(app, "build-") {
		app = "pass"
	}
	if app == "broken-once" {
		if firstTime(filepath.Join(marks, "broken-"+r.RunID)) {
			return evaluate.Result{}, errors.New("the container runtime is not answering")
		}
		app = "pass"
	}
	denied, signedOut := 403, 401
	switch app {
	case "leaky":
		denied = 200
	case "holdout":
		signedOut = 200
	}
	csv := "invoice_id,customer,amount,status\nINV-0001,Acme Tools,120.00,paid\nINV-0007,Gable Roofing,2500.00,archived\n"
	obs := []checks.Observation{
		{Check: "export-owner", HTTP: &checks.HTTPObservation{Status: 200, Header: map[string]string{"content-type": "text/csv; charset=utf-8"}, Body: csv}},
		{Check: "export-archived", HTTP: &checks.HTTPObservation{Status: 200, Body: csv}},
		{Check: "export-denied", HTTP: &checks.HTTPObservation{Status: denied}},
		{Check: "export-signed-out", HTTP: &checks.HTTPObservation{Status: signedOut}},
		{Check: "page-still-works", HTTP: &checks.HTTPObservation{Status: 200, Body: "<td>INV-0001</td>"}},
	}
	if app == "unreachable" {
		obs[0] = checks.Observation{Check: "export-owner", Error: "request failed: connection refused"}
	}
	report, err := checks.Grade(r.Suite, obs)
	return evaluate.Result{Report: report, Observations: obs, ServedBefore: r.Candidate, ServedAfter: r.Candidate}, err
}

// fakeGitHub is the API side of GitHub for the suite. Branches live in a
// real bare repository the controller pushes to.
type fakeGitHub struct {
	remote string
	mu     sync.Mutex
	prs    map[string]int // head branch -> number
	titles map[string]string
	bodies map[string]string
	opened map[string]int // head branch -> times a create was asked for
	status map[string]int // commit -> statuses posted
	next   int
	// failPulls makes every pull request creation fail.
	failPulls bool
}

func (f *fakeGitHub) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /repos/o/r/git/ref/heads/{branch...}", func(w http.ResponseWriter, r *http.Request) {
		branch := r.PathValue("branch")
		out, err := exec.Command("git", "--git-dir", f.remote, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch).Output()
		if err != nil {
			http.Error(w, `{"message":"Not Found"}`, http.StatusNotFound)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"ref": "refs/heads/" + branch, "object": map[string]string{"sha": strings.TrimSpace(string(out))}})
	})
	mux.HandleFunc("GET /repos/o/r/pulls", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		branch := strings.TrimPrefix(r.URL.Query().Get("head"), "o:")
		list := []map[string]any{}
		if n, ok := f.prs[branch]; ok {
			list = append(list, map[string]any{"number": n, "head": map[string]string{"ref": branch}})
		}
		json.NewEncoder(w).Encode(list)
	})
	mux.HandleFunc("POST /repos/o/r/pulls", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.opened[body["head"]]++
		if f.failPulls {
			http.Error(w, `{"message":"Server Error"}`, http.StatusInternalServerError)
			return
		}
		if _, exists := f.prs[body["head"]]; exists {
			http.Error(w, `{"message":"A pull request already exists"}`, http.StatusUnprocessableEntity)
			return
		}
		if !strings.Contains(body["body"], "sprintfoundry-job:") || body["base"] != "main" {
			http.Error(w, `{"message":"unexpected pull request"}`, http.StatusBadRequest)
			return
		}
		f.next++
		f.prs[body["head"]] = f.next
		f.titles[body["head"]], f.bodies[body["head"]] = body["title"], body["body"]
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]int{"number": f.next})
	})
	mux.HandleFunc("POST /repos/o/r/statuses/{sha}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.status[r.PathValue("sha")]++
		f.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		io.WriteString(w, `{}`)
	})
	return mux
}

// scenario is one fresh world: a database, two copies of the controller's
// store (a restarted controller uses the other one, as a second machine
// would), a remote repository, a fake API and two approved jobs.
type scenario struct {
	t           *testing.T
	db          string
	dir         string
	parent      string
	plan        string
	autoPublish bool
	api         *fakeGitHub
	url         string
	store       *postgres.Store
	jobs        []postgres.Job
}

func newScenario(t *testing.T, plan string) *scenario {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	s := &scenario{t: t, db: pgtest.FreshURL(t), dir: t.TempDir(), plan: plan, autoPublish: true}
	var err error
	if s.parent, err = demo.SeedStore(ctx, filepath.Join(s.dir, "store.git")); err != nil {
		t.Fatal(err)
	}
	remote := filepath.Join(s.dir, "remote", "o", "r.git")
	for _, args := range [][]string{
		{"clone", "--quiet", "--bare", filepath.Join(s.dir, "store.git"), filepath.Join(s.dir, "store2.git")},
		{"init", "--quiet", "--bare", remote},
		{"--git-dir", filepath.Join(s.dir, "store.git"), "push", "--quiet", remote, s.parent + ":refs/heads/main"},
	} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	s.api = &fakeGitHub{remote: remote, prs: map[string]int{}, opened: map[string]int{}, status: map[string]int{},
		titles: map[string]string{}, bodies: map[string]string{}}
	srv := httptest.NewServer(s.api.handler())
	t.Cleanup(srv.Close)
	s.url = srv.URL
	if s.store, err = postgres.Open(ctx, s.db); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.store.Close)
	for _, issue := range []int{11, 12} {
		criteria := append(demo.Criteria(), []byte(fmt.Sprintf("\n<!-- issue %d -->\n", issue))...)
		job := postgres.Job{ID: fmt.Sprintf("job-%d", issue), Repository: "github.com/o/r", Issue: issue, Base: s.parent, BaseBranch: "main"}
		if issue == 12 {
			// One job comes from Linear (design 0010).
			job.Source, job.Issue, job.IssueKey = postgres.SourceLinear, 0, "ENG-12"
		}
		job.Inputs.CriteriaDigest, err = s.store.PutInput(ctx, "criteria", criteria)
		if err != nil {
			t.Fatal(err)
		}
		suite, _ := checks.Parse(demo.Checks())
		spec, _ := runspec.Parse(demo.RunSpec())
		job.Inputs.SuiteDigest, job.Inputs.RunSpecDigest = suite.Digest(), spec.Digest()
		if err := s.store.PutInputAs(ctx, "check-suite", job.Inputs.SuiteDigest, demo.Checks()); err != nil {
			t.Fatal(err)
		}
		if err := s.store.PutInputAs(ctx, "run-spec", job.Inputs.RunSpecDigest, demo.RunSpec()); err != nil {
			t.Fatal(err)
		}
		if err := s.store.CreateJob(ctx, job); err != nil {
			t.Fatal(err)
		}
		s.jobs = append(s.jobs, job)
	}
	return s
}

// run says how one controller process runs.
type run struct {
	store       string // store directory: store.git or store2.git
	killAt      string // job:step:n, job may be *; empty: never
	concurrency int    // default 2
	steal       string // "push" or "pr"
}

type child struct {
	run            run
	cmd            *exec.Cmd
	stdout, stderr syncBuffer
}

// syncBuffer is a buffer the test may read while the child still writes.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func (s *scenario) start(r run) *child {
	s.t.Helper()
	if r.store == "" {
		r.store = "store.git"
	}
	if r.concurrency == 0 {
		r.concurrency = 2
	}
	c := &child{run: r, cmd: exec.Command(os.Args[0], "-test.run=^$")}
	auto := "0"
	if s.autoPublish {
		auto = "1"
	}
	c.cmd.Env = append(os.Environ(), envChild+"=1", envDB+"="+s.db, envDir+"="+s.dir, envStore+"="+r.store, envAPI+"="+s.url,
		envParent+"="+s.parent, envKillAt+"="+r.killAt, envPlan+"="+s.plan, envAutoPublish+"="+auto,
		envConcurrency+"="+strconv.Itoa(r.concurrency))
	if r.steal != "" {
		c.cmd.Env = append(c.cmd.Env, envSteal+"="+r.steal)
	}
	c.cmd.Stdout, c.cmd.Stderr = &c.stdout, &c.stderr
	if err := c.cmd.Start(); err != nil {
		s.t.Fatal(err)
	}
	return c
}

// held returns the jobs a controller took up.
func (c *child) held() map[string]bool {
	held := map[string]bool{}
	for _, line := range strings.Split(c.stdout.String(), "\n") {
		if id, ok := strings.CutPrefix(line, "HELD "); ok {
			held[id] = true
		}
	}
	return held
}

// wait waits for a controller. It fails the test unless the controller
// ended as expected: killed when a kill was asked for, cleanly otherwise. It
// returns the steps a clean run passed.
func (s *scenario) wait(c *child) []string {
	s.t.Helper()
	err := c.cmd.Wait()
	code := c.cmd.ProcessState.ExitCode()
	switch {
	case c.run.killAt != "" && code != killedExit:
		s.t.Fatalf("the controller was not killed at %s (exit %d)\n%s", c.run.killAt, code, c.stderr.String())
	case c.run.killAt == "" && err != nil:
		s.t.Fatalf("controller exited %d: %v\n%s", code, err, c.stderr.String())
	}
	var steps []string
	for _, line := range strings.Split(c.stdout.String(), "\n") {
		if k, ok := strings.CutPrefix(line, "STEP "); ok {
			steps = append(steps, k)
		}
	}
	return steps
}

func (s *scenario) controller(r run) []string {
	s.t.Helper()
	return s.wait(s.start(r))
}

func (s *scenario) job(id string) postgres.Job {
	s.t.Helper()
	job, err := s.store.GetJob(context.Background(), id)
	if err != nil {
		s.t.Fatal(err)
	}
	return job
}

func (s *scenario) branch(name string) string {
	out, err := exec.Command("git", "--git-dir", s.api.remote, "rev-parse", "--verify", "--quiet", "refs/heads/"+name).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// sql runs one statement against the scenario's database, for tests that
// tamper with what a controller stored.
func (s *scenario) sql(query string, args ...any) {
	s.t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, s.db)
	if err != nil {
		s.t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		s.t.Fatal(err)
	}
}

// checkPassed asserts that every job passed once and nothing was done twice.
func (s *scenario) checkPassed(label string, failures int) {
	s.t.Helper()
	ctx := context.Background()
	if open, _ := s.store.OpenJobs(ctx); open != 0 {
		s.t.Fatalf("%s: %d jobs still open", label, open)
	}
	if records, err := s.store.Open(ctx); err != nil || len(records) != 0 {
		s.t.Errorf("%s: effects without a recorded result: %v %v", label, records, err)
	}
	for _, j := range s.jobs {
		job := s.job(j.ID)
		branch := controller.BranchPrefix + j.ID
		rounds, err := s.store.Rounds(ctx, j.ID)
		if err != nil || len(rounds) == 0 || rounds[len(rounds)-1].Outcome != "passed" {
			s.t.Fatalf("%s: %s ended %s (%s); rounds = %+v, %v", label, j.ID, job.State, job.Reason, rounds, err)
		}
		last := rounds[len(rounds)-1]
		s.api.mu.Lock()
		opened, pr, statuses := s.api.opened[branch], s.api.prs[branch], s.api.status[last.Commit]
		title, body := s.api.titles[branch], s.api.bodies[branch]
		s.api.mu.Unlock()
		// The builder's description, cleaned, with SprintFoundry's footer
		// naming the job's own issue.
		wantTitle := "Export only what the owner may see (`@alice`, refers to `#99`)"
		own := "Closes #11."
		if j.Source == postgres.SourceLinear {
			own = "Fixes ENG-12\n"
		}
		if title != wantTitle || !strings.Contains(body, "for "+j.ID+".\n\nrefers to `#98` too.") || !strings.Contains(body, own) ||
			!strings.Contains(body, "Built by SprintFoundry with plan builder") {
			s.t.Errorf("%s: %s: pull request %q\n%s", label, j.ID, title, body)
		}
		if subject, err := exec.Command("git", "--git-dir", s.api.remote, "log", "-1", "--format=%s", last.Commit).Output(); err != nil || strings.TrimSpace(string(subject)) != wantTitle {
			s.t.Errorf("%s: %s: commit subject %q, %v", label, j.ID, subject, err)
		}
		if job.State != postgres.JobPassed || job.PullRequest == 0 || job.PullRequest != pr || job.Failures != failures {
			s.t.Errorf("%s: %s ended %s (%s), pull request %d, API has %d, %d failures (last: %s)",
				label, j.ID, job.State, job.Reason, job.PullRequest, pr, job.Failures, job.LastError)
		}
		if opened != 1 {
			s.t.Errorf("%s: %s: a pull request was asked for %d times", label, j.ID, opened)
		}
		if statuses == 0 {
			s.t.Errorf("%s: %s: no status on the passing commit", label, j.ID)
		}
		if got := s.branch(branch); got != last.Commit {
			s.t.Errorf("%s: %s: branch at %q, want the passing commit %s", label, j.ID, got, last.Commit)
		}
		for _, r := range rounds {
			if r.Attempts > 2 {
				s.t.Errorf("%s: %s round %d: %d builder attempts", label, j.ID, r.Number, r.Attempts)
			}
		}
		used, _ := s.store.EvaluationsUsed(ctx, j.Repository, j.Inputs.CriteriaDigest)
		evidenceRows, _ := s.store.EvidenceCount(ctx, j.ID)
		if used != len(rounds) || evidenceRows != len(rounds) {
			s.t.Errorf("%s: %s: %d rounds, %d evaluations taken, %d evidence rows; want one of each per round", label, j.ID, len(rounds), used, evidenceRows)
		}
	}
}

func TestRecoveryAfterAKillAtEveryStep(t *testing.T) {
	clean := newScenario(t, defaultPlan)
	steps := clean.controller(run{})
	clean.checkPassed("no kill", 0)
	if len(steps) == 0 {
		t.Fatal("a clean run passed no steps")
	}
	for _, name := range []string{"branch-pushed-unrecorded", "pull-request-opened-unrecorded", "round-stored", "change-stored"} {
		if !strings.Contains(strings.Join(steps, " "), ":"+name+":") {
			t.Fatalf("a clean run never passed %s: %v", name, steps)
		}
	}
	sort.Strings(steps)
	t.Logf("a full run of two jobs passes %d steps; killing at each", len(steps))

	for _, killAt := range steps {
		t.Run("kill at "+killAt, func(t *testing.T) {
			s := newScenario(t, defaultPlan)
			s.controller(run{killAt: killAt})
			// The restarted controller has its own store, without anything
			// the killed one imported.
			s.controller(run{store: "store2.git"})
			s.checkPassed("kill at "+killAt, 0)
		})
	}
}

func TestTwoControllersAtOnce(t *testing.T) {
	t.Run("each holds one job", func(t *testing.T) {
		s := newScenario(t, defaultPlan)
		a := s.start(run{concurrency: 1})
		b := s.start(run{store: "store2.git", concurrency: 1})
		s.wait(a)
		s.wait(b)
		s.checkPassed("two controllers", 0)
		// Each controller held one job: the work really was shared.
		if ha, hb := a.held(), b.held(); len(ha) != 1 || len(hb) != 1 || maps.Equal(ha, hb) {
			t.Errorf("controller a held %v, controller b held %v", ha, hb)
		}
	})
	for _, killAt := range []string{"*:change-stored:1", "*:round-stored:2", "*:branch-pushed-unrecorded:1", "*:pull-request-opened-unrecorded:1"} {
		t.Run("one is killed at "+killAt+" while the other runs", func(t *testing.T) {
			s := newScenario(t, defaultPlan)
			a := s.start(run{killAt: killAt, concurrency: 1})
			b := s.start(run{store: "store2.git", concurrency: 1})
			s.wait(a) // fails the test unless a was killed
			s.wait(b) // b finishes both jobs, the killed one after its lease ran out
			s.checkPassed("one killed at "+killAt, 0)
			if hb := b.held(); len(hb) != 2 {
				t.Errorf("the surviving controller held %v, want both jobs", hb)
			}
		})
	}
}

// A lease that is lost after a lookup stops the remote call: the controller
// that lost it pushes nothing or opens nothing, is not counted as failing,
// and the job still finishes once.
func TestALeaseLostJustBeforeARemoteCallStopsIt(t *testing.T) {
	for _, mode := range []string{"push", "pr"} {
		t.Run(mode, func(t *testing.T) {
			s := newScenario(t, defaultPlan)
			c := s.start(run{steal: mode})
			// Wait until the controller has given up both jobs because their
			// leases were gone, then stop it: the thief holds them for an hour.
			deadline := time.Now().Add(time.Minute)
			for !(strings.Contains(c.stderr.String(), "Job job-11 stopped") && strings.Contains(c.stderr.String(), "Job job-12 stopped")) {
				if time.Now().After(deadline) {
					t.Fatalf("the controller did not stop either job:\n%s", c.stderr.String())
				}
				time.Sleep(100 * time.Millisecond)
			}
			_ = c.cmd.Process.Kill()
			_ = c.cmd.Wait()
			if !strings.Contains(c.stderr.String(), "lease") {
				t.Errorf("the jobs did not stop for their leases:\n%s", c.stderr.String())
			}
			for _, j := range s.jobs {
				branch := controller.BranchPrefix + j.ID
				switch mode {
				case "push":
					if b := s.branch(branch); b != "" {
						t.Errorf("%s: the controller that lost its lease pushed %s", j.ID, b)
					}
				case "pr":
					if n := s.api.opened[branch]; n != 0 {
						t.Errorf("%s: the controller that lost its lease asked for a pull request %d times", j.ID, n)
					}
				}
				if f := s.job(j.ID).Failures; f != 0 {
					t.Errorf("%s: a lost lease was counted as %d failures", j.ID, f)
				}
			}
			// The thief gives up; a controller finishes the jobs, once each.
			s.sql(`UPDATE sf_jobs SET lease_owner = '', lease_until = NULL WHERE lease_owner = 'thief'`)
			s.controller(run{store: "store2.git"})
			s.checkPassed("after a stolen lease", 0)
		})
	}
}

// Without auto-publish a passing change waits for a person, and publishing
// it later pushes it once without evaluating again.
func TestAPassingChangeWaitsForAPersonToPublishIt(t *testing.T) {
	s := newScenario(t, defaultPlan)
	s.autoPublish = false
	s.controller(run{})
	ctx := context.Background()
	for _, j := range s.jobs {
		job := s.job(j.ID)
		if job.State != postgres.JobAwaitingPublish || !strings.Contains(job.Reason, "sprintfoundry publish --job "+j.ID) {
			t.Fatalf("%s: %s (%s)", j.ID, job.State, job.Reason)
		}
		if b := s.branch(controller.BranchPrefix + j.ID); b != "" {
			t.Errorf("%s: pushed before anyone approved it", j.ID)
		}
	}
	if len(s.api.opened) != 0 || len(s.api.status) != 0 {
		t.Fatalf("pull requests %v or statuses %v were posted", s.api.opened, s.api.status)
	}
	if err := s.store.ApprovePublish(ctx, "job-11"); err != nil {
		t.Fatal(err)
	}
	if err := s.store.ApprovePublish(ctx, "job-11"); !errors.Is(err, postgres.ErrWrongState) {
		t.Errorf("approving twice: %v", err)
	}
	s.controller(run{store: "store2.git"})
	if job := s.job("job-11"); job.State != postgres.JobPassed || job.PullRequest == 0 || s.api.opened[controller.BranchPrefix+"job-11"] != 1 {
		t.Errorf("job-11 after approval: %s (%s), %v", job.State, job.Reason, s.api.opened)
	}
	if job := s.job("job-12"); job.State != postgres.JobAwaitingPublish || s.branch(controller.BranchPrefix+"job-12") != "" {
		t.Errorf("job-12 was published without approval: %s", job.State)
	}
	if used, _ := s.store.EvaluationsUsed(ctx, "github.com/o/r", s.jobs[0].Inputs.CriteriaDigest); used != 2 {
		t.Errorf("publishing evaluated again: %d evaluations", used)
	}
}

// A round's stored commit that its stored change no longer imports to stops
// the job before anything is pushed.
func TestAStoredCommitThatDoesNotMatchItsChangeStopsTheJob(t *testing.T) {
	s := newScenario(t, defaultPlan)
	s.controller(run{killAt: "job-11:round-stored:2"})
	s.sql(`UPDATE sf_rounds SET commit_id = $1 WHERE job_id = 'job-11' AND number = 2`, strings.Repeat("a", 40))
	s.controller(run{store: "store2.git"})
	job := s.job("job-11")
	if job.State != postgres.JobNeedsOwner || !strings.Contains(job.Reason, "imports as") || job.Failures != 1 {
		t.Errorf("job-11: %s (%s), %d failures (a mismatch is permanent: want 1)", job.State, job.Reason, job.Failures)
	}
	if b := s.branch(controller.BranchPrefix + "job-11"); b != "" {
		t.Errorf("a branch was pushed at %s", b)
	}
}

// Every way a job ends with a person, as controller.Run ends a run.
func TestJobOutcomesThatGoToAPerson(t *testing.T) {
	tests := []struct {
		name, plan, reason string
		rounds, failures   int
	}{
		{"a passing change to protected paths is never pushed", "tamper:pass", "nothing was pushed", 1, 0},
		{"a failing holdout tells the builder nothing", "defect:holdout", "holdout check failed", 1, 0},
		{"a candidate that cannot be reached is inconclusive", "fixed:unreachable", "inconclusive", 1, 0},
		{"a builder that never produces a change, after two attempts", "fail:pass", "without handing over a change (last error: round 1: the builder did not produce a change: the builder gave up)", 1, 2},
		{"three failing rounds use up the allowance", "defect:leaky,defect:leaky", "repair limit", 3, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newScenario(t, tt.plan)
			s.controller(run{})
			for _, j := range s.jobs {
				job := s.job(j.ID)
				if job.State != postgres.JobNeedsOwner || !strings.Contains(job.Reason, tt.reason) || job.Failures != tt.failures {
					t.Errorf("%s: %s (%s), %d failures", j.ID, job.State, job.Reason, job.Failures)
				}
				rounds, _ := s.store.Rounds(context.Background(), j.ID)
				if len(rounds) != tt.rounds {
					t.Errorf("%s: %d rounds, want %d", j.ID, len(rounds), tt.rounds)
				}
				if b := s.branch(controller.BranchPrefix + j.ID); b != "" {
					t.Errorf("%s: a branch was pushed at %s", j.ID, b)
				}
			}
			s.api.mu.Lock()
			defer s.api.mu.Unlock()
			if len(s.api.opened) != 0 || len(s.api.status) != 0 {
				t.Errorf("pull requests %v or statuses %v were posted", s.api.opened, s.api.status)
			}
		})
	}
}

// A builder or an evaluation that fails once because of the machine is
// tried again: the round is not spent, and the job still passes.
func TestAMachineHiccupIsTriedAgain(t *testing.T) {
	t.Run("the builder's sandbox fails once", func(t *testing.T) {
		s := newScenario(t, "flaky:pass")
		s.controller(run{})
		s.checkPassed("flaky builder", 1)
	})
	t.Run("the evaluation cannot run once", func(t *testing.T) {
		s := newScenario(t, "fixed:broken-once")
		s.controller(run{})
		s.checkPassed("flaky evaluation", 1)
	})
}

// Approval to publish does not let a change to protected paths through.
func TestApprovalDoesNotPublishAProtectedChange(t *testing.T) {
	s := newScenario(t, "tamper:pass")
	s.autoPublish = false
	s.sql(`UPDATE sf_jobs SET publish_approved = true`)
	s.controller(run{})
	for _, j := range s.jobs {
		if job := s.job(j.ID); job.State != postgres.JobNeedsOwner || !strings.Contains(job.Reason, "nothing was pushed") {
			t.Errorf("%s: %s (%s)", j.ID, job.State, job.Reason)
		}
		if b := s.branch(controller.BranchPrefix + j.ID); b != "" {
			t.Errorf("%s: pushed %s", j.ID, b)
		}
	}
}

// A build that fails because of the machine is tried again without
// spending the round; one that never works goes to a person after three
// tries, still in its first round.
func TestABuildThatFailsIsTriedAgain(t *testing.T) {
	t.Run("once", func(t *testing.T) {
		s := newScenario(t, "fixed:build-broken-once")
		s.controller(run{})
		s.checkPassed("build broken once", 1)
	})
	t.Run("always", func(t *testing.T) {
		s := newScenario(t, "fixed:build-broken")
		s.controller(run{})
		ctx := context.Background()
		for _, j := range s.jobs {
			job := s.job(j.ID)
			rounds, _ := s.store.Rounds(ctx, j.ID)
			used, _ := s.store.EvaluationsUsed(ctx, j.Repository, j.Inputs.CriteriaDigest)
			if job.State != postgres.JobNeedsOwner || job.Failures != controller.DefaultMaxFailures || !strings.Contains(job.Reason, "could not be built") ||
				len(rounds) != 1 || rounds[0].Finished() || used != 1 {
				t.Errorf("%s: %s (%s), %d failures, rounds %+v, %d evaluations", j.ID, job.State, job.Reason, job.Failures, rounds, used)
			}
		}
	})
}

// A branch that is already there at another commit is not moved, and the
// job goes to a person at once instead of trying again and again.
func TestABranchAlreadyThereStopsTheJob(t *testing.T) {
	s := newScenario(t, defaultPlan)
	if out, err := exec.Command("git", "--git-dir", s.api.remote, "branch", controller.BranchPrefix+"job-11", "main").CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	s.controller(run{})
	job := s.job("job-11")
	if job.State != postgres.JobNeedsOwner || !strings.Contains(job.Reason, "already points at") || job.Failures != 1 {
		t.Errorf("job-11: %s (%s), %d failures", job.State, job.Reason, job.Failures)
	}
	if got := s.branch(controller.BranchPrefix + "job-11"); got != s.parent {
		t.Errorf("the existing branch was moved to %s", got)
	}
	if s.api.opened[controller.BranchPrefix+"job-11"] != 0 {
		t.Error("a pull request was asked for")
	}
	if other := s.job("job-12"); other.State != postgres.JobPassed {
		t.Errorf("the other job: %s (%s)", other.State, other.Reason)
	}
}

// A job whose pull request can never be opened goes to a person after a
// few tries, without evaluating again, and can be queued again later.
func TestAJobThatKeepsFailingGoesToAPerson(t *testing.T) {
	s := newScenario(t, defaultPlan)
	s.api.failPulls = true
	s.controller(run{})
	ctx := context.Background()
	for _, j := range s.jobs {
		job := s.job(j.ID)
		if job.State != postgres.JobNeedsOwner || job.Failures != controller.DefaultMaxFailures || !strings.Contains(job.Reason, "500") {
			t.Errorf("%s: %s (%s), %d failures", j.ID, job.State, job.Reason, job.Failures)
		}
		if used, _ := s.store.EvaluationsUsed(ctx, j.Repository, j.Inputs.CriteriaDigest); used != 2 {
			t.Errorf("%s: %d evaluations, want 2 (retries must not evaluate again)", j.ID, used)
		}
	}
	// After the outage, the operator queues the jobs again.
	s.api.mu.Lock()
	s.api.failPulls = false
	s.api.opened = map[string]int{}
	s.api.mu.Unlock()
	for _, j := range s.jobs {
		if err := s.store.Requeue(ctx, j.ID); err != nil {
			t.Fatal(err)
		}
	}
	s.controller(run{store: "store2.git"})
	s.checkPassed("after the outage", 0)
}

// A round whose builder was started the most times allowed without handing
// over a change (each start cut short by a crash) goes to a person, and no
// more requests are reserved for it.
func TestARoundOutOfBuilderAttemptsGoesToAPerson(t *testing.T) {
	s := newScenario(t, defaultPlan)
	ctx := context.Background()
	for range s.jobs {
		if _, ok, err := s.store.ClaimJob(ctx, "crashed", time.Minute); !ok || err != nil {
			t.Fatalf("claim: %v %v", ok, err)
		}
	}
	for _, j := range s.jobs {
		if _, err := s.store.StartRound(ctx, j.ID, "crashed", 1, 3); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			if _, err := s.store.BeginAttempt(ctx, j.ID, "crashed", 1, 10, 100, 2); err != nil {
				t.Fatal(err)
			}
		}
		if err := s.store.ReleaseLease(ctx, j.ID, "crashed"); err != nil {
			t.Fatal(err)
		}
	}
	s.controller(run{})
	for _, j := range s.jobs {
		job := s.job(j.ID)
		if job.State != postgres.JobNeedsOwner || !strings.Contains(job.Reason, "started 2 times in round 1") {
			t.Errorf("%s: %s (%s)", j.ID, job.State, job.Reason)
		}
		rounds, _ := s.store.Rounds(ctx, j.ID)
		if len(rounds) != 1 || rounds[0].StopReason == "" || rounds[0].Attempts != 2 {
			t.Errorf("%s rounds = %+v", j.ID, rounds)
		}
		if spent, _ := s.store.Spend(ctx, j.Repository, j.Inputs.CriteriaDigest); spent != 20 {
			t.Errorf("%s: %d requests reserved, want 20", j.ID, spent)
		}
	}
	if len(s.api.opened) != 0 {
		t.Errorf("pull requests were asked for: %v", s.api.opened)
	}
}

// A job the controller keeps dying on goes to a person.
func TestAJobTheControllerKeepsDyingOnGoesToAPerson(t *testing.T) {
	s := newScenario(t, defaultPlan)
	ctx := context.Background()
	// Simulate crashed controllers: claim both jobs and let the leases run
	// out. The lease outlasts the two claims, so each claims a different job.
	for range controller.DefaultMaxClaims {
		claimed := map[string]bool{}
		for range s.jobs {
			j, ok, err := s.store.ClaimJob(ctx, "dying", 300*time.Millisecond)
			if err != nil || !ok {
				t.Fatalf("claim: %v %v", ok, err)
			}
			claimed[j.ID] = true
		}
		if len(claimed) != len(s.jobs) {
			t.Fatalf("claimed %v", claimed)
		}
		time.Sleep(350 * time.Millisecond)
	}
	s.controller(run{})
	for _, j := range s.jobs {
		if job := s.job(j.ID); job.State != postgres.JobNeedsOwner || !strings.Contains(job.Reason, "may be crashing") {
			t.Errorf("%s: %s (%s)", j.ID, job.State, job.Reason)
		}
	}
}
