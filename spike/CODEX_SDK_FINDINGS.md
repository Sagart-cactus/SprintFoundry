# Codex SDK Spike Findings: `@openai/codex-sdk`

**Date:** 2026-02-19  
**SDK version:** `@openai/codex-sdk@0.104.0`

## Scope
This spike validates the Codex SDK thread flow required by SprintFoundry runtime migration planning:
- `startThread()`
- multiple `run()` calls on the same thread
- `resumeThread(threadId)`
- structured output (`outputSchema`)
- usage metadata exposure
- checks for `OPENAI_API_KEY`, workspace path control, `AGENTS.md`, and `CODEX_HOME` skills behavior

## CLI-to-SDK Mapping
Current Codex runtime (`src/service/runtime/codex-runtime.ts`) invokes:
- `codex exec <prompt> --json --sandbox workspace-write`

Codex SDK equivalent:
- `new Codex({ env })`
- `const thread = codex.startThread({ workingDirectory, sandboxMode, model, ... })`
- `await thread.run(prompt, { outputSchema })`
- `const resumed = codex.resumeThread(threadId, options)`
- `await resumed.run(followUpPrompt)`

Detailed mapping:

| Current runtime concept | Current behavior | Codex SDK mapping |
|---|---|---|
| Prompt text | pass to `codex exec` | pass to `thread.run(input)` |
| Workspace path | process `cwd` | `startThread({ workingDirectory })` |
| Sandbox | `--sandbox workspace-write` | `startThread({ sandboxMode: "workspace-write" })` |
| Model | `OPENAI_MODEL` env | `startThread({ model })` |
| Auth | `OPENAI_API_KEY` env | `new Codex({ env: { OPENAI_API_KEY } })` |
| Continuation | re-run command with context files | multiple `thread.run()` calls on same thread |
| Resume by thread id | not explicitly modeled | `resumeThread(threadId)` |
| Structured output | parse text/JSON from stdout | `run(..., { outputSchema })` |
| Usage tokens | parse from stdout JSONL | direct `turn.usage` and `turn.completed.usage` |
| Cost | estimated externally | **not exposed** in current SDK type surface |

## Captured Metadata
The PoC captures:
- `turn.finalResponse` (raw)
- parsed JSON payload from `turn.finalResponse`
- `turn.usage.input_tokens`
- `turn.usage.cached_input_tokens`
- `turn.usage.output_tokens`
- persisted `thread.id` after first run
- resumed-thread ID match assertion

Cost metadata status:
- The TypeScript SDK surface (`Turn`, `RunResult`, `TurnCompletedEvent`) exposes token usage but no cost field.
- PoC records `cost.value_usd = null` with explicit source note.

## Required Checks in the PoC
The PoC implements explicit checks for:
- `OPENAI_API_KEY` auth presence and live-run success path
- workspace path control (`workingDirectory` and workspace sentinel file read)
- `AGENTS.md` pickup in workspace (marker rule)
- conversation persistence across multiple `run()` calls
- persistence after `resumeThread(threadId)`
- `CODEX_HOME` skills behavior (`skills/skill-marker/SKILL.md` marker check)
- structured JSON response parsing via `outputSchema`

If `OPENAI_API_KEY` is missing, the script runs in preflight mode and marks live checks as `skipped`.

## Codex SDK vs Claude SDK (Current Spike)
Reference Claude spike: `spike/claude-sdk-poc.ts`.

| Dimension | Codex SDK (`@openai/codex-sdk`) | Claude SDK (`@anthropic-ai/claude-agent-sdk`) |
|---|---|---|
| Primary API | `Codex` + `Thread` (`startThread`, `run`, `resumeThread`) | `query()` async stream |
| Conversation identity | explicit `thread.id` | session id via system/result messages |
| Resume | first-class `resumeThread(threadId)` | implicit via persisted sessions / SDK config |
| Structured output | `outputSchema` on `run()` | parse typed result message text/JSON |
| Usage tokens | `turn.usage` | `result.usage` |
| Cost | not exposed by current type surface | `total_cost_usd` available |
| Thread events | `thread.started`, `turn.*`, `item.*`, `error` | broader message taxonomy (`system`, `assistant`, `result`, etc.) |
| SDK transport model | wraps `codex exec --experimental-json` | wraps `claude --sdk` |

## Notable Integration Difference
A direct difference for SprintFoundry accounting:
- Claude SDK can provide exact cost (`total_cost_usd`) per run.
- Codex SDK currently provides token usage but not cost, so runtime must continue using estimated cost or external pricing lookup.

