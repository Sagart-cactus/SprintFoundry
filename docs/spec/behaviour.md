# Behaviour spec

This is what the tests implement. Each rule names the Go test that proves it. A rule without a passing test is not done, and its test is marked *planned* with the milestone that adds it.

In CI, a test that needs Postgres or a live hook control fails if it would otherwise be skipped, so a skip cannot pass for a proof.

## Run states

A run moves through these states. Any state can move to `stopped` (a cap was hit or the owner cancelled) or `needs_owner` (a decision is required).

```
requested -> criteria_frozen -> building -> candidate_built -> evaluating
evaluating -> passed | failed | inconclusive
failed -> building            (repair, at most two rounds per criteria digest)
passed -> evidence_signed -> released_decision_issued
```

| Rule | Test |
|---|---|
| A run cannot leave `requested` until the criteria, the check suite and the run spec each have a digest | `TestRunNeedsFrozenInputs` |
| A set of criteria gets one attempt and two repair rounds across all runs; after that no run for it builds or evaluates anything | `TestRepairCapIsPerCriteriaDigest`, `TestEvaluationAllowance` |
| A run ID can be used once | `TestRunIDIsSingleUse` |
| A Dockerfile that names an unlisted base image or reaches outside the build is refused before any build | `TestAnUnlistedBaseImageIsRefusedBeforeAnyBuild`, `TestCheckRefusesWhatReachesOutsideTheBuild` |
| An evaluation with a check that could not be completed is graded inconclusive, never passed | `TestInconclusiveNeverPasses`, `TestGradeNeedsRealFacts` |
| An inconclusive evaluation goes to a person and never starts a repair round | `TestInconclusiveEvaluationGoesToAPerson` |
| An inconclusive run is retried within a budget before it goes to a person | *planned, milestone 3* |

## Mechanism 1: a change is imported as data

The builder's change reaches the controller as a patch plus the tree hash the builder tested. The controller never runs git, hooks or builds inside a working tree the builder wrote.

| Rule | Test |
|---|---|
| The patch is applied to the parent commit in a bare repository with hooks disabled, without a working tree | `TestImportAppliesPatchWithoutWorktree` |
| The import fails unless the resulting tree hash equals the tree hash the builder reported | `TestImportRejectsTreeMismatch` |
| The import fails if the patch changes nothing | `TestImportRejectsEmptyChange` |
| A hook planted in the patch or the store never runs | `TestImportNeverRunsHooks` |
| A patch that writes outside the repository is rejected | `TestImportRejectsPathEscape` |
| Git variables in the controller's environment cannot redirect the import | `TestImportIgnoresTheCallersGitEnvironment` |
| A replace ref in the store cannot change what the parent commit means | `TestImportIgnoresReplaceRefs` |
| A patch that adds a symbolic link, a submodule or a `.gitmodules` file is rejected | `TestImportRefusesLinksAndSubmodules` |
| A patch larger than the limit is rejected | `TestImportRefusesAnOversizedPatch` |

## Mechanism 2: the thing tested is the thing served

| Rule | Test |
|---|---|
The controller reads the image identity from the container runtime. It never asks the application, which could answer anything.

| Rule | Test |
|---|---|
| Before evaluation starts, the runtime must report that the preview runs the candidate image | `TestEvaluationWaitsForCandidateDigest` |
| After evaluation ends, the runtime must still report the same image, or the result is discarded | `TestEvaluationDiscardedIfPreviewChanged` |

## Mechanism 3: intent before effect

Every action with an effect outside the controller (create a branch, open a pull request, comment, dispatch a release) follows the same four steps.

1. Write an intent record with a stable key derived from the run and the action.
2. Look for the effect at the remote by that key (branch name, marker in the pull request body).
3. Perform the effect only if it is not found.
4. Record the result.

These rules are one shared suite (`internal/effect/effecttest`). It runs against the in-memory journal as `TestMemoryJournal/...` and against real Postgres as `TestPostgresJournal/...`.

| Rule | Test |
|---|---|
| A crash after the effect and before step 4 does not repeat the effect on restart | `EffectNotRepeatedAfterCrash` |
| A crash after step 1 and before the effect performs it exactly once on restart | `EffectPerformedOnceAfterEarlyCrash` |
| Three controllers racing on the same key produce one effect | `EffectSingleUnderRace` |
| An effect without a remote lookup cannot be registered | `EffectRequiresReconciler` |
| A recorded result is never overwritten | `RecordedResultIsNeverOverwritten` |
| A hold is exclusive, and releasing it twice does not free the next holder's hold | `HoldIsExclusiveAndReleaseIsIdempotent` |
| A hold whose database session is killed is released, and the next controller gets it | `TestLockIsReleasedWhenTheHolderDies` |
| A controller that loses its session while performing an effect gets an error and cannot record a result | `TestHolderCannotRecordAfterLosingItsSession` |

One window stays open by design: if a hold is lost while the effect is being performed, another controller may act too. The remote call must therefore be safe to repeat for the same key.

## Trust rules with tests

| Rule | Test |
|---|---|
| A sandbox spec is refused if it mounts anything outside the run's workspace (also through a symbolic link), names an environment variable that is not on its role's list, or carries a credential raw, in base64 or URL-encoded | `TestSandboxRefusesSecrets` |
| A guard with an empty secret list is refused unless it states that there are no secrets | `TestGuardCannotBeLeftHalfConfigured` |
| A backend accepts only a spec that passed validation | enforced by the `sandbox.Validated` type |
| The check runner's output is raw results; the grade is computed by controller code | `TestGradeComputedFromRawResults` |
| A result that names a check not in the frozen suite is refused | `TestGradeRefusesUnknownCheck` |
| A header is compared exactly; only `content-type` ignores parameters | `TestHeadersAreComparedExactly` |
| A suite file with a second document, a target on another host or a non-scalar JSON value is refused | `TestParseRejectsWhatWouldBeDroppedOrLeaveThePreview` |
| JSON numbers are compared exactly | `TestJSONNumbersAreExact` |
| Feedback to the builder contains the criterion and a symptom, never the request or the expected value | `TestFeedbackHidesCheckDetails` |
| A holdout failure sends nothing to the builder | `TestHoldoutFailureIsSilentToBuilder` |
| A demo signer refuses any statement whose own purpose is not `demo`, whatever the caller says | `TestDemoSignerCannotSignProduction` |
| `verify` rejects a decision older than `max_decision_age`, for another image, another policy digest or another repository | `TestVerifyRejectsStaleOrForeignDecision` |
| Evidence superseded by a newer run cannot back a new decision | `TestSupersededEvidenceCannotRelease` |

## The release gate

| Rule | Test |
|---|---|
| What was tested and what happened is read from the signed evidence statement, and evidence the controller did not sign is refused. Which evidence is newest, whether it is superseded and whether a review was approved come from the controller's database | `TestControllerDoesNotTrustItsOwnStoreBlindly`, `TestControllerRefusesToAuthorise` |
| Evidence is superseded once a newer run exists for the same repository and criteria, also when the older run stores it late | `TestSupersessionIsWorkedOutWhenEvidenceIsRead` |
| The newest evidence for an image is the one written last | `TestLatestEvidenceIsTheLastOneWritten` |
| Demo evidence cannot back a production release, and a production release needs a registry manifest digest | `TestProductionRules` |
| A decision is refused if it names another verifier than its signer, sits in another envelope type, or names no evidence | `TestVerifierChecksWhoDecidedAndForWhat` |
| A change that touched a protected path cannot be released until a person approves the review | `TestProtectedPathsNeedAPersonEvenWhenChecksPass`, `TestReviewApprovalUnblocksAFlaggedChange` |
| A holdout failure goes to a person and never starts a repair round | `TestHoldoutFailureGoesToAPersonNotTheBuilder` |
| A signed statement never names a check, and its test names cannot be recomputed without the controller's key | `TestSignedStatementsNeverNameChecks` |
| A body sent with a content encoding, or a header sent twice, makes the check inconclusive | `TestEncodedBodiesAndRepeatedHeadersAreInconclusive` |
| Two evaluations never share a container or network name | `TestEvaluationsWithTheSameRunIDDoNotCollide` |
| Options that a container runtime would read as flags never reach it | `TestOptionsThatCouldBecomeFlagsAreRefused` |
| A production policy cannot trust a demo signer, and a decision may not live longer than an hour | `TestPolicyRules` |
| `verify` never accepts a tag | `TestParseImageNeverAcceptsATag` |

## Running a real agent

| Rule | Test |
|---|---|
| The proxy adds the key, drops whatever credential the client sent, and forwards only listed calls | `TestProxyAddsTheKeyAndDropsTheClientsCredentials`, `TestProxyRefusesEverythingOffItsList` |
| The proxy refuses unknown request fields and tools that run on the provider's side, also nested ones | `TestProxyRefusesEverythingOffItsList`, `TestAnthropicPreset` |
| The upstream sees only the body the proxy checked | `TestUpstreamSeesOnlyWhatWasChecked` |
| A URL, stored file or stored item anywhere in a request is refused; inline data is allowed | `TestProxyRefusesReferencesTheProviderWouldFollow` |
| Only the run's model is allowed, each request's output is capped, and the conversation is not stored at the provider | `TestProxyPinsTheModelAndCapsSpend` |
| The key never travels over plain http beyond this machine or its container network | `TestPlainHTTPOnlyNearby` |
| The proxy stops at the run's request budget, also under contention, and never follows a redirect | `TestProxyStopsAtTheRequestBudget`, `TestProxyPassesARedirectBackWithoutFollowingIt` |
| A sandbox reaches the model API only through the proxy, holds no key, cannot reach the internet or the upstream (by name or address), and has a read-only root; a request path cannot forge a proxy log line | `TestSandboxReachesOnlyTheProxyAndHoldsNoKey` |
| What a sandbox writes back is bounded, keeping the head or the tail | `TestOutputIsBounded` |
| The agent sees no history, its output cannot flood the controller, and control characters never reach the person's screen | `TestAgentSeesNoHistoryAndCannotFloodTheController` |
| The local backend never mounts host directories | `TestBackendRefusesHostMounts` |
| The builder is told the criteria and the feedback, never a check | `TestTaskTextCarriesCriteriaAndFeedbackOnly` |
| Each round starts from the previous round's change, and a symbolic link from the agent is refused on import | `TestAgentRoundsBuildOnEachOtherAndImportCleanly`, `TestASymlinkFromTheAgentIsRefusedOnImport` |
| `sprintfoundry run` takes a change from a sandboxed agent to a gate decision without touching the user's repository | `TestRunWithAStubAgent` |

## GitHub

| Rule | Test |
|---|---|
| A commit someone else wrote is built and checked against the registered inputs; a failure names criteria and symptoms only; protected paths need a person | `TestCheckOfAPullRequestHead` |
| Pull request checks draw on an allowance per repository and criteria, and a refused check records no run; release checks are not counted | `TestCheckAllowance` |
| A check whose app cannot be reached is inconclusive; a failing holdout tells the author nothing | `TestCheckOfAnAppThatCannotBeReachedOrFailsAHoldout` |
| Evidence says whether a builder run, a pull request check or a release check produced it | `TestEvidenceRecordsWhatKindOfCheckItWas` |
| A pull request check supersedes nothing and its evidence is never an image's evidence for a release | `TestPullRequestChecksNeitherSupersedeNorBackARelease` |
| The gate refuses pull request evidence from the signed statement alone | `TestControllerRefusesToAuthorise` |
| Only pull requests to the registered branch are checked, measured from where they left it; a release check is only for a merged commit on that branch, measured from its pull request's base | `TestResolveCheck` |
| A failed release check names nothing; an evaluation that could not run posts `error` | `TestCheckStatus` |
| A repository's registered inputs can be replaced only by registering again, and only with stored inputs | `TestRegistration` |
| The GitHub adapter validates every reference and cuts status descriptions to GitHub's limit | `TestPullRequestAndStatus`, `TestReferencesAreValidated` |
| On a real repository: advisory statuses on pull requests, after a squash merge only the release check's image is accepted, and a later pull request check changes neither | `TestGitHubExit` (runs when `SPRINTFOUNDRY_GITHUB_TESTBED` is set) |

## The whole slice

`TestDemoEndToEnd` runs the demo three times in a row on a real container runtime and then asks the gate from a separate command. It is the milestone 1 exit test. In CI it runs on Linux with Docker.

## Not carried over from the prototype

Ticket intake from one tracker, the local-model author and the task wrapper of one sandbox product are specific to the prototype's environment. They are not part of this spec.
