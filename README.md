# SprintFoundry v1

**Status: pre-alpha, under construction on the `v1` branch.** The released product is v0.7 on the [`main` branch](https://github.com/Sagart-cactus/SprintFoundry/tree/main). What works today: the demo below, and `sprintfoundry run`, which runs Codex CLI on your own repository in a sandbox that holds no key. Working against GitHub is not built yet.

SprintFoundry v1 answers one question before a change is released: *did an independent check pass on this exact image?*

1. A requester approves the acceptance criteria and a small check suite. Both are hashed and frozen before any code exists.
2. An existing coding agent (Codex CLI first) builds the change inside a sandbox that holds no credentials.
3. The controller builds the image from a run spec the builder cannot edit and records its digest.
4. A check runner with no model in it runs the frozen checks against that digest. Controller code grades the results.
5. The controller signs the evidence. At release, `sprintfoundry verify` asks for a short-lived decision bound to the image, the criteria and the purpose.

The builder never sees the checks and never grades its own work.

## Try the demo

You need Go 1.25 or newer, `make`, `git`, and Docker or Podman. Nothing else is installed and no API key is used.

```bash
make build
```

```bash
./sprintfoundry demo
```

The demo plays two recorded builders against one feature request:

1. The first implements the feature and also rewrites a test and the Dockerfile. Its checks pass, and it is still held for a person to review.
2. The second ships a defect. The check runner catches it on that exact image, the builder is told only which criterion failed and what a user would notice, and its repair passes.

It asks the release gate about all three images, writes an evidence report, and prints two `sprintfoundry verify` commands you can run yourself. A run takes under a minute once the Postgres and Python base images are pulled, and you can run it as often as you like.

```bash
./sprintfoundry down --purge
```

**What the demo does not prove.** The candidates run in ordinary containers. That keeps honest mistakes apart, and it is not a security boundary against a hostile agent. The demo's signing key is generated on your machine and can only sign for the `demo` purpose.

## Run Codex CLI on your own repository

`sprintfoundry run` takes three files you write and approve first, and a repository:

```bash
export OPENAI_API_KEY=...
```

```bash
./sprintfoundry run --repo path/to/app --criteria criteria.md --checks checks.yaml --runspec runspec.yaml
```

- **criteria.md** says what to build, in plain words. Codex CLI sees this, and nothing else.
- **checks.yaml** is the frozen check suite. Codex CLI never sees it. See `internal/demo/checks.yaml` and `docs/design/0003-check-suite.md`.
- **runspec.yaml** says how to build and preview the app, which base images are allowed and which paths need a person's review. See `internal/demo/runspec.yaml` and `docs/design/0001-run-spec.md`.

Codex CLI runs in a container whose only network peer is a proxy. The proxy holds the key and forwards only the model calls Codex needs. It refuses tools that would run on the provider's side, and any URL or stored file in a request that the provider would fetch. It allows only the `--model` you chose, caps each request at `--max-output-tokens` (default 32000), stops after `--max-requests` requests (default 60), and tells the provider not to store the conversation. Codex sees your repository's files at HEAD without its history. Your repository is copied, never changed. The first run builds an agent image with Node and Codex CLI, which needs network access.

`OPENAI_API_KEY` is read by `sprintfoundry`, written to a private file for a moment, and handed to the proxy container, whose settings hold it until the container is removed at the end of the run. `sprintfoundry down` removes a proxy left behind by an interrupted run.

The sandbox's isolation depends on internal container networks. Podman is fine. Docker Engine before 26.0 lets internal networks reach outside DNS servers, so `run` refuses it.

## Layout

| Path | What it holds |
|---|---|
| `cmd/sprintfoundry` | The single binary |
| `cmd/sprintfoundry-runner` | The check runner that goes into a container; it has no model |
| `cmd/sprintfoundry-proxy` | The sandbox's only way out: holds the model key and filters requests |
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
