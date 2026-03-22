# Monitor v3 — Complete UI Audit

> Captured 2026-03-22 from Kind cluster (`sprintfoundry-system` namespace).
> Data source: PostgreSQL + Redis, 3 completed runs from `linear-workflow-kind` project.

---

## 1. Board Page (Runs Overview)

### 1.1 Header Bar (Sticky Top)
| Element | Details |
|---------|---------|
| **Title** | "Run Monitor v3" with subtitle "AI run execution dashboard" |
| **Animated Icon** | Glowing orange circle pulse before title |
| **Search Input** | Placeholder "Filter runs...", debounced 200ms. Searches: run_id, project_id, classification, ticket_id, ticket_title, ticket_source |
| **Project Filter** | Dropdown, dynamically populated from run data. Default "All projects". Observed: "linear-workflow-kind" |
| **Resume Filter** | Dropdown: "All runs" / "Resumed" / "Non-resumed" |
| **Refresh Button** | Manual fetch trigger, updates status line |

### 1.2 Three-Lane Kanban Board

Each lane has a **collapsible header** (click toggles, arrow rotates, state persisted to sessionStorage).

| Lane | Statuses Included | Count Observed |
|------|-------------------|----------------|
| **Active Runs** | planning, executing, pending, waiting_human_review | 0 |
| **Failed Runs** | failed | 0 |
| **Completed Runs** | completed | 3 |

**Active lane special feature**: "Show/Hide empty runs" toggle when runs exist with no steps.

### 1.3 Run Card Anatomy

Each card is a **clickable link** → navigates to Run Detail page.

**Header row:**
- Status badge (color-coded: green=completed, blue=executing, red=failed, amber=waiting_human_review)
- "Webhook" trigger badge (green) if `trigger_source` ends with `_webhook`
- "Resumed" badge (blue) with count (e.g., "Resumed x3") if applicable
- "Stale" badge (gray italic) if no event for >1 hour
- Relative time (e.g., "2d ago")

**Title:** Run ID in monospace, truncated with ellipsis

**Chip row** (inline tags):
- Project ID (e.g., `linear-workflow-kind`)
- Classification (e.g., `direct`, or "unclassified")
- Ticket source UPPERCASE (e.g., `LINEAR`, `GITHUB`)
- Ticket ID (e.g., `SPR-8`)

**Progress bar:** Horizontal, orange gradient, `completed_steps / total_steps * 100`

**Step pills** (mini timeline):
- One pill per step, color-coded: green=completed, blue=running, red=failed, gray=pending
- Shows agent name (e.g., `merge-bot`, `qa`, `developer`)

**Bottom info line:**
- Completed: "Ran {duration}" (e.g., "Ran 1m 4s", "Ran 2m 4s", "Ran 55s")
- Failed: "Failed at {agent} {step_number}"
- Running: "{agent} · {model} · {elapsed_time}"

**Resume button** (only on failed/cancelled runs):
- Orange border pill, bottom-right
- Opens modal with optional prompt textarea
- POST to `/api/run/resume`

### 1.4 Status Bar (Sticky Footer)
| Position | Content |
|----------|---------|
| **Left** | Status message (e.g., "Showing 3 runs") |
| **Center** | SSE connection indicator: "Live" (green dot), "Connecting..." (amber pulse), "Polling" (gray dot) |
| **Right** | "Last refreshed: HH:MM:SS AM" |

### 1.5 Real-Time Updates
- **SSE primary**: `/api/events/stream` — event types: "connected", "runs", "event"
- **Polling fallback**: Every 5 seconds to `/api/runs` if SSE disconnects

---

## 2. Run Detail Page

### 2.1 Header Bar
| Element | Details |
|---------|---------|
| **Back link** | "←" arrow, navigates to `/v3` |
| **Title** | `{project_id}/{run_id}` (e.g., "linear-workflow-kind/run-1773936119102-9f9ae708") |
| **Status badge** | Color-coded, capitalized (e.g., "Completed" in green) |
| **Resume Run button** | Hidden if not resumable; shown for failed/cancelled |
| **Refresh button** | Manual refresh trigger |

### 2.2 Left Sidebar (240px, sticky)

#### 2.2.1 Run Metadata (Key-Value Pairs)
| Field | Example Values | Notes |
|-------|---------------|-------|
| **Status** | completed | With colored status dot |
| **Resumed** | No | "Yes" with step number if applicable |
| **Tokens** | 523.7K, 208.9K, 224.7K | Human-readable format (K/M) |
| **Updated** | 2d ago | Relative time |
| **Classification** | direct | |
| **Hosting** | k8s-agent-sandbox | local / docker / k8s-agent-sandbox |
| **Sandbox** | succeeded | Sandbox lifecycle state (running/stopping/succeeded) |
| **Project** | linear-workflow-kind | |
| **Ticket Source** | linear | Source system name |
| **Trigger** | linear_webhook, github_webhook | How run was initiated |
| **Issue** | SPR-8 | **Clickable link** → Linear issue URL |
| **Repository** | Sagart-cactus/sprintfoundry-dryrun | **Clickable link** → GitHub repo |
| **PR** | Sagart-cactus/sprintfoundry-dryrun | **Clickable link** → PR URL. Shows "-" if no PR |

#### 2.2.2 Handoff Button
- Orange outlined button, full sidebar width
- Click → copies `handoff_command` to clipboard
- Shows "Copied" feedback → resets after 1.8s

#### 2.2.3 Steps List
- Header: "STEPS"
- Clickable list items, each showing:
  - Status dot (green=completed, blue=running, red=failed)
  - "Step {n}" label
  - Agent name right-aligned (e.g., `qa`, `developer`, `merge-bot`)
- Click toggles selection → scrolls feed to step card

**Observed steps across runs:**
| Run | Steps |
|-----|-------|
| run-...9f9ae708 | Step 1 (qa), Step 901 (developer) |
| run-...d47d443c | Step 1 (merge-bot) |
| run-...ece39267 | Step 1 (developer) |

#### 2.2.4 Plan Section
- Header: "PLAN"
- **View Plan** (collapsible): Shows step count, Plan ID (e.g., `direct-17739361321`), classification, reasoning
- **Errors** (collapsible): Shows error count badge (red if >0). Lists last 6 failure events + last 8 planner stderr lines

### 2.3 Main Feed (Right Column)

#### 2.3.1 Step Card Anatomy

**Card header:**
- Status dot (color = step status)
- "Step {n} · {agent}" (e.g., "Step 1 · qa", "Step 901 · developer")
- "↺ Rework" label (if `is_rework` or step_number ≥ 900)
- Right-side pills:
  - Duration (e.g., "44s", "1m 19s", "1m 4s", "55s")
  - Token count (e.g., "265.0K tokens", "258.7K tokens")
  - "↺ {n} rework" amber pill (if reworked)
  - Model name pill (if present)
  - "Resumed" / "Resumed + prompt" blue pill (if applicable)

**Alerts** (conditional):
- **Rework triggered**: Amber banner with "↺ Rework triggered (attempt {n}) — {reason}"
  - Observed: "Implementation does not meet ticket timestamp requirement for QA webhook retry marker."
- **Token limit exceeded**: Red banner with "⛔ Token/budget limit exceeded — {reason}"

**INPUT section:**
- Label: "INPUT"
- Task description text (full agent task prompt)
- Observed examples:
  - "Validate the existing implementation on branch 'feat/spr-8-...' Run the relevant test suite..."
  - "Fix issue from step 1: Implementation does not meet ticket timestamp requirement..."
  - "Resolve any remaining merge blockers for branch..."
  - "Implement the Linear ticket on branch..."

**OUTPUT section:**
- Label: "OUTPUT"
- Gray background box with result summary text
- Observed examples:
  - "Validated branch feat/spr-8-... by running the available smoke QA suite; all checks passed..."
  - "Fixed SPR-8 QA webhook retry marker timestamp by updating kind-workflow-smoke.txt..."
  - "Verified branch is up to date with origin/main; no merge conflicts; ran smoke test successfully."

**Action buttons** (horizontal row):
| Button | Action |
|--------|--------|
| **Agent Output ({count})** | Opens side drawer with agent JSONL activity. Counts observed: 22, 49, 62, 64 |
| **Step Result** | Opens side drawer with step result metadata |
| **Files Modified** | Opens side drawer with file diffs |
| **Resume From Step {n}** | Red button, only on failed steps. Opens resume dialog |

### 2.4 Detail Drawer (Side Panel)

Slides in from right over main content. Has header with kicker text, title, and Close button.

#### 2.4.1 Agent Output Mode
- Header kicker: "STEP {n} · {AGENT}" (e.g., "STEP 1 · QA", "STEP 1 · MERGE-BOT")
- Title: "Agent Output"
- Section: "OUTPUT"
- Displays JSONL items as classified log rows

**Log row types observed:**
| Type | Color/Style | Content |
|------|-------------|---------|
| **Session started** | Gray | Session initialization |
| **Turn started** | Gray | Turn boundary marker |
| **Agent message** | Dark (bold header) | Agent reasoning text (truncated with "...") |
| **Command executed** | Amber background | Shell command in monospace code block |

**Command examples observed:**
- `/bin/bash -lc "cat AGENTS.md 2>/dev/null; echo '---'; cat .agent-context/stack.json 2>/dev/null; echo '---'; cat .agent-task.md 2>..."`
- `/bin/bash -lc 'find . -maxdepth 3 -type f | sort'`
- `/bin/bash -lc "rg --files -g 'AGENTS.md' -g '.agent-task.md' -g '.agent-context/stack.json'"`
- `/bin/bash -lc 'ls -la'`

Each row shows **item number** (#1, #2, #3...) on the right.

Log rows are **clickable** → toggles visibility of full raw JSON.

#### 2.4.2 Step Result Mode
- Header kicker: "STEP {n} · {AGENT}"
- Title: "Step Result"

**Sections displayed:**

| Section | Content |
|---------|---------|
| **SUMMARY** | Status (`complete`), Source (`db_step_result`), Summary text |
| **ARTIFACTS CREATED ({n})** | Expandable file list with lazy-loaded diffs. Observed: `artifacts/handoff/dev-to-qa.md`, `.agent-result.json` |
| **FILES MODIFIED ({n})** | Expandable file list with lazy-loaded diffs. Observed: `kind-workflow-smoke.txt`, `artifacts/qa-shell-run.log`, `artifacts/qa-shell-results.json`, `.agent-result.json` |
| **ISSUES ({n})** | Bulleted list of issues. "None" if empty |
| **METADATA ({n} FIELDS)** | Collapsible, shows nested key-value metadata. Observed: 6 fields, 12 fields |

**File diff expansion:**
- Click ► arrow to expand
- Lazy-loads diff via `/api/diff` on first expand
- Shows "No diff available" if diff not found
- Diff rendering: green additions, red deletions, blue hunk headers

#### 2.4.3 Files Modified Mode
- Header kicker: "STEP {n} · {AGENT}"
- Title: "Files Modified"

**Sections:**
| Section | Content |
|---------|---------|
| **FILES CREATED ({n})** | List of new files with expandable diffs. "None" if empty |
| **FILES MODIFIED ({n})** | List of modified files with expandable diffs |

### 2.5 Review Panel (Conditional)

Only displayed when `status === "waiting_human_review"`. Not observed in current data (all runs completed).

**Per review gate:**
- "Human Gate" badge + meta: "After step {n} · {review_id}"
- Summary section (scrollable, max 200px)
- Artifacts list with expandable diffs
- Feedback textarea (4 rows)
- "Approve" (green) and "Reject" (red outline) buttons
- POST to `/api/review/decide`

### 2.6 Real-Time Updates
- SSE: `/api/events/stream?project=...&run=...`
- Auto-refresh: Every 5 seconds
- Parallel fetch on refresh:
  - `/api/run` — run metadata
  - `/api/events` — event history (limit 800)
  - `/api/log?kind=planner_stdout` — planner output (1000 lines)
  - `/api/log?kind=planner_stderr` — planner errors (400 lines)
  - `/api/log?kind=agent_stdout` — agent output (1400 lines)
  - `/api/log?kind=agent_stderr` — agent errors (1400 lines)
  - Per-step logs for non-pending steps

---

## 3. Observed Data — All Three Runs

### 3.1 Run: run-1773936119102-9f9ae708 (Multi-step with Rework)
| Field | Value |
|-------|-------|
| Status | Completed |
| Tokens | 523.7K |
| Duration | 2m 4s |
| Classification | direct |
| Hosting | k8s-agent-sandbox |
| Sandbox | succeeded |
| Trigger | linear_webhook |
| Ticket | SPR-8 (Linear) |
| Repository | Sagart-cactus/sprintfoundry-dryrun |
| PR | #57 |
| Handoff | Available |
| **Steps** | Step 1 (qa, 44s, 265.0K tokens, ↺ 1 rework) → Step 901 (developer, 1m 19s, 258.7K tokens, rework) |
| **Rework reason** | "Implementation does not meet ticket timestamp requirement for QA webhook retry marker." |

### 3.2 Run: run-1773936320489-d47d443c (Merge Bot)
| Field | Value |
|-------|-------|
| Status | Completed |
| Tokens | 208.9K |
| Duration | 1m 4s |
| Classification | direct |
| Hosting | k8s-agent-sandbox |
| Sandbox | succeeded |
| Trigger | github_webhook |
| Ticket | SPR-8 (Linear) |
| Repository | Sagart-cactus/sprintfoundry-dryrun |
| PR | #57 |
| Handoff | Available |
| **Steps** | Step 1 (merge-bot, 1m 4s, 208.9K tokens) |
| Agent Output | 49 items |

### 3.3 Run: run-1773935925462-ece39267 (Developer)
| Field | Value |
|-------|-------|
| Status | Completed |
| Tokens | 224.7K |
| Duration | 55s |
| Classification | direct |
| Hosting | k8s-agent-sandbox |
| Sandbox | succeeded |
| Trigger | linear_webhook |
| Ticket | SPR-8 (Linear) |
| Repository | Sagart-cactus/sprintfoundry-dryrun |
| PR | - (none) |
| Handoff | Available |
| **Steps** | Step 1 (developer, 55s, 224.7K tokens) |
| Agent Output | 62 items |
| Artifacts Created | artifacts/handoff/dev-to-qa.md, .agent-result.json |
| Files Modified | kind-workflow-smoke.txt |

---

## 4. Visual Design Summary

| Aspect | v3 Treatment |
|--------|-------------|
| **Theme** | Light only (no dark mode) |
| **Brand color** | Orange `#FF4D00` |
| **Typography** | IBM Plex Sans (UI) + IBM Plex Mono (data/code) |
| **Card style** | White cards with light gray borders, subtle shadow |
| **Status colors** | Green=completed, Blue=executing, Red=failed, Amber=warning |
| **Badges/chips** | Rounded pill shape, border + light fill |
| **Layout** | Single-column kanban (board) / 2-column sidebar+feed (detail) |
| **Drawer** | Slide-in from right, backdrop overlay |
| **Background** | `#edf1f6` (light blue-gray) |
| **Surfaces** | `#ffffff` (white) |
| **Code blocks** | Light gray background, monospace font |

---

## 5. Complete Interactive Element Index

### Board Page
| # | Element | Type | Action |
|---|---------|------|--------|
| 1 | Search input | Text field | Filters runs by ID/project/ticket/classification |
| 2 | Project dropdown | Select | Filters by project ID |
| 3 | Resume dropdown | Select | Filters by resumed state |
| 4 | Refresh button | Button | Manual data refresh |
| 5 | Lane headers | Collapsible | Toggle lane expand/collapse |
| 6 | Run cards | Link | Navigate to run detail |
| 7 | Resume button (on card) | Button | Opens resume prompt modal |
| 8 | Show/Hide empty toggle | Toggle | Shows/hides runs with no steps |

### Detail Page
| # | Element | Type | Action |
|---|---------|------|--------|
| 1 | ← Back link | Link | Returns to board |
| 2 | Refresh button | Button | Manual data refresh |
| 3 | Resume Run button | Button | Opens resume dialog (header) |
| 4 | Issue link (e.g., SPR-8) | External link | Opens Linear/GitHub issue |
| 5 | Repository link | External link | Opens GitHub repo |
| 6 | PR link | External link | Opens pull request |
| 7 | Handoff button | Button | Copies handoff command to clipboard |
| 8 | Step list items | Clickable | Select step, scroll to card |
| 9 | View Plan | Collapsible | Shows plan ID, classification, steps, reasoning |
| 10 | Errors | Collapsible | Shows error count and error list |
| 11 | Agent Output button | Button | Opens agent activity drawer |
| 12 | Step Result button | Button | Opens step result drawer |
| 13 | Files Modified button | Button | Opens files drawer |
| 14 | Resume From Step button | Button | Opens resume dialog (step-specific) |
| 15 | Drawer Close button | Button | Closes side drawer |
| 16 | Drawer log rows | Clickable | Toggles raw JSON visibility |
| 17 | File diff details | Expandable | Lazy-loads and shows file diff |
| 18 | Metadata details | Expandable | Shows nested metadata tree |
| 19 | Approve button (review) | Button | Approves human gate review |
| 20 | Reject button (review) | Button | Rejects human gate review |
| 21 | Feedback textarea (review) | Text area | Optional feedback for review |

---

## 6. API Endpoints

### Board Page
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/runs` | Fetch all runs |
| GET | `/api/events/stream` | SSE live updates |
| POST | `/api/run/resume` | Queue run resume |

### Detail Page
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/run?project=...&run=...` | Single run metadata |
| GET | `/api/events?project=...&run=...&limit=800` | Run event history |
| GET | `/api/log?project=...&run=...&kind={kind}&lines={n}` | Log output (planner/agent stdout/stderr) |
| GET | `/api/log?project=...&run=...&step={n}&kind={kind}&lines=1400` | Per-step logs |
| GET | `/api/step-result?project=...&run=...&step={n}` | Step result metadata |
| GET | `/api/diff?project=...&run=...&file={path}` | File diff for artifact |
| GET | `/api/reviews?project=...&run=...` | Human gate reviews |
| POST | `/api/review/decide` | Submit review decision |
| POST | `/api/run/resume` | Queue run resume |
| GET | `/api/events/stream?project=...&run=...` | SSE for single run |

### Authentication
- Header: `Authorization: Bearer {token}`
- Or query param: `?access_token={token}` / `?token={token}`
- Token stored in localStorage as `sf_monitor_api_token`

---

## 7. State Persistence

| Storage | Key | Purpose |
|---------|-----|---------|
| localStorage | `sf_monitor_api_token` | Auth token |
| sessionStorage | `collapsedLanes` | Lane expand/collapse state |
| sessionStorage | `sf_monitor_v3_board_prefs` | Filter/search preferences |
| In-memory | `state.expandedLogIds` | Expanded log row JSON |
| In-memory | `state.expandedPlanDetails` | Expanded plan sections |
| In-memory | `state.expandedFeedSections` | Expanded feed sections |
| In-memory | `state.expandedDrawerSections` | Expanded drawer sections |
| In-memory | `state.expandedReviewSections` | Expanded review diffs |
| In-memory | `state.artifactDiffs` | Cached file diff content |
