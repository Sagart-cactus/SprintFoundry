package evidence

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/checks"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
)

func h(c string) string { return strings.Repeat(c, 64) }

func report(outcomes ...checks.Outcome) checks.Report {
	r := checks.Report{Result: checks.Passed}
	for i, o := range outcomes {
		r.Checks = append(r.Checks, checks.CheckGrade{ID: "check-" + string(rune('a'+i)), Criterion: "c", Outcome: o})
	}
	return r
}

func evaluation(outcomes ...checks.Outcome) Evaluation {
	return Evaluation{
		ImageName: "local/invoices", ImageDigest: h("1"), DigestKind: ImageConfig,
		CriteriaDigest: "sha256:" + h("2"), SuiteDigest: "sha256:" + h("3"), RunSpecDigest: "sha256:" + h("4"),
		RunnerImage: h("5"), Repository: "local/invoices",
		Commit: strings.Repeat("a", 40), Tree: strings.Repeat("b", 40),
		RunID: "run-1", Purpose: signer.PurposeDemo,
		FinishedAt: time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC),
		Report:     report(outcomes...),
	}
}

func TestEvidenceResultFollowsTheChecks(t *testing.T) {
	tests := []struct {
		name     string
		outcomes []checks.Outcome
		want     string
	}{
		{"all passed", []checks.Outcome{checks.Passed, checks.Passed}, "PASSED"},
		{"one failed", []checks.Outcome{checks.Passed, checks.Failed}, "FAILED"},
		{"one inconclusive", []checks.Outcome{checks.Passed, checks.Inconclusive}, "WARNED"},
		{"failed outranks inconclusive", []checks.Outcome{checks.Inconclusive, checks.Failed}, "FAILED"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := evaluation(tt.outcomes...)
			// A report whose headline disagrees with its checks must not
			// produce a pass: the statement is derived from the checks.
			e.Report.Result = checks.Passed
			st, err := NewEvidence(e)
			if err != nil {
				t.Fatal(err)
			}
			payload, _ := st.Marshal()
			_, pred, err := ParseTestResult(payload)
			if err != nil {
				t.Fatal(err)
			}
			if pred.Result != tt.want {
				t.Errorf("result = %s, want %s", pred.Result, tt.want)
			}
			if got := len(pred.PassedTests) + len(pred.WarnedTests) + len(pred.FailedTests); got != len(tt.outcomes) {
				t.Errorf("%d checks listed, want %d", got, len(tt.outcomes))
			}
		})
	}
}

func TestEvidenceCarriesEveryBinding(t *testing.T) {
	e := evaluation(checks.Passed)
	e.ReviewRequired = []string{"change touches test_app.py", "change touches Dockerfile"}
	st, err := NewEvidence(e)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := st.Marshal()
	parsed, pred, err := ParseTestResult(payload)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Subject[0].Digest["sha256"] != h("1") || parsed.Subject[0].Annotations["digestKind"] != "image-config" {
		t.Errorf("subject = %+v", parsed.Subject[0])
	}
	want := map[string]string{"criteria": h("2"), "check-suite": h("3"), "run-spec": h("4"), "runner-image": h("5")}
	for name, digest := range want {
		d, ok := pred.Config(name)
		if !ok || d.Digest["sha256"] != digest {
			t.Errorf("%s = %+v, want digest %s", name, d, digest)
		}
	}
	src, _ := pred.Config("source")
	if src.Digest["gitCommit"] != e.Commit || src.Digest["gitTree"] != e.Tree || src.Annotations["repository"] != "local/invoices" {
		t.Errorf("source = %+v", src)
	}
	run, _ := pred.Config("run")
	if run.Annotations["purpose"] != "demo" || run.Annotations["id"] != "run-1" || run.Annotations["finishedAt"] != "2026-11-22T10:00:00Z" {
		t.Errorf("run = %+v", run)
	}
	if run.Annotations["reviewRequired"] != "change touches Dockerfile; change touches test_app.py" {
		t.Errorf("reviewRequired = %q", run.Annotations["reviewRequired"])
	}

	// The same evaluation always gives the same bytes, so its digest is stable.
	again, _ := NewEvidence(e)
	againPayload, _ := again.Marshal()
	if Digest(payload) != Digest(againPayload) {
		t.Error("the same evaluation produced two different statements")
	}
}

func TestEvidenceRefusesIncompleteInput(t *testing.T) {
	breakers := map[string]func(*Evaluation){
		"tag instead of digest":    func(e *Evaluation) { e.ImageDigest = "latest" },
		"unknown digest kind":      func(e *Evaluation) { e.DigestKind = "tag" },
		"missing suite digest":     func(e *Evaluation) { e.SuiteDigest = "" },
		"short criteria digest":    func(e *Evaluation) { e.CriteriaDigest = "sha256:abc" },
		"missing run spec digest":  func(e *Evaluation) { e.RunSpecDigest = "" },
		"runner image by name":     func(e *Evaluation) { e.RunnerImage = "runner:latest" },
		"abbreviated commit":       func(e *Evaluation) { e.Commit = "abc1234" },
		"missing tree":             func(e *Evaluation) { e.Tree = "" },
		"missing run ID":           func(e *Evaluation) { e.RunID = "" },
		"unknown purpose":          func(e *Evaluation) { e.Purpose = "staging" },
		"missing finish time":      func(e *Evaluation) { e.FinishedAt = time.Time{} },
		"report without any check": func(e *Evaluation) { e.Report = checks.Report{Result: checks.Passed} },
	}
	for name, breakIt := range breakers {
		t.Run(name, func(t *testing.T) {
			e := evaluation(checks.Passed)
			breakIt(&e)
			if _, err := NewEvidence(e); err == nil {
				t.Fatal("incomplete evaluation was accepted")
			}
		})
	}
}

func decision(passed bool) Decision {
	return Decision{
		ImageName: "local/invoices", ImageDigest: h("1"), DigestKind: ImageConfig,
		VerifierID: "demo:ed25519:" + h("9"), ResourceURI: "local/invoices#demo",
		PolicyURI: "file:verify-policy.yaml", PolicyDigest: "sha256:" + h("6"),
		EvidenceDigest: "sha256:" + h("7"), Passed: passed,
		At: time.Date(2026, 11, 22, 10, 5, 0, 0, time.UTC),
	}
}

func TestDecisionIsAVerificationSummary(t *testing.T) {
	st, err := NewDecision(decision(true))
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := st.Marshal()

	// Field names are those of the SLSA verification summary v1 predicate.
	var raw map[string]any
	_ = json.Unmarshal(payload, &raw)
	pred := raw["predicate"].(map[string]any)
	for _, field := range []string{"verifier", "timeVerified", "resourceUri", "policy", "inputAttestations", "verificationResult", "verifiedLevels", "slsaVersion"} {
		if _, ok := pred[field]; !ok {
			t.Errorf("predicate is missing %q", field)
		}
	}
	if raw["predicateType"] != VerificationType {
		t.Errorf("predicateType = %v", raw["predicateType"])
	}

	_, vsa, err := ParseDecision(payload)
	if err != nil {
		t.Fatal(err)
	}
	if vsa.VerificationResult != "PASSED" || len(vsa.VerifiedLevels) != 1 || strings.HasPrefix(vsa.VerifiedLevels[0], "SLSA_") {
		t.Errorf("passed decision = %+v", vsa)
	}
	if vsa.Policy.Digest["sha256"] != h("6") || vsa.InputAttestations[0].Digest["sha256"] != h("7") {
		t.Errorf("bindings = %+v %+v", vsa.Policy, vsa.InputAttestations)
	}

	failed, _ := NewDecision(decision(false))
	failedPayload, _ := failed.Marshal()
	_, vsa, _ = ParseDecision(failedPayload)
	if vsa.VerificationResult != "FAILED" || len(vsa.VerifiedLevels) != 0 {
		t.Errorf("failed decision = %+v", vsa)
	}
}

func TestStatementsAreNotInterchangeable(t *testing.T) {
	ev, _ := NewEvidence(evaluation(checks.Passed))
	evPayload, _ := ev.Marshal()
	dec, _ := NewDecision(decision(true))
	decPayload, _ := dec.Marshal()

	if _, _, err := ParseDecision(evPayload); err == nil {
		t.Error("an evidence statement was read as a decision")
	}
	if _, _, err := ParseTestResult(decPayload); err == nil {
		t.Error("a decision was read as evidence")
	}
	for name, breakIt := range map[string]func(*Decision){
		"no policy digest":   func(d *Decision) { d.PolicyDigest = "" },
		"no evidence digest": func(d *Decision) { d.EvidenceDigest = "" },
		"no time":            func(d *Decision) { d.At = time.Time{} },
		"no resource":        func(d *Decision) { d.ResourceURI = "" },
		"tag as digest":      func(d *Decision) { d.ImageDigest = "v1.2.3" },
	} {
		d := decision(true)
		breakIt(&d)
		if _, err := NewDecision(d); err == nil {
			t.Errorf("%s: incomplete decision was accepted", name)
		}
	}
}
