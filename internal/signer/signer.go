// Package signer signs the controller's statements as DSSE envelopes.
//
// A signing key never enters a sandbox. The local demo signer can sign for
// the demo purpose only, and its identity is marked so that a production
// verify policy can never trust it.
package signer

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Purpose says what a signature may be used for.
type Purpose string

const (
	PurposeDemo       Purpose = "demo"
	PurposeProduction Purpose = "production"
)

// DemoIdentityPrefix marks the identity of every demo signer.
const DemoIdentityPrefix = "demo:ed25519:"

// PayloadTypeInToto is the DSSE payload type of an in-toto statement.
const PayloadTypeInToto = "application/vnd.in-toto+json"

// Errors returned by this package. Callers match them with errors.Is.
var (
	ErrPurposeNotAllowed = errors.New("signer: this signer may not sign for that purpose")
	ErrBadSignature      = errors.New("signer: signature does not verify")
)

// Signature is one DSSE signature.
type Signature struct {
	KeyID string `json:"keyid"`
	Sig   string `json:"sig"` // base64
}

// Envelope is a DSSE envelope.
type Envelope struct {
	PayloadType string      `json:"payloadType"`
	Payload     string      `json:"payload"` // base64
	Signatures  []Signature `json:"signatures"`
}

// Signer signs in-toto statements on behalf of the controller.
type Signer interface {
	// Identity names the signer in a way a verify policy can list.
	Identity() string
	// Sign returns an envelope over an in-toto statement. A signer reads the
	// purpose from the statement itself and returns ErrPurposeNotAllowed if
	// it may not sign for it, so the purpose is part of what is signed.
	Sign(ctx context.Context, statement []byte) (Envelope, error)
	// Verify checks that this signer signed the envelope and returns the
	// statement. The controller uses it to re-check evidence it reads back
	// from its own store before relying on it.
	Verify(env Envelope) (statement []byte, err error)
}

// PurposeAnnotation is the subject annotation that carries a statement's
// purpose.
const PurposeAnnotation = "purpose"

// StatementPurpose returns the purpose an in-toto statement declares. Every
// subject must carry the same purpose annotation. A statement without one has
// no purpose and cannot be signed.
func StatementPurpose(statement []byte) (Purpose, error) {
	var s struct {
		Type    string `json:"_type"`
		Subject []struct {
			Annotations map[string]string `json:"annotations"`
		} `json:"subject"`
	}
	if err := json.Unmarshal(statement, &s); err != nil {
		return "", fmt.Errorf("signer: payload is not a statement: %w", err)
	}
	if s.Type != "https://in-toto.io/Statement/v1" || len(s.Subject) == 0 {
		return "", errors.New("signer: payload is not an in-toto v1 statement with a subject")
	}
	purpose := Purpose(s.Subject[0].Annotations[PurposeAnnotation])
	for _, subject := range s.Subject {
		if Purpose(subject.Annotations[PurposeAnnotation]) != purpose {
			return "", errors.New("signer: subjects disagree about the purpose")
		}
	}
	if purpose != PurposeDemo && purpose != PurposeProduction {
		return "", fmt.Errorf("signer: statement declares no known purpose (%q)", purpose)
	}
	return purpose, nil
}

// PAE is the DSSE pre-authentication encoding: the bytes that are signed.
func PAE(payloadType string, payload []byte) []byte {
	return []byte(fmt.Sprintf("DSSEv1 %d %s %d %s", len(payloadType), payloadType, len(payload), payload))
}

// Demo is a local Ed25519 signer for the demo purpose.
type Demo struct {
	key ed25519.PrivateKey
}

var _ Signer = (*Demo)(nil)

// NewDemo generates a fresh demo key.
func NewDemo() (*Demo, error) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("signer: generate demo key: %w", err)
	}
	return &Demo{key: key}, nil
}

// DemoFromSeed rebuilds a demo signer from its 32-byte seed, so the same key
// survives a controller restart.
func DemoFromSeed(seed []byte) (*Demo, error) {
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("signer: demo seed must be %d bytes", ed25519.SeedSize)
	}
	return &Demo{key: ed25519.NewKeyFromSeed(seed)}, nil
}

// Seed returns the bytes DemoFromSeed needs. It is stored only in the
// controller's data directory.
func (d *Demo) Seed() []byte { return d.key.Seed() }

// PublicKey returns the verification key.
func (d *Demo) PublicKey() ed25519.PublicKey { return d.key.Public().(ed25519.PublicKey) }

func (d *Demo) Identity() string {
	sum := sha256.Sum256(d.PublicKey())
	return DemoIdentityPrefix + hex.EncodeToString(sum[:])
}

func (d *Demo) Sign(_ context.Context, statement []byte) (Envelope, error) {
	purpose, err := StatementPurpose(statement)
	if err != nil {
		return Envelope{}, fmt.Errorf("%w: %v", ErrPurposeNotAllowed, err)
	}
	if purpose != PurposeDemo {
		return Envelope{}, fmt.Errorf("%w: demo signer given a statement for %q", ErrPurposeNotAllowed, purpose)
	}
	sig := ed25519.Sign(d.key, PAE(PayloadTypeInToto, statement))
	return Envelope{
		PayloadType: PayloadTypeInToto,
		Payload:     base64.StdEncoding.EncodeToString(statement),
		Signatures:  []Signature{{KeyID: d.Identity(), Sig: base64.StdEncoding.EncodeToString(sig)}},
	}, nil
}

func (d *Demo) Verify(env Envelope) ([]byte, error) {
	return VerifyEd25519(env, d.PublicKey())
}

// IsDemoIdentity reports whether an identity belongs to a demo signer.
func IsDemoIdentity(identity string) bool {
	return strings.HasPrefix(identity, DemoIdentityPrefix)
}

// VerifyEd25519 checks that the envelope carries a valid signature by pub and
// returns the payload.
func VerifyEd25519(env Envelope, pub ed25519.PublicKey) ([]byte, error) {
	payload, err := base64.StdEncoding.DecodeString(env.Payload)
	if err != nil {
		return nil, fmt.Errorf("%w: payload is not base64", ErrBadSignature)
	}
	message := PAE(env.PayloadType, payload)
	for _, s := range env.Signatures {
		sig, err := base64.StdEncoding.DecodeString(s.Sig)
		if err != nil {
			continue
		}
		if ed25519.Verify(pub, message, sig) {
			return payload, nil
		}
	}
	return nil, ErrBadSignature
}
