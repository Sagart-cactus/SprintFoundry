// Package report writes the evidence report: one static HTML page a person
// reads to see what a run did and why it ended as it did. The report shows
// check details, so it is for the run's owner and never for the builder.
package report

import (
	"html/template"
	"io"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/checks"
	"github.com/sagart-cactus/sprintfoundry/internal/controller"
)

// Run is one run as the report shows it.
type Run struct {
	Title  string
	Result controller.Result
}

// Verification is one `verify` outcome shown in the report.
type Verification struct {
	Label    string
	Image    string
	Accepted bool
	Reason   string
}

// Page is everything on the report.
type Page struct {
	Generated     time.Time
	Criteria      string
	SignerID      string
	Runs          []Run
	Verifications []Verification
}

var page = template.Must(template.New("report").Funcs(template.FuncMap{
	"short": func(s string) string {
		if len(s) > 19 {
			return s[:19]
		}
		return s
	},
	"image": func(s string) string {
		if len(s) > 12 {
			return s[:12]
		}
		return s
	},
	"class": func(o checks.Outcome) string { return string(o) },
}).Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SprintFoundry evidence report</title>
<style>
:root { --bg:#fbfaf7; --fg:#1d1c1a; --muted:#6b6963; --line:#dcd9d1; --pass:#1f6f3d; --fail:#a12a2a; --warn:#8a5a00; --card:#ffffff; }
@media (prefers-color-scheme: dark) { :root { --bg:#161513; --fg:#ecebe6; --muted:#a3a097; --line:#35332e; --pass:#6fcf97; --fail:#f08a8a; --warn:#e7b65c; --card:#1e1d1a; } }
body { background:var(--bg); color:var(--fg); font:16px/1.55 system-ui, sans-serif; margin:0; padding:24px 16px 48px; }
main { max-width:860px; margin:0 auto; }
h1 { font-size:24px; margin:0 0 4px; } h2 { font-size:19px; margin:32px 0 8px; } h3 { font-size:16px; margin:20px 0 6px; }
p.meta, td.meta { color:var(--muted); font-size:14px; }
pre { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; white-space:pre-wrap; font-size:14px; }
table { border-collapse:collapse; width:100%; background:var(--card); border:1px solid var(--line); border-radius:8px; font-size:14px; }
th, td { text-align:left; padding:7px 10px; border-top:1px solid var(--line); vertical-align:top; } tr:first-child th { border-top:0; }
code { font:13px ui-monospace, monospace; }
.passed { color:var(--pass); font-weight:600; } .failed { color:var(--fail); font-weight:600; } .inconclusive, .needs_owner { color:var(--warn); font-weight:600; }
.note { border-left:3px solid var(--line); padding:2px 12px; color:var(--muted); font-size:14px; }
</style>
</head>
<body><main>
<h1>SprintFoundry evidence report</h1>
<p class="meta">Generated {{.Generated.Format "2 January 2006 15:04 MST"}}. Signed by <code>{{short .SignerID}}…</code>. This page shows check details and is for the run's owner. The builder never sees it.</p>

<h2>Approved criteria</h2>
<pre>{{.Criteria}}</pre>

{{range .Runs}}
<h2>{{.Title}}</h2>
<p>Run <code>{{.Result.RunID}}</code> ended as <span class="{{.Result.State}}">{{.Result.State}}</span>{{if .Result.Reason}}: {{.Result.Reason}}{{end}}.</p>
<p class="meta">Criteria <code>{{short .Result.CriteriaDigest}}</code>, checks <code>{{short .Result.SuiteDigest}}</code>, run spec <code>{{short .Result.RunSpecDigest}}</code>.</p>
{{range .Result.Rounds}}
<h3>Round {{.Number}}: image <code>{{image .Image}}</code>, <span class="{{.Outcome}}">{{.Outcome}}</span></h3>
<p class="meta">Commit <code>{{image .Commit}}</code>. Changed: {{range $i, $p := .ChangedPaths}}{{if $i}}, {{end}}<code>{{$p}}</code>{{end}}.{{if .SensitivePaths}} Protected paths touched: {{range $i, $p := .SensitivePaths}}{{if $i}}, {{end}}<code>{{$p}}</code>{{end}}.{{end}}</p>
<table>
<tr><th>Criterion</th><th>Check</th><th>Result</th><th>What was seen</th></tr>
{{range .Report.Checks}}<tr><td>{{.Criterion}}</td><td><code>{{.ID}}</code>{{if .Holdout}} (holdout){{end}}</td><td class="{{class .Outcome}}">{{.Outcome}}</td><td class="meta">{{.Detail}}</td></tr>
{{end}}</table>
{{if .Feedback}}<p class="note">Sent back to the builder, and nothing else:{{range .Feedback}}<br><code>{{.Criterion}}</code>: {{.Text}}{{end}}</p>{{end}}
{{if .HoldoutFailed}}<p class="note">A holdout check failed. The builder was told nothing about it.</p>{{end}}
<p class="meta">Evidence <code>{{short .EvidenceDigest}}</code></p>
{{end}}
{{end}}

{{if .Verifications}}
<h2>Release gate</h2>
<table>
<tr><th>Image</th><th>Asked</th><th>Answer</th><th>Reason</th></tr>
{{range .Verifications}}<tr><td><code>{{image .Image}}</code></td><td>{{.Label}}</td><td class="{{if .Accepted}}passed{{else}}failed{{end}}">{{if .Accepted}}accepted{{else}}rejected{{end}}</td><td class="meta">{{.Reason}}</td></tr>
{{end}}</table>
{{end}}

<h2>What this does not prove</h2>
<p class="note">The candidates ran in ordinary containers on this machine. That keeps honest mistakes apart, and it is not a security boundary against a hostile agent. An image can also tell that it is being evaluated, because its network has no way out. A person approves a release by default for both reasons.</p>
</main></body></html>
`))

// Write renders the report.
func Write(w io.Writer, p Page) error {
	return page.Execute(w, p)
}
