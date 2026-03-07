---
title: "Implement `DockerExecutionBackend` — one container per run"
labels: [implementation, milestone-1]
milestone: "Milestone 1: Execution abstraction and identity"
depends-on: ["#001", "#002"]
---

## Summary

Create `src/service/execution/docker-backend.ts` implementing `ExecutionBackend` with Docker. The backend runs **one container for the full run** and dispatches each step via `docker exec` into the running container. This is the correct sandbox model and supersedes the deprecated per-step container mode (which will be cleaned up in issue #012).

## Background

The deprecated `container` runtime mode in `RuntimeFactory` spawned a new container per step, which lost all workspace state between steps. The correct model is one long-lived container per run, with steps dispatched via exec. This pattern also serves as the implementation template for `KubernetesPodExecutionBackend` (issue #006).

## Implementation

| Method | Docker operation |
|---|---|
| `prepareRunEnvironment` | `docker run -d` with workspace mounted, env vars injected, entrypoint overridden to `sleep infinity` |
| `executeStep` | `docker exec <container_id> /usr/local/bin/run-step.sh` |
| `pauseRun` | `docker pause <container_id>` |
| `resumeRun` | `docker unpause <container_id>` |
| `teardownRun` | `docker stop && docker rm` — always runs, even on failure |

### Security requirements

- API keys injected via environment variables, **never baked into the image**
- `teardownRun` wrapped in `try/finally` to always clean up
- Container workspace is a bind mount of the same directory used by the orchestration service

### `RunEnvironmentHandle` fields

- `sandbox_id` = the Docker container ID returned by `docker run`
- `execution_backend` = `"docker"`

## Files to create

- `src/service/execution/docker-backend.ts`

## Acceptance Criteria

- [ ] `DockerExecutionBackend` implements all 5 methods of `ExecutionBackend`
- [ ] Exactly one container is created per run (not per step)
- [ ] Steps dispatched via `docker exec`, not new `docker run` calls
- [ ] API keys are injected via environment variables — not in any image layer
- [ ] `teardownRun` always stops and removes the container (including on failure paths)
- [ ] `pauseRun` / `resumeRun` use `docker pause` / `docker unpause`
- [ ] `sandbox_id` is the container ID and appears in `sandbox.created` event payload
- [ ] Integration test can run a single-step task with Docker backend

## How to test

**Integration test** (skip in CI if Docker unavailable via `DOCKER_AVAILABLE=true` env guard):
1. Construct `AgentRunner` with `DockerExecutionBackend`
2. Run a trivial one-step plan (developer writes a file)
3. Assert output file exists in workspace
4. Assert container is removed after `teardownRun` (check `docker ps -a`)
5. Assert only one container was created during the run

**Unit test** (mock Docker CLI or `dockerode`):
- `prepareRunEnvironment` → calls `docker run -d` once
- `executeStep` → calls `docker exec` (not `docker run`)
- `teardownRun` → calls `docker stop` then `docker rm`

## Definition of Done

- `DockerExecutionBackend` compiles cleanly
- Integration test passes with Docker available locally
- No static secrets in backend code
- `sandbox_id` (container ID) appears in event JSONL
- Reviewed and merged
