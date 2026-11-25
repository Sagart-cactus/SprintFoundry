package controller

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"

	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
	"github.com/sagart-cactus/sprintfoundry/internal/textsafe"
)

// Limits on a builder's pull request description (design 0010).
const (
	MaxTitleRunes = 120
	MaxBodyBytes  = 20000
)

// CleanDescription makes a builder's pull request title and body safe to
// store, show and send to GitHub (design 0010, decision 2).
//
// The rewrites do not depend on how Markdown is parsed: they apply to every
// part of the text, code included, so a construct the controller reads
// differently from GitHub can only make the text look a little odder, never
// let a mention or a reference through. Characters a reader could not see
// and HTML comments are removed; character references are escaped, so none
// decodes to '@' or '#'; '@' before a name becomes '＠', '#' before a number
// becomes '＃', GitHub issue URLs lose their scheme, and a closing or
// linking keyword before issue references becomes "refers to", with the
// references made inert. In the title, which is also the commit message,
// every other Linear-style identifier is made inert too: Linear links a
// pull request to an issue named in its title. ownKey is the job's own
// Linear identifier, which may stay.
func CleanDescription(title, body, fallback, ownKey string) (string, string) {
	title = cleanTitle(title, ownKey)
	if title == "" {
		title = cleanTitle(fallback, ownKey)
	}

	body = strings.ReplaceAll(body, "\r\n", "\n")
	body = strings.Map(visible(false), body)
	body = stripComments(body)
	cut := false
	if len(body) > MaxBodyBytes {
		body, cut = cutBytes(body, MaxBodyBytes), true
	}
	body = defang(escapeMarkup(body))
	if len(body) > MaxBodyBytes {
		body, cut = trimPartialEscape(cutBytes(body, MaxBodyBytes)), true
	}
	body = strings.Trim(body, "\n")
	if cut {
		body += "\n\n(The builder's description was cut here.)"
	}
	return title, body
}

func cleanTitle(title, ownKey string) string {
	title = strings.Join(strings.Fields(strings.Map(visible(true), title)), " ")
	title = cutRunes(title, MaxTitleRunes)
	title = defang(title)
	title = linearID.ReplaceAllStringFunc(title, func(id string) string {
		if strings.EqualFold(id, ownKey) {
			return id
		}
		return inertID(id)
	})
	// Escaping can make the title longer; cutting it again cannot undo a
	// rewrite, since every stand-in is a whole character.
	return cutRunes(title, MaxTitleRunes)
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

// Inert stand-ins. They read as the characters they replace, and neither
// GitHub nor Linear acts on them.
const (
	inertAt     = "＠" // U+FF20 FULLWIDTH COMMERCIAL AT
	inertHash   = "＃" // U+FF03 FULLWIDTH NUMBER SIGN
	inertHyphen = "‑" // U+2011 NON-BREAKING HYPHEN
	inertSlash  = "∕" // U+2215 DIVISION SLASH
)

var (
	// charRef is '&' where it could start a character reference. Escaped,
	// it shows as itself and never decodes to '@', '#' or a keyword.
	charRef = regexp.MustCompile(`&([#A-Za-z])`)
	// mention is '@' before a user or team name. GitHub treats '@' as a
	// mention after anything but a letter, digit or underscore; an e-mail
	// address such as ops@example.com is left as it is.
	mention = regexp.MustCompile(`(^|[^A-Za-z0-9_])@([A-Za-z0-9])`)
	// issueNumber is '#' before a number: #12, owner/repo#12.
	issueNumber = regexp.MustCompile(`#([0-9])`)
	// ghPrefix is GitHub's other issue form, GH-12.
	ghPrefix = regexp.MustCompile(`(?i)\bGH-([0-9])`)
	// issueURL is the scheme and host of a GitHub or Linear URL, with any
	// run of schemes and slashes before it, so one pass removes them all.
	issueURL = regexp.MustCompile(`(?i)(?:(?:https?:)?/{2,})+(?:www\.)?(github\.com|linear\.app)/`)
	// issuePath is the part of a GitHub path that GitHub links as an issue
	// or pull request even without a host: owner/repo/issues/12.
	issuePath = regexp.MustCompile(`(?i)\b(issues|pulls?|discussions)/([0-9])`)
	// linearID is what Linear reads as an issue identifier.
	linearID = regexp.MustCompile(`\b[A-Za-z][A-Za-z0-9]{0,9}-[0-9]{1,9}\b`)
	// linearNew is Linear's placeholder that creates a new issue and links
	// it: ENG-NEW.
	linearNew = regexp.MustCompile(`(?i)\b[A-Za-z][A-Za-z0-9]{0,9}-NEW\b`)
	// markupStart is '<' where it could start HTML.
	markupStart = regexp.MustCompile(`<([A-Za-z/!?])`)
	// keywordRefs is a closing or linking keyword that GitHub or Linear
	// documents, followed by one or more issue references, possibly across
	// a line break or Markdown punctuation.
	keywordRefs = regexp.MustCompile(`(?i)\b(close[sd]?|closing|fix(?:e[sd])?|fixing|resolve[sd]?|resolving|complete[sd]?|completing` +
		`|implement(?:s|ed|ing)?|refs?|references|part\s+of|related\s+to|relates\s+to|contributes\s+to|towards?|linear\s+issues?|skip|ignore)\b` +
		`((?:(?:[\s:*_~` + "`" + `\[\]()>"',.&;-]|and\b)*` +
		`(?:[^\s\[\]()<>` + "`" + `"']*[A-Za-z][A-Za-z0-9]{0,9}-(?:[0-9]{1,9}|NEW)\b|[^\s\[\]()<>` + "`" + `"']*[#＃][0-9]+` +
		`|[^\s\[\]()<>` + "`" + `"']*/(?:issues|pulls?|discussions)/[0-9]+))+)`)
)

func inertID(id string) string { return strings.Replace(id, "-", inertHyphen, 1) }

// escapeMarkup makes every '<' that could start HTML show as itself, so no
// HTML in the body can hide, strike out or swallow the footer, whatever a
// Markdown parser makes of the text around it. It runs before defang, so
// keywords and references next to the escape are still seen; defang leaves
// "&lt;" as it is, since it can only ever show '<'.
func escapeMarkup(s string) string { return markupStart.ReplaceAllString(s, "&lt;$1") }

// defang applies the rewrites to text wherever it stands.
func defang(s string) string {
	// Keywords first, while their references still look like references.
	// Every pass replaces a keyword with "refers to", which is none, so the
	// loop ends.
	for {
		next := keywordRefs.ReplaceAllStringFunc(s, func(m string) string {
			sub := keywordRefs.FindStringSubmatch(m)
			return "refers to" + linearNew.ReplaceAllStringFunc(linearID.ReplaceAllStringFunc(sub[2], inertID), inertID)
		})
		if next == s {
			break
		}
		s = next
	}
	// Removing a scheme can leave another one ("////github.com/"), so
	// repeat until nothing changes; the text gets shorter every time.
	for next := issueURL.ReplaceAllString(s, "$1/"); next != s; next = issueURL.ReplaceAllString(s, "$1/") {
		s = next
	}
	s = issuePath.ReplaceAllString(s, "${1}"+inertSlash+"${2}")
	s = linearNew.ReplaceAllStringFunc(s, inertID)
	s = issueNumber.ReplaceAllString(s, inertHash+"$1")
	s = ghPrefix.ReplaceAllStringFunc(s, inertID)
	s = mention.ReplaceAllString(s, "${1}"+inertAt+"${2}")
	// Last, so that no rewrite above can put a new '&' before a name.
	return escapeAmpersands(s)
}

// escapeAmpersands escapes every '&' that could start a character
// reference, except "&lt;".
func escapeAmpersands(s string) string {
	var b strings.Builder
	last := 0
	for _, loc := range charRef.FindAllStringIndex(s, -1) {
		if strings.HasPrefix(s[loc[0]:], "&lt;") {
			continue
		}
		b.WriteString(s[last:loc[0]])
		b.WriteString("&amp;")
		last = loc[0] + 1
	}
	b.WriteString(s[last:])
	return b.String()
}

func cutRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(trimPartialEscape(string(r[:n-1]))) + "…"
}

// trimPartialEscape drops the start of an "&amp;" or "&lt;" that a cut
// left at the end of s.
func trimPartialEscape(s string) string {
	if i := strings.LastIndexByte(s, '&'); i >= 0 && len(s)-i < len("&amp;") {
		return s[:i]
	}
	return s
}

func cutBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
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
// job's own issue, what was evaluated, and who built it. The body is placed
// so that nothing in it can run on into the footer (see containBody).
func pullRequestBody(job postgres.Job, rec postgres.RoundRecord, builder string) string {
	var b strings.Builder
	if body := containBody(rec.PRBody); body != "" {
		b.WriteString(body)
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

// containBody returns the body in a form that ends every block it opens, so
// the footer after it is read as the controller wrote it: an unclosed code
// fence or HTML element would otherwise swallow "Closes #N". The body is
// used as it is when a CommonMark parser finds that a paragraph after it
// stands on its own and it holds no raw HTML; otherwise it is quoted, which
// closes everything at the end of the quote; failing that, it is shown as
// code; failing that, it is left out.
func containBody(body string) string {
	if body == "" {
		return ""
	}
	if standsAlone(body, true) {
		return body
	}
	quoted := "> " + strings.ReplaceAll(body, "\n", "\n> ")
	if standsAlone(quoted, false) {
		return quoted
	}
	fence := strings.Repeat("`", max(3, longestRun(body, '`')+1))
	code := fence + "text\n" + body + "\n" + fence
	if standsAlone(code, false) {
		return code
	}
	return "(The builder's description could not be shown safely.)"
}

const sentinel = "sprintfoundry-footer-follows"

var markdown = goldmark.New(goldmark.WithExtensions(extension.GFM))

// standsAlone reports whether a paragraph written after text is a paragraph
// of its own at the top of the document, and, when noHTML is set, that text
// holds no raw HTML.
func standsAlone(s string, noHTML bool) bool {
	src := []byte(s + "\n\n" + sentinel + "\n")
	doc := markdown.Parser().Parse(text.NewReader(src))
	html := false
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering && (n.Kind() == ast.KindHTMLBlock || n.Kind() == ast.KindRawHTML) {
			html = true
		}
		return ast.WalkContinue, nil
	})
	if noHTML && html {
		return false
	}
	last, ok := doc.LastChild().(*ast.Paragraph)
	if !ok || last.Lines().Len() != 1 {
		return false
	}
	line := last.Lines().At(0)
	return strings.TrimSpace(string(line.Value(src))) == sentinel
}

func longestRun(s string, c byte) int {
	best, run := 0, 0
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			run++
			best = max(best, run)
		} else {
			run = 0
		}
	}
	return best
}
