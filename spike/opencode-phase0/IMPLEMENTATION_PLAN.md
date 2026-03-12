# OpenCode Integration Plan

## Decision

Integrate OpenCode as a SprintFoundry step-execution runtime using the CLI only.

- Supported path: `local_process`
- Explicitly out of scope: OpenCode SDK integration

## Why

Phase 0 showed that the CLI already provides the runtime signals SprintFoundry needs:

- stable `sessionID`
- parseable streamed JSON events
- usable tool activity
- usage data
- workable resume and fork behavior
- clean run-scoped isolation with XDG directories

The main weak area is billing fidelity, not process control. SDK work would add scope without solving the real risk.

## Required For V1

### 1. Add OpenCode as a runtime provider

Files:

- `src/shared/types.ts`
- `src/service/runtime/runtime-factory.ts`

Changes:

- add `"opencode"` to `RuntimeProvider`
- wire `RuntimeFactory` to construct `OpenCodeRuntime`

### 2. Implement `OpenCodeRuntime` for CLI execution

File:

- `src/service/runtime/opencode-runtime.ts`

Scope:

- support `local_process` only
- spawn `opencode run --format json`
- enforce timeout handling
- capture stdout/stderr logs
- extract `sessionID` as the runtime session identifier

### 3. Parse OpenCode JSON stream into SprintFoundry runtime events

Required live event handling:

- `tool_use` -> `agent_tool_call`
- file-mutating tool calls such as `apply_patch` -> `agent_file_edit`
- command tool calls if present -> `agent_command_run`
- `reasoning` -> `agent_thinking`
- final `step_finish` with `reason == "stop"` -> run completion

Parser requirements:

- accumulate usage from all `step_finish` events
- accumulate cost from all `step_finish` events
- preserve raw provider payloads in `runtime_metadata.provider_metadata`

### 4. Add run-scoped environment isolation

Likely file:

- `src/service/agent-runner.ts`

Required behavior:

- create run-scoped XDG directories in the workspace or run-owned subdirectory
- pass `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` to the child process
- control the child environment explicitly so provider auth is run-scoped rather than inherited accidentally

This is required, not optional.

### 5. Keep SprintFoundry result contract unchanged

SprintFoundry should continue to require:

- `.agent-task.md`
- provider instruction file(s)
- `.agent-result.json`

OpenCode should adapt to SprintFoundry’s step contract rather than replacing it.

### 6. Persist runtime metadata cleanly

Required metadata:

- provider: `opencode`
- mode: `local_process`
- runtime/session id
- usage fields
- billing fields
- resume metadata when used later
- provider metadata with raw OpenCode-specific details

Billing rule:

- use `runtime_reported` only when OpenCode emits trustworthy non-zero cost values
- otherwise estimate and mark as `estimated`

### 7. Add config examples

Files:

- `config/platform.yaml`
- `config/project.example.yaml`

Add:

- commented OpenCode runtime examples
- note that OpenCode support is CLI-based only

### 8. Add tests

Required tests:

- fixture-driven parser tests using real OpenCode JSONL transcripts
- session ID extraction tests
- usage and cost aggregation tests
- invalid resume handling test
- one smoke test for an OpenCode step runtime

## Required Soon After V1

### Phase 2: OpenCode-native instruction staging

Goal:

- stop treating OpenCode as Claude/Codex with different flags

Needed work:

- generate a per-run OpenCode config area
- generate OpenCode-friendly instruction bundles
- start with one shared execution agent plus role overlays

### Phase 3: Provider-neutral skills

Goal:

- refactor current Codex-shaped skill staging into a provider-neutral layer

Needed work:

- keep one canonical SprintFoundry skill catalog
- add provider-specific staging for Codex, Claude, and OpenCode

### Phase 4: Run-scoped MCP support

Goal:

- attach only the MCP servers allowed for the run

Needed work:

- generate run-scoped config for MCP attachment
- keep MCP state isolated per run
- record attached MCPs in runtime metadata

### Phase 5: Runtime-aware resume/fork

Goal:

- persist OpenCode session IDs and use them intentionally

Needed work:

- continue same session when requested
- fork when safer
- fall back to fresh run on attach failure
- surface real resume state in runtime metadata

## Not Required For V1

- OpenCode SDK integration
- `local_sdk` support for OpenCode
- planner integration
- `serve` mode
- broad refactor of planner abstractions
- full provider-neutral skill refactor before runtime parity exists
- MCP policy engine
- post-run export enrichment
- billing-perfect accuracy
- many custom OpenCode agents on day one

## Explicit Non-Goals

- do not replace `.agent-result.json`
- do not block the runtime integration on MCP support
- do not block the runtime integration on skills refactoring
- do not introduce a second OpenCode execution mode yet

## Suggested Rollout

### PR 1

- add `RuntimeProvider: "opencode"`
- add `OpenCodeRuntime`
- support CLI `local_process`
- add parser fixtures and unit tests

### PR 2

- add run-scoped XDG/env preparation in `agent-runner`
- persist runtime metadata and session IDs cleanly
- add smoke coverage

### PR 3

- add config examples and documentation

### PR 4

- start OpenCode-native instruction/config staging

## Bottom Line

SprintFoundry should add OpenCode as a CLI-based subprocess runtime first.

That is the smallest, clearest, and lowest-risk path that matches the Phase 0 findings.
