# 0009: A durable controller that works from GitHub issues

Status: proposed on 23 November 2026, built in milestone 3. Needs the owner's review.

## Context

Milestone 3 turns the one-shot `run` and `check` commands into a controller that keeps going: it takes work from GitHub issues, runs a bounded number of jobs at once, and survives being killed at any step without opening a second pull request or paying twice for the same evaluation. The exit test is the failure-injection suite (experiment 2 in the plan): kill the controller at every step, with two jobs in flight, and show that each job finishes once.

What already existed: the effect package (intent, remote lookup, perform once, result), the Postgres journal and holds, the evaluation allowance per repository and criteria, and the GitHub adapter with the operator's `gh` login (0008).

## Decisions

### 1. An issue label is a request; only the operator approves

`sprintfoundry serve` lists open issues labelled `sprintfoundry` in each registered repository that have no job yet. A label never starts a build: anyone with triage rights can add one, and the issue can be edited after it was added.

A job starts when the operator runs `sprintfoundry approve --repo OWNER/NAME --issue N --checks checks.yaml`. The first call prints the issue's title and body as they would be frozen, with their digest. A second call with `--digest` approves exactly that text and fails if the issue changed in between. Text a terminal could show differently from what is frozen (control characters other than newline and tab, invisible and direction-changing code points) is refused. Every new text of an issue would start with a fresh allowance and request cap, so a second job for the same issue needs `--again`. Job IDs carry a hash of the repository and the criteria. The check suite stays on the operator's machine and in the store; it is never posted to GitHub. The run spec and the protected branch come from the repository's registration (0008) unless given.

Rejected: approval by a second label or a comment command. Both need the controller to prove that the text it froze is the text the approver read, which GitHub's edit history makes awkward and racy.

### 2. Publishing a passing change needs a person, by default

Pushing a branch into the repository runs the repository's own CI on the builder's code, with whatever secrets that CI has, before anyone has read the change. So a job whose change passed stops in `awaiting_publish`, which no controller claims. The reason names the full commit and every path it changes. `sprintfoundry publish --job ID` approves it, with a fresh claim and failure budget; a running `serve` then pushes the branch and opens the pull request from the stored result, without evaluating again. `serve --auto-publish` skips the approval for every job that controller runs, in every repository it serves; run it only where the operator accepts that risk for all of them.

Whatever the run spec says, a change to CI configuration counts as touching a protected path: it goes to a person and is never pushed, with or without approval or auto-publish. This is a deny list of the CI systems known to read their configuration from the repository (`.github/`, `.gitlab-ci.yml`, `.circleci/`, `Jenkinsfile`, Cirrus, Semaphore, AppVeyor, CodeBuild, Drone, Woodpecker and others, in both `.yml` and `.yaml` spellings); anything else a repository's CI reads belongs in the run spec's sensitive paths.

### 3. Jobs live in Postgres and are leased

A job row holds its frozen inputs, its base commit and branch, and a state: `queued`, `running`, `passed`, `needs_owner`. A worker claims a job with `SELECT ... FOR UPDATE SKIP LOCKED` and holds a lease that it renews every third of its length. Every claim has its own owner token, so a job that one goroutine let lapse and another claimed is never held by both. Every write a job makes checks the lease in the same statement; a holder that lost its lease cannot record anything. `serve --workers N` (default 2) bounds concurrency per controller; several controllers can share one database.

### 4. Every step is either recorded or safe to repeat

On resume a job continues from what the store says happened:

| Step | Recorded as | On resume |
| --- | --- | --- |
| Allowance for round k | the round row, created in the same transaction that takes the evaluation | not taken again |
| Builder attempt | attempt count and requests reserved on the round row, before the builder starts | counted even if cut short; at most two attempts per round |
| Builder change | patch, tested tree and time on the round row | the builder is not asked again |
| Import | the commit date comes from the round row | the same commit every time |
| Build and evaluation | the signed evidence and the round result, in one transaction | not evaluated again once stored; never evidence without its result |
| Next round | the stored patch of the previous round goes to the builder | the builder starts from its previous change in any process |
| Finished round in another controller | nothing new | the commit is imported again from the stored change and must equal the evaluated commit before anything uses it |
| Protected paths | none | a passing change that touches them, or CI configuration, goes to a person and is never pushed |
| Publishing | `awaiting_publish` until a person approves, unless auto-publish | the approved job resumes from the stored result |
| Push branch `sprintfoundry/<job>` | effect, looked up by branch; the push can only create the branch | pushed once; a branch already at another commit sends the job to a person at once |
| Open pull request | effect, looked up by head branch; the body carries a job marker | opened once |
| Commit status | none | posted again, harmless |

### 5. A job that cannot finish goes to a person

A builder that fails to start, a build or an evaluation that cannot run, an import that fails for any reason other than the patch itself: these may be the machine's fault, so they are errors, not results. The round is not spent; the job is tried again. A builder attempt is still counted, so a builder that never hands over a change ends the round after two attempts, with the last error in the reason.

A run of a job that ends in an error is counted on the job. The job is released with a backoff and tried again; after three failures, or at once for an error retrying cannot fix (a branch already at another commit, a stored change that no longer imports to the evaluated commit), it goes to a person with the error as the reason. A job taken up ten times without finishing, because the controller keeps dying on it, goes to a person too. A controller that lost its lease stores nothing, and checks its lease again right before pushing or opening a pull request. A renewal that fails because the database was briefly unreachable is tried again; only a lease that is really gone stops the job. A controller stopped with Ctrl-C gives its jobs back at once. `sprintfoundry retry --job ID` queues a job that stopped because of errors again, keeping what was evaluated; a job that reached a result (a failing holdout, a round out of builder attempts) stays with the person. Reasons are stored as valid UTF-8, without NUL, cut on a character boundary.

Fetches into one store take turns across processes through a lock file and run with automatic gc and maintenance off; a `shallow.lock` left by a killed fetch is removed under that lock once it is a minute old. Git is stopped with SIGTERM, not killed, when its context ends, and pushes and fetches have time limits.

### 6. Model spend is capped per criteria digest, by reservation

Before each builder attempt the controller reserves that attempt's request budget (`--max-requests`) against a cap per repository and criteria digest (`--request-cap`). The proxy for the attempt is started with exactly that budget. Because the reservation comes first, a controller that crashes again and again cannot spend more than the cap. Unused requests are not given back.

### 7. Failure injection lives in the tests

The job loop calls a step hook at every boundary. It is nil in the shipped binary. The failure-injection test runs its own test binary as the controller, against real Postgres, a real bare Git repository as the remote, and a fake GitHub API that counts pull requests. The boundaries include the moment after GitHub has a branch or a pull request and before the journal records it. A kill is aimed at a named step of a named job (for example `job-11:round-stored:2`), so every (job, step) pair of a full run of two jobs is covered however the two jobs interleave. For each, the test kills the controller there and starts it again on a different store directory, as a second machine would, and checks: both jobs passed, each opened one pull request, each branch points at the passing commit and has a status, one evaluation and one evidence row per round, no round had more than two builder attempts, no failure was counted, and no effect is left without a result. Build and evaluation are faked there; the real ones are covered by the milestone 1 tests. It runs on every push in the Linux CI job.

Further tests run two controllers that hold one job each (and check that each did), with one killed at a named step; steal a job's lease between a lookup and the push, and between a lookup and opening the pull request; check that approval does not let a protected change through; check that a passing change waits for `publish` and is then pushed once; tamper with a stored commit; walk every way a job ends with a person; retry a builder, a build and an evaluation that fail once, and give up on a build that never works; and cover a branch that is already there, a pull request that can never be opened (then `retry` after the outage), a round out of builder attempts and a job the controller keeps dying on.

The suite's first full run found a real bug: when the attempts of a round were used up, the refusal overwrote the round record, and the job tried to store its result against round 0. The independent review then found that the suite never killed the window between a remote call and its record, never ran two holders, and let a passing change to protected paths be pushed. All three are fixed and tested. A second, adversarial pass (four verifiers with mutation tests, three fresh reviewers, a skeptic) confirmed the fixes and found the rest of what this design now covers: CI running on pushed code, machine errors spending rounds, a weak two-controller test, other invisible characters, and a stale `shallow.lock`. A third pass on those fixes found only minor points (approval sharing the claim budget, CI systems missing from the deny list, import faults spending rounds, `retry` on jobs with results, terminal output that could fake a row), all fixed and tested.

## Not in milestone 3

- **Release dispatch.** The plan's exit test also names "no duplicate release". On the laptop there is no release to dispatch yet: the release gate is `sprintfoundry verify` in the user's own delivery, after a release check of the merged commit (0002, 0008). Dispatching a release workflow comes with the hosted controller, as one more effect.
- A GitHub App and webhooks (0008 keeps the operator's login and polling), giving unused requests back to the cap, and a per-pull-request share of the check allowance.
- Known edges, recorded rather than fixed: the effect journal's hold is a Postgres session lock, so a controller suspended inside the short publish window holds it until its session dies; two jobs of one repository with different bases share the store's `refs/sprintfoundry/base` for a few milliseconds while bundling; a Ctrl-C during a builder attempt still counts that attempt.
