# SprintFoundry v1

**Status: pre-alpha, under construction on the `v1` branch.** The released product is v0.7 on the [`main` branch](https://github.com/Sagart-cactus/SprintFoundry/tree/main). What works today is the demo below. Running a real coding agent and working against GitHub are not built yet.

SprintFoundry v1 answers one question before a change is released: *did an independent check pass on this exact image?*

1. A requester approves the acceptance criteria and a small check suite. Both are hashed and frozen before any code exists.
2. An existing coding agent (Codex CLI first) builds the change inside a sandbox that holds no credentials.
3. The controller builds the image from a run spec the builder cannot edit and records its digest.
4. A check runner with no model in it runs the frozen checks against that digest. Controller code grades the results.
5. The controller signs the evidence. At release, `sprintfoundry verify` asks for a short-lived decision bound to the image, the criteria and the purpose.

The builder never sees the checks and never grades its own work.

## Try the demo

You need Go 1.25 or newer, `make`, and Docker or Podman. Nothing else is installed and no API key is used.

```bash
make build
```

```bash
./sprintfoundry demo
```

The demo plays two recorded builders against one feature request:

1. The first implements the feature and also rewrites a test and the Dockerfile. Its checks pass, and it is still held for a person to review.
2. The second ships a defect. The check runner catches it on that exact image, the builder is told only which criterion failed and what a user would notice, and its repair passes.

It then asks the release gate about all three images, writes an evidence report, and prints two `sprintfoundry verify` commands you can run yourself. The first run takes under a minute once the Postgres and Python base images are pulled.

```bash
./sprintfoundry down --purge
```

**What the demo does not prove.** The candidates run in ordinary containers. That keeps honest mistakes apart, and it is not a security boundary against a hostile agent. The demo's signing key is generated on your machine and can only sign for the `demo` purpose.

## Layout

| Path | What it holds |
|---|---|
| `cmd/sprintfoundry` | The single binary |
| `cmd/sprintfoundry-runner` | The check runner that goes into a container; it has no model |
| `internal/` | Controller, evaluation, release gate, store, signer and the demo |
| `docs/design/` | Design decisions, each with the rejected option |
| `docs/spec/` | Behaviour spec that the tests implement |

## Build

```bash
make build
```

```bash
make test
```

Tests that need Postgres read `SPRINTFOUNDRY_TEST_DATABASE_URL`. Tests that need containers use Docker or Podman if one is running.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
