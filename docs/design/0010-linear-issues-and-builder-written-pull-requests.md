# 0010: Linear issues, and pull requests the builder describes

Status: proposed on 24 November 2026. Needs the owner's review.

## Context

The durable controller (0009) takes work only from GitHub issues, and it writes every pull request itself: the title is `SprintFoundry: issue #N` and the body is fixed. The owner wants two changes:

1. Work can come from a Linear issue.
2. The builder decides how its pull request reads. SprintFoundry only adds a footer that says the change was built and evaluated by SprintFoundry, the way Claude Code adds "Generated with Claude Code".

The code stays on GitHub. A Linear issue only replaces the GitHub issue as the source of the criteria.

## Decisions

### 1. `approve --linear ENG-123` freezes a Linear issue

`sprintfoundry approve --linear ENG-123 --repo OWNER/NAME --checks checks.yaml` works like `--issue N` (0009, decision 1): the first call shows the issue's title and description as they would be frozen, with their digest, and a second call with `--digest` approves exactly that text. The same hidden-character rules apply. The issue must not be completed or cancelled. `--repo` is required, because nothing in a Linear issue says which repository it belongs to.

The controller reads Linear with a personal API key from `LINEAR_API_KEY`. It only reads: the issue, and the open issues labelled `sprintfoundry`. The key stays with the controller, like the `gh` token, and is sent only to `api.linear.app`; a read-only key is enough. Without the key, everything else works as before.

`serve` also lists open Linear issues labelled `sprintfoundry` that have no job yet, with the `approve` command to run. It cannot know their repository, so the command asks for `--repo`.

A job records where its issue came from: `github` with the issue number, or `linear` with the identifier. Job IDs for Linear issues carry the identifier (`job-eng-123-<hash>`), so the branch `sprintfoundry/job-eng-123-<hash>` names the issue. Linear's GitHub integration links a pull request to the issue by the identifier in its branch, and the footer says `Fixes ENG-123`, so merging the pull request moves the issue as the team's Linear workflow says. SprintFoundry itself never writes to Linear.

Rejected: writing comments or state changes to Linear from the controller. It needs a write key, and Linear's own GitHub integration already does it from the branch and the footer.

### 2. The builder writes the pull request's title and body

The builder's task now asks it to describe its change in `/workspace/pull-request.md`: the title on the first line, then a blank line, then the body. The file is outside the repository checkout, so it is never part of the patch. The builder writes it again every round; the description of the passing round is used. A builder that writes nothing gets the issue's title and an empty body.

The description is untrusted text from the builder, shown to reviewers and read by GitHub and Linear. Before it is stored, the controller:

- keeps the title to one line of at most 120 characters, and the body to 20,000 bytes;
- removes the characters a terminal or browser could show differently (the same set `approve` refuses) and HTML comments, so what a reviewer reads is all there is;
- turns `@name` and `@org/team` into code (`` `@name` ``), so the pull request notifies nobody;
- rewrites a closing or linking keyword followed by issue references (`Fixes #12`, `closes owner/repo#3`, `Resolves ENG-456, ENG-457`, `Part of OPS-7`, an issue URL) as ``refers to `#12` ``, so merging cannot close or move any issue but the job's own;
- turns any other GitHub issue reference (`#12`, `owner/repo#3`, `GH-12`, an issue or pull request URL) into code, so the pull request posts no cross-reference on another issue.

Text inside code spans and fenced code blocks is left as it is: GitHub does not act on it. The title gets the same treatment, because it is also the commit message, which GitHub and Linear read when the commit lands.

The cleaned title and body are stored with the round's change, in the same transaction as the patch. A restarted controller opens the pull request with exactly the stored text, and the commit message (the title, then the job and round) gives the same commit after every import.

### 3. SprintFoundry's footer

Below the builder's body, after a rule, the controller adds what only it can vouch for:

- the closing line for the job's own issue: `Closes #N` or `Fixes ENG-123`;
- the job, the round, the criteria digest and the evidence digest;
- that the check is advisory and the release gate evaluates the merged commit;
- `🤖 Built by SprintFoundry with Codex CLI` (the builder's name);
- the hidden job marker.

The pull request is opened with the operator's `gh` login (0008), so GitHub shows the operator as its author; the footer and the commit author (`SprintFoundry builder`) say who wrote the change.

## Consequences

- Schema: `sf_jobs` gains `source`, `issue_key` and `issue_title`; `sf_rounds` gains `pr_title` and `pr_body`. Rows written before this change are GitHub jobs and have empty descriptions. The uniqueness of a job moves from (repository, issue number, criteria) to (repository, source, issue, criteria).
- A builder can still put anything else it likes in the body, links included. A reviewer reads it as the builder's claims; the footer is the controller's.
- The closing-keyword rewrite is a deny list of the keywords GitHub and Linear document. A keyword either adds later would get through until it is added here.
- Linear also links a pull request to an issue whose identifier appears in the pull request's title. A builder that puts another issue's identifier in its title (without a keyword) links that issue. Telling an identifier from ordinary text such as `UTF-8` needs the workspace's team keys, which the controller does not read; a person sees the link before merging.
- The rewrite can change harmless text: `fixes UTF-8 names` becomes ``refers to `UTF-8` names``, and a link to another issue loses its link. Both are visible to the reviewer.
