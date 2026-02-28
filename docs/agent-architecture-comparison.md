# Agent Architecture: Dedicated Identity vs. Blank Agent + Runtime Skills

## Context

SprintFoundry currently has **11 dedicated agents**, each with a handcrafted CLAUDE.md (~100-300 lines), a fixed definition in `platform.yaml`, and a dedicated Dockerfile. Language variants (developer/go-developer, qa/go-qa) are ~85-90% duplicated. The proposal is to move to a **blank agent + runtime skills** model where a generic base agent gets specialized by attaching skills at runtime.

---

## Comparison: Current vs. Proposed vs. Hybrid

### A. Current: Dedicated Agent Identity

**How it works:** Each agent has a static `src/agents/{id}/CLAUDE.md` that defines its complete identity — role, process, rules, output format. The orchestrator selects agent IDs from a fixed catalog. Agent-runner copies the CLAUDE.md into the workspace.

| Strength | Detail |
|----------|--------|
| Prompt coherence | Single, hand-tuned narrative. LLMs perform best with one unified system prompt |
| Simple orchestration | Orchestrator picks from a fixed list — a selection task, not a composition task |
| Easy debugging | One file per agent. Bad output → inspect one CLAUDE.md |
| Clear container mapping | 1 agent = 1 Dockerfile with exact tooling needed |

| Weakness | Detail |
|----------|--------|
| Language variant duplication | developer vs go-developer = ~85% copy-paste. Adding Python/Rust = 2 more agents each |
| Rigid composition | Can't create "Go developer with Next.js knowledge" without a new agent |
| Scaling cost | N roles × M languages = N×M agents to maintain |
| Plugin disconnect | Plugins exist but are supplementary; core behavior is still in the static CLAUDE.md |

### B. Proposed: Blank Agent + Runtime Skills

**How it works:** One generic base CLAUDE.md (~40 lines). Skills from a repository are composed at runtime. The orchestrator selects skill combinations instead of agent IDs. Agent-runner concatenates base + selected skills.

```
base-agent.md + role-developer + lang-go + review-code-quality → "Go Developer"
base-agent.md + role-qa + lang-go → "Go QA"
```

| Strength | Detail |
|----------|--------|
| Zero duplication | N+M instead of N×M. One `lang-go` skill works with any role |
| Free composition | "Go developer with Next.js" = just add both language skills |
| External skill repos | Teams can publish `skill-pack-rails` without forking SprintFoundry |
| Dynamic specialization | Orchestrator can tailor skills per-ticket, not just per-role |

| Weakness | Detail |
|----------|--------|
| **Prompt quality degradation** | Concatenated skills (~300+ lines with headers/preambles) vs hand-tuned single doc (~134 lines). LLMs consistently perform worse with fragmented instructions than a coherent narrative |
| **Identity dilution** | Generic base weakens the agent's "sense of self". A strong opening identity produces more consistent behavior |
| **Skill conflicts** | Two skills may contradict (e.g., "don't fix code" from review skill + "implement features" from developer role). No single author ensures coherence |
| **Orchestrator complexity** | Composing skill sets is a combinatorial decision — harder for the planning LLM than selecting from a fixed list |
| **Debugging difficulty** | Bad output from 4 composed skills — which one caused it? |
| **Testing explosion** | 6 roles × 5 langs × 5 tools = hundreds of valid combos to test vs 11 agents today |
| **Context window bloat** | Assembled prompts are ~2x larger than dedicated CLAUDE.md for equivalent behavior |
| **Container image problem** | Either one massive image (all langs) or a matrix of images (back to N×M) |

### C. Hybrid: Assembled Agent Identity from Skill Building Blocks (Recommended)

**How it works:** Keep dedicated agent identities as the external interface. Internally, each agent's CLAUDE.md is **assembled at runtime** from composable partials. The orchestrator still picks agent IDs. The assembled CLAUDE.md is one coherent document.

```
src/agents/
  _base/                         # shared sections
    before-you-start.md          # common preamble
    result-format.md             # .agent-result.json spec
    pre-commit-hooks.md          # hook handling
  _roles/                        # role-specific process + rules
    developer-process.md
    qa-process.md
  _languages/                    # language-specific standards + commands
    go-standards.md
    typescript-standards.md
  go-developer/
    agent.yaml                   # assembly manifest
```

**agent.yaml example:**
```yaml
identity: "You are a senior Go developer working as part of an AI development team."
includes:
  - _base/before-you-start.md
  - _roles/developer-process.md
  - _languages/go-standards.md
  - _base/result-format.md
variables:
  BUILD_CMD: "go build ./..."
  TEST_CMD: "go test ./..."
  LINT_CMD: "go vet ./..."
```

The assembler reads `agent.yaml`, concatenates includes with variable substitution, and produces a **single coherent CLAUDE.md** — same quality as a hand-written one, zero duplication.

| Dimension | Dedicated (Current) | Blank + Skills | Hybrid |
|-----------|---------------------|----------------|--------|
| Duplication | High (N×M) | None | None |
| Prompt coherence | Excellent | Poor-medium | Excellent |
| Orchestrator complexity | Simple | Complex | Simple |
| Adding new language | 2 new files, copy-paste | 1 skill file | 1 partial + 1 manifest |
| Debugging | 1 file | N skills | 1 assembled file (traceable) |
| Testing | 11 agents | Combinatorial | 11 agents |
| Context window | Minimal | Bloated (~2x) | Minimal |
| Container images | 1:1 works | Complex | 1:1 works |
| External extensibility | Via plugins | Skills replace everything | Plugins + community partials |

---

## Implementation Plan (Hybrid Approach)

### Phase 1: Extract shared sections from existing CLAUDE.md files
- Diff `developer/CLAUDE.md` vs `go-developer/CLAUDE.md` to identify shared vs language-specific sections
- Diff `qa/CLAUDE.md` vs `go-qa/CLAUDE.md` similarly
- Create partials in `src/agents/_base/`, `_roles/`, `_languages/`
- Files: `before-you-start.md`, `result-format.md`, `pre-commit-hooks.md`, `developer-process.md`, `qa-process.md`, `go-standards.md`, `typescript-standards.md`

### Phase 2: Build the assembler (`src/service/agent-assembler.ts`)
- Read `agent.yaml` manifests from agent directories
- Load and concatenate partials in order
- Variable substitution (`{{BUILD_CMD}}`, `{{LANGUAGE}}`, etc.)
- Validate output (required sections present, reasonable length)
- Fallback: if no `agent.yaml` exists, use static CLAUDE.md as-is (backward compatible)

### Phase 3: Wire into agent-runner
- Modify `prepareWorkspace()` in `agent-runner.ts` (lines 178-249)
- Replace `fs.copyFile(CLAUDE.md)` with `agentAssembler.assemble(agentId)`
- Add assembled content logging for debugging

### Phase 4: Convert the duplicated pairs first
- `developer` + `go-developer` → shared `_roles/developer-process.md` + separate language partials
- `qa` + `go-qa` → shared `_roles/qa-process.md` + separate language partials
- Verify assembled output matches or improves current CLAUDE.md quality

### Phase 5: Convert remaining agents (optional, incremental)
- Agents with no duplication (product, architect, security) can stay as static CLAUDE.md — the assembler skips them
- Convert only when there's concrete benefit (e.g., adding Python variants)

### Verification
- Assemble each agent and diff against current CLAUDE.md to ensure nothing is lost
- Run existing integration tests (agent-runner workspace preparation tests)
- Manual test: run a Go development task with assembled agent, compare output quality to current

### Key files to modify
- `src/service/agent-runner.ts` — `prepareWorkspace()` (lines 178-249)
- `src/agents/developer/CLAUDE.md` → decompose into partials
- `src/agents/go-developer/CLAUDE.md` → decompose into partials
- `src/agents/qa/CLAUDE.md` → decompose into partials
- `src/agents/go-qa/CLAUDE.md` → decompose into partials
- New: `src/service/agent-assembler.ts`
- New: `src/agents/_base/`, `_roles/`, `_languages/` partial directories
- New: `agent.yaml` manifests in agent directories that use assembly
