// Package verify is the release gate. The controller side decides whether an
// image may be released now and signs a short-lived decision. The verifier
// side, which runs in the user's own delivery pipeline, checks that decision
// against a verify policy. See docs/design/0004-attestation-and-verify-policy.md.
package verify

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/sagart-cactus/sprintfoundry/internal/signer"
)

// ErrInvalidPolicy is returned by ParsePolicy.
var ErrInvalidPolicy = errors.New("verify: invalid policy")

// Policy says what a release must be backed by. It is kept with the
// deployment configuration, never in the application repository.
type Policy struct {
	Version        int             `yaml:"version"`
	Purpose        signer.Purpose  `yaml:"purpose"`
	Repository     string          `yaml:"repository"`
	Environment    string          `yaml:"environment"`
	TrustedSigners []TrustedSigner `yaml:"trusted_signers"`
	Expect         Expect          `yaml:"expect"`
	MaxEvidenceAge Duration        `yaml:"max_evidence_age"`
	MaxDecisionAge Duration        `yaml:"max_decision_age"`

	digest string
}

// TrustedSigner is an identity whose decisions the policy accepts.
type TrustedSigner struct {
	Identity string `yaml:"identity"`
	// PublicKey is a base64 Ed25519 key. It is how a key-based identity,
	// such as the demo signer, is verified.
	PublicKey string `yaml:"public_key,omitempty"`
}

// Expect pins the frozen inputs the evidence must have been produced with.
type Expect struct {
	Criteria   string `yaml:"criteria"`
	CheckSuite string `yaml:"check_suite"`
	RunSpec    string `yaml:"run_spec"`
}

// Duration is a time.Duration that reads from YAML as "15m" or "24h".
type Duration time.Duration

func (d *Duration) UnmarshalYAML(node *yaml.Node) error {
	parsed, err := time.ParseDuration(node.Value)
	if err != nil {
		return fmt.Errorf("%q is not a duration such as 15m or 24h", node.Value)
	}
	*d = Duration(parsed)
	return nil
}

var sha256Ref = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// ParsePolicy reads and validates a policy file. The policy's digest is the
// SHA-256 of the file's bytes.
func ParsePolicy(data []byte) (Policy, error) {
	var p Policy
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&p); err != nil {
		return Policy{}, fmt.Errorf("%w: %v", ErrInvalidPolicy, err)
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return Policy{}, fmt.Errorf("%w: the file holds more than one YAML document", ErrInvalidPolicy)
	}
	fail := func(format string, args ...any) (Policy, error) {
		return Policy{}, fmt.Errorf("%w: "+format, append([]any{ErrInvalidPolicy}, args...)...)
	}
	switch {
	case p.Version != 1:
		return fail("version %d is not supported", p.Version)
	case p.Purpose != signer.PurposeDemo && p.Purpose != signer.PurposeProduction:
		return fail("purpose must be demo or production")
	case p.Repository == "" || p.Environment == "" || strings.Contains(p.Environment, "#"):
		return fail("repository and environment are required")
	case len(p.TrustedSigners) == 0:
		return fail("at least one trusted signer is required")
	case !sha256Ref.MatchString(p.Expect.Criteria), !sha256Ref.MatchString(p.Expect.CheckSuite), !sha256Ref.MatchString(p.Expect.RunSpec):
		return fail("expect.criteria, expect.check_suite and expect.run_spec must each be sha256:<64 hex>")
	case p.MaxEvidenceAge <= 0 || p.MaxDecisionAge <= 0:
		return fail("max_evidence_age and max_decision_age must be positive")
	case time.Duration(p.MaxDecisionAge) > time.Hour:
		return fail("max_decision_age must not exceed one hour; a decision is meant to be short-lived")
	}
	for _, s := range p.TrustedSigners {
		if s.Identity == "" {
			return fail("a trusted signer has no identity")
		}
		if p.Purpose == signer.PurposeProduction && signer.IsDemoIdentity(s.Identity) {
			return fail("a demo signer cannot be trusted for production")
		}
		if s.PublicKey != "" {
			if key, err := base64.StdEncoding.DecodeString(s.PublicKey); err != nil || len(key) != ed25519.PublicKeySize {
				return fail("public key of %s is not a base64 Ed25519 key", s.Identity)
			}
		}
	}
	sum := sha256.Sum256(data)
	p.digest = "sha256:" + hex.EncodeToString(sum[:])
	return p, nil
}

// Digest returns sha256:<hex> of the policy file.
func (p Policy) Digest() string { return p.digest }

// ResourceURI names where a release under this policy goes.
func (p Policy) ResourceURI() string { return p.Repository + "#" + p.Environment }

// Image is an image reference by digest.
type Image struct {
	Name   string // empty for a bare image ID
	Digest string // 64 hex characters
}

var (
	bareDigest = regexp.MustCompile(`^(sha256:)?([0-9a-f]{64})$`)
	nameDigest = regexp.MustCompile(`^([^@\s]+)@sha256:([0-9a-f]{64})$`)
)

// ParseImage reads an image reference. It accepts an image ID or
// name@sha256:digest, and never a tag.
func ParseImage(ref string) (Image, error) {
	if m := bareDigest.FindStringSubmatch(ref); m != nil {
		return Image{Digest: m[2]}, nil
	}
	if m := nameDigest.FindStringSubmatch(ref); m != nil {
		return Image{Name: m[1], Digest: m[2]}, nil
	}
	return Image{}, fmt.Errorf("verify: %q is not an image digest; a tag can be moved and is never accepted", ref)
}
