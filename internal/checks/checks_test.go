package checks

import (
	"errors"
	"strings"
	"testing"
)

// invoiceSuite is the example from docs/design/0003-check-suite.md.
const invoiceSuite = `
version: 1
actors:
  - owner
  - member
checks:
  - id: export-owner
    criterion: export-csv
    http:
      as: owner
      request: GET /invoices/export.csv
      expect:
        status: 200
        header: { content-type: text/csv }
  - id: export-archived
    criterion: export-includes-archived
    http:
      as: owner
      request: GET /invoices/export.csv
      expect:
        body_contains: INV-0007
  - id: export-denied
    criterion: export-owner-only
    http:
      as: member
      request: GET /invoices/export.csv
      expect:
        status: 403
  - id: export-button
    criterion: export-csv
    holdout: true
    browser:
      as: owner
      open: /invoices
      expect:
        visible: { role: button, name: Export CSV }
`

func mustParse(t *testing.T, src string) Suite {
	t.Helper()
	s, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return s
}

func yes() *bool { v := true; return &v }
func no() *bool  { v := false; return &v }

// goodObservations is what a runner sees when the feature works.
func goodObservations() []Observation {
	csv := "invoice_id,amount,status\nINV-0001,10,open\nINV-0007,25,archived\n"
	return []Observation{
		{Check: "export-owner", HTTP: &HTTPObservation{Status: 200, Header: map[string]string{"content-type": "text/csv; charset=utf-8"}, Body: csv}},
		{Check: "export-archived", HTTP: &HTTPObservation{Status: 200, Body: csv}},
		{Check: "export-denied", HTTP: &HTTPObservation{Status: 403}},
		{Check: "export-button", Browser: &BrowserObservation{URL: "http://preview/invoices", VisibleFound: yes()}},
	}
}

func TestParseExampleSuite(t *testing.T) {
	s := mustParse(t, invoiceSuite)
	if len(s.Checks) != 4 {
		t.Fatalf("checks = %d, want 4", len(s.Checks))
	}
	c, ok := s.Check("export-button")
	if !ok || !c.Holdout || c.Browser.Expect.Visible.Name != "Export CSV" {
		t.Errorf("export-button parsed wrongly: %+v", c)
	}
}

func TestDigestIgnoresLayoutButNotContent(t *testing.T) {
	base := mustParse(t, invoiceSuite).Digest()
	if !strings.HasPrefix(base, "sha256:") || len(base) != len("sha256:")+64 {
		t.Fatalf("digest = %q", base)
	}

	reformatted := strings.ReplaceAll(invoiceSuite, "header: { content-type: text/csv }", "header:\n          content-type: text/csv   # media type")
	reformatted = "# approved 22 November\n" + reformatted
	if got := mustParse(t, reformatted).Digest(); got != base {
		t.Errorf("digest changed with comments and layout: %s vs %s", got, base)
	}

	weakened := strings.ReplaceAll(invoiceSuite, "status: 403", "status: 200")
	if got := mustParse(t, weakened).Digest(); got == base {
		t.Error("digest did not change when an expectation was weakened")
	}
	unheld := strings.ReplaceAll(invoiceSuite, "    holdout: true\n", "")
	if got := mustParse(t, unheld).Digest(); got == base {
		t.Error("digest did not change when a holdout flag was removed")
	}
}

func TestParseRejectsBadSuites(t *testing.T) {
	tests := []struct {
		name string
		edit func(string) string
		want string
	}{
		{"unknown field", func(s string) string { return strings.Replace(s, "status: 403", "statuz: 403", 1) }, "statuz"},
		{"script smuggled in", func(s string) string {
			return strings.Replace(s, "open: /invoices", "open: /invoices\n      script: document.cookie", 1)
		}, "script"},
		{"duplicate ID", func(s string) string { return strings.Replace(s, "id: export-archived", "id: export-owner", 1) }, "used twice"},
		{"undeclared actor", func(s string) string { return strings.Replace(s, "as: member", "as: admin", 1) }, "not declared"},
		{"request without method", func(s string) string {
			return strings.Replace(s, "request: GET /invoices/export.csv", "request: /invoices/export.csv", 1)
		}, "must look like"},
		{"absolute URL as request", func(s string) string {
			return strings.Replace(s, "request: GET /invoices/export.csv", "request: GET http://elsewhere.example/x", 1)
		}, "must look like"},
		{"check that expects nothing", func(s string) string { return strings.Replace(s, "        status: 403\n", "        {}\n", 1) }, "expects nothing"},
		{"unsupported version", func(s string) string { return strings.Replace(s, "version: 1", "version: 2", 1) }, "not supported"},
		{"both kinds on one check", func(s string) string {
			return strings.Replace(s, "    holdout: true\n", "    holdout: true\n    http:\n      as: owner\n      request: GET /x\n      expect: { status: 200 }\n", 1)
		}, "both http and browser"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Parse([]byte(tt.edit(invoiceSuite)))
			if !errors.Is(err, ErrInvalidSuite) {
				t.Fatalf("err = %v, want ErrInvalidSuite", err)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("err = %q, want it to mention %q", err, tt.want)
			}
		})
	}
	if _, err := Parse([]byte("version: 1\nactors: [owner]\nchecks: []\n")); !errors.Is(err, ErrInvalidSuite) {
		t.Errorf("empty suite: err = %v", err)
	}
}

func TestGradeComputedFromRawResults(t *testing.T) {
	s := mustParse(t, invoiceSuite)

	report, err := Grade(s, goodObservations())
	if err != nil {
		t.Fatal(err)
	}
	if report.Result != Passed {
		t.Fatalf("result = %s, want passed: %+v", report.Result, report.Checks)
	}

	// The seeded defect: any member can download the export.
	leaky := goodObservations()
	leaky[2].HTTP.Status = 200
	report, err = Grade(s, leaky)
	if err != nil {
		t.Fatal(err)
	}
	if report.Result != Failed {
		t.Fatalf("result = %s, want failed", report.Result)
	}
	for _, g := range report.Checks {
		want := Passed
		if g.ID == "export-denied" {
			want = Failed
		}
		if g.Outcome != want {
			t.Errorf("%s = %s, want %s", g.ID, g.Outcome, want)
		}
	}

	// An observation has no field in which a runner could claim a verdict.
	// The grade follows the facts even when they are the only thing sent.
	missingArchived := goodObservations()
	missingArchived[1].HTTP.Body = "invoice_id,amount,status\nINV-0001,10,open\n"
	if report, _ = Grade(s, missingArchived); report.Result != Failed {
		t.Errorf("missing archived invoice: result = %s, want failed", report.Result)
	}
	wrongType := goodObservations()
	wrongType[0].HTTP.Header["content-type"] = "text/html"
	if report, _ = Grade(s, wrongType); report.Result != Failed {
		t.Errorf("wrong content type: result = %s, want failed", report.Result)
	}
}

func TestGradeRefusesUnknownCheck(t *testing.T) {
	s := mustParse(t, invoiceSuite)
	extra := append(goodObservations(), Observation{Check: "always-green", HTTP: &HTTPObservation{Status: 200}})
	if _, err := Grade(s, extra); !errors.Is(err, ErrUnknownCheck) {
		t.Fatalf("err = %v, want ErrUnknownCheck", err)
	}
	twice := append(goodObservations(), goodObservations()[0])
	if _, err := Grade(s, twice); err == nil {
		t.Fatal("two observations for one check were accepted")
	}
}

func TestInconclusiveNeverPasses(t *testing.T) {
	s := mustParse(t, invoiceSuite)

	missing := goodObservations()[:3] // the runner never reported the browser check
	report, err := Grade(s, missing)
	if err != nil {
		t.Fatal(err)
	}
	if report.Result != Inconclusive {
		t.Errorf("missing observation: result = %s, want inconclusive", report.Result)
	}

	timedOut := goodObservations()
	timedOut[0] = Observation{Check: "export-owner", Error: "timeout after 30s"}
	if report, _ = Grade(s, timedOut); report.Result != Inconclusive {
		t.Errorf("runner error: result = %s, want inconclusive", report.Result)
	}
	if got := report.BuilderFeedback(); len(got) != 0 {
		t.Errorf("an inconclusive check produced builder feedback: %v", got)
	}

	unreported := goodObservations()
	unreported[3].Browser.VisibleFound = nil
	if report, _ = Grade(s, unreported); report.Result != Inconclusive {
		t.Errorf("browser fact not reported: result = %s, want inconclusive", report.Result)
	}

	// A failure outranks an inconclusive check.
	both := goodObservations()[:3]
	both[2].HTTP.Status = 200
	if report, _ = Grade(s, both); report.Result != Failed {
		t.Errorf("failed plus inconclusive: result = %s, want failed", report.Result)
	}
}

func TestFeedbackHidesCheckDetails(t *testing.T) {
	s := mustParse(t, invoiceSuite)
	obs := goodObservations()
	obs[0].HTTP.Status = 500               // export-owner
	obs[1].HTTP.Body = "invoice_id,amount" // export-archived
	obs[2].HTTP.Status = 200               // export-denied

	report, err := Grade(s, obs)
	if err != nil {
		t.Fatal(err)
	}
	feedback := report.BuilderFeedback()
	if len(feedback) != 3 {
		t.Fatalf("feedback = %v, want 3 entries", feedback)
	}
	want := map[string]string{
		"export-csv":               "a request that should succeed did not",
		"export-includes-archived": "a response did not contain what the criterion requires",
		"export-owner-only":        "a request that should be refused was allowed",
	}
	secrets := []string{"/invoices", "export.csv", "INV-0007", "403", "200", "500", "GET", "member", "owner ", "text/csv",
		"export-owner", "export-archived", "export-denied", "export-button"}
	for _, f := range feedback {
		if want[f.Criterion] != f.Text {
			t.Errorf("criterion %s: symptom = %q, want %q", f.Criterion, f.Text, want[f.Criterion])
		}
		for _, secret := range secrets {
			if strings.Contains(f.Text, secret) {
				t.Errorf("symptom %q leaks %q", f.Text, secret)
			}
		}
	}
}

func TestHoldoutFailureIsSilentToBuilder(t *testing.T) {
	s := mustParse(t, invoiceSuite)
	obs := goodObservations()
	obs[3].Browser.VisibleFound = no()

	report, err := Grade(s, obs)
	if err != nil {
		t.Fatal(err)
	}
	if report.Result != Failed {
		t.Fatalf("result = %s, want failed", report.Result)
	}
	if got := report.BuilderFeedback(); len(got) != 0 {
		t.Errorf("a holdout failure reached the builder: %v", got)
	}
	if !report.HoldoutFailed() {
		t.Error("HoldoutFailed = false, want true so a person is told")
	}
}

func TestGradeJSONAndBrowserExpectations(t *testing.T) {
	s := mustParse(t, `
version: 1
actors: [owner]
checks:
  - id: api-count
    criterion: api
    http:
      as: owner
      request: GET /api/invoices
      expect:
        json: { meta.count: 2, meta.kind: invoice }
        body_not_contains: password
  - id: no-admin-link
    criterion: nav
    browser:
      as: owner
      open: /
      expect:
        hidden: { role: link, name: Admin }
        text_visible: Invoices
        url_matches: /dashboard$
`)
	ok := []Observation{
		{Check: "api-count", HTTP: &HTTPObservation{Status: 200, Body: `{"meta":{"count":2,"kind":"invoice"}}`}},
		{Check: "no-admin-link", Browser: &BrowserObservation{URL: "http://preview/dashboard", HiddenFound: no(), TextVisibleHit: yes()}},
	}
	if report, err := Grade(s, ok); err != nil || report.Result != Passed {
		t.Fatalf("result = %v, %v: %+v", report.Result, err, report.Checks)
	}

	cases := map[string]func([]Observation){
		"wrong JSON value":    func(o []Observation) { o[0].HTTP.Body = `{"meta":{"count":3,"kind":"invoice"}}` },
		"JSON path missing":   func(o []Observation) { o[0].HTTP.Body = `{"meta":{}}` },
		"body is not JSON":    func(o []Observation) { o[0].HTTP.Body = `<html>` },
		"forbidden content":   func(o []Observation) { o[0].HTTP.Body = `{"meta":{"count":2,"kind":"invoice"},"password":"x"}` },
		"hidden link shown":   func(o []Observation) { o[1].Browser.HiddenFound = yes() },
		"text not on page":    func(o []Observation) { o[1].Browser.TextVisibleHit = no() },
		"redirected to login": func(o []Observation) { o[1].Browser.URL = "http://preview/login" },
	}
	for name, breakIt := range cases {
		t.Run(name, func(t *testing.T) {
			obs := []Observation{
				{Check: "api-count", HTTP: &HTTPObservation{Status: 200, Body: `{"meta":{"count":2,"kind":"invoice"}}`}},
				{Check: "no-admin-link", Browser: &BrowserObservation{URL: "http://preview/dashboard", HiddenFound: no(), TextVisibleHit: yes()}},
			}
			breakIt(obs)
			report, err := Grade(s, obs)
			if err != nil {
				t.Fatal(err)
			}
			if report.Result != Failed {
				t.Errorf("result = %s, want failed", report.Result)
			}
		})
	}
}

func TestHeadersAreComparedExactly(t *testing.T) {
	s := mustParse(t, `
version: 1
actors: [owner]
checks:
  - id: csp
    criterion: security
    http:
      as: owner
      request: GET /
      expect:
        header:
          content-security-policy: "default-src 'self'"
          location: /dashboard
          content-type: text/html
`)
	base := func() []Observation {
		return []Observation{{Check: "csp", HTTP: &HTTPObservation{Status: 200, Header: map[string]string{
			"content-security-policy": "default-src 'self'", "location": "/dashboard", "content-type": "Text/HTML; charset=utf-8"}}}}
	}
	if report, err := Grade(s, base()); err != nil || report.Result != Passed {
		t.Fatalf("exact headers: %v, %v: %+v", report.Result, err, report.Checks)
	}
	weakened := map[string]string{
		"content-security-policy": "default-src 'self'; script-src * 'unsafe-inline'",
		"location":                "/dashboard;evil",
		"content-type":            "text/htmlx",
	}
	for name, value := range weakened {
		obs := base()
		obs[0].HTTP.Header[name] = value
		if report, _ := Grade(s, obs); report.Result != Failed {
			t.Errorf("%s = %q graded %s, want failed", name, value, report.Result)
		}
	}
	upper := base()
	upper[0].HTTP.Header["content-security-policy"] = "DEFAULT-SRC 'SELF'"
	if report, _ := Grade(s, upper); report.Result != Failed {
		t.Error("a header in another case was accepted as an exact match")
	}
}

func TestGradeNeedsRealFacts(t *testing.T) {
	s := mustParse(t, `
version: 1
actors: [owner]
checks:
  - id: no-leak
    criterion: privacy
    http:
      as: owner
      request: GET /profile
      expect:
        body_not_contains: password
`)
	// An observation with no facts in it must not satisfy a negative check.
	if report, _ := Grade(s, []Observation{{Check: "no-leak", HTTP: &HTTPObservation{}}}); report.Result != Inconclusive {
		t.Errorf("empty HTTP observation graded %s, want inconclusive", report.Result)
	}
	// A body cut at the size limit cannot prove that something is absent.
	cut := []Observation{{Check: "no-leak", HTTP: &HTTPObservation{Status: 200, Body: "name=x", Truncated: true}}}
	if report, _ := Grade(s, cut); report.Result != Inconclusive {
		t.Errorf("truncated body graded %s, want inconclusive", report.Result)
	}
	whole := []Observation{{Check: "no-leak", HTTP: &HTTPObservation{Status: 200, Body: "name=x"}}}
	if report, _ := Grade(s, whole); report.Result != Passed {
		t.Errorf("complete clean body graded %s, want passed", report.Result)
	}

	// A suite that never went through Parse cannot grade anything as passed.
	if report, err := Grade(Suite{}, nil); err == nil {
		t.Errorf("an empty suite graded %q with no error", report.Result)
	}
	kindless := Suite{Version: 1, Actors: []string{"owner"}, Checks: []Check{{ID: "x", Criterion: "c"}}}
	if _, err := Grade(kindless, []Observation{{Check: "x"}}); err == nil {
		t.Error("a check with neither kind was graded")
	}
}

func TestParseRejectsWhatWouldBeDroppedOrLeaveThePreview(t *testing.T) {
	second := invoiceSuite + "---\nversion: 1\nactors: [owner]\nchecks:\n  - id: dropped\n    criterion: c\n    http: { as: owner, request: GET /x, expect: { status: 200 } }\n"
	if _, err := Parse([]byte(second)); !errors.Is(err, ErrInvalidSuite) || !strings.Contains(err.Error(), "more than one") {
		t.Errorf("two documents: err = %v", err)
	}
	for _, target := range []string{"//elsewhere.example/x", "/\\\\elsewhere.example", "/a b"} {
		src := strings.Replace(invoiceSuite, "request: GET /invoices/export.csv", "request: \"GET "+target+"\"", 1)
		if _, err := Parse([]byte(src)); !errors.Is(err, ErrInvalidSuite) {
			t.Errorf("request target %q: err = %v", target, err)
		}
	}
	if _, err := Parse([]byte(strings.Replace(invoiceSuite, "open: /invoices", "open: //elsewhere.example", 1))); !errors.Is(err, ErrInvalidSuite) {
		t.Errorf("browser open on another host: err = %v", err)
	}
	for _, value := range []string{".nan", ".inf", "{1: x}", "[1, 2]", "{a: b}"} {
		src := strings.Replace(invoiceSuite, "body_contains: INV-0007", "json: { total: "+value+" }", 1)
		if _, err := Parse([]byte(src)); !errors.Is(err, ErrInvalidSuite) {
			t.Errorf("json value %s: err = %v", value, err)
		}
	}
}

func TestJSONNumbersAreExact(t *testing.T) {
	s := mustParse(t, `
version: 1
actors: [owner]
checks:
  - id: big
    criterion: c
    http:
      as: owner
      request: GET /n
      expect:
        json: { id: 9007199254740993, ratio: 0.5, count: 2, flag: true, none: null, name: x }
`)
	obs := func(body string) []Observation {
		return []Observation{{Check: "big", HTTP: &HTTPObservation{Status: 200, Body: body}}}
	}
	exact := `{"id":9007199254740993,"ratio":0.50,"count":2.0,"flag":true,"none":null,"name":"x"}`
	if report, err := Grade(s, obs(exact)); err != nil || report.Result != Passed {
		t.Fatalf("exact values: %v, %v: %+v", report.Result, err, report.Checks)
	}
	for name, body := range map[string]string{
		"neighbouring large integer": `{"id":9007199254740992,"ratio":0.5,"count":2,"flag":true,"none":null,"name":"x"}`,
		"number as string":           `{"id":"9007199254740993","ratio":0.5,"count":2,"flag":true,"none":null,"name":"x"}`,
		"null replaced":              `{"id":9007199254740993,"ratio":0.5,"count":2,"flag":true,"none":0,"name":"x"}`,
		"boolean as number":          `{"id":9007199254740993,"ratio":0.5,"count":2,"flag":1,"none":null,"name":"x"}`,
	} {
		if report, _ := Grade(s, obs(body)); report.Result != Failed {
			t.Errorf("%s graded %s, want failed", name, report.Result)
		}
	}
}

func TestEncodedBodiesAndRepeatedHeadersAreInconclusive(t *testing.T) {
	s := mustParse(t, `
version: 1
actors: [member]
checks:
  - id: no-archived
    criterion: privacy
    http:
      as: member
      request: GET /invoices
      expect:
        status: 200
        body_not_contains: INV-0007
  - id: no-cache
    criterion: caching
    http:
      as: member
      request: GET /invoices
      expect:
        header: { cache-control: no-store }
`)
	clean := func() []Observation {
		return []Observation{
			{Check: "no-archived", HTTP: &HTTPObservation{Status: 200, Body: "<td>INV-0001</td>"}},
			{Check: "no-cache", HTTP: &HTTPObservation{Status: 200, Header: map[string]string{"cache-control": "no-store"}}},
		}
	}
	if report, err := Grade(s, clean()); err != nil || report.Result != Passed {
		t.Fatalf("plain response: %v, %v", report.Result, err)
	}

	// A compressed body can carry text the raw bytes do not show.
	encoded := clean()
	encoded[0].HTTP.ContentEncoding = "deflate"
	encoded[0].HTTP.Body = "\x78\x9c opaque bytes"
	report, _ := Grade(s, encoded)
	if report.Result != Inconclusive || report.Checks[0].Outcome != Inconclusive {
		t.Errorf("encoded body: result %s, check %s; want inconclusive", report.Result, report.Checks[0].Outcome)
	}

	// A header sent twice, where the first value satisfies the check and the
	// second undoes it.
	repeated := clean()
	repeated[1].HTTP.RepeatedHeaders = []string{"cache-control"}
	report, _ = Grade(s, repeated)
	if report.Result != Inconclusive || report.Checks[1].Outcome != Inconclusive {
		t.Errorf("repeated header: result %s, check %s; want inconclusive", report.Result, report.Checks[1].Outcome)
	}

	// An encoding does not matter to a check that never looks at the body.
	statusOnly := clean()
	statusOnly[1].HTTP.ContentEncoding = "br"
	if report, _ = Grade(s, statusOnly); report.Checks[1].Outcome != Passed {
		t.Errorf("header check on an encoded response: %s, want passed", report.Checks[1].Outcome)
	}
}
