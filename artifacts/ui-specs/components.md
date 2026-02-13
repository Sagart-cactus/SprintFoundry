# Component Specifications

## RunMonitorPageLayout

**Purpose:** Defines the information architecture for a single run: persistent run summary, phase progress, event timeline, active context, and secondary artifacts/logs.

**Props:**
- `runId: string`
- `projectId: string`
- `status: "queued" | "running" | "completed" | "failed" | "cancelled"`
- `phases: { key: string; label: string; status: "pending" | "active" | "complete" | "failed" }[]`
- `events: TimelineEvent[]`
- `activeEventId?: string`
- `artifacts: ArtifactItem[]`
- `logs: LogGroup`
- `isLoading?: boolean`
- `error?: string`

**IA Regions:**
1. `RunHeaderStrip` (top, sticky)
2. `PhaseProgressBar` (below header)
3. Main split:
- left: `TimelinePane`
- right: `ActiveContextPane`
4. Secondary area: `ArtifactsLogsPanel`

**Layout:**
- Container: `main` column flex, full viewport height minus top app chrome.
- Desktop grid (`>=1100px`):
- row 1: header strip full width
- row 2: phase progress full width
- row 3: two-column main split (`timeline 42% / context 58%`)
- secondary panel docked right in context column as internal tabs
- Tablet (`768-1099px`): main split stacks with timeline first, context second; secondary panel appears below context as segmented tabs.
- Mobile (`<768px`): timeline primary; context opens in bottom drawer; artifacts/logs become accordion under timeline.

**States:**
| State | Appearance | Behavior |
|-------|------------|----------|
| Loading | Skeleton blocks for all regions | Controls disabled; announce "Run monitor loading" |
| Default | Full layout visible | Auto-refresh active when enabled |
| Empty | Empty timeline and context helper text | Show "No events yet for this run." |
| Error | Inline error banner in main content | `Retry` action refetches run/events/logs |

**Accessibility:**
- Landmark order: `<header>` then `<main>` with named `<section>` labels.
- Skip link target: timeline heading.
- Dynamic status updates announced in dedicated `aria-live="polite"` region.

## RunHeaderStrip

**Purpose:** Persistent run identity and high-priority controls.

**Content:**
- Left: `Run #<id>`, project ID, status pill, elapsed time.
- Right actions: `Auto refresh` toggle, `Refresh`, `Open artifacts`.
- Error copy: "Run metadata unavailable. Showing cached values."

**States:**
| State | Appearance | Behavior |
|-------|------------|----------|
| Default | Single row on desktop | Actions always visible |
| Compact (mobile) | Two rows, wrapped meta | Primary actions remain 44px min tap targets |
| Stale | Small warning text + warn pill | Retains last known values |
| Disabled | Buttons dimmed | No action dispatch |

**Responsive:**
| Breakpoint | Changes |
|------------|---------|
| <768px | Metadata wraps; status and elapsed pinned; action row horizontal-scroll if needed |
| 768-1099px | Two-row but non-scroll actions |
| >=1100px | One-row, justify between meta/actions |

**Interactions:**
- `Refresh` triggers hard refetch.
- `Auto refresh` toggle does not steal focus on state updates.

**Accessibility:**
- Status pill includes text (not color-only): `Running`, `Failed`, etc.
- Toggle exposes `aria-pressed` and explicit label: `Auto refresh run data`.

## PhaseProgressBar

**Purpose:** Shows run lifecycle progress and current phase.

**Content:**
- Ordered phases with connector lines and optional timestamps.
- Current phase label: `Current phase: Execute`.

**States:**
| State | Appearance | Behavior |
|-------|------------|----------|
| Default | All phases visible with status styling | Current phase highlighted |
| Delayed | Active phase shows warning icon + duration | Tooltip explains "Phase running longer than expected" |
| Failed | Failed phase marked with error icon + text | Downstream phases remain pending |
| Empty | Placeholder text | Hidden connectors |

**Responsive:**
| Breakpoint | Changes |
|------------|---------|
| <768px | Horizontal scroll list of phase chips; current phase chip first in DOM order via duplication hidden visually from SR |
| 768-1099px | Condensed full-width track, labels truncated with tooltip |
| >=1100px | Full track with labels and optional timestamps |

**Accessibility:**
- Use `role="list"`/`role="listitem"` semantics.
- Current phase item includes `aria-current="step"`.
- Any delay/failure uses icon + text label.

## TimelinePane

**Purpose:** Chronological run activity feed and navigation source for context details.

**Content:**
- Filter controls: `All`, `Steps`, `Decisions`, `Errors`.
- Virtualized event list rows: timestamp, event type, step number/agent, short payload preview.
- Empty copy: "No timeline events for this run yet."

**States:**
| State | Appearance | Behavior |
|-------|------------|----------|
| Default | Scrollable list | Click/Enter selects row |
| Selected | Row border + background emphasis | Syncs active context |
| Auto-follow | New rows animate in | Scroll pinned to newest |
| Paused follow | Sticky notice "Following paused" | `Jump to latest` control |
| Error | Inline row-level warning | Events before failure remain visible |

**Layout:**
- Desktop min width: 320px.
- Row padding uses existing scale (`0.45rem`/`0.55rem` equivalent).
- Preserve existing event density for parity with monitor logs.

**Interactions:**
- Single select behavior.
- `Home/End` jumps first/last row.
- `j/k` optional shortcuts if focus is inside list.

**Accessibility:**
- List container focusable (`tabindex="0"`) with `aria-label="Run timeline events"`.
- Selected row uses `aria-selected="true"`.
- New event announcement rate-limited to avoid screen-reader spam.

## ActiveContextPane

**Purpose:** Shows details for currently selected timeline item, including step details and decision rationale.

**Content Sections:**
- `Step summary`: agent, task, status, token usage, timing.
- `Decision context`: prompt, chosen option, rationale.
- `Impacted artifacts`: quick list of file paths touched.
- `Next transitions`: links to prior/next relevant event.

**States:**
| State | Appearance | Behavior |
|-------|------------|----------|
| Empty | Instruction panel | "Select a timeline event to inspect details." |
| Step active | Step summary emphasized | Supports copy task text |
| Decision active | Decision block appears first | Highlights rationale and confidence |
| Error event | Error callout at top | Shows remediation hint if available |

**Responsive:**
| Breakpoint | Changes |
|------------|---------|
| <768px | Render in bottom drawer (85vh max), snap points 50% and 85% |
| 768-1099px | Inline block below timeline |
| >=1100px | Fixed right column adjacent to timeline |

**Accessibility:**
- Context title (`h2`) receives programmatic focus on selection updates.
- Drawer uses `role="dialog"`, `aria-modal="true"`, and close on `Escape`.

## ArtifactsLogsPanel

**Purpose:** Secondary deep-dive surface for artifacts and raw logs without overwhelming primary monitoring flow.

**Variants:**
- `DesktopTabs`: tabbed panel in context region.
- `TabletTabs`: full-width tabs below context.
- `MobileAccordion`: collapsible sections inline.
- `MobileLogDrawer`: full-height log reader opened from accordion.

**Content:**
- `Artifacts` tab/section: list with filename, type, updated time.
- `Logs` tab/section: planner/agent stdout/stderr segmented controls.
- `Result JSON` tab/section: formatted read-only viewer.

**States:**
| State | Appearance | Behavior |
|-------|------------|----------|
| Default | Tabs or accordion visible | First section open by default |
| Loading | Skeleton rows + spinner in viewer | Action buttons disabled |
| Empty artifacts | Empty panel copy | "No artifacts captured for this run." |
| Empty logs | Placeholder copy | "No log lines available yet." |
| Error | Inline banner in active section | `Retry` keeps current section open |

**Responsive:**
| Breakpoint | Changes |
|------------|---------|
| <768px | `Artifacts`, `Logs`, `Result JSON` as single-expand accordion; `Open full logs` launches drawer from bottom |
| 768-1099px | Horizontal tablist below main context |
| >=1100px | Right-side tabset integrated into context column |

**Mobile Drawer Behavior (required):**
- Trigger: `Open full logs` button in Logs accordion panel.
- Height: 100dvh with safe-area padding.
- Header: log kind selector + close button.
- Body: virtualized/preformatted log lines.
- Footer: `Jump to latest` and `Copy visible` actions.
- Dismiss: close button, swipe down, or `Escape` (hardware keyboard).
- Focus return: to original trigger button.

**Accessibility:**
- Accordion triggers are `<button>` with `aria-expanded` and `aria-controls`.
- Tab variant follows WAI-ARIA tab pattern (`role="tablist"`, `role="tab"`, `role="tabpanel"`).
- Log stream updates announced with concise live region: "12 new log lines in planner stdout".

## Design Token Alignment

Use existing monitor tokens from `monitor/public/styles.css` only:
- Colors: `--bg`, `--panel`, `--text`, `--muted`, `--border`, `--accent`, `--ok`, `--warn`, `--err`
- Radius: `8px`, `10px`, `12px`, and pill `999px`
- Spacing rhythm: `0.35rem`, `0.45rem`, `0.55rem`, `0.75rem`, `0.8rem`, `1rem`

No new color palette is introduced. New UI states should compose these semantic tokens.

## Accessibility Audit Notes (WCAG 2.1 AA)

- Pass target: text contrast >= 4.5:1 against panel/background tokens.
- Pass target: all interactive controls maintain 44x44px minimum on mobile.
- Required: color is never sole status indicator; include text/icon.
- Required: drawer and accordion keyboard support with visible focus outlines.
- Required: content usable at 320px without horizontal page scroll (local horizontal scroll allowed for phase chips/log text only).
