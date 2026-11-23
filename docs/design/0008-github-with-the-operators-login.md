# 0008: GitHub checks use the operator's gh login

Status: decided on 23 November 2026 with the owner. Changes the GitHub part of milestone 2.

## Decision

For now SprintFoundry talks to GitHub with the token of the operator's `gh` login, not with a GitHub App.

- `sprintfoundry register --repo OWNER/NAME ...` stores the criteria, check suite and run spec with the controller. Nothing in the repository can change them.
- `sprintfoundry check --repo OWNER/NAME --pr N` builds the pull request's head, runs the registered checks on its exact image, signs the evidence and posts an advisory commit status, `sprintfoundry/checks`. A failure names the criteria and symptoms only.
- `sprintfoundry check --repo OWNER/NAME --commit SHA` does the same for a commit after merge and posts `sprintfoundry/release-check`. Its image is the release candidate: `sprintfoundry verify` accepts that image and refuses any image of the same commit with other content (design 0002).

The token is read with `gh auth token`, stays with the controller, and reaches git through git's configuration environment, never on a command line and never in a sandbox.

Pull request checks draw on an allowance per repository and criteria (default 10), because each one tells its author which criteria failed. Release checks tell no author anything and are not counted.

### What keeps a pull request check from backing a release

Found by the milestone 2 review: a pull request check and a release check looked the same in the store, so a pull request check could supersede the release candidate's evidence and get its own head image accepted. Now:

- Every evidence statement carries a signed `check` annotation: `builder`, `pull-request` or `release`. `verify` refuses `pull-request` evidence from the statement alone.
- The store never picks pull request evidence as an image's evidence, and a pull request check supersedes nothing. A builder run or a release check still supersedes older evidence for the same criteria.
- A pull request check is recorded only after the allowance granted it.
- The operator registers the branch that matters (`--branch`, default the repository's default branch). A pull request to any other branch is not checked, and the protected paths are measured from where the pull request left that branch, so a pull request aimed at a branch that already holds its edit cannot hide it.
- A release check is only for a commit on that branch that a merged pull request produced, and the protected paths are measured from that pull request's base, so every commit it brought in counts. Anything else needs a person.
- A failed release check posts a status that names nothing; the operator sees the details. A check whose evaluation could not run posts `error`, and a check that stops for any reason after posting `pending` posts `error` on the way out.

## Rejected for now

- **A GitHub App.** It is the right identity for a shared deployment: scoped permissions, its own audit trail, short-lived installation tokens. It needs the owner to create and install it, and it adds nothing to proving the flow. It comes back when SprintFoundry runs for more than one person.
- **`verify` as a GitHub Action, and keyless signing through Actions.** Both need the controller to be reachable from GitHub's runners, or to run inside them. Today the controller runs on a laptop. They come with a hosted controller.

## Consequences

- The controller acts on GitHub with the operator's full permissions. Use it on repositories you own.
- The milestone 2 exit test, `TestGitHubExit`, runs against a real repository when `SPRINTFOUNDRY_GITHUB_TESTBED` is set, and is skipped in CI.
- Evidence is still signed with the local demo key. A production purpose needs a production signer, which comes with the hosted controller.

## Known limits

- One allowance per repository and criteria is shared by every pull request, so one author pushing again and again uses it up for everyone, and checking an unchanged head again costs another unit. A per-pull-request share and reuse of evidence for an unchanged head come with the durable controller.
- A hostile pull request's tree is fetched and archived without a size limit; the bound is the one-hour timeout. A byte cap on the fetch and a streamed archive are open.
- While git fetches, the token sits in that git process's environment, which other processes of the same user can read. Use the controller on a machine you trust; a credential helper fed through an inherited file descriptor would close this.

