package controller

import (
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

// live finds what GitHub or Linear would act on in cleaned text: a mention,
// an issue number, a GitHub issue form, a character reference, an issue
// URL with its scheme, or a keyword before a reference.
var live = []*regexp.Regexp{
	regexp.MustCompile(`(^|[^A-Za-z0-9_])@[A-Za-z0-9]`),
	regexp.MustCompile(`#[0-9]`),
	regexp.MustCompile(`(?i)\bGH-[0-9]`),
	regexp.MustCompile(`&[#A-Za-z]`),
	regexp.MustCompile(`(?i)//(www\.)?(github\.com|linear\.app)/`),
	regexp.MustCompile(`(?i)\b(issues|pulls?|discussions)/[0-9]`),
	regexp.MustCompile(`(?i)\b[A-Za-z][A-Za-z0-9]{0,9}-NEW\b`),
}

// liveInBody is HTML that GitHub would read in a body.
var liveInBody = regexp.MustCompile(`<[A-Za-z/!?]`)

func assertInert(t *testing.T, label, s string) {
	t.Helper()
	for i, re := range live {
		for _, loc := range re.FindAllStringIndex(s, -1) {
			if i == 3 && (strings.HasPrefix(s[loc[0]:], "&amp;") || strings.HasPrefix(s[loc[0]:], "&lt;")) {
				continue // an escape
			}
			t.Errorf("%s: %q is still live in %q", label, s[loc[0]:loc[1]], s)
		}
	}
	if m := keywordRefs.FindString(s); m != "" {
		t.Errorf("%s: keyword and reference %q are still live in %q", label, m, s)
	}
}

// Each of these got past an earlier cleaner that tried to leave code alone.
var bypasses = []string{
	"\\`Fixes #99 @alice\\`",
	"<b title=\"`\">Fixes #99 @alice</b><i title=\"`\"></i>",
	"<http://a/`> Fixes #99 @alice <http://b/`>",
	"``a```Fixes #99 @alice`",
	"thanks \\@alice",
	"    ```\nFixes #99 @alice",
	"- note\n  ```\nFixes #99 @alice",
	"```x`\nFixes #99 @alice",
	"Fixes &#35;99, cc &#64;alice &commat;bob &num;7 &#x23;8",
	"``x``#99 ``y``@alice",
	"#99``x``",
	"``#99 hi",
	"``@alice hi",
	"Closes\nENG-99",
	"part of\nOPS-7",
	"Fixes:\nENG-1, ENG-2",
	"Implements ENG-99",
	"Linear issue ENG-99",
	"Fixes `#12` and **ENG-5**",
	"closing https://github.com/o/r/issues/9",
	"Fixes HTTPS://WWW.GitHub.com/o/r/pull/3",
	"[x](https://github.com/o/r/issues/5) and <a href=\"//github.com/o/r/issues/6\">y</a>",
	"Completes https://linear.app/acme/issue/ENG-5/add-x",
	"see GH-44 and o/r#2 and @acme/reviewers",
	"fi\u200bxes #3 @\u200balice",
	"&#70;ixes ENG-3",
	"see https://github.com/rails/rails/issues/1 and github.com/r/r/pull/2 and plain rails/rails/issues/3 and o/r/discussions/4",
	"Fixes https://github.com/octocat/Hello-World/issues/1",
	"thanks .@alice -@bob +@carol %@dave a.@erin end.@acme/team",
	"ENG-NEW and Fixes ENG-NEW and Refs ops-new",
	"Ignore ENG-999 and skip ENG-1, ENG-2 and ignore https://linear.app/x/issue/ENG-1/y",
	"Fixes ENG-1" + strings.Repeat(",closes,https://github.com/o/r/issues/2", 9),
	"Fixes ENG-1" + strings.Repeat(",fixes,1DES-2", 12),
	"Adds it. <code>x",
	"www.example.com\\<details>",
	"https://example.com/\\<s> x",
	"See <s> for details.",
}

func TestCleanDescriptionLeavesNothingLive(t *testing.T) {
	for _, in := range bypasses {
		title, body := CleanDescription(in, in, "", "")
		assertInert(t, "body", body)
		assertInert(t, "title", title)
		if m := liveInBody.FindString(body); m != "" {
			t.Errorf("HTML %q is still live in %q", m, body)
		}
	}
}

func TestCleanDescriptionRewrites(t *testing.T) {
	for in, want := range map[string]string{
		"Fixes #12":                 "refers to ＃12",
		"This closes owner/repo#3.": "This refers to owner/repo＃3.",
		"resolves: ENG-456":         "refers to: ENG‑456",
		"Fixes ENG-1, ENG-2 and #3": "refers to ENG‑1, ENG‑2 and ＃3",
		"thanks @alice and @acme/x": "thanks ＠alice and ＠acme/x",
		"mail ops@example.com":      "mail ops@example.com",
		"see https://github.com/o/r/pull/8 and https://example.com/a": "see github.com/o/r/pull∕8 and https://example.com/a",
		"R&D &amp; &#64;":       "R&amp;D &amp;amp; &＃64;",
		"a < b and <b>bold</b>": "a < b and &lt;b>bold&lt;/b>",
		"Supports UTF-8 names.": "Supports UTF-8 names.",
	} {
		_, got := CleanDescription("t", in, "", "")
		if got != want {
			t.Errorf("%q\n got %q\nwant %q", in, got, want)
		}
	}
}

func TestCleanDescriptionKeepsOrdinaryMarkdown(t *testing.T) {
	body := "## Summary\n\nAdds `GET /health`, which returns 200.\n\n- one\n- two\n\n```go\nfmt.Println(\"x\")\n```"
	title, got := CleanDescription("Add a health check", body, "fallback", "")
	if title != "Add a health check" || got != body {
		t.Errorf("title %q\nbody %q", title, got)
	}
}

func TestTheTitleNamesNoOtherLinearIssue(t *testing.T) {
	title, _ := CleanDescription("ENG-7: add retries, see OPS-3 and UTF-8", "", "", "ENG-7")
	if title != "ENG-7: add retries, see OPS‑3 and UTF‑8" {
		t.Errorf("title %q", title)
	}
}

func TestCleanDescriptionRemovesWhatAReaderCannotSee(t *testing.T) {
	title, body := CleanDescription("Add\u202e x\u200b\n\ty", "a<!-- fixes #9 @frank -->b\x1b[2Kc\u2066d\r\ne<!-- unclosed", "", "")
	if title != "Add x y" || body != "ab[2Kcd\ne" {
		t.Errorf("title %q, body %q", title, body)
	}
	_, body = CleanDescription("t", "ok\xff\xfe", "", "")
	if body != "ok" {
		t.Errorf("invalid UTF-8 kept: %q", body)
	}
}

func TestCleanDescriptionLimitsAndFallback(t *testing.T) {
	title, _ := CleanDescription(strings.Repeat("é", 300), "", "", "")
	if n := utf8.RuneCountInString(title); n != MaxTitleRunes || !strings.HasSuffix(title, "…") {
		t.Errorf("title has %d runes: %q", n, title)
	}
	title, _ = CleanDescription(strings.Repeat("&#", 200), "", "", "")
	if n := utf8.RuneCountInString(title); n > MaxTitleRunes {
		t.Errorf("escaped title has %d runes", n)
	}
	_, body := CleanDescription("t", strings.Repeat("ü", MaxBodyBytes), "", "")
	if len(body) > MaxBodyBytes+100 || !utf8.ValidString(body) || !strings.Contains(body, "cut here") {
		t.Errorf("body of %d bytes", len(body))
	}
	// A cut cannot leave a reference live, wherever it falls.
	for pad := MaxBodyBytes - 12; pad <= MaxBodyBytes; pad++ {
		for _, tail := range []string{" o/r#1234", " @alice", " Fixes ENG-12", " &#64;bob"} {
			_, body := CleanDescription("t", strings.Repeat("a", pad)+tail, "", "")
			assertInert(t, "cut body", body)
		}
	}
	for _, empty := range []string{"", "   ", "\u200b", "\n\n"} {
		title, _ := CleanDescription(empty, "", "Add a health check, fixes #4", "")
		if title != "Add a health check, refers to ＃4" {
			t.Errorf("fallback for %q: %q", empty, title)
		}
	}
}

// Whatever the builder's body leaves open, the footer after it stands on
// its own.
func TestTheFooterCannotBeSwallowed(t *testing.T) {
	for _, body := range []string{
		"```\nunclosed fence",
		"~~~~\nunclosed tilde fence",
		"<details>\n\nhidden",
		"<div>\n<pre>",
		"- a list\n  ```\n  open in the item",
		"> quote\n> ```",
		"| a | b |\n|---|---|\n| 1 | 2 |",
		"<!-- unclosed",
		"`````\n````\n```",
		"text\n<script>",
		"plain text",
		"Adds it. <code>x",
		"<s>x",
		"<b>x",
		"<a href=x>x",
		"www.example.com\\<details>",
	} {
		_, cleaned := CleanDescription("t", body, "", "")
		contained := containBody(cleaned)
		if !standsAlone(contained, false) {
			t.Errorf("%q: the footer would not stand alone after %q", body, contained)
		}
		if strings.Contains(body, "plain") && contained != cleaned {
			t.Errorf("plain text was changed: %q", contained)
		}
	}
}

// pandoc reads GFM like GitHub does. When it is installed, check that the
// footer of a pull request whose body leaves a fence or an element open
// still renders as a paragraph of its own.
func TestTheFooterRendersOnItsOwnWithPandoc(t *testing.T) {
	if _, err := exec.LookPath("pandoc"); err != nil {
		t.Skip("pandoc not installed")
	}
	job := postgres.Job{ID: "job-12-abc", Source: postgres.SourceGitHub, Issue: 12}
	for _, body := range []string{"```\nopen", "- a\n  ```\n  open", "<details>\n\nhidden", "    ```\nx", "plain", "Adds it. <s>x", "www.example.com\\<details>", "See <s> for details."} {
		_, cleaned := CleanDescription("t", body, "", "")
		md := pullRequestBody(job, postgres.RoundRecord{Number: 1, PRBody: cleaned}, "Codex CLI")
		cmd := exec.Command("pandoc", "-f", "gfm", "-t", "html")
		cmd.Stdin = strings.NewReader(md)
		out, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(out), "<p>Closes #12.</p>") || strings.Contains(string(out), "<s>") || strings.Contains(string(out), "<details>") {
			t.Errorf("%q: the footer did not render on its own:\n%s", body, out)
		}
	}
}

func FuzzCleanDescription(f *testing.F) {
	for _, b := range bypasses {
		f.Add(b)
	}
	f.Fuzz(func(t *testing.T, in string) {
		title, body := CleanDescription(in, in, "", "")
		assertInert(t, "body", body)
		assertInert(t, "title", title)
		if m := liveInBody.FindString(body); m != "" {
			t.Fatalf("HTML %q is still live in %q", m, body)
		}
		if !utf8.ValidString(title+body) || strings.Contains(title, "\n") || utf8.RuneCountInString(title) > MaxTitleRunes {
			t.Fatalf("title %q", title)
		}
		if c := containBody(body); c != "" && !standsAlone(c, false) && !strings.HasPrefix(c, "(The builder") {
			t.Fatalf("not contained: %q", c)
		}
	})
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
	if got := changeTitle(gh, postgres.RoundRecord{}); got != "SprintFoundry: issue #12" {
		t.Errorf("legacy title %q", got)
	}
	if got := fallbackTitle(lin); got != "SprintFoundry: issue ENG-123" {
		t.Errorf("fallback %q", got)
	}
}
