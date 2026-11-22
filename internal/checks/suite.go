// Package checks holds the declarative check suite: its format, its digest,
// the grade the controller computes from a runner's raw observations, and
// what a builder is allowed to learn from a failure.
//
// A suite is data. It has no scripts and no selectors, it is approved with
// the criteria, and it is frozen before any code exists. See
// docs/design/0003-check-suite.md.
package checks

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"
)

// ErrInvalidSuite is returned by Parse. Callers match it with errors.Is.
var ErrInvalidSuite = errors.New("checks: invalid suite")

// Suite is a frozen set of checks.
type Suite struct {
	Version int      `yaml:"version" json:"version"`
	Actors  []string `yaml:"actors" json:"actors"`
	Checks  []Check  `yaml:"checks" json:"checks"`
}

// Check tests one criterion in one of two ways.
type Check struct {
	ID        string        `yaml:"id" json:"id"`
	Criterion string        `yaml:"criterion" json:"criterion"`
	Holdout   bool          `yaml:"holdout,omitempty" json:"holdout,omitempty"`
	HTTP      *HTTPCheck    `yaml:"http,omitempty" json:"http,omitempty"`
	Browser   *BrowserCheck `yaml:"browser,omitempty" json:"browser,omitempty"`
}

// HTTPCheck makes one request as an actor.
type HTTPCheck struct {
	As      string     `yaml:"as" json:"as"`
	Request string     `yaml:"request" json:"request"` // "GET /path"
	Expect  HTTPExpect `yaml:"expect" json:"expect"`
}

// HTTPExpect lists what the response must satisfy. Every field that is set
// must hold.
type HTTPExpect struct {
	Status          *int              `yaml:"status,omitempty" json:"status,omitempty"`
	Header          map[string]string `yaml:"header,omitempty" json:"header,omitempty"`
	BodyContains    string            `yaml:"body_contains,omitempty" json:"body_contains,omitempty"`
	BodyNotContains string            `yaml:"body_not_contains,omitempty" json:"body_not_contains,omitempty"`
	JSON            map[string]any    `yaml:"json,omitempty" json:"json,omitempty"` // dotted path -> value
}

// BrowserCheck opens one page as an actor.
type BrowserCheck struct {
	As     string        `yaml:"as" json:"as"`
	Open   string        `yaml:"open" json:"open"`
	Expect BrowserExpect `yaml:"expect" json:"expect"`
}

// RoleName finds an element the way a user of assistive technology would.
type RoleName struct {
	Role string `yaml:"role" json:"role"`
	Name string `yaml:"name" json:"name"`
}

// BrowserExpect lists what the page must satisfy.
type BrowserExpect struct {
	Visible     *RoleName `yaml:"visible,omitempty" json:"visible,omitempty"`
	Hidden      *RoleName `yaml:"hidden,omitempty" json:"hidden,omitempty"`
	TextVisible string    `yaml:"text_visible,omitempty" json:"text_visible,omitempty"`
	URLMatches  string    `yaml:"url_matches,omitempty" json:"url_matches,omitempty"`
}

var (
	idPattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	requestPattern = regexp.MustCompile(`^(GET|HEAD|POST|PUT|PATCH|DELETE) (/\S*)$`)
)

// Parse reads a suite from YAML and validates it. Unknown fields are errors,
// so a typo cannot silently drop an expectation.
func Parse(data []byte) (Suite, error) {
	var s Suite
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&s); err != nil {
		return Suite{}, fmt.Errorf("%w: %v", ErrInvalidSuite, err)
	}
	if err := s.validate(); err != nil {
		return Suite{}, fmt.Errorf("%w: %v", ErrInvalidSuite, err)
	}
	return s, nil
}

func (s Suite) validate() error {
	if s.Version != 1 {
		return fmt.Errorf("version %d is not supported", s.Version)
	}
	if len(s.Checks) == 0 {
		return errors.New("a suite needs at least one check")
	}
	actors := map[string]bool{}
	for _, a := range s.Actors {
		if !idPattern.MatchString(a) {
			return fmt.Errorf("actor %q is not a valid name", a)
		}
		actors[a] = true
	}
	seen := map[string]bool{}
	for _, c := range s.Checks {
		if !idPattern.MatchString(c.ID) {
			return fmt.Errorf("check ID %q is not valid", c.ID)
		}
		if seen[c.ID] {
			return fmt.Errorf("check ID %q is used twice", c.ID)
		}
		seen[c.ID] = true
		if !idPattern.MatchString(c.Criterion) {
			return fmt.Errorf("check %s: criterion %q is not valid", c.ID, c.Criterion)
		}
		switch {
		case c.HTTP != nil && c.Browser != nil:
			return fmt.Errorf("check %s: has both http and browser", c.ID)
		case c.HTTP != nil:
			if !actors[c.HTTP.As] {
				return fmt.Errorf("check %s: actor %q is not declared", c.ID, c.HTTP.As)
			}
			if !requestPattern.MatchString(c.HTTP.Request) {
				return fmt.Errorf("check %s: request %q must look like \"GET /path\"", c.ID, c.HTTP.Request)
			}
			e := c.HTTP.Expect
			if e.Status == nil && len(e.Header) == 0 && e.BodyContains == "" && e.BodyNotContains == "" && len(e.JSON) == 0 {
				return fmt.Errorf("check %s: expects nothing", c.ID)
			}
			if e.Status != nil && (*e.Status < 100 || *e.Status > 599) {
				return fmt.Errorf("check %s: status %d is not an HTTP status", c.ID, *e.Status)
			}
		case c.Browser != nil:
			if !actors[c.Browser.As] {
				return fmt.Errorf("check %s: actor %q is not declared", c.ID, c.Browser.As)
			}
			if !strings.HasPrefix(c.Browser.Open, "/") {
				return fmt.Errorf("check %s: open %q must be a path", c.ID, c.Browser.Open)
			}
			e := c.Browser.Expect
			if e.Visible == nil && e.Hidden == nil && e.TextVisible == "" && e.URLMatches == "" {
				return fmt.Errorf("check %s: expects nothing", c.ID)
			}
			for _, rn := range []*RoleName{e.Visible, e.Hidden} {
				if rn != nil && (rn.Role == "" || rn.Name == "") {
					return fmt.Errorf("check %s: role and name are both required", c.ID)
				}
			}
			if e.URLMatches != "" {
				if _, err := regexp.Compile(e.URLMatches); err != nil {
					return fmt.Errorf("check %s: url_matches is not a valid pattern", c.ID)
				}
			}
		default:
			return fmt.Errorf("check %s: needs http or browser", c.ID)
		}
	}
	return nil
}

// Digest is the SHA-256 of the suite's canonical JSON form. Comments, key
// order and whitespace in the YAML source do not change it.
func (s Suite) Digest() string {
	canonical, err := json.Marshal(s)
	if err != nil {
		// Suite holds only strings, numbers, booleans and maps of them.
		panic(fmt.Sprintf("checks: suite cannot be encoded: %v", err))
	}
	sum := sha256.Sum256(canonical)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// Check returns the check with the given ID.
func (s Suite) Check(id string) (Check, bool) {
	for _, c := range s.Checks {
		if c.ID == id {
			return c, true
		}
	}
	return Check{}, false
}
