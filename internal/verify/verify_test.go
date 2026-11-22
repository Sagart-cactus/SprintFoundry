package verify

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/checks"
	"github.com/sagart-cactus/sprintfoundry/internal/evidence"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

func h(c string) string { return strings.Repeat(c, 64) }

var now = time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)

// memoryStore holds evidence rows the way the Postgres store returns them.
type memoryStore struct {
	rows      map[string]postgres.Evidence // by image digest
	decisions int
}

func (m *memoryStore) LatestEvidence(_ context.Context, repository, image string) (postgres.Evidence, error) {
	row, ok := m.rows[image]
	if !ok || row.Repository != repository {
		return postgres.Evidence{}, postgres.ErrNotFound
	}
	return row, nil
}

func (m *memoryStore) PutDecision(context.Context, string, string, []byte) error {
	m.decisions++
	return nil
}

type fixture struct {
	t      *testing.T
	sgn    *signer.Demo
	store  *memoryStore
	policy Policy
	image  Image
}

func policyYAML(sgn *signer.Demo, edits ...func(string) string) []byte {
	src := fmt.Sprintf(`version: 1
purpose: demo
repository: local/invoices
environment: demo
trusted_signers:
  - identity: %s
    public_key: %s
expect:
  criteria: sha256:%s
  check_suite: sha256:%s
  run_spec: sha256:%s
max_evidence_age: 24h
max_decision_age: 15m
`, sgn.Identity(), base64.StdEncoding.EncodeToString(sgn.PublicKey()), h("2"), h("3"), h("4"))
	for _, edit := range edits {
		src = edit(src)
	}
	return []byte(src)
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	sgn, err := signer.NewDemo()
	if err != nil {
		t.Fatal(err)
	}
	policy, err := ParsePolicy(policyYAML(sgn))
	if err != nil {
		t.Fatalf("ParsePolicy: %v", err)
	}
	return &fixture{t: t, sgn: sgn, store: &memoryStore{rows: map[string]postgres.Evidence{}},
		policy: policy, image: Image{Digest: h("1")}}
}

// evaluation returns a passing evaluation of the fixture's image that
// finished an hour ago.
func (f *fixture) evaluation() evidence.Evaluation {
	return evidence.Evaluation{
		ImageName: "local/invoices", ImageDigest: f.image.Digest, DigestKind: evidence.ImageConfig,
		CriteriaDigest: "sha256:" + h("2"), SuiteDigest: "sha256:" + h("3"), RunSpecDigest: "sha256:" + h("4"),
		RunnerImage: h("5"), Repository: "local/invoices",
		Commit: strings.Repeat("a", 40), Tree: strings.Repeat("b", 40),
		RunID: "run-1", Purpose: signer.PurposeDemo, FinishedAt: now.Add(-time.Hour),
		Report: checks.Report{Result: checks.Passed, Checks: []checks.CheckGrade{
			{ID: "export-owner", Criterion: "export-csv", Outcome: checks.Passed},
			{ID: "export-denied", Criterion: "export-owner-only", Outcome: checks.Passed},
		}},
	}
}

// put signs an evaluation with sgn and stores it as the image's evidence.
func (f *fixture) put(e evidence.Evaluation, sgn *signer.Demo, edit func(*postgres.Evidence)) {
	f.t.Helper()
	st, err := evidence.NewEvidence(e)
	if err != nil {
		f.t.Fatal(err)
	}
	payload, _ := st.Marshal()
	env, err := sgn.Sign(context.Background(), payload)
	if err != nil {
		f.t.Fatal(err)
	}
	raw, _ := json.Marshal(env)
	row := postgres.Evidence{Digest: evidence.Digest(payload), RunID: e.RunID, Repository: e.Repository,
		ImageDigest: e.ImageDigest, Outcome: "passed", Envelope: raw, CreatedAt: e.FinishedAt}
	if edit != nil {
		edit(&row)
	}
	f.store.rows[e.ImageDigest] = row
}

func (f *fixture) decide() (signer.Envelope, []string, error) {
	return Decide(context.Background(), f.store, f.sgn, f.policy, "file:verify-policy.yaml", f.image, now)
}

func TestVerifyAcceptsAFreshPassingDecision(t *testing.T) {
	f := newFixture(t)
	f.put(f.evaluation(), f.sgn, nil)

	env, reasons, err := f.decide()
	if err != nil || len(reasons) != 0 {
		t.Fatalf("Decide: %v, reasons %v", err, reasons)
	}
	if err := Check(env, f.policy, f.image, now.Add(time.Minute)); err != nil {
		t.Fatalf("Check: %v", err)
	}
	if f.store.decisions != 1 {
		t.Errorf("decisions stored = %d, want 1", f.store.decisions)
	}
}

func TestControllerRefusesToAuthorise(t *testing.T) {
	failed := func(e *evidence.Evaluation) { e.Report.Checks[1].Outcome = checks.Failed }
	tests := []struct {
		name string
		eval func(*evidence.Evaluation)
		row  func(*postgres.Evidence)
		want string
	}{
		{"a failed evaluation", failed, nil, "did not pass (outcome: failed)"},
		{"an inconclusive evaluation", func(e *evidence.Evaluation) { e.Report.Checks[0].Outcome = checks.Inconclusive }, nil, "outcome: inconclusive"},
		{"a failed evaluation whose database row says passed", failed, func(r *postgres.Evidence) { r.Outcome = "passed" }, "did not pass"},
		{"evidence for other criteria", func(e *evidence.Evaluation) { e.CriteriaDigest = "sha256:" + h("9") }, nil, "criteria digest differs"},
		{"evidence from another check suite", func(e *evidence.Evaluation) { e.SuiteDigest = "sha256:" + h("9") }, nil, "check-suite digest differs"},
		{"evidence from another run spec", func(e *evidence.Evaluation) { e.RunSpecDigest = "sha256:" + h("9") }, nil, "run-spec digest differs"},
		{"evidence older than the policy allows", func(e *evidence.Evaluation) { e.FinishedAt = now.Add(-25 * time.Hour) }, nil, "older than 24h"},
		{"evidence dated in the future", func(e *evidence.Evaluation) { e.FinishedAt = now.Add(2 * time.Hour) }, nil, "dated in the future"},
		{"a change that needs a person's review", func(e *evidence.Evaluation) { e.ReviewRequired = []string{"change touches Dockerfile"} }, nil, "a person must review"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			e := f.evaluation()
			if tt.eval != nil {
				tt.eval(&e)
			}
			f.put(e, f.sgn, tt.row)

			env, reasons, err := f.decide()
			if err != nil {
				t.Fatalf("Decide: %v", err)
			}
			if !strings.Contains(strings.Join(reasons, " | "), tt.want) {
				t.Fatalf("reasons = %v, want one mentioning %q", reasons, tt.want)
			}
			// The refusal is itself a signed decision, and it does not verify.
			if err := Check(env, f.policy, f.image, now); !errors.Is(err, ErrRejected) {
				t.Errorf("Check on a refusal: err = %v, want ErrRejected", err)
			}
		})
	}
}

func TestReviewApprovalUnblocksAFlaggedChange(t *testing.T) {
	f := newFixture(t)
	e := f.evaluation()
	e.ReviewRequired = []string{"change touches test_app.py"}
	f.put(e, f.sgn, func(r *postgres.Evidence) { r.ReviewApprovedBy = "olivia" })

	env, reasons, err := f.decide()
	if err != nil || len(reasons) != 0 {
		t.Fatalf("Decide after approval: %v, reasons %v", err, reasons)
	}
	if err := Check(env, f.policy, f.image, now); err != nil {
		t.Fatalf("Check: %v", err)
	}
}

func TestSupersededEvidenceCannotRelease(t *testing.T) {
	f := newFixture(t)
	f.put(f.evaluation(), f.sgn, func(r *postgres.Evidence) { r.Superseded = true })

	env, reasons, err := f.decide()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(reasons, " "), "superseded") {
		t.Fatalf("reasons = %v, want superseded", reasons)
	}
	if err := Check(env, f.policy, f.image, now); !errors.Is(err, ErrRejected) {
		t.Errorf("Check: err = %v, want ErrRejected", err)
	}
}

func TestControllerDoesNotTrustItsOwnStoreBlindly(t *testing.T) {
	f := newFixture(t)

	if _, _, err := f.decide(); !errors.Is(err, ErrNoEvidence) {
		t.Fatalf("no evidence: err = %v, want ErrNoEvidence", err)
	}

	// Evidence in the store that this controller did not sign.
	stranger, _ := signer.NewDemo()
	f.put(f.evaluation(), stranger, nil)
	if _, _, err := f.decide(); err == nil || !strings.Contains(err.Error(), "not signed by this controller") {
		t.Fatalf("foreign evidence: err = %v", err)
	}

	// Evidence for another image filed under this image's digest.
	other := f.evaluation()
	other.ImageDigest = h("8")
	f.put(other, f.sgn, func(r *postgres.Evidence) { r.ImageDigest = f.image.Digest })
	f.store.rows[f.image.Digest] = f.store.rows[h("8")]
	_, reasons, err := f.decide()
	if err != nil || !strings.Contains(strings.Join(reasons, " "), "another image") {
		t.Fatalf("misfiled evidence: %v, reasons %v", err, reasons)
	}
}

func TestVerifyRejectsStaleOrForeignDecision(t *testing.T) {
	f := newFixture(t)
	f.put(f.evaluation(), f.sgn, nil)
	good, _, err := f.decide()
	if err != nil {
		t.Fatal(err)
	}
	if err := Check(good, f.policy, f.image, now); err != nil {
		t.Fatalf("the unmodified decision was rejected: %v", err)
	}

	reparse := func(edit func(string) string) Policy {
		p, err := ParsePolicy(policyYAML(f.sgn, edit))
		if err != nil {
			t.Fatalf("ParsePolicy: %v", err)
		}
		return p
	}
	stranger, _ := signer.NewDemo()

	tests := []struct {
		name   string
		env    signer.Envelope
		policy Policy
		image  Image
		at     time.Time
		want   string
	}{
		{"older than max_decision_age", good, f.policy, f.image, now.Add(16 * time.Minute), "older than 15m"},
		{"dated in the future", good, f.policy, f.image, now.Add(-10 * time.Minute), "dated in the future"},
		{"for another image", good, f.policy, Image{Digest: h("7")}, now, "another image"},
		{"made under another policy", good, reparse(func(s string) string { return s + "# reviewed\n" }), f.image, now, "another policy"},
		{"for another environment", good, reparse(func(s string) string { return strings.Replace(s, "environment: demo", "environment: staging", 1) }), f.image, now, "this policy is for"},
		{"for another repository", good, reparse(func(s string) string {
			return strings.Replace(s, "repository: local/invoices", "repository: local/other", 1)
		}), f.image, now, "this policy is for"},
		{"signed by a key the policy does not trust", good, func() Policy {
			p, _ := ParsePolicy(policyYAML(stranger))
			return p
		}(), f.image, now, "not signed by a signer this policy trusts"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := Check(tt.env, tt.policy, tt.image, tt.at)
			if !errors.Is(err, ErrRejected) {
				t.Fatalf("err = %v, want ErrRejected", err)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("err = %q, want it to mention %q", err, tt.want)
			}
		})
	}

	t.Run("a changed payload", func(t *testing.T) {
		tampered := good
		payload, _ := base64.StdEncoding.DecodeString(good.Payload)
		tampered.Payload = base64.StdEncoding.EncodeToString([]byte(strings.Replace(string(payload), h("1"), h("7"), 1)))
		if err := Check(tampered, f.policy, Image{Digest: h("7")}, now); !errors.Is(err, ErrRejected) {
			t.Fatalf("err = %v, want ErrRejected", err)
		}
	})
	t.Run("an evidence statement offered as a decision", func(t *testing.T) {
		var evidenceEnvelope signer.Envelope
		_ = json.Unmarshal(f.store.rows[f.image.Digest].Envelope, &evidenceEnvelope)
		if err := Check(evidenceEnvelope, f.policy, f.image, now); !errors.Is(err, ErrRejected) {
			t.Fatalf("err = %v, want ErrRejected", err)
		}
	})
}

func TestPolicyRules(t *testing.T) {
	sgn, _ := signer.NewDemo()
	if _, err := ParsePolicy(policyYAML(sgn)); err != nil {
		t.Fatalf("a valid policy was refused: %v", err)
	}
	bad := map[string]func(string) string{
		"a production policy that trusts a demo signer": func(s string) string { return strings.Replace(s, "purpose: demo", "purpose: production", 1) },
		"an unknown purpose":                            func(s string) string { return strings.Replace(s, "purpose: demo", "purpose: staging", 1) },
		"no trusted signer": func(s string) string {
			return s[:strings.Index(s, "trusted_signers:")] + "trusted_signers: []\n" + s[strings.Index(s, "expect:"):]
		},
		"a criteria digest that is not a digest": func(s string) string { return strings.Replace(s, "criteria: sha256:"+h("2"), "criteria: latest", 1) },
		"a decision allowed to live for a day":   func(s string) string { return strings.Replace(s, "max_decision_age: 15m", "max_decision_age: 24h", 1) },
		"a duration that is not one": func(s string) string {
			return strings.Replace(s, "max_evidence_age: 24h", "max_evidence_age: forever", 1)
		},
		"an unknown field":               func(s string) string { return s + "allow_unsigned: true\n" },
		"a second document":              func(s string) string { return s + "---\npurpose: production\n" },
		"a public key that is not a key": func(s string) string { return strings.Replace(s, "public_key: ", "public_key: AAAA", 1) },
	}
	for name, edit := range bad {
		if _, err := ParsePolicy(policyYAML(sgn, edit)); !errors.Is(err, ErrInvalidPolicy) {
			t.Errorf("%s: err = %v, want ErrInvalidPolicy", name, err)
		}
	}
}

func TestParseImageNeverAcceptsATag(t *testing.T) {
	for _, ref := range []string{h("1"), "sha256:" + h("1"), "ghcr.io/owner/app@sha256:" + h("1")} {
		img, err := ParseImage(ref)
		if err != nil || img.Digest != h("1") {
			t.Errorf("ParseImage(%q) = %+v, %v", ref, img, err)
		}
	}
	for _, ref := range []string{"ghcr.io/owner/app:latest", "app", "ghcr.io/owner/app:v1@sha256:short", "sha256:abc", ""} {
		if _, err := ParseImage(ref); err == nil {
			t.Errorf("ParseImage(%q) was accepted", ref)
		}
	}
}
