# 0001: The controller owns the run spec

Status: proposed, 22 November 2026. Needs the owner's review before milestone 1 starts.

## Decision

A **run spec** says how a candidate is built and how its preview is started. It lives in the criteria store on the controller side. The builder cannot read or write it.

The run spec holds:

| Field | Meaning |
|---|---|
| `build.context`, `build.dockerfile` | Paths inside the repository. The files are builder-editable; the choice of paths is not. |
| `build.args`, `build.platforms` | Fixed build arguments and target platforms. |
| `build.network` | `none`, or `registries` with an explicit list of package registries reached through the proxy. |
| `preview.command`, `preview.port`, `preview.env` | How the preview starts. No value comes from the repository. |
| `preview.health` | Path and expected status that mean "ready". |
| `preview.network` | Always an internal network shared only with the check runner. |
| `runner.image` | Check runner image, pinned by digest. |
| `sensitive_paths` | Globs whose change is flagged for human review. Default: Dockerfiles, dependency manifests and lockfiles, tests, CI configuration. |

The controller hashes the run spec (`run_spec_digest`) and puts the digest in the evidence. A change to the run spec is a new digest and needs the same approval as a change to the criteria.

The controller, not the builder, starts the build and the preview. Neither runs inside the builder's sandbox, and neither can reach the controller, the store or the internet beyond what `build.network` lists.

## Rejected

- **Run spec in the repository.** The builder could then change how its own work is built and served.
- **Build inside the builder sandbox.** The builder would produce the image, so the digest would prove nothing about what was tested.

## What this does not solve

The builder still writes the code and the Dockerfile. An image could behave well only when it detects a test. Two things reduce that risk and neither removes it:

1. A change to a sensitive path is flagged, and the verdict is not usable for release until a person reviews it.
2. A person approves release by default.

The preview can tell it is under evaluation: its network has no route out and its only client is the runner. We do not claim otherwise.

We state this as remaining risk in the docs and in the evidence report.

## Consequences

- The demo app builds with `build.network: none`, so the first run needs no registry access.
- Project onboarding means writing a run spec. Milestone 2 only supports repositories that have one.
