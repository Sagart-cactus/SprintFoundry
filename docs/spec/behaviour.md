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

## Durable controller

| Rule | Test |
|---|---|
| A job is created once per issue and criteria and is its own run | `TestAJobIsCreatedOnceAndIsItsOwnRun` |
| Only one controller holds a job; a lease can be renewed only by its holder | `TestOnlyOneControllerHoldsAJob` |
| An expired lease is taken over and the old holder can no longer write | `TestAnExpiredLeaseIsTakenOverAndTheOldHolderCannotWrite` |
| A round keeps the first change and the first result stored for it | `TestRoundsKeepTheFirstChangeAndResult` |
| Rounds draw on the evaluation allowance, and builder attempts on the request cap, across jobs | `TestRoundsDrawOnTheAllowanceAndTheRequestCapAcrossJobs` |
| Importing the same change with the same date gives the same commit | `TestImportWithAFixedDateGivesTheSameCommitAgain` |
| Killed at any of its steps with two jobs in flight, the controller resumes and every job ends once: one branch, one pull request, no evaluation taken twice | `TestRecoveryAfterAKillAtEveryStep` |
| A round whose builder attempts ran out goes to a person and reserves nothing more | `TestARoundOutOfBuilderAttemptsGoesToAPerson` |
| Two controllers holding one job each, one killed at a named step, still finish every job once | `TestTwoControllersAtOnce` |
| A lease lost between a lookup and the push, or the pull request, stops that call and is not counted as a failure | `TestALeaseLostJustBeforeARemoteCallStopsIt` |
| Approval to publish does not let a change to protected paths through | `TestApprovalDoesNotPublishAProtectedChange` |
| A build that fails once is tried again; one that never works goes to a person after three tries, in its first round | `TestABuildThatFailsIsTriedAgain` |
| Publishing is approved only from `awaiting_publish`, with a fresh claim budget | `TestPublishApprovalOnlyFromAwaitingPublishAndWithAFreshBudget` |
| `retry` works only for jobs that stopped because of errors; stored reasons are valid UTF-8 without NUL | `TestRequeueOnlyForJobsThatStoppedBecauseOfErrors` |
| CI configuration the run spec misses still makes a change sensitive | `TestSensitivePathsIncludeCIConfigTheRunSpecMisses` |
| A passing change waits for a person to approve publishing it; once approved it is pushed once without evaluating again | `TestAPassingChangeWaitsForAPersonToPublishIt` |
| A stored commit its stored change does not import to stops the job before anything is pushed | `TestAStoredCommitThatDoesNotMatchItsChangeStopsTheJob` |
| A builder or an evaluation that fails once because of the machine is tried again without spending the round | `TestAMachineHiccupIsTriedAgain` |
| CI configuration counts as a protected path whatever the run spec says | `TestCIConfigIsAlwaysProtected` |
| Fetches into one store take turns across processes | `TestStoreLockIsExclusiveAndGivesUpWithItsContext` |
| Text from issues, builders and job reasons is escaped before it reaches the terminal | `TestPrintableEscapesWhatATerminalWouldActOn`, `TestShellQuote` |
| A passing change to protected paths or CI configuration is never pushed; holdout, inconclusive, a builder that never hands over a change and the repair limit end with a person and post nothing | `TestJobOutcomesThatGoToAPerson` |
| A branch already at another commit is not moved and sends the job to a person at once | `TestABranchAlreadyThereStopsTheJob` |
| A job that keeps failing goes to a person after three tries without evaluating again, and `retry` queues it again; one the controller keeps dying on goes to a person after ten claims | `TestAJobThatKeepsFailingGoesToAPerson`, `TestAJobTheControllerKeepsDyingOnGoesToAPerson` |
| A controller that lost its lease stores nothing, even for a round the new holder stored | `TestALostLeaseStoresNothingEvenForAStoredRound` |
| Failures are counted, with a backoff, and permanent errors end the job at once | `TestFailuresSendAJobToAPersonAfterALimit` |
| Evidence and the round result are stored together, by the leaseholder only | `TestEvidenceAndRoundResultAreStoredTogether` |
| The push only creates the job's branch, never moves one | `TestPushBranchOnlyCreatesTheBranch` |
| `approve` refuses issue text a terminal would show differently; job IDs depend on the repository | `TestIssueCriteriaRefusesTextATerminalWouldHide`, `TestJobIDsDependOnTheRepository` |

## Linear issues and builder-written pull requests

| Rule | Test |
|---|---|
| A Linear job is created once per issue and criteria, also after the issue moves to another team; another issue with the same text is another job | `TestALinearJobIsCreatedOncePerIssueAndCriteria` |
| A job names its issue either by GitHub number or by Linear identifier and ID, never both | `TestAJobMustNameItsIssueOneWay` |
| A milestone 3 database is upgraded in place and keeps its jobs | `TestAnOlderJobTableIsUpgraded` |
| Linear is read with the key as given, never through a redirect; identifiers are checked before Linear is asked; only open states count as open, and archived or trashed issues do not; a moved issue is found with its new identifier; a missing or refused issue is an error that does not show the key | `TestGetIssue`, `TestGetIssueEdges`, `TestIdentifiersAreCheckedBeforeAsking`, `TestARedirectIsNotFollowedWithTheKey` |
| `serve` lists open Linear issues labelled `sprintfoundry` that have no job, knowing them by their Linear ID | `TestLabeledIssues`, `TestServeListsLinearIssuesWithoutAJob` |
| `approve` takes exactly one issue, GitHub or Linear; Linear job IDs carry the identifier | `TestApproveTakesExactlyOneIssue`, `TestLinearJobIDsNameTheIssue` |
| The builder describes its change outside the repository; the description is never in the patch, and a missing, linked, FIFO or oversized description keeps the change | `TestTheBuilderDescribesItsChangeOutsideThePatch`, `TestParseDescription` |
| Nothing GitHub or Linear acts on survives cleaning, whatever the Markdown, the encoding or where a cut falls: no mention, issue number, character reference, issue URL or keyword with references; in the title no other Linear identifier | `TestCleanDescriptionLeavesNothingLive`, `FuzzCleanDescription`, `TestCleanDescriptionRewrites`, `TestTheTitleNamesNoOtherLinearIssue`, `TestCleanDescriptionLimitsAndFallback` |
| Ordinary Markdown is kept as written; hidden characters and HTML comments are removed | `TestCleanDescriptionKeepsOrdinaryMarkdown`, `TestCleanDescriptionRemovesWhatAReaderCannotSee` |
| Whatever the body leaves open, the footer after it stands on its own (checked with goldmark, and with pandoc's GFM reader when installed) | `TestTheFooterCannotBeSwallowed`, `TestTheFooterRendersOnItsOwnWithPandoc` |
| The footer names the job's own issue and the builder; a round stored before descriptions keeps its title | `TestThePullRequestNamesItsOwnIssueInTheFooter` |
| After a kill at any step, each pull request has the cleaned builder title and body and the footer for its own issue, GitHub or Linear, and the commit subject is the title | `TestRecoveryAfterAKillAtEveryStep` |

## The whole slice

`TestDemoEndToEnd` runs the demo three times in a row on a real container runtime and then asks the gate from a separate command. It is the milestone 1 exit test. In CI it runs on Linux with Docker.

## Not carried over from the prototype

Ticket intake from one tracker, the local-model author and the task wrapper of one sandbox product are specific to the prototype's environment. They are not part of this spec.
