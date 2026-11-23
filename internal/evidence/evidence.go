// Package evidence builds the two statements SprintFoundry signs: the
// evidence of one evaluation, and the short-lived decision that an image may
// be released. See docs/design/0004-attestation-and-verify-policy.md.
package evidence

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/checks"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
)

// Statement and predicate types.
const (
	StatementType      = "https://in-toto.io/Statement/v1"
	TestResultType     = "https://in-toto.io/attestation/test-result/v0.1"
	VerificationType   = "https://slsa.dev/verification_summary/v1"
	ChecksPassedLevel  = "SPRINTFOUNDRY_CHECKS_PASSED"
	extensionNamespace = "https://github.com/sagart-cactus/sprintfoundry/"
)

// DigestKind says what a subject's SHA-256 is the hash of.
type DigestKind string

const (
	// ImageConfig is a local image ID. It identifies an image on one machine.
	ImageConfig DigestKind = "image-config"
	// Manifest is a registry manifest digest. It is what a deployment pulls.
	Manifest DigestKind = "manifest"
)

// ResourceDescriptor is the in-toto v1 ResourceDescriptor, limited to the
// fields SprintFoundry writes.
type ResourceDescriptor struct {
	Name        string            `json:"name,omitempty"`
	URI         string            `json:"uri,omitempty"`
	Digest      map[string]string `json:"digest,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

// Statement is an in-toto v1 statement.
type Statement struct {
	Type          string               `json:"_type"`
	Subject       []ResourceDescriptor `json:"subject"`
	PredicateType string               `json:"predicateType"`
	Predicate     json.RawMessage      `json:"predicate"`
}

// TestResult is the test-result v0.1 predicate.
type TestResult struct {
	Result        string               `json:"result"` // PASSED, WARNED or FAILED
	Configuration []ResourceDescriptor `json:"configuration"`
	URL           string               `json:"url,omitempty"`
	PassedTests   []string             `json:"passedTests"`
	WarnedTests   []string             `json:"warnedTests"`
	FailedTests   []string             `json:"failedTests"`
}

var (
	hex64      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	sha256Ref  = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	gitObject  = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)
	errInvalid = errors.New("evidence: invalid input")
)

// Evaluation is everything one evidence statement records.
type Evaluation struct {
	ImageName   string     // for example "local/invoices" or "ghcr.io/owner/app"
	ImageDigest string     // 64 hex characters
	DigestKind  DigestKind // what ImageDigest is the hash of

	CriteriaDigest string // sha256:...
	SuiteDigest    string // sha256:...
	RunSpecDigest  string // sha256:...
	RunnerImage    string // 64 hex characters

	Repository string // for example "github.com/owner/repo"
	Commit     string // full Git commit ID
	Tree       string // full Git tree ID

	RunID      string
	Purpose    signer.Purpose
	FinishedAt time.Time
	ReportURL  string

	// NameKey is the controller's secret for naming checks in the statement.
	NameKey []byte

	// ReviewRequired lists why a person must look before this evidence can
	// back a release, for example "change touches Dockerfile".
	ReviewRequired []string

	// Check says what kind of evaluation this was. Only builder runs and
	// release checks can back a release; a pull request check is advisory.
	Check CheckKind

	Report checks.Report
}

func (e Evaluation) validate() error {
	switch {
	case e.ImageName == "":
		return fmt.Errorf("%w: image name is empty", errInvalid)
	case !hex64.MatchString(e.ImageDigest):
		return fmt.Errorf("%w: image digest must be 64 hex characters", errInvalid)
	case e.DigestKind != ImageConfig && e.DigestKind != Manifest:
		return fmt.Errorf("%w: digest kind %q", errInvalid, e.DigestKind)
	case !sha256Ref.MatchString(e.CriteriaDigest), !sha256Ref.MatchString(e.SuiteDigest), !sha256Ref.MatchString(e.RunSpecDigest):
		return fmt.Errorf("%w: criteria, suite and run spec digests must look like sha256:<64 hex>", errInvalid)
	case !hex64.MatchString(e.RunnerImage):
		return fmt.Errorf("%w: runner image must be 64 hex characters", errInvalid)
	case !gitObject.MatchString(e.Commit), !gitObject.MatchString(e.Tree):
		return fmt.Errorf("%w: commit and tree must be full Git object IDs", errInvalid)
	case e.RunID == "" || e.Repository == "":
		return fmt.Errorf("%w: run ID and repository are required", errInvalid)
	case e.Purpose != signer.PurposeDemo && e.Purpose != signer.PurposeProduction:
		return fmt.Errorf("%w: purpose %q", errInvalid, e.Purpose)
	case e.FinishedAt.IsZero():
		return fmt.Errorf("%w: finish time is required", errInvalid)
	case len(e.Report.Checks) == 0:
		return fmt.Errorf("%w: report has no checks", errInvalid)
	case len(e.NameKey) < 16:
		return fmt.Errorf("%w: the key for naming checks is missing or shorter than 16 bytes", errInvalid)
	case e.Check != CheckBuilder && e.Check != CheckPullRequest && e.Check != CheckRelease:
		return fmt.Errorf("%w: check kind %q", errInvalid, e.Check)
	}
	return nil
}

// TestName is how a signed statement names a check: its criterion and a
// keyed hash of the suite digest and the check ID. The key never leaves the
// controller, so a reader of the statement cannot confirm a guessed check ID.
// A holdout check does not show its criterion either.
func TestName(key []byte, suiteDigest string, g checks.CheckGrade) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(suiteDigest + "\x00" + g.ID))
	prefix := g.Criterion
	if g.Holdout {
		prefix = "holdout"
	}
	return prefix + "/" + hex.EncodeToString(mac.Sum(nil))[:12]
}

// CheckKind is what kind of evaluation produced a statement.
type CheckKind string

// Check kinds, recorded in the run descriptor's "check" annotation.
const (
	// CheckBuilder evaluates a change a builder made in a controller run.
	CheckBuilder CheckKind = "builder"
	// CheckPullRequest evaluates a pull request's head. Its result is
	// advisory and never backs a release.
	CheckPullRequest CheckKind = "pull-request"
	// CheckRelease evaluates a commit after merge: the release candidate.
	CheckRelease CheckKind = "release"
)

// Outcome values recorded in the run descriptor.
const (
	OutcomePassed       = "passed"
	OutcomeFailed       = "failed"
	OutcomeInconclusive = "inconclusive"
)

// NewEvidence builds the evidence statement for one evaluation.
func NewEvidence(e Evaluation) (Statement, error) {
	if err := e.validate(); err != nil {
		return Statement{}, err
	}
	pred := TestResult{URL: e.ReportURL, PassedTests: []string{}, WarnedTests: []string{}, FailedTests: []string{}}
	failed, inconclusive := 0, 0
	for _, g := range e.Report.Checks {
		name := TestName(e.NameKey, e.SuiteDigest, g)
		switch g.Outcome {
		case checks.Passed:
			pred.PassedTests = append(pred.PassedTests, name)
		case checks.Failed:
			failed++
			pred.FailedTests = append(pred.FailedTests, name)
		default:
			// The predicate defines a warned test as one that passed with
			// warnings, so a check that could not be completed is listed as
			// failed and the run's outcome says why.
			inconclusive++
			pred.FailedTests = append(pred.FailedTests, name)
		}
	}
	sort.Strings(pred.PassedTests)
	sort.Strings(pred.FailedTests)
	// The result is derived from the per-check grades, not copied from the
	// report's headline, so the two can never disagree.
	outcome := OutcomePassed
	pred.Result = "PASSED"
	switch {
	case failed > 0:
		outcome, pred.Result = OutcomeFailed, "FAILED"
	case inconclusive > 0:
		outcome, pred.Result = OutcomeInconclusive, "FAILED"
	}

	run := map[string]string{
		"outcome":    outcome,
		"finishedAt": e.FinishedAt.UTC().Format(time.RFC3339),
		"check":      string(e.Check),
	}
	if len(e.ReviewRequired) > 0 {
		reasons := append([]string(nil), e.ReviewRequired...)
		sort.Strings(reasons)
		run["reviewRequired"] = strings.Join(reasons, "; ")
	}
	pred.Configuration = []ResourceDescriptor{
		{Name: "criteria", Digest: map[string]string{"sha256": strings.TrimPrefix(e.CriteriaDigest, "sha256:")}},
		{Name: "check-suite", Digest: map[string]string{"sha256": strings.TrimPrefix(e.SuiteDigest, "sha256:")}},
		{Name: "run-spec", Digest: map[string]string{"sha256": strings.TrimPrefix(e.RunSpecDigest, "sha256:")}},
		{Name: "runner-image", Digest: map[string]string{"sha256": e.RunnerImage}},
		{Name: "source-commit", Digest: map[string]string{"gitCommit": e.Commit},
			Annotations: map[string]string{"repository": e.Repository}},
		{Name: "source-tree", Digest: map[string]string{"gitTree": e.Tree}},
		{Name: "run", URI: RunURI(e.RunID), Annotations: run},
	}

	raw, err := json.Marshal(pred)
	if err != nil {
		return Statement{}, fmt.Errorf("evidence: encode predicate: %w", err)
	}
	return Statement{
		Type:          StatementType,
		Subject:       []ResourceDescriptor{subject(e.ImageName, e.ImageDigest, e.DigestKind, e.Purpose)},
		PredicateType: TestResultType,
		Predicate:     raw,
	}, nil
}

// RunURI names a run in a statement.
func RunURI(runID string) string { return "sprintfoundry:run/" + runID }

// subject builds the one subject of a statement. The purpose sits here so
// that it is part of the signed bytes and a signer can read it.
func subject(name, digest string, kind DigestKind, purpose signer.Purpose) ResourceDescriptor {
	return ResourceDescriptor{
		Name:   name,
		Digest: map[string]string{"sha256": digest},
		Annotations: map[string]string{
			"digestKind":             string(kind),
			signer.PurposeAnnotation: string(purpose),
		},
	}
}

// Marshal returns the statement's bytes: the DSSE payload.
func (s Statement) Marshal() ([]byte, error) {
	return json.Marshal(s)
}

// Digest returns sha256:<hex> of a statement's bytes.
func Digest(payload []byte) string {
	sum := sha256.Sum256(payload)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// ParseTestResult reads an evidence statement back. It refuses anything that
// is not a test-result statement with exactly one subject.
func ParseTestResult(payload []byte) (Statement, TestResult, error) {
	var s Statement
	if err := json.Unmarshal(payload, &s); err != nil {
		return Statement{}, TestResult{}, fmt.Errorf("evidence: not a statement: %w", err)
	}
	if s.Type != StatementType || s.PredicateType != TestResultType || len(s.Subject) != 1 {
		return Statement{}, TestResult{}, errors.New("evidence: not a test-result statement with one subject")
	}
	var p TestResult
	if err := json.Unmarshal(s.Predicate, &p); err != nil {
		return Statement{}, TestResult{}, fmt.Errorf("evidence: predicate: %w", err)
	}
	return s, p, nil
}

// Config returns the named configuration entry of a test result.
func (p TestResult) Config(name string) (ResourceDescriptor, bool) {
	for _, d := range p.Configuration {
		if d.Name == name {
			return d, true
		}
	}
	return ResourceDescriptor{}, false
}
