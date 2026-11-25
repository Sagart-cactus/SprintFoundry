# 0010: Linear issues, and pull requests the builder describes

Status: proposed on 24 November 2026. Needs the owner's review.

## Context

The durable controller (0009) takes work only from GitHub issues, and it writes every pull request itself: the title is `SprintFoundry: issue #N` and the body is fixed. The owner wants two changes:

1. Work can come from a Linear issue.
2. The builder decides how its pull request reads. SprintFoundry only adds a footer that says the change was built and evaluated by SprintFoundry, the way Claude Code adds "Generated with Claude Code".

The code stays on GitHub. A Linear issue only replaces the GitHub issue as the source of the criteria.

## Decisions

### 1. `approve --linear ENG-123` freezes a Linear issue

`sprintfoundry approve --linear ENG-123 --repo OWNER/NAME --checks checks.yaml` works like `--issue N` (0009, decision 1): the first call shows the issue's title and description as they would be frozen, with their digest, and a second call with `--digest` approves exactly that text. The same hidden-character rules apply. The issue must be in an open state (triage, backlog, unstarted or started; any other state type, including duplicate and any Linear adds later, counts as closed) and must not be archived or in the trash. `--repo` is required, because nothing in a Linear issue says which repository it belongs to.

The controller reads Linear with a personal API key from `LINEAR_API_KEY`. It only reads: the issue, and the open issues labelled `sprintfoundry`. The key stays with the controller, like the `gh` token, and is sent only to `api.linear.app`; a read-only key is enough. Without the key, everything else works as before.

`serve` also lists open Linear issues labelled `sprintfoundry` that have no job yet, with the `approve` command to run. It cannot know their repository, so the command asks for `--repo`.

A job records where its issue came from: `github` with the issue number, or `linear` with the identifier and Linear's own ID for the issue. The ID is what makes a Linear job unique and what `approve` and `serve` compare: an issue that moves to another team gets a new identifier but keeps its ID, so it is not offered or approved a second time by accident. `approve` asks for `--again` when the Linear issue already has a job in any repository. Job IDs for Linear issues carry the identifier (`job-eng-123-<hash>`), so the branch `sprintfoundry/job-eng-123-<hash>` names the issue. Linear's GitHub integration links a pull request to the issue by the identifier in its branch, and the footer says `Fixes ENG-123`, so merging the pull request moves the issue as the team's Linear workflow says. SprintFoundry itself never writes to Linear.

Rejected: writing comments or state changes to Linear from the controller. It needs a write key, and Linear's own GitHub integration already does it from the branch and the footer.

### 2. The builder writes the pull request's title and body

The builder's task now asks it to describe its change in `/workspace/pull-request.md`: the title on the first line, then a blank line, then the body. The file is outside the repository checkout, so it is never part of the patch. The builder writes it again every round; the description of the passing round is used. A builder that writes nothing gets the issue's title and an empty body.

The description is untrusted text from the builder, shown to reviewers and read by GitHub and Linear. A builder can be steered by text in the issue, and the pull request is opened before anyone reads it, so the cleaning must hold against a builder that tries to get around it. Before the description is stored, the controller:

- keeps the title to one line of at most 120 characters, and the body to 20,000 bytes;
- removes the characters a terminal or browser could show differently (the same set `approve` refuses) and HTML comments, so what a reviewer reads is all there is;
- in the body, escapes every `<` that could start HTML, so no HTML can hide, strike out or swallow anything (a code sample shows `&lt;` for such a `<`);
- escapes every `&` that could start a character reference (except `&lt;`, which can only show `<`), so nothing decodes to `@`, `#` or a keyword;
- replaces `@` after anything but a letter, digit or underscore (GitHub's mention boundary) with `＠` (fullwidth), so the pull request notifies nobody, and `#` before a number with `＃`, so it posts no cross-reference and closes nothing on GitHub; `GH-12` gets a non-breaking hyphen;
- removes the scheme from GitHub and Linear URLs, and replaces the slash in `issues/12`, `pull/12` and `discussions/12` with `∕` (division slash), because GitHub links `owner/repo/issues/12` even without a host;
- rewrites a closing or linking keyword that GitHub or Linear documents, followed by issue references (`Fixes ENG-456, ENG-457`, `Implements OPS-7`, `Part of`, `Linear issue`, and Linear's `skip` and `ignore`, which would unlink the job's own issue), as "refers to", and gives the identifiers a non-breaking hyphen, so merging cannot close or move any issue but the job's own;
- gives Linear's `ENG-NEW` placeholder, which would create and link a new issue, a non-breaking hyphen wherever it stands;
- in the title, which Linear reads for identifiers even without a keyword, gives every identifier but the job's own a non-breaking hyphen.

These rewrites do not depend on how Markdown is parsed. A first version left code spans and fenced code alone, because GitHub does not act on code; review showed that any disagreement between that scanner and GitHub's parser (escaped backticks, raw HTML, autolinks, indented fences, a cut inside a span) let mentions and references through. Now every part of the text is rewritten, code included, so a construct the controller reads differently from GitHub can only make a code sample look a little odd. The stand-ins read like the characters they replace; neither GitHub nor Linear acts on them. A fuzz test checks that nothing GitHub or Linear acts on survives, for any input.

The title gets the same treatment, because it is also the commit message, which GitHub and Linear read as plain text when the commit lands.

The cleaned title and body are stored with the round's change, in the same transaction as the patch. A restarted controller opens the pull request with exactly the stored text, and the commit message (the title, then the job and round) gives the same commit after every import.

### 3. SprintFoundry's footer

Below the builder's body, after a rule, the controller adds what only it can vouch for. The body must not be able to swallow the footer: an unclosed code fence or HTML element would turn `Closes #N` into code or hide it. HTML is already escaped by the cleaning. For Markdown structure, a CommonMark parser (goldmark) checks that a paragraph written after the body stands on its own at the top level. If not, the body is quoted, which closes every block at the end of the quote; failing that, shown as a code block with a longer fence; failing that, left out with a note. pandoc's GFM reader checks the same in the tests when it is installed. The footer holds:

- the closing line for the job's own issue: `Closes #N` or `Fixes ENG-123`;
- the job, the round, the criteria digest and the evidence digest;
- that the check is advisory and the release gate evaluates the merged commit;
- `🤖 Built by SprintFoundry with Codex CLI` (the builder's name);
- the hidden job marker.

The pull request is opened with the operator's `gh` login (0008), so GitHub shows the operator as its author; the footer and the commit author (`SprintFoundry builder`) say who wrote the change.

## Consequences

- Schema: `sf_jobs` gains `source`, `issue_key`, `issue_uid` and `issue_title`; `sf_rounds` gains `pr_title` and `pr_body`. Rows written before this change are GitHub jobs and have empty descriptions; a round stored without a title keeps the commit message it was evaluated with. The uniqueness of a job moves from (repository, issue number, criteria) to (repository, source, issue number or Linear ID, criteria).
- Stop every milestone 3 controller before a controller with this change starts against the same database. An old controller would claim Linear jobs and make commits with its old messages, which the new one refuses as not the evaluated commit.
- A builder can still put anything else it likes in the body, links to other sites included. A reviewer reads it as the builder's claims; the footer is the controller's.
- The keyword rewrite is a deny list of the keywords GitHub and Linear document. A keyword either adds later would get through for Linear identifiers until it is added here (GitHub needs `#`, which is always replaced).
- In the body, a Linear identifier without a keyword is left as it is: the controller cannot tell `ENG-12` from `UTF-8` without the workspace's team keys. Linear documents linking only through keywords in the body.
- The rewrites change some harmless text: `fixes UTF-8 names` becomes "refers to UTF‑8 names", `@decorator` in a code sample becomes `＠decorator`, `List<String>` in a code sample shows as `List&lt;String>`, and a link to another issue loses its link. All of it stays readable for the reviewer.
- Two adversarial reviews (first of a version that left code alone, then of this one, checked against GitHub's own Markdown renderer) found the gaps closed above. The fuzz test's oracle encodes every form GitHub or Linear was shown to act on.
- goldmark (v1.7.8) is a new dependency, used only to check that the footer stands on its own.
