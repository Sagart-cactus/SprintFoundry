# 0004: Two signed records and a verify policy

Status: proposed, 22 November 2026. Needs the owner's review before milestone 1 starts.

## Decision

SprintFoundry signs two different things. Both are in-toto v1 statements in DSSE envelopes.

### 1. Evidence: what was tested and what happened

Predicate type `https://in-toto.io/attestation/test-result/v0.1`. One statement per evaluation. It is kept in the store and has no authority on its own.

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{ "name": "registry.example/app", "digest": { "sha256": "<image manifest digest>" },
                "annotations": { "purpose": "demo", "digestKind": "manifest" } }],
  "predicateType": "https://in-toto.io/attestation/test-result/v0.1",
  "predicate": {
    "result": "PASSED",
    "configuration": [
      { "name": "criteria",      "digest": { "sha256": "..." } },
      { "name": "check-suite",   "digest": { "sha256": "..." } },
      { "name": "run-spec",      "digest": { "sha256": "..." } },
      { "name": "runner-image",  "digest": { "sha256": "..." } },
      { "name": "source-commit", "digest": { "gitCommit": "..." },
        "annotations": { "repository": "github.com/owner/repo" } },
      { "name": "source-tree",   "digest": { "gitTree": "..." } },
      { "name": "run", "uri": "sprintfoundry:run/<run id>",
        "annotations": { "outcome": "passed", "finishedAt": "<RFC 3339>" } }
    ],
    "url": "<link to the evidence report>",
    "passedTests": ["export-csv/3f9a1c0be771", "export-includes-archived/b20e44d19a05"],
    "warnedTests": [],
    "failedTests": []
  }
}
```

Rules that follow from the specifications:

- Every descriptor carries a `uri` or a `digest`, as a ResourceDescriptor must. The commit and the tree are two descriptors, because a digest set describes one object.
- `result` is `PASSED` only when every check passed. The test-result predicate defines a warned test as one that passed with warnings, so we never use `WARNED`. A failed or an inconclusive evaluation is `FAILED`, its checks are listed under `failedTests`, and `run.annotations.outcome` says which of the two it was.
- A test name is the check's criterion and a 12-character hash of the suite digest and the check ID. Check IDs, holdouts included, never appear in a signed statement.
- The purpose is a subject annotation. A signer reads it from the bytes it is about to sign and refuses a purpose it may not sign for, so a demo key cannot produce a statement that says `production`.

### 2. Decision: may this image be released now

Predicate type `https://slsa.dev/verification_summary/v1`. The controller issues it when `verify` asks. It is valid for minutes.

| Field | Value |
|---|---|
| `subject` | The image manifest digest |
| `verifier.id` | The controller's identity |
| `timeVerified` | Issue time. `verify` rejects a decision older than the policy's `max_decision_age` |
| `resourceUri` | The repository and environment the release targets |
| `policy.uri`, `policy.digest` | Where the verify policy below lives and its digest. The policy fixes the purpose |
| `inputAttestations` | Digest of the evidence statement |
| `verificationResult` | `PASSED` or `FAILED` |
| `verifiedLevels` | `["SPRINTFOUNDRY_CHECKS_PASSED"]` on a pass, empty otherwise. The field is required, and custom values are allowed when they do not start with `SLSA_` |

The controller issues `PASSED` only if the newest evidence for that image and criteria is `PASSED`, is younger than `max_evidence_age`, and has not been superseded by a newer run.

### Verify policy

A file kept with the deployment configuration, not in the application repository. The builder can change anything in the application repository, including its workflows, so nothing there may be a trusted signer.

```yaml
version: 1
purpose: production            # a signer marked "demo" never satisfies this
repository: github.com/owner/repo
environment: production
trusted_signers:          # the controller's own identity, defined outside the application repository
  - identity: https://github.com/owner/release-config/.github/workflows/sprintfoundry-controller.yml@refs/heads/main
    issuer: https://token.actions.githubusercontent.com
expect:
  criteria: sha256:...
  check_suite: sha256:...
  run_spec: sha256:...
max_evidence_age: 24h
max_decision_age: 15m
```

`sprintfoundry verify <image@digest> --policy <file>` passes only if a decision exists that is signed by a trusted signer, names this image, this policy digest and this repository and environment, says `PASSED`, and is younger than `max_decision_age`.

### Keys

| Mode | Signer | Purpose it can sign |
|---|---|---|
| Local demo | An Ed25519 key generated on first run, stored in the controller's data directory | `demo` only |
| Production | Sigstore keyless identity, or a KMS key | Any |

A signing key never enters a sandbox.

## Rejected

- **One long-lived signed pass.** A verifier that works offline cannot see a later failure, so a pass signed for 24 hours could be replayed for 24 hours.
- **The prototype's ssh-keygen envelope.** No existing verifier reads it.
- **A custom predicate type.** The two standard predicates carry everything we need, and standard tools can display them.

## Known weaker path

Policy engines such as Kyverno can check the evidence statement offline. That path has no revocation before `max_evidence_age` expires, and it means publishing the evidence beside the image. The evidence is written so that publishing it reveals criteria and opaque test names only. The docs will say that this path is weaker, and the online decision is the default.
