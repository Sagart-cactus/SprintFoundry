# 0002: The gating verdict is on the digest that is released

Status: proposed, 22 November 2026. Needs the owner's review before milestone 1 starts.

## Problem

A verdict on the image built from a pull request does not cover what is released. A squash or merge commit has a new commit ID, and the user's CI normally builds a new image from it. Image builds are not reproducible by default, so the new image has a new digest even when the source is identical.

## Decision

Release is gated on a verdict for **the digest the CD promotes**. The check on a pull request is advisory: it tells the author and reviewer what the evaluator found, and it never authorises a release.

Two ways to get a gating verdict are supported.

1. **Build once, promote by digest.** The controller's candidate image is the one that is released. This is allowed only when the Git tree of the merged commit equals the Git tree that was evaluated. The evidence records the tree hash for this comparison. Commit IDs are not compared, because a squash merge changes them.
2. **Evaluate after merge.** If the trees differ, or the project's CI builds its own image, the controller evaluates the post-merge image and issues a new verdict for its digest.

`sprintfoundry verify` takes an image reference with a digest. It never accepts a tag alone.

## Rejected

- **A verdict on the pull request image gates release.** It would never match the released digest after a squash merge, so every release would be rejected, or users would learn to bypass the gate.
- **Rebuild and trust.** Rebuilding the same commit and assuming the same behaviour treats the build as reproducible when it is not.

## Consequences

- Evidence carries the source commit, the source tree hash and the image manifest digest.
- The milestone 2 exit test includes a squash-merged change that is released only after the promoted digest has its own verdict.
- The demo uses mode 1 with a local registry.
