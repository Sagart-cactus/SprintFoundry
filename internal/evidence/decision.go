package evidence

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// VerificationSummary is the SLSA verification summary v1 predicate, limited
// to the fields SprintFoundry writes.
type VerificationSummary struct {
	Verifier           Verifier             `json:"verifier"`
	TimeVerified       string               `json:"timeVerified"`
	ResourceURI        string               `json:"resourceUri"`
	Policy             ResourceDescriptor   `json:"policy"`
	InputAttestations  []ResourceDescriptor `json:"inputAttestations"`
	VerificationResult string               `json:"verificationResult"` // PASSED or FAILED
	VerifiedLevels     []string             `json:"verifiedLevels"`
	SlsaVersion        string               `json:"slsaVersion"`
}

// Verifier names who made the decision.
type Verifier struct {
	ID string `json:"id"`
}

// Decision is everything one release decision records.
type Decision struct {
	ImageName   string
	ImageDigest string
	DigestKind  DigestKind

	// VerifierID is the controller's identity.
	VerifierID string
	// ResourceURI names where the release goes: repository and environment.
	ResourceURI string
	// PolicyURI and PolicyDigest identify the verify policy that was applied.
	PolicyURI    string
	PolicyDigest string // sha256:...
	// EvidenceDigest is the digest of the evidence statement this decision
	// rests on.
	EvidenceDigest string // sha256:...
	Passed         bool
	At             time.Time
}

// NewDecision builds the decision statement.
func NewDecision(d Decision) (Statement, error) {
	switch {
	case d.ImageName == "" || !hex64.MatchString(d.ImageDigest):
		return Statement{}, fmt.Errorf("%w: image name and a 64 hex digest are required", errInvalid)
	case d.DigestKind != ImageConfig && d.DigestKind != Manifest:
		return Statement{}, fmt.Errorf("%w: digest kind %q", errInvalid, d.DigestKind)
	case d.VerifierID == "" || d.ResourceURI == "" || d.PolicyURI == "":
		return Statement{}, fmt.Errorf("%w: verifier, resource and policy URIs are required", errInvalid)
	case !sha256Ref.MatchString(d.PolicyDigest) || !sha256Ref.MatchString(d.EvidenceDigest):
		return Statement{}, fmt.Errorf("%w: policy and evidence digests must look like sha256:<64 hex>", errInvalid)
	case d.At.IsZero():
		return Statement{}, fmt.Errorf("%w: decision time is required", errInvalid)
	}
	pred := VerificationSummary{
		Verifier:     Verifier{ID: d.VerifierID},
		TimeVerified: d.At.UTC().Format(time.RFC3339),
		ResourceURI:  d.ResourceURI,
		Policy: ResourceDescriptor{URI: d.PolicyURI,
			Digest: map[string]string{"sha256": strings.TrimPrefix(d.PolicyDigest, "sha256:")}},
		InputAttestations: []ResourceDescriptor{{
			Digest: map[string]string{"sha256": strings.TrimPrefix(d.EvidenceDigest, "sha256:")}}},
		VerificationResult: "FAILED",
		VerifiedLevels:     []string{},
		SlsaVersion:        "1.2",
	}
	if d.Passed {
		pred.VerificationResult = "PASSED"
		pred.VerifiedLevels = []string{ChecksPassedLevel}
	}
	raw, err := json.Marshal(pred)
	if err != nil {
		return Statement{}, fmt.Errorf("evidence: encode decision: %w", err)
	}
	return Statement{
		Type: StatementType,
		Subject: []ResourceDescriptor{{
			Name:        d.ImageName,
			Digest:      map[string]string{"sha256": d.ImageDigest},
			Annotations: map[string]string{"digestKind": string(d.DigestKind)},
		}},
		PredicateType: VerificationType,
		Predicate:     raw,
	}, nil
}

// ParseDecision reads a decision statement back.
func ParseDecision(payload []byte) (Statement, VerificationSummary, error) {
	var s Statement
	if err := json.Unmarshal(payload, &s); err != nil {
		return Statement{}, VerificationSummary{}, fmt.Errorf("evidence: not a statement: %w", err)
	}
	if s.Type != StatementType || s.PredicateType != VerificationType || len(s.Subject) != 1 {
		return Statement{}, VerificationSummary{}, errors.New("evidence: not a verification summary with one subject")
	}
	var p VerificationSummary
	if err := json.Unmarshal(s.Predicate, &p); err != nil {
		return Statement{}, VerificationSummary{}, fmt.Errorf("evidence: predicate: %w", err)
	}
	return s, p, nil
}
