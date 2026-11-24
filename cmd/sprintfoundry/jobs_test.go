package main

import (
	"strings"
	"testing"

	"github.com/sagart-cactus/sprintfoundry/internal/forge/github"
)

func TestIssueCriteriaRefusesTextATerminalWouldHide(t *testing.T) {
	ok, err := issueCriteria(github.Issue{Title: " Export ", Body: "As an owner\r\n\tI can export.\r\n"})
	if err != nil || string(ok) != "# Export\n\nAs an owner\n\tI can export.\n" {
		t.Fatalf("plain text: %q %v", ok, err)
	}
	for name, body := range map[string]string{
		"escape sequence":        "fine\x1b[2Kreplaced",
		"lone carriage return":   "shown\rhidden",
		"right-to-left override": "abc\u202Edcb",
		"zero-width space":       "ex\u200Bport",
		"byte order mark":        "\uFEFFexport",
		"invalid UTF-8":          "bad \xff byte",
	} {
		if _, err := issueCriteria(github.Issue{Title: "t", Body: body}); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if _, err := issueCriteria(github.Issue{Title: "t\u2066x", Body: "b"}); err == nil {
		t.Error("an isolate in the title was accepted")
	}
	for name, r := range map[string]rune{
		"line separator": 0x2028, "paragraph separator": 0x2029, "no-break space": 0x00A0, "ideographic space": 0x3000,
		"variation selector": 0xFE0F, "variation selector supplement": 0xE0100, "combining grapheme joiner": 0x034F,
		"Hangul filler": 0x3164, "braille blank": 0x2800, "private use": 0xE000, "unassigned": 0x0378, "tag": 0xE0041,
		"Khitan filler": 0x16FE4, "blank notehead": 0x1D159, "replacement character": 0xFFFD,
	} {
		if _, err := issueCriteria(github.Issue{Title: "t", Body: "a" + string(r) + "b"}); err == nil {
			t.Errorf("%s (%U) was accepted", name, r)
		}
	}
	for _, ok := range []string{"Exporter les factures en CSV", "請求書をエクスポート", "Ñandú – naïve café", "math: a≤b, x²"} {
		if _, err := issueCriteria(github.Issue{Title: "t", Body: ok}); err != nil {
			t.Errorf("ordinary text %q was refused: %v", ok, err)
		}
	}
}

func TestPrintableEscapesWhatATerminalWouldActOn(t *testing.T) {
	got := printable("reason: \x1b[2Kfake\u202Eevil\u200B ok\nnext\xff")
	if strings.ContainsAny(got, "\x1b\u202E\u200B") || strings.Contains(got, "\xff") {
		t.Errorf("printable left raw characters: %q", got)
	}
	if !strings.Contains(got, `\u{1B}`) || !strings.Contains(got, `ok\u{A}next`) || strings.Contains(got, "\n") {
		t.Errorf("printable = %q", got)
	}
	// A literal escape in the input cannot pass for an escaped character.
	if got := printable(`fake \u{202E} row`); got != `fake \\u{202E} row` {
		t.Errorf("printable of a literal escape = %q", got)
	}
}

func TestShellQuote(t *testing.T) {
	got := shellQuote([]string{"sprintfoundry", "approve", "--checks", "my checks.yaml", "--repo", "o/r", "it's", "=checks.yaml"})
	want := `sprintfoundry approve --checks 'my checks.yaml' --repo o/r 'it'\''s' '=checks.yaml'`
	if got != want {
		t.Errorf("shellQuote = %s, want %s", got, want)
	}
}

func TestJobIDsDependOnTheRepository(t *testing.T) {
	a := jobID("github.com/o/a", 7, "sha256:"+strings.Repeat("1", 64))
	b := jobID("github.com/o/b", 7, "sha256:"+strings.Repeat("1", 64))
	if a == b || !strings.HasPrefix(a, "job-7-") || len(a) > 31 {
		t.Errorf("job IDs %q and %q", a, b)
	}
}

func TestLinearJobIDsNameTheIssue(t *testing.T) {
	d := "sha256:" + strings.Repeat("1", 64)
	a := linearJobID("github.com/o/r", "ENG-123", d)
	if !strings.HasPrefix(a, "job-eng-123-") || len(a) != len("job-eng-123-")+8 {
		t.Errorf("job ID %q", a)
	}
	if a == linearJobID("github.com/o/r", "ENG-124", d) || a == linearJobID("github.com/o/s", "ENG-123", d) {
		t.Error("job IDs do not depend on the issue and the repository")
	}
}

func TestApproveTakesExactlyOneIssue(t *testing.T) {
	for _, args := range [][]string{
		{"--repo", "o/r", "--checks", "c.yaml"},
		{"--repo", "o/r", "--checks", "c.yaml", "--issue", "3", "--linear", "ENG-1"},
		{"--repo", "o/r", "--checks", "c.yaml", "--issue", "0"},
	} {
		var out, errOut strings.Builder
		if code := approveCommand(args, &out, &errOut); code != 2 {
			t.Errorf("%v: exit %d, want 2", args, code)
		}
	}
	// A bad identifier is refused before anything is asked of GitHub or Linear.
	t.Setenv("PATH", t.TempDir())
	var out, errOut strings.Builder
	if code := approveCommand([]string{"--repo", "o/r", "--checks", "c.yaml", "--linear", "ENG-1;rm"}, &out, &errOut); code != 1 ||
		!strings.Contains(errOut.String(), "not a Linear issue identifier") {
		t.Errorf("exit %d, %s", code, errOut.String())
	}
}

func TestAnApprovedIssueNamesItself(t *testing.T) {
	gh := approvedIssue{source: "github", number: 12}
	lin := approvedIssue{source: "linear", key: "ENG-7"}
	if gh.ref() != "#12" || lin.ref() != "ENG-7" {
		t.Errorf("refs %q %q", gh.ref(), lin.ref())
	}
	if strings.Join(gh.flag(), " ") != "--issue 12" || strings.Join(lin.flag(), " ") != "--linear ENG-7" {
		t.Errorf("flags %v %v", gh.flag(), lin.flag())
	}
}
