package verify

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/evidence"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

// Errors returned by this package. Callers match them with errors.Is.
var (
	// ErrNoEvidence means the controller holds no evidence for the image.
	ErrNoEvidence = errors.New("verify: no evidence for this image")
	// ErrRejected means a decision does not authorise the release.
	ErrRejected = errors.New("verify: release not authorised")
)

// EvidenceStore is what the controller side needs from its store.
type EvidenceStore interface {
	LatestEvidence(ctx context.Context, repository, imageDigest string) (postgres.Evidence, error)
	PutDecision(ctx context.Context, digest, evidenceDigest string, envelope []byte) error
}

// Decide is the controller side. It looks at the newest evidence for the
// image, decides whether it may back a release under the policy right now,
// and returns a signed decision either way, together with the reasons for a
// refusal. Everything it relies on is read from the signed evidence
// statement, not from the store's columns.
func Decide(ctx context.Context, store EvidenceStore, sgn signer.Signer, policy Policy, policyURI string, image Image, now time.Time) (signer.Envelope, []string, error) {
	row, err := store.LatestEvidence(ctx, policy.Repository, image.Digest)
	if errors.Is(err, postgres.ErrNotFound) {
		return signer.Envelope{}, nil, ErrNoEvidence
	}
	if err != nil {
		return signer.Envelope{}, nil, err
	}
	var evidenceEnvelope signer.Envelope
	if err := json.Unmarshal(row.Envelope, &evidenceEnvelope); err != nil {
		return signer.Envelope{}, nil, fmt.Errorf("verify: stored evidence is not an envelope: %w", err)
	}
	payload, err := sgn.Verify(evidenceEnvelope)
	if err != nil {
		return signer.Envelope{}, nil, fmt.Errorf("verify: stored evidence was not signed by this controller: %w", err)
	}
	statement, result, err := evidence.ParseTestResult(payload)
	if err != nil {
		return signer.Envelope{}, nil, err
	}
	purpose, err := signer.StatementPurpose(payload)
	if err != nil {
		return signer.Envelope{}, nil, err
	}
	subject := statement.Subject[0]
	kind := evidence.DigestKind(subject.Annotations["digestKind"])

	var reasons []string
	refuse := func(format string, args ...any) { reasons = append(reasons, fmt.Sprintf(format, args...)) }

	if subject.Digest["sha256"] != image.Digest {
		refuse("the evidence is for another image")
	}
	if result.Result != "PASSED" || len(result.FailedTests) > 0 || len(result.WarnedTests) > 0 {
		run, _ := result.Config("run")
		refuse("the evaluation did not pass (outcome: %s)", run.Annotations["outcome"])
	}
	if row.Superseded {
		refuse("a newer run for the same criteria has started, so this result is superseded")
	}
	if run, _ := result.Config("run"); run.Annotations["reviewRequired"] != "" && row.ReviewApprovedBy == "" {
		refuse("a person must review this change first: %s", run.Annotations["reviewRequired"])
	}
	if purpose != policy.Purpose {
		refuse("the evidence was produced for purpose %q, the policy requires %q", purpose, policy.Purpose)
	}
	if policy.Purpose == signer.PurposeProduction && kind != evidence.Manifest {
		refuse("a production release needs a registry manifest digest, not a local image ID")
	}
	for name, want := range map[string]string{"criteria": policy.Expect.Criteria, "check-suite": policy.Expect.CheckSuite, "run-spec": policy.Expect.RunSpec} {
		got, _ := result.Config(name)
		if "sha256:"+got.Digest["sha256"] != want {
			refuse("the %s digest differs from the one the policy expects", name)
		}
	}
	run, _ := result.Config("run")
	finished, err := time.Parse(time.RFC3339, run.Annotations["finishedAt"])
	switch {
	case err != nil:
		refuse("the evidence has no finish time")
	case now.Sub(finished) > time.Duration(policy.MaxEvidenceAge):
		refuse("the evidence is older than %s", time.Duration(policy.MaxEvidenceAge))
	case finished.After(now.Add(time.Minute)):
		refuse("the evidence is dated in the future")
	}

	name := image.Name
	if name == "" {
		name = subject.Name
	}
	decision, err := evidence.NewDecision(evidence.Decision{
		ImageName: name, ImageDigest: image.Digest, DigestKind: kind, Purpose: purpose,
		VerifierID: sgn.Identity(), ResourceURI: policy.ResourceURI(),
		PolicyURI: policyURI, PolicyDigest: policy.Digest(),
		EvidenceDigest: evidence.Digest(payload), Passed: len(reasons) == 0, At: now,
	})
	if err != nil {
		return signer.Envelope{}, nil, err
	}
	decisionPayload, err := decision.Marshal()
	if err != nil {
		return signer.Envelope{}, nil, err
	}
	envelope, err := sgn.Sign(ctx, decisionPayload)
	if err != nil {
		return signer.Envelope{}, nil, fmt.Errorf("verify: sign decision: %w", err)
	}
	stored, err := json.Marshal(envelope)
	if err != nil {
		return signer.Envelope{}, nil, err
	}
	if err := store.PutDecision(ctx, evidence.Digest(decisionPayload), row.Digest, stored); err != nil {
		return signer.Envelope{}, nil, err
	}
	return envelope, reasons, nil
}

// Check is the verifier side. It accepts a decision only if a signer the
// policy trusts signed it, and it names this image, this policy, this
// repository and environment, says PASSED, and is younger than the policy's
// max_decision_age.
func Check(envelope signer.Envelope, policy Policy, image Image, now time.Time) error {
	reject := func(format string, args ...any) error {
		return fmt.Errorf("%w: "+format, append([]any{ErrRejected}, args...)...)
	}
	var payload []byte
	var signedBy string
	for _, trusted := range policy.TrustedSigners {
		if trusted.PublicKey == "" {
			continue // keyless identities arrive with milestone 2
		}
		key, err := base64.StdEncoding.DecodeString(trusted.PublicKey)
		if err != nil || len(key) != ed25519.PublicKeySize {
			continue
		}
		if p, err := signer.VerifyEd25519(envelope, ed25519.PublicKey(key)); err == nil {
			payload, signedBy = p, trusted.Identity
			break
		}
	}
	if payload == nil {
		return reject("the decision is not signed by a signer this policy trusts")
	}
	if envelope.PayloadType != signer.PayloadTypeInToto {
		return reject("the envelope does not hold an in-toto statement")
	}
	purpose, err := signer.StatementPurpose(payload)
	if err != nil || purpose != policy.Purpose {
		return reject("the decision is for purpose %q, the policy requires %q", purpose, policy.Purpose)
	}
	if policy.Purpose == signer.PurposeProduction && signer.IsDemoIdentity(signedBy) {
		return reject("a demo signer cannot authorise a production release")
	}
	statement, vsa, err := evidence.ParseDecision(payload)
	if err != nil {
		return reject("the signed statement is not a release decision")
	}
	if statement.Subject[0].Digest["sha256"] != image.Digest {
		return reject("the decision is for another image")
	}
	if vsa.Verifier.ID != signedBy {
		return reject("the decision names verifier %q but was signed by %q", vsa.Verifier.ID, signedBy)
	}
	if vsa.ResourceURI != policy.ResourceURI() {
		return reject("the decision is for %q, this policy is for %q", vsa.ResourceURI, policy.ResourceURI())
	}
	if "sha256:"+vsa.Policy.Digest["sha256"] != policy.Digest() {
		return reject("the decision was made under another policy")
	}
	issued, err := time.Parse(time.RFC3339, vsa.TimeVerified)
	switch {
	case err != nil:
		return reject("the decision has no valid time")
	case issued.After(now.Add(time.Minute)):
		return reject("the decision is dated in the future")
	case now.Sub(issued) > time.Duration(policy.MaxDecisionAge):
		return reject("the decision is older than %s", time.Duration(policy.MaxDecisionAge))
	}
	if vsa.VerificationResult != "PASSED" {
		return reject("the controller refused the release")
	}
	if len(vsa.InputAttestations) != 1 || !strings.HasPrefix("sha256:"+vsa.InputAttestations[0].Digest["sha256"], "sha256:") || len(vsa.InputAttestations[0].Digest["sha256"]) != 64 {
		return reject("the decision does not name the evidence it rests on")
	}
	return nil
}
