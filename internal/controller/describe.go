package controller

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
	"github.com/sagart-cactus/sprintfoundry/internal/textsafe"
)

// Limits on a builder's pull request description (design 0010).
const (
	MaxTitleRunes = 120
	MaxBodyBytes  = 20000
)

// CleanDescription makes a builder's pull request title and body safe to
// store, show and send to GitHub (design 0010, decision 2): characters a
// reader could not see are removed, and so are HTML comments; mentions are
// made code, so nobody is notified; a closing or linking keyword followed by
// issue references is rewritten, so the change can close or move no issue
// but its job's own, which the controller's footer names. The title is one
// line; an empty one becomes fallback. Text inside code is left as it is.
func CleanDescription(title, body, fallback string) (string, string) {
	title = strings.Join(strings.Fields(strings.Map(visible(true), title)), " ")
	title = neutralize(title)
	if title == "" {
		title = strings.Join(strings.Fields(strings.Map(visible(true), fallback)), " ")
		title = neutralize(title)
	}
	title = cutRunes(title, MaxTitleRunes)

	body = strings.ReplaceAll(body, "\r\n", "\n")
	body = strings.Map(visible(false), body)
	body = stripComments(body)
	body = neutralizeBlocks(body)
	body = strings.Trim(body, "\n")
	if len(body) > MaxBodyBytes {
		body = cutBytes(body, MaxBodyBytes) + "\n\n(The builder's description was cut here.)"
	}
	return title, body
}

// visible keeps the characters a reader sees. In a title, newlines and tabs
// become spaces.
func visible(oneLine bool) func(rune) rune {
	return func(r rune) rune {
		switch {
		case r == utf8.RuneError:
			return -1
		case r == '\n' || r == '\t':
			if oneLine {
				return ' '
			}
			return r
		case textsafe.Hidden(r):
			return -1
		}
		return r
	}
}

// stripComments removes HTML comments, which GitHub does not show. An
// unclosed comment runs to the end.
func stripComments(s string) string {
	for {
		i := strings.Index(s, "<!--")
		if i < 0 {
			return s
		}
		j := strings.Index(s[i+4:], "-->")
		if j < 0 {
			return s[:i]
		}
		s = s[:i] + s[i+4+j+3:]
	}
}

// neutralizeBlocks applies neutralize to the lines outside fenced code
// blocks.
func neutralizeBlocks(s string) string {
	lines := strings.Split(s, "\n")
	fence := ""
	for i, line := range lines {
		trimmed := strings.TrimLeft(line, " ")
		if fence != "" {
			if strings.HasPrefix(trimmed, fence) {
				fence = ""
			}
			continue
		}
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			fence = trimmed[:3]
			continue
		}
		lines[i] = neutralize(line)
	}
	return strings.Join(lines, "\n")
}

// neutralize rewrites one line outside code spans.
func neutralize(line string) string {
	var b strings.Builder
	for line != "" {
		start := strings.IndexByte(line, '`')
		if start < 0 {
			b.WriteString(neutralizeText(line))
			break
		}
		b.WriteString(neutralizeText(line[:start]))
		run := len(line[start:]) - len(strings.TrimLeft(line[start:], "`"))
		ticks := line[start : start+run]
		end := strings.Index(line[start+run:], ticks)
		if end < 0 {
			// An unmatched backtick run is plain text.
			b.WriteString(ticks)
			line = line[start+run:]
			continue
		}
		b.WriteString(line[start : start+run+end+run])
		line = line[start+run+end+run:]
	}
	return b.String()
}

var (
	// reference is one issue or pull request reference as GitHub or Linear
	// reads it.
	reference = `(?:https?://(?:www\.)?github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/(?:issues|pull)/[0-9]+[^\s)\]]*` +
		`|https?://linear\.app/[^\s)\]]*/issue/[^\s)\]]+` +
		`|[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[0-9]+|GH-[0-9]+|#[0-9]+|[A-Za-z][A-Za-z0-9]{0,9}-[0-9]+)`
	// keywordRefs is a closing or linking keyword (GitHub's and Linear's)
	// followed by one or more references.
	keywordRefs = regexp.MustCompile(`(?i)\b(?:close[sd]?|closing|fix(?:e[sd])?|fixing|resolve[sd]?|resolving|complete[sd]?|completing` +
		`|refs?|references|part\s+of|related\s+to|relates\s+to|contributes\s+to|towards?)\b\s*:?\s*(` + reference +
		`(?:(?:\s*,\s*|\s+and\s+|\s*&\s*|\s+)` + reference + `)*)`)
	oneRef = regexp.MustCompile(`(?i)` + reference)
	// mention is a GitHub user or team mention, not part of an e-mail
	// address or a word.
	mention = regexp.MustCompile(`(^|[^A-Za-z0-9_.@/-])(@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:/[A-Za-z0-9][A-Za-z0-9_.-]*)?)`)
)

func neutralizeText(s string) string {
	s = keywordRefs.ReplaceAllStringFunc(s, func(m string) string {
		refs := oneRef.FindAllString(keywordRefs.FindStringSubmatch(m)[1], -1)
		for i, r := range refs {
			refs[i] = "`" + r + "`"
		}
		return "refers to " + strings.Join(refs, ", ")
	})
	s = gitHubRef.ReplaceAllString(s, "${1}`${2}`")
	return mention.ReplaceAllString(s, "${1}`${2}`")
}

// gitHubRef is a bare GitHub issue or pull request reference, which would
// post a cross-reference on that issue. Code shows it without linking it.
var gitHubRef = regexp.MustCompile("(^|[^A-Za-z0-9_`/&])" +
	`(https?://(?:www\.)?github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/(?:issues|pull)/[0-9]+[^\s)\]` + "`" + `]*` +
	`|[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[0-9]+|GH-[0-9]+|#[0-9]+)`)

func cutRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:n-1])) + "…"
}

func cutBytes(s string, n int) string {
	s = s[:n]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}

// fallbackTitle is the pull request title when the builder wrote none: the
// issue's title, or failing that its reference.
func fallbackTitle(job postgres.Job) string {
	if strings.TrimSpace(job.IssueTitle) != "" {
		return job.IssueTitle
	}
	return "SprintFoundry: issue " + job.IssueRef()
}

// changeTitle is the title of a round's commit and pull request. Rounds
// stored before builders wrote a description keep the title they were
// evaluated with.
func changeTitle(job postgres.Job, rec postgres.RoundRecord) string {
	if rec.PRTitle != "" {
		return rec.PRTitle
	}
	return fmt.Sprintf("SprintFoundry: issue #%d", job.Issue)
}

// pullRequestBody is the builder's body with SprintFoundry's footer: the
// job's own issue, what was evaluated, and who built it.
func pullRequestBody(job postgres.Job, rec postgres.RoundRecord, builder string) string {
	var b strings.Builder
	if rec.PRBody != "" {
		b.WriteString(rec.PRBody)
		b.WriteString("\n\n---\n\n")
	}
	if job.Source == postgres.SourceLinear {
		fmt.Fprintf(&b, "Fixes %s\n\n", job.IssueKey)
	} else {
		fmt.Fprintf(&b, "Closes #%d.\n\n", job.Issue)
	}
	if builder == "" {
		builder = "a coding agent"
	}
	fmt.Fprintf(&b, "🤖 Built by SprintFoundry with %s: job `%s`, round %d, evaluated on the exact image built from this commit.\n\n", builder, job.ID, rec.Number)
	fmt.Fprintf(&b, "- Criteria: `%s`\n- Evidence: `%s`\n\n", job.Inputs.CriteriaDigest, rec.EvidenceDigest)
	b.WriteString("This check is advisory. The release gate evaluates the image built from the merged commit.\n\n")
	fmt.Fprintf(&b, "<!-- sprintfoundry-job: %s -->\n", job.ID)
	return b.String()
}
