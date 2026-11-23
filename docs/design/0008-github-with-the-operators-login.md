# 0008: GitHub checks use the operator's gh login

Status: decided on 23 November 2026 with the owner. Changes the GitHub part of milestone 2.

## Decision

For now SprintFoundry talks to GitHub with the token of the operator's `gh` login, not with a GitHub App.

- `sprintfoundry register --repo OWNER/NAME ...` stores the criteria, check suite and run spec with the controller. Nothing in the repository can change them.
- `sprintfoundry check --repo OWNER/NAME --pr N` builds the pull request's head, runs the registered checks on its exact image, signs the evidence and posts an advisory commit status, `sprintfoundry/checks`. A failure names the criteria and symptoms only.
- `sprintfoundry check --repo OWNER/NAME --commit SHA` does the same for a commit after merge and posts `sprintfoundry/release-check`. Its image is the release candidate: `sprintfoundry verify` accepts that image and refuses any image of the same commit with other content (design 0002).

The token is read with `gh auth token`, stays with the controller, and reaches git through git's configuration environment, never on a command line and never in a sandbox.

Pull request checks draw on an allowance per repository and criteria (default 10), because each one tells its author which criteria failed. Release checks tell no author anything and are not counted.

## Rejected for now

- **A GitHub App.** It is the right identity for a shared deployment: scoped permissions, its own audit trail, short-lived installation tokens. It needs the owner to create and install it, and it adds nothing to proving the flow. It comes back when SprintFoundry runs for more than one person.
- **`verify` as a GitHub Action, and keyless signing through Actions.** Both need the controller to be reachable from GitHub's runners, or to run inside them. Today the controller runs on a laptop. They come with a hosted controller.

## Consequences

- The controller acts on GitHub with the operator's full permissions. Use it on repositories you own.
- The milestone 2 exit test, `TestGitHubExit`, runs against a real repository when `SPRINTFOUNDRY_GITHUB_TESTBED` is set, and is skipped in CI.
- Evidence is still signed with the local demo key. A production purpose needs a production signer, which comes with the hosted controller.
