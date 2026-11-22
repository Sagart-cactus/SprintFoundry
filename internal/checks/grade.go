package checks

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"strings"
)

// Observation is what the check runner saw for one check. It states facts
// and carries no verdict: the controller decides pass or fail.
type Observation struct {
	Check string `json:"check"`
	// Error is set when the runner could not complete the check, for example
	// on a timeout. It makes the check inconclusive.
	Error   string              `json:"error,omitempty"`
	HTTP    *HTTPObservation    `json:"http,omitempty"`
	Browser *BrowserObservation `json:"browser,omitempty"`
}

// HTTPObservation is the response to an http check.
type HTTPObservation struct {
	Status int               `json:"status"`
	Header map[string]string `json:"header"` // names in lower case
	Body   string            `json:"body"`
	// Truncated is set when the runner cut the body at its size limit. A
	// check that looks at the body is then inconclusive.
	Truncated bool `json:"truncated,omitempty"`
}

// BrowserObservation is what the page showed for a browser check.
type BrowserObservation struct {
	URL            string `json:"url"`
	VisibleFound   *bool  `json:"visible_found,omitempty"` // the role and name under expect.visible
	HiddenFound    *bool  `json:"hidden_found,omitempty"`  // the role and name under expect.hidden
	TextVisibleHit *bool  `json:"text_visible_hit,omitempty"`
}

// Outcome is the grade of one check or of a whole evaluation.
type Outcome string

const (
	Passed       Outcome = "passed"
	Failed       Outcome = "failed"
	Inconclusive Outcome = "inconclusive"
)

// ErrUnknownCheck is returned when a runner reports a check that is not in
// the frozen suite.
var ErrUnknownCheck = errors.New("checks: observation names a check that is not in the suite")

// CheckGrade is the controller's grade of one check.
type CheckGrade struct {
	ID        string
	Criterion string
	Holdout   bool
	Outcome   Outcome
	// symptom is what a user would notice. It never includes the request or
	// the expected value.
	symptom string
	// Detail is for the evidence report that people read. It is never sent
	// to the builder.
	Detail string
}

// Report is the grade of one evaluation.
type Report struct {
	Result Outcome
	Checks []CheckGrade
}

// Grade computes the result from the frozen suite and the runner's raw
// observations. An observation for a check that is not in the suite is
// refused. A suite check without an observation is inconclusive.
func Grade(s Suite, observations []Observation) (Report, error) {
	// A suite that did not come through Parse, or an empty one, must not
	// grade as passed.
	if err := s.validate(); err != nil {
		return Report{}, fmt.Errorf("%w: %v", ErrInvalidSuite, err)
	}
	byCheck := map[string]Observation{}
	for _, o := range observations {
		if _, ok := s.Check(o.Check); !ok {
			return Report{}, fmt.Errorf("%w: %q", ErrUnknownCheck, o.Check)
		}
		if _, dup := byCheck[o.Check]; dup {
			return Report{}, fmt.Errorf("checks: two observations for check %q", o.Check)
		}
		byCheck[o.Check] = o
	}

	report := Report{Result: Passed}
	for _, c := range s.Checks {
		g := CheckGrade{ID: c.ID, Criterion: c.Criterion, Holdout: c.Holdout}
		o, ok := byCheck[c.ID]
		switch {
		case !ok:
			g.Outcome, g.Detail = Inconclusive, "the runner reported nothing for this check"
		case o.Error != "":
			g.Outcome, g.Detail = Inconclusive, "the runner could not complete the check: "+o.Error
		case c.HTTP != nil:
			g.Outcome, g.symptom, g.Detail = gradeHTTP(c.HTTP.Expect, o.HTTP)
		default:
			g.Outcome, g.symptom, g.Detail = gradeBrowser(c.Browser.Expect, o.Browser)
		}
		report.Checks = append(report.Checks, g)
	}
	for _, g := range report.Checks {
		if g.Outcome == Failed {
			report.Result = Failed
			break
		}
		if g.Outcome == Inconclusive {
			report.Result = Inconclusive
		}
	}
	return report, nil
}

const (
	symptomShouldSucceed  = "a request that should succeed did not"
	symptomShouldRefuse   = "a request that should be refused was allowed"
	symptomWrongResponse  = "a request was answered with the wrong kind of response"
	symptomMissingContent = "a response did not contain what the criterion requires"
	symptomForbidden      = "a response contained something the criterion forbids"
	symptomNotVisible     = "something that should be on the page was not visible"
	symptomShouldBeHidden = "something that should not be on the page was visible"
	symptomWrongPage      = "the page ended up at the wrong address"
)

func gradeHTTP(e HTTPExpect, o *HTTPObservation) (Outcome, string, string) {
	if o == nil {
		return Inconclusive, "", "the runner sent no HTTP observation"
	}
	if o.Status < 100 || o.Status > 599 {
		return Inconclusive, "", fmt.Sprintf("the runner reported status %d, which is not an HTTP status", o.Status)
	}
	if o.Truncated && (e.BodyContains != "" || e.BodyNotContains != "" || len(e.JSON) > 0) {
		return Inconclusive, "", "the response body was cut at the runner's size limit"
	}
	if e.Status != nil && o.Status != *e.Status {
		symptom := symptomWrongResponse
		switch {
		case *e.Status < 400 && o.Status >= 400:
			symptom = symptomShouldSucceed
		case *e.Status >= 400 && o.Status < 400:
			symptom = symptomShouldRefuse
		}
		return Failed, symptom, fmt.Sprintf("status %d, expected %d", o.Status, *e.Status)
	}
	names := make([]string, 0, len(e.Header))
	for name := range e.Header {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		got := o.Header[strings.ToLower(name)]
		if !headerMatches(name, got, e.Header[name]) {
			return Failed, symptomMissingContent, fmt.Sprintf("header %s was %q, expected %q", name, got, e.Header[name])
		}
	}
	if e.BodyContains != "" && !strings.Contains(o.Body, e.BodyContains) {
		return Failed, symptomMissingContent, fmt.Sprintf("body did not contain %q", e.BodyContains)
	}
	if e.BodyNotContains != "" && strings.Contains(o.Body, e.BodyNotContains) {
		return Failed, symptomForbidden, fmt.Sprintf("body contained %q", e.BodyNotContains)
	}
	if len(e.JSON) > 0 {
		var doc any
		dec := json.NewDecoder(strings.NewReader(o.Body))
		dec.UseNumber() // keep numbers exact
		if err := dec.Decode(&doc); err != nil {
			return Failed, symptomMissingContent, "body was not JSON"
		}
		paths := make([]string, 0, len(e.JSON))
		for p := range e.JSON {
			paths = append(paths, p)
		}
		sort.Strings(paths)
		for _, p := range paths {
			got, ok := lookup(doc, p)
			if !ok || !sameJSON(got, e.JSON[p]) {
				return Failed, symptomMissingContent, fmt.Sprintf("JSON path %s was %v, expected %v", p, got, e.JSON[p])
			}
		}
	}
	return Passed, "", ""
}

func gradeBrowser(e BrowserExpect, o *BrowserObservation) (Outcome, string, string) {
	if o == nil {
		return Inconclusive, "", "the runner sent no browser observation"
	}
	if e.Visible != nil {
		if o.VisibleFound == nil {
			return Inconclusive, "", "the runner did not report on the expected element"
		}
		if !*o.VisibleFound {
			return Failed, symptomNotVisible, fmt.Sprintf("%s %q was not visible", e.Visible.Role, e.Visible.Name)
		}
	}
	if e.Hidden != nil {
		if o.HiddenFound == nil {
			return Inconclusive, "", "the runner did not report on the element that must be hidden"
		}
		if *o.HiddenFound {
			return Failed, symptomShouldBeHidden, fmt.Sprintf("%s %q was visible", e.Hidden.Role, e.Hidden.Name)
		}
	}
	if e.TextVisible != "" {
		if o.TextVisibleHit == nil {
			return Inconclusive, "", "the runner did not report on the expected text"
		}
		if !*o.TextVisibleHit {
			return Failed, symptomNotVisible, fmt.Sprintf("text %q was not visible", e.TextVisible)
		}
	}
	if e.URLMatches != "" {
		re, err := regexp.Compile(e.URLMatches)
		if err != nil || !re.MatchString(o.URL) {
			return Failed, symptomWrongPage, fmt.Sprintf("URL was %q, expected to match %q", o.URL, e.URLMatches)
		}
	}
	return Passed, "", ""
}

func lookup(doc any, path string) (any, bool) {
	cur := doc
	for _, part := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		if cur, ok = m[part]; !ok {
			return nil, false
		}
	}
	return cur, true
}

// headerMatches compares a header value exactly, after trimming white space.
// Content-Type is the one exception: its media type is compared without
// regard to case and its parameters (such as charset) are ignored, because
// that is how the header is defined.
func headerMatches(name, got, want string) bool {
	got, want = strings.TrimSpace(got), strings.TrimSpace(want)
	if strings.EqualFold(name, "content-type") {
		mediaType := func(v string) string { return strings.TrimSpace(strings.SplitN(v, ";", 2)[0]) }
		if !strings.Contains(want, ";") {
			return strings.EqualFold(mediaType(got), want)
		}
	}
	return got == want
}

// sameJSON compares a decoded JSON value with a scalar from the suite.
// Numbers are compared exactly, as rationals, so large integers do not
// collide and 2 equals 2.0.
func sameJSON(got, want any) bool {
	switch w := want.(type) {
	case nil:
		return got == nil
	case string:
		g, ok := got.(string)
		return ok && g == w
	case bool:
		g, ok := got.(bool)
		return ok && g == w
	}
	num, ok := got.(json.Number)
	if !ok {
		return false
	}
	g, ok := new(big.Rat).SetString(num.String())
	if !ok {
		return false
	}
	w := new(big.Rat)
	switch n := want.(type) {
	case int:
		w.SetInt64(int64(n))
	case int64:
		w.SetInt64(n)
	case uint64:
		w.SetUint64(n)
	case float64:
		if w.SetFloat64(n) == nil {
			return false
		}
	default:
		return false
	}
	return g.Cmp(w) == 0
}

// Symptom is what a builder may learn from one failed check.
type Symptom struct {
	Criterion string
	Text      string
}

// BuilderFeedback lists what may be sent back to the builder: for each failed
// check that is not a holdout, its criterion and a symptom. It never includes
// a check ID, a request or an expected value. Inconclusive checks produce no
// feedback, because the fault may not be the builder's.
func (r Report) BuilderFeedback() []Symptom {
	var out []Symptom
	seen := map[Symptom]bool{}
	for _, g := range r.Checks {
		if g.Outcome != Failed || g.Holdout {
			continue
		}
		s := Symptom{Criterion: g.Criterion, Text: g.symptom}
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// HoldoutFailed reports whether any holdout check failed. A person is told;
// the builder is not.
func (r Report) HoldoutFailed() bool {
	for _, g := range r.Checks {
		if g.Holdout && g.Outcome == Failed {
			return true
		}
	}
	return false
}
