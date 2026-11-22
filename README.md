# SprintFoundry v1

**Status: pre-alpha, under construction on the `v1` branch.** The released product is v0.7 on the [`main` branch](https://github.com/Sagart-cactus/SprintFoundry/tree/main). Nothing here is ready to use yet.

SprintFoundry v1 answers one question before a change is released: *did an independent check pass on this exact image?*

1. A requester approves the acceptance criteria and a small check suite. Both are hashed and frozen before any code exists.
2. An existing coding agent (Codex CLI first) builds the change inside a sandbox that holds no credentials.
3. The controller builds the image from a run spec the builder cannot edit and records its digest.
4. A check runner with no model in it runs the frozen checks against that digest. Controller code grades the results.
5. The controller signs the evidence. At release, `sprintfoundry verify` asks for a short-lived decision bound to the image, the criteria and the purpose.

The builder never sees the checks and never grades its own work.

## Layout

| Path | What it holds |
|---|---|
| `cmd/sprintfoundry` | The single binary |
| `internal/` | Controller, sandbox, agent, store and signer packages |
| `docs/design/` | Design decisions, each with the rejected option |
| `docs/spec/` | Behaviour spec that the tests implement |

## Build

```bash
go build ./cmd/sprintfoundry
```

```bash
go test ./...
```

## Licence

Apache-2.0. See [LICENSE](LICENSE).
