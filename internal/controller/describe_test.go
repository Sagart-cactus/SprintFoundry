package controller

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

func TestCleanDescriptionKeepsOrdinaryText(t *testing.T) {
	body := "## Summary\n\nAdds `GET /health`, which returns 200.\n\n- Mail ops@example.com\n- See [docs](https://example.com/docs)\n\n```go\n// @todo fixes #3\nfmt.Println(\"x\")\n```"
	title, got := CleanDescription("Add a health check", body, "fallback")
	if title != "Add a health check" || got != body {
		t.Errorf("title %q\nbody %q", title, got)
	}
}

func TestCleanDescriptionNeutralizesWhatActsOnOthers(t *testing.T) {
	for in, want := range map[string]string{
		"Fixes #12":                                           "refers to `#12`",
		"This closes owner/repo#3.":                           "This refers to `owner/repo#3`.",
		"resolves: ENG-456":                                   "refers to `ENG-456`",
		"Fixes ENG-1, ENG-2 and #3":                           "refers to `ENG-1`, `ENG-2`, `#3`",
		"Part of OPS-7":                                       "refers to `OPS-7`",
		"closing https://github.com/o/r/issues/9":             "refers to `https://github.com/o/r/issues/9`",
		"Completes https://linear.app/acme/issue/ENG-5/add-x": "refers to `https://linear.app/acme/issue/ENG-5/add-x`",
		"thanks @alice and @acme/reviewers":                   "thanks `@alice` and `@acme/reviewers`",
		"(@bob)":                                              "(`@bob`)",
		"see #44":                                             "see `#44`",
		"see GH-44 and o/r#2":                                 "see `GH-44` and `o/r#2`",
		"https://github.com/o/r/pull/8":                       "`https://github.com/o/r/pull/8`",
	} {
		_, got := CleanDescription("t", in, "")
		if got != want {
			t.Errorf("%q\n got %q\nwant %q", in, got, want)
		}
	}
	// The title is held to the same rules: it becomes the commit message,
	// which GitHub and Linear read too.
	title, _ := CleanDescription("Fix login, fixes #7 for @carol", "", "")
	if title != "Fix login, refers to `#7` for `@carol`" {
		t.Errorf("title %q", title)
	}
}

func TestCleanDescriptionLeavesCodeAlone(t *testing.T) {
	in := "Run `fixes #1 @dave` locally.\n\n~~~\nCloses #2 @erin\n~~~\nthen fixes #3"
	_, got := CleanDescription("t", in, "")
	want := "Run `fixes #1 @dave` locally.\n\n~~~\nCloses #2 @erin\n~~~\nthen refers to `#3`"
	if got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}

func TestCleanDescriptionRemovesWhatAReaderCannotSee(t *testing.T) {
	title, body := CleanDescription("Add\u202e x\u200b\n\ty", "a<!-- fixes #9 @frank -->b\x1b[2Kc\u2066d\r\ne<!-- unclosed", "")
	if title != "Add x y" {
		t.Errorf("title %q", title)
	}
	if body != "ab[2Kcd\ne" {
		t.Errorf("body %q", body)
	}
	if !utf8.ValidString(title + body) {
		t.Error("not valid UTF-8")
	}
	_, body = CleanDescription("t", "ok\xff\xfe", "")
	if body != "ok" {
		t.Errorf("invalid UTF-8 kept: %q", body)
	}
}

func TestCleanDescriptionLimitsAndFallback(t *testing.T) {
	title, _ := CleanDescription(strings.Repeat("é", 300), "", "")
	if n := utf8.RuneCountInString(title); n != MaxTitleRunes || !strings.HasSuffix(title, "…") {
		t.Errorf("title has %d runes: %q", n, title)
	}
	_, body := CleanDescription("t", strings.Repeat("ü", MaxBodyBytes), "")
	if len(body) > MaxBodyBytes+100 || !utf8.ValidString(body) || !strings.Contains(body, "cut here") {
		t.Errorf("body of %d bytes", len(body))
	}
	for _, empty := range []string{"", "   ", "\u200b", "\n\n"} {
		title, _ := CleanDescription(empty, "", "Add a health check, fixes #4")
		if title != "Add a health check, refers to `#4`" {
			t.Errorf("fallback for %q: %q", empty, title)
		}
	}
}

func TestThePullRequestNamesItsOwnIssueInTheFooter(t *testing.T) {
	rec := postgres.RoundRecord{Number: 2, PRTitle: "Add a health check", PRBody: "Adds it.", EvidenceDigest: "sha256:e"}
	gh := postgres.Job{ID: "job-12-abc", Source: postgres.SourceGitHub, Issue: 12, Inputs: postgres.Run{CriteriaDigest: "sha256:c"}}
	body := pullRequestBody(gh, rec, "Codex CLI")
	for _, want := range []string{"Adds it.\n\n---\n\nCloses #12.", "Built by SprintFoundry with Codex CLI", "job `job-12-abc`, round 2", "`sha256:e`", "<!-- sprintfoundry-job: job-12-abc -->"} {
		if !strings.Contains(body, want) {
			t.Errorf("GitHub body lacks %q:\n%s", want, body)
		}
	}
	lin := postgres.Job{ID: "job-eng-123-abc", Source: postgres.SourceLinear, IssueKey: "ENG-123"}
	body = pullRequestBody(lin, rec, "Codex CLI")
	if !strings.Contains(body, "Fixes ENG-123\n") || strings.Contains(body, "Closes #") {
		t.Errorf("Linear body:\n%s", body)
	}
	if got := changeTitle(lin, rec); got != "Add a health check" {
		t.Errorf("title %q", got)
	}
	// A round stored before builders wrote descriptions keeps its title, so
	// its commit is the one that was evaluated.
	if got := changeTitle(gh, postgres.RoundRecord{}); got != "SprintFoundry: issue #12" {
		t.Errorf("legacy title %q", got)
	}
	if got := fallbackTitle(lin); got != "SprintFoundry: issue ENG-123" {
		t.Errorf("fallback %q", got)
	}
}
