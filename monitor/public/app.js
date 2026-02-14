const projectSelect = document.getElementById("project-select");
const runSelect = document.getElementById("run-select");
const liveToggleBtn = document.getElementById("live-toggle");
const manualSyncBtn = document.getElementById("manual-sync");
const refreshBtn = document.getElementById("refresh-btn");
const headerError = document.getElementById("header-error");

const runLabel = document.getElementById("run-label");
const runStatus = document.getElementById("run-status");
const runElapsed = document.getElementById("run-elapsed");
const currentPhase = document.getElementById("current-phase");
const phaseList = document.getElementById("phase-list");

const eventsList = document.getElementById("events-list");
const eventCount = document.getElementById("event-count");
const loadMoreBtn = document.getElementById("load-more-btn");
const jumpLatestBtn = document.getElementById("jump-latest-btn");
const followNotice = document.getElementById("follow-notice");

const activeStepEl = document.getElementById("active-step");
const stepDetailsToggle = document.getElementById("step-details-toggle");
const stepDetailsPanel = document.getElementById("step-details-panel");
const stepArtifactsList = document.getElementById("step-artifacts-list");
const stepChangeSummary = document.getElementById("step-change-summary");

const nextActionEl = document.getElementById("next-action");
const nextActionControls = document.getElementById("next-action-controls");
const nextActionError = document.getElementById("next-action-error");

const metricsGrid = document.getElementById("metrics-grid");
const metricsNote = document.getElementById("metrics-note");

const selectedEventEl = document.getElementById("selected-event");
const contextHeading = document.getElementById("context-heading");

const artifactsList = document.getElementById("artifacts-list");
const logView = document.getElementById("log-view");
const resultView = document.getElementById("result-view");
const secondaryTabButtons = Array.from(document.querySelectorAll(".tabs[role='tablist'] .tab"));
const secondaryPanels = {
  artifacts: document.getElementById("artifacts-panel"),
  logs: document.getElementById("logs-panel"),
  result: document.getElementById("result-panel"),
};
const logTabButtons = Array.from(document.querySelectorAll("#logs-panel .log-tabs .tab"));

const statusLine = document.getElementById("status-line");
const liveRegion = document.getElementById("live-region");

const state = {
  runs: [],
  selectedProject: "",
  selectedRun: "",
  selectedEventKey: "",
  selectedLogKind: "planner_stdout",
  selectedSecondaryPanel: "artifacts",
  runData: null,
  events: [],
  files: [],
  eventsLimit: 160,
  canLoadMoreEvents: true,
  expandedPayload: new Set(),
  liveUpdates: true,
  followLatest: true,
  lastEventTotal: 0,
  isLoading: false,
  stepDetailsExpanded: false,
  pendingActionId: null,
};

const EVENT_TYPE_META = {
  "task.plan_generated": { icon: "[P]", label: "Plan generated" },
  "task.plan_validated": { icon: "[V]", label: "Plan validated" },
  "step.started": { icon: "[>]", label: "Step started" },
  "step.completed": { icon: "[OK]", label: "Step completed" },
  "ticket.updated": { icon: "[T]", label: "Ticket updated" },
};

const METRICS = [
  { id: "duration", label: "Duration" },
  { id: "tokens", label: "Tokens" },
  { id: "agents_steps", label: "Agents/Steps" },
  { id: "errors", label: "Errors" },
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function fmtElapsed(startedAt) {
  if (!startedAt) return "-";
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "-";
  const diffSec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const h = Math.floor(diffSec / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  const s = diffSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function shortText(text, n = 120) {
  if (!text) return "";
  return text.length > n ? `${text.slice(0, n)}...` : text;
}

function eventSignature(evt) {
  const payload = evt?.data ? safeJson(evt.data) : "";
  return `${evt?.timestamp ?? ""}|${evt?.event_type ?? ""}|${payload}`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function deriveEventKey(events) {
  const counts = new Map();
  return events.map((evt) => {
    const signature = eventSignature(evt);
    const count = (counts.get(signature) ?? 0) + 1;
    counts.set(signature, count);
    return `${signature}::${count}`;
  });
}

function inferPhaseState(phaseName, runStatus) {
  const normalized = String(phaseName || "").toLowerCase();
  if (runStatus === "failed" && (normalized.includes("execute") || normalized.includes("validate"))) {
    return "failed";
  }
  if (runStatus === "completed") return "complete";
  if (runStatus === "executing" || runStatus === "running") {
    if (normalized.includes("execute")) return "active";
    if (normalized.includes("plan")) return "complete";
    return "pending";
  }
  if (runStatus === "planning") {
    if (normalized.includes("plan")) return "active";
    return "pending";
  }
  if (runStatus === "unknown") return "unknown";
  return "pending";
}

function derivePhases(runData) {
  const base = ["Plan", "Execute", "Validate", "Finalize"];
  return base.map((label) => ({
    label,
    status: inferPhaseState(label, runData?.status),
  }));
}

function deriveActiveStep(runData) {
  const steps = runData?.steps ?? [];
  if (!steps.length) return null;
  const running = steps.find((s) => s.status === "running");
  if (running) return running;
  const pending = steps.find((s) => s.status === "pending");
  if (pending) return pending;
  return [...steps].reverse().find((s) => s.status === "completed" || s.status === "failed") ?? null;
}

function parseImpactedPaths(evt) {
  const data = evt?.data ?? {};
  const candidates = [data.files, data.paths, data.changed_files, data.impacted_files, data.artifacts];
  const values = [];
  for (const item of candidates) {
    if (!Array.isArray(item)) continue;
    for (const value of item) {
      if (typeof value === "string") values.push(value);
      if (value && typeof value.path === "string") values.push(value.path);
    }
  }
  return values;
}

function deriveStepArtifacts(step) {
  if (!step) return [];
  const values = [];
  const candidates = [step.artifacts, step.files, step.outputs, step.changed_files];
  for (const item of candidates) {
    if (!Array.isArray(item)) continue;
    for (const value of item) {
      if (typeof value === "string") values.push(value);
      if (value && typeof value.path === "string") values.push(value.path);
    }
  }
  return Array.from(new Set(values));
}

function deriveStepSummary(step) {
  if (!step) return "No change summary.";
  if (typeof step.change_summary === "string" && step.change_summary.trim()) {
    return step.change_summary.trim();
  }
  if (typeof step.task === "string" && step.task.trim()) {
    return shortText(step.task.trim(), 220);
  }
  return "No change summary.";
}

function deriveNextAction(runData, events) {
  const status = runData?.status ?? "unknown";
  const activeStep = deriveActiveStep(runData);
  const lastEvent = events.at(-1);

  if (status === "failed") {
    return `Inspect failure details from ${lastEvent?.event_type ?? "latest event"} and retry the failed step.`;
  }
  if (status === "completed") {
    return "Review artifacts and result JSON, then close or archive the run.";
  }
  if (status === "planning") {
    return "Wait for plan generation to complete, then confirm step assignments.";
  }
  if (status === "pending") {
    return "Await planner startup. Sync manually if no events appear.";
  }
  if (activeStep?.status === "running") {
    return `Monitor completion for step #${activeStep.step_number} (${activeStep.agent}).`;
  }
  if (activeStep?.status === "pending") {
    return `Next expected transition: step #${activeStep.step_number} should start.`;
  }
  return "Monitor the latest event stream for the next transition.";
}

function deriveNextActionControls(runData) {
  const status = runData?.status ?? "unknown";

  return [
    {
      id: "view-result",
      label: "View Result JSON",
      enabled: Boolean(runData),
      reason: "",
    },
    {
      id: "archive",
      label: "Archive Run",
      enabled: false,
      reason:
        status === "completed"
          ? "Archive Run is unavailable in this environment."
          : "Archive Run is unavailable while run is still executing.",
    },
    {
      id: "close",
      label: "Close Run",
      enabled: false,
      reason:
        status === "completed" || status === "failed"
          ? "Close Run is unavailable in this environment."
          : "Close Run is unavailable while run is still executing.",
    },
  ];
}

function deriveMetrics(runData, events) {
  const duration = fmtElapsed(runData?.started_at);
  const tokenValue = (runData?.steps ?? [])
    .map((s) => (typeof s.tokens === "number" ? s.tokens : null))
    .filter((v) => typeof v === "number")
    .reduce((sum, item) => sum + item, 0);
  const tokenText = tokenValue > 0 ? String(tokenValue) : "-";

  const agentSet = new Set((runData?.steps ?? []).map((s) => s.agent).filter(Boolean));
  const stepCount = runData?.step_count || (runData?.steps ?? []).length || 0;
  const agentStepText = stepCount > 0 ? `${agentSet.size}/${stepCount}` : "-";

  const errorCount = events.filter((evt) => {
    const type = String(evt?.event_type ?? "");
    return type.includes("failed") || type.includes("error");
  }).length;

  return {
    duration,
    tokens: tokenText,
    agents_steps: agentStepText,
    errors: String(errorCount),
    hasMissing: duration === "-" || tokenText === "-" || agentStepText === "-",
  };
}

function eventPreview(evt) {
  const data = evt?.data ?? {};
  if (typeof data.message === "string") return shortText(data.message, 140);
  if (typeof data.error === "string") return shortText(data.error, 140);
  if (typeof data.task === "string") return shortText(data.task, 140);
  if (typeof data.reason === "string") return shortText(data.reason, 140);
  if (typeof data.agent === "string" && typeof data.step === "number") {
    return `Step #${data.step} assigned to ${data.agent}`;
  }
  const raw = safeJson(data);
  if (!raw || raw === "{}") return "No payload";
  return shortText(raw, 140);
}

function badgeClass(status) {
  return `badge ${status ?? "pending"}`;
}

function setLiveAnnouncement(text) {
  liveRegion.textContent = text;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${res.status} ${txt}`);
  }
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${res.status} ${txt}`);
  }
  return res.text();
}

function patchChildrenInOrder(parent, desiredNodes) {
  let cursor = parent.firstChild;
  for (const node of desiredNodes) {
    if (node === cursor) {
      cursor = cursor.nextSibling;
      continue;
    }
    parent.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    parent.removeChild(cursor);
    cursor = next;
  }
}

function renderRunSelectors() {
  const projects = [...new Set(state.runs.map((r) => r.project_id))];
  projectSelect.innerHTML = projects.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");

  if (!state.selectedProject || !projects.includes(state.selectedProject)) {
    state.selectedProject = projects[0] ?? "";
  }
  projectSelect.value = state.selectedProject;

  const runsForProject = state.runs.filter((r) => r.project_id === state.selectedProject);
  runSelect.innerHTML = runsForProject
    .map((r) => `<option value="${escapeHtml(r.run_id)}">${escapeHtml(r.run_id)} (${escapeHtml(r.status)})</option>`)
    .join("");

  if (!state.selectedRun || !runsForProject.some((r) => r.run_id === state.selectedRun)) {
    state.selectedRun = runsForProject[0]?.run_id ?? "";
  }
  runSelect.value = state.selectedRun;

  const hasRun = Boolean(state.selectedProject && state.selectedRun);
  runSelect.disabled = !runsForProject.length;
  liveToggleBtn.disabled = !hasRun;
  manualSyncBtn.disabled = !hasRun;
  loadMoreBtn.disabled = !hasRun || !state.canLoadMoreEvents;
}

function renderHeader() {
  const runData = state.runData;
  const hasRun = Boolean(state.selectedProject && state.selectedRun);

  if (!hasRun) {
    runLabel.textContent = "No run selected";
    runStatus.className = badgeClass("unknown");
    runStatus.textContent = "unknown";
    runElapsed.textContent = "Elapsed: -";
  } else {
    runLabel.textContent = `${state.selectedProject}/${state.selectedRun}`;
    const status = runData?.status ?? "unknown";
    runStatus.className = badgeClass(status);
    runStatus.textContent = status;
    runElapsed.textContent = `Elapsed: ${fmtElapsed(runData?.started_at)}`;
  }

  liveToggleBtn.setAttribute("aria-pressed", String(state.liveUpdates));
  liveToggleBtn.textContent = state.liveUpdates ? "Pause updates" : "Resume updates";
}

function renderPhases() {
  const phases = derivePhases(state.runData);
  const active = phases.find((p) => p.status === "active") ?? phases.find((p) => p.status === "failed");
  currentPhase.textContent = `Current phase: ${active?.label ?? "-"}`;

  phaseList.innerHTML = phases
    .map((phase, index) => {
      const cls = phase.status;
      const marker =
        phase.status === "complete"
          ? "done"
          : phase.status === "active"
            ? "live"
            : phase.status === "failed"
              ? "fail"
              : "wait";
      return `<li class="phase-item ${escapeHtml(cls)}" role="listitem" tabindex="0" aria-label="Phase ${index + 1} of ${phases.length}: ${escapeHtml(phase.label)}, ${escapeHtml(phase.status)}" ${phase.status === "active" ? 'aria-current="step"' : ""}><span class="phase-dot">${marker}</span>${escapeHtml(phase.label)} - ${escapeHtml(phase.status)}</li>`;
    })
    .join("");
}

function ensureSelectionStillExists(keys) {
  if (state.selectedEventKey && !keys.includes(state.selectedEventKey)) {
    state.selectedEventKey = keys.at(-1) ?? "";
  }
  if (!state.selectedEventKey) {
    state.selectedEventKey = keys.at(-1) ?? "";
  }
}

function syncFollowNotice() {
  const paused = !state.followLatest;
  followNotice.hidden = !paused;
  jumpLatestBtn.hidden = !paused;
}

function inferActiveEventKey(keys) {
  if (!keys.length) return "";
  const running = state.runData?.status === "executing" || state.runData?.status === "planning" || state.runData?.status === "pending";
  return running ? keys.at(-1) ?? "" : "";
}

function createEventRow(evt, key) {
  const li = document.createElement("li");
  li.className = "event-row";
  li.dataset.key = key;
  li.setAttribute("role", "option");

  const summaryBtn = document.createElement("button");
  summaryBtn.type = "button";
  summaryBtn.className = "event-summary";
  summaryBtn.dataset.eventKey = key;
  summaryBtn.dataset.focusId = `${key}:summary`;
  summaryBtn.addEventListener("click", () => {
    state.selectedEventKey = key;
    renderSelectedEvent();
    renderEvents(false, false);
    renderArtifacts();
  });

  const tools = document.createElement("div");
  tools.className = "event-tools";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "payload-toggle";
  toggle.dataset.eventKey = key;
  toggle.dataset.focusId = `${key}:toggle`;
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (state.expandedPayload.has(key)) {
      state.expandedPayload.delete(key);
    } else {
      state.expandedPayload.add(key);
    }
    renderEvents(false, true);
  });

  const payload = document.createElement("pre");
  payload.className = "payload";
  payload.id = `payload-${encodeURIComponent(key).replace(/%/g, "_")}`;

  tools.appendChild(toggle);
  li.append(summaryBtn, tools, payload);
  updateEventRow(li, evt, key, "");
  return li;
}

function updateEventRow(li, evt, key, activeKey) {
  const summaryBtn = li.querySelector(".event-summary");
  const toggle = li.querySelector(".payload-toggle");
  const payload = li.querySelector(".payload");

  const isSelected = key === state.selectedEventKey;
  const expanded = state.expandedPayload.has(key);
  const isActive = key === activeKey;
  const preview = eventPreview(evt);
  const meta = EVENT_TYPE_META[evt.event_type] ?? { icon: "[i]", label: "Event" };

  li.setAttribute("aria-selected", String(isSelected));
  li.classList.toggle("is-active", isActive);

  summaryBtn.innerHTML = `
    <div class="event-head">
      <span class="event-type-wrap">
        <span class="event-icon" aria-hidden="true">${escapeHtml(meta.icon)}</span>
        <span class="event-type">${escapeHtml(evt.event_type ?? "unknown")}</span>
        ${isActive ? '<span class="event-state-pill">active</span>' : ""}
      </span>
      <span class="meta">${escapeHtml(fmtTime(evt.timestamp))}</span>
    </div>
    <div class="event-preview">${escapeHtml(preview || "No payload")}</div>
  `;
  summaryBtn.setAttribute(
    "aria-label",
    `${meta.label}: ${evt.event_type ?? "unknown"} at ${fmtTime(evt.timestamp)}. ${preview || "No payload preview"}${isActive ? ". Active event" : ""}`
  );

  toggle.textContent = expanded ? "Hide payload" : "Show payload";
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute("aria-controls", payload.id);

  payload.hidden = !expanded;
  payload.textContent = JSON.stringify(evt.data ?? {}, null, 2);
}

function renderEvents(restoreScrollForPrepend, preserveFocus) {
  const previousScrollTop = eventsList.scrollTop;
  const previousScrollHeight = eventsList.scrollHeight;
  const wasNearBottom =
    eventsList.scrollHeight - (eventsList.scrollTop + eventsList.clientHeight) < 20 || state.followLatest;

  const keys = deriveEventKey(state.events);
  ensureSelectionStillExists(keys);
  const activeKey = inferActiveEventKey(keys);

  const focusedId = preserveFocus ? document.activeElement?.dataset?.focusId ?? "" : "";
  const existing = new Map(Array.from(eventsList.children).map((node) => [node.dataset.key, node]));
  const desiredNodes = [];

  state.events.forEach((evt, index) => {
    const key = keys[index];
    const row = existing.get(key) ?? createEventRow(evt, key);
    updateEventRow(row, evt, key, activeKey);
    desiredNodes.push(row);
  });

  patchChildrenInOrder(eventsList, desiredNodes);
  eventCount.textContent = String(state.events.length);

  if (restoreScrollForPrepend) {
    const delta = eventsList.scrollHeight - previousScrollHeight;
    eventsList.scrollTop = Math.max(0, previousScrollTop + delta);
  } else if (state.followLatest && wasNearBottom) {
    eventsList.scrollTop = eventsList.scrollHeight;
  }

  if (focusedId) {
    const focusTarget = eventsList.querySelector(`[data-focus-id="${CSS.escape(focusedId)}"]`);
    if (focusTarget) focusTarget.focus();
  }

  syncFollowNotice();
}

function renderSelectedEvent(moveFocus = false) {
  const keys = deriveEventKey(state.events);
  const index = keys.indexOf(state.selectedEventKey);
  const evt = index >= 0 ? state.events[index] : null;

  if (!evt) {
    selectedEventEl.innerHTML = '<h3>Selected Timeline Event</h3><p class="meta">Select an event to inspect details.</p>';
    return;
  }

  selectedEventEl.innerHTML = "";
  const title = document.createElement("h3");
  title.textContent = evt.event_type;
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = fmtTime(evt.timestamp);
  const payload = document.createElement("pre");
  payload.className = "payload";
  payload.textContent = JSON.stringify(evt.data ?? {}, null, 2);
  selectedEventEl.append(title, meta, payload);

  if (moveFocus) {
    contextHeading.focus();
  }
}

function renderStepDetails() {
  const activeStep = deriveActiveStep(state.runData);
  const stepSummary = activeStep
    ? `Step ${activeStep.step_number} of ${state.runData?.step_count ?? state.runData?.steps?.length ?? "-"} - ${activeStep.agent ?? "-"} (${activeStep.status ?? "pending"})`
    : "No active step yet. Waiting for planner or executor transition.";

  if (!activeStep) {
    activeStepEl.textContent = stepSummary;
    stepDetailsToggle.disabled = true;
    stepDetailsToggle.setAttribute("aria-expanded", "false");
    stepDetailsPanel.hidden = true;
    state.stepDetailsExpanded = false;
    stepArtifactsList.innerHTML = "";
    stepChangeSummary.textContent = "No change summary.";
    return;
  }

  activeStepEl.innerHTML = `${escapeHtml(stepSummary)} <span class="${badgeClass(activeStep.status)}">${escapeHtml(activeStep.status)}</span>`;
  stepDetailsToggle.disabled = false;
  stepDetailsToggle.setAttribute("aria-expanded", String(state.stepDetailsExpanded));
  stepDetailsPanel.hidden = !state.stepDetailsExpanded;

  const artifacts = deriveStepArtifacts(activeStep);
  stepArtifactsList.innerHTML = artifacts.length
    ? artifacts.map((path) => `<li>${escapeHtml(path)}</li>`).join("")
    : '<li class="meta">No artifacts recorded for this step.</li>';
  stepChangeSummary.textContent = deriveStepSummary(activeStep);
}

function renderNextActions() {
  nextActionEl.textContent = deriveNextAction(state.runData, state.events);
  nextActionError.hidden = true;

  const controls = deriveNextActionControls(state.runData);
  nextActionControls.innerHTML = controls
    .map((action) => {
      const isBusy = state.pendingActionId === action.id;
      const reasonId = `reason-${action.id}`;
      const disabled = !action.enabled || isBusy;
      const reasonText = !action.enabled ? action.reason : "";
      return `
        <div class="next-action-control">
          <button type="button" data-action-id="${escapeHtml(action.id)}" ${disabled ? "disabled" : ""} ${
            reasonText ? `aria-describedby="${reasonId}"` : ""
          }>${isBusy ? "Working..." : escapeHtml(action.label)}</button>
          ${reasonText ? `<p id="${reasonId}" class="control-reason">${escapeHtml(reasonText)}</p>` : ""}
        </div>
      `;
    })
    .join("");

  nextActionControls.setAttribute("aria-busy", String(Boolean(state.pendingActionId)));
}

function renderMetrics() {
  const metrics = deriveMetrics(state.runData, state.events);

  metricsGrid.innerHTML = METRICS.map((metric) => {
    const value = metrics[metric.id] ?? "-";
    return `<div><dt>${escapeHtml(metric.label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  }).join("");

  metricsNote.hidden = !metrics.hasMissing;
}

function inferArtifactCategory(pathValue) {
  const pathLower = String(pathValue || "").toLowerCase();
  if (pathLower.endsWith(".agent-result.json") || pathLower.includes("result")) return "final_result";
  if (pathLower.includes("planner") || pathLower.includes("stderr") || pathLower.includes("stdout") || pathLower.endsWith(".log")) {
    return pathLower.includes("agent") ? "agent_log" : "system_log";
  }
  if (pathLower.endsWith(".json") || pathLower.endsWith(".md") || pathLower.endsWith(".txt") || pathLower.endsWith(".yaml")) {
    return "output";
  }
  return "other";
}

function artifactCategoryLabel(category) {
  if (category === "system_log") return "System log";
  if (category === "agent_log") return "Agent log";
  if (category === "output") return "Output";
  if (category === "final_result") return "Final result";
  return "Other";
}

function fileIcon(pathValue) {
  const pathLower = String(pathValue || "").toLowerCase();
  if (pathLower.endsWith(".json")) return "[{}]";
  if (pathLower.endsWith(".md")) return "[md]";
  if (pathLower.endsWith(".log") || pathLower.includes("stderr") || pathLower.includes("stdout")) return "[log]";
  if (pathLower.endsWith(".yaml") || pathLower.endsWith(".yml")) return "[yml]";
  return "[file]";
}

function artifactPreviewKind(pathValue) {
  const pathLower = String(pathValue || "").toLowerCase();
  if (pathLower.endsWith(".planner-runtime.stdout.log")) return "planner_stdout";
  if (pathLower.endsWith(".planner-runtime.stderr.log")) return "planner_stderr";
  if (pathLower.endsWith(".codex-runtime.stdout.log")) return "agent_stdout";
  if (pathLower.endsWith(".codex-runtime.stderr.log")) return "agent_stderr";
  if (pathLower.endsWith(".agent-result.json")) return "agent_result";
  return "";
}

function createArtifactRow(file) {
  const item = document.createElement("li");
  item.className = "artifact-item";
  item.dataset.path = file.path;

  const top = document.createElement("div");
  top.className = "artifact-top";

  const icon = document.createElement("span");
  icon.className = "artifact-icon";
  icon.setAttribute("aria-hidden", "true");

  const path = document.createElement("span");
  path.className = "artifact-path";

  const tag = document.createElement("span");
  tag.className = "artifact-tag";

  const touched = document.createElement("span");
  touched.className = "artifact-touched";

  top.append(icon, path, tag, touched);

  const meta = document.createElement("div");
  meta.className = "artifact-meta meta";

  const actions = document.createElement("div");
  actions.className = "artifact-actions";

  const previewBtn = document.createElement("button");
  previewBtn.type = "button";
  previewBtn.className = "artifact-btn";
  previewBtn.dataset.action = "preview";

  const downloadBtn = document.createElement("button");
  downloadBtn.type = "button";
  downloadBtn.className = "artifact-btn";
  downloadBtn.dataset.action = "download";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "artifact-btn";
  copyBtn.dataset.action = "copy";

  actions.append(previewBtn, downloadBtn, copyBtn);
  item.append(top, meta, actions);
  return item;
}

function updateArtifactRow(item, file, impactedSet) {
  const top = item.querySelector(".artifact-top");
  const icon = top.children[0];
  const path = top.children[1];
  const tag = top.children[2];
  const touched = top.children[3];

  const meta = item.querySelector(".artifact-meta");
  const previewBtn = item.querySelector(".artifact-btn[data-action='preview']");
  const downloadBtn = item.querySelector(".artifact-btn[data-action='download']");
  const copyBtn = item.querySelector(".artifact-btn[data-action='copy']");

  const category = inferArtifactCategory(file.path);
  const previewKind = artifactPreviewKind(file.path);

  icon.textContent = fileIcon(file.path);
  path.textContent = file.path;
  path.title = file.path;

  tag.className = `artifact-tag ${category}`;
  tag.textContent = artifactCategoryLabel(category);

  const touchedBySelection = impactedSet.has(file.path);
  touched.textContent = touchedBySelection ? "Touched by selected event" : "";

  meta.textContent = `${Math.max(1, Math.round((file.size ?? 0) / 1024))}KB | ${fmtTime(file.mtime_ms)}`;

  previewBtn.textContent = "Preview";
  previewBtn.disabled = !previewKind;
  previewBtn.setAttribute("aria-label", `Preview ${file.path}`);
  previewBtn.dataset.path = file.path;

  downloadBtn.textContent = "Download";
  downloadBtn.disabled = true;
  downloadBtn.setAttribute("aria-label", `Download ${file.path}`);

  copyBtn.textContent = "Copy path";
  copyBtn.disabled = false;
  copyBtn.setAttribute("aria-label", `Copy path for ${file.path}`);

  previewBtn.title = previewKind ? "Preview in logs/result panel" : "Preview not available for this file type.";
  downloadBtn.title = "Download is unavailable in this environment.";
}

function renderArtifacts() {
  const previousScrollTop = artifactsList.scrollTop;
  const focusedPath = document.activeElement?.dataset?.path ?? "";

  const keys = deriveEventKey(state.events);
  const selectedIndex = keys.indexOf(state.selectedEventKey);
  const selectedEvent = selectedIndex >= 0 ? state.events[selectedIndex] : null;
  const impactedSet = new Set(parseImpactedPaths(selectedEvent));

  if (!state.files.length) {
    artifactsList.innerHTML = '<li class="artifact-item meta">No artifacts captured for this run.</li>';
    return;
  }

  const existing = new Map(Array.from(artifactsList.children).map((node) => [node.dataset.path, node]));
  const desired = [];

  for (const file of state.files.slice(0, 80)) {
    const row = existing.get(file.path) ?? createArtifactRow(file);
    updateArtifactRow(row, file, impactedSet);
    desired.push(row);
  }

  patchChildrenInOrder(artifactsList, desired);
  artifactsList.scrollTop = Math.min(previousScrollTop, artifactsList.scrollHeight);

  if (focusedPath) {
    const node = artifactsList.querySelector(`[data-path="${CSS.escape(focusedPath)}"]`);
    if (node) node.focus();
  }
}

function switchSecondaryPanel(panelName) {
  state.selectedSecondaryPanel = panelName;
  secondaryTabButtons.forEach((btn) => {
    const active = btn.dataset.panel === panelName;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });

  Object.entries(secondaryPanels).forEach(([name, panel]) => {
    panel.hidden = name !== panelName;
  });
}

function setActiveLogTab(kind) {
  logTabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.kind === kind);
  });
}

async function loadLog(kind = state.selectedLogKind) {
  if (!state.selectedProject || !state.selectedRun) return;
  const text = await fetchText(
    `/api/log?project=${encodeURIComponent(state.selectedProject)}&run=${encodeURIComponent(state.selectedRun)}&kind=${encodeURIComponent(kind)}&lines=700`
  );

  if (kind === "agent_result") {
    resultView.textContent = text || "(empty)";
  } else {
    logView.textContent = text || "(empty)";
  }
}

async function handleArtifactAction(event) {
  const button = event.target.closest(".artifact-btn");
  if (!button) return;

  const action = button.dataset.action;
  const pathValue = button.dataset.path || button.closest(".artifact-item")?.dataset.path;
  if (!pathValue) return;

  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(pathValue);
      setLiveAnnouncement("Path copied.");
    } catch {
      setLiveAnnouncement("Unable to copy path.");
    }
    return;
  }

  if (action === "download") {
    nextActionError.hidden = false;
    nextActionError.textContent = "Action failed. The run state did not change. Try again.";
    return;
  }

  if (action === "preview") {
    const kind = artifactPreviewKind(pathValue);
    if (!kind) return;

    if (kind === "agent_result") {
      switchSecondaryPanel("result");
      await loadLog("agent_result");
      return;
    }

    switchSecondaryPanel("logs");
    state.selectedLogKind = kind;
    setActiveLogTab(kind);
    await loadLog(kind);
  }
}

async function handleNextActionClick(event) {
  const button = event.target.closest("button[data-action-id]");
  if (!button) return;

  const actionId = button.dataset.actionId;
  if (actionId === "view-result") {
    switchSecondaryPanel("result");
    await loadLog("agent_result");
    return;
  }

  nextActionError.hidden = false;
  nextActionError.textContent = "Action failed. The run state did not change. Try again.";
}

async function refreshRunData(options = {}) {
  const { preserveScrollForPrepend = false, moveContextFocus = false, preserveTimelineFocus = true } = options;

  if (!state.selectedProject || !state.selectedRun) {
    statusLine.textContent = "Select a project and run to load monitor data.";
    return;
  }

  const [runData, eventsData, filesData] = await Promise.all([
    fetchJson(`/api/run?project=${encodeURIComponent(state.selectedProject)}&run=${encodeURIComponent(state.selectedRun)}`),
    fetchJson(
      `/api/events?project=${encodeURIComponent(state.selectedProject)}&run=${encodeURIComponent(state.selectedRun)}&limit=${encodeURIComponent(state.eventsLimit)}`
    ),
    fetchJson(`/api/files?project=${encodeURIComponent(state.selectedProject)}&run=${encodeURIComponent(state.selectedRun)}`),
  ]);

  state.runData = runData;
  state.events = eventsData.events ?? [];
  state.files = filesData.files ?? [];
  state.canLoadMoreEvents = state.events.length >= state.eventsLimit;

  renderRunSelectors();
  renderHeader();
  renderPhases();
  renderStepDetails();
  renderNextActions();
  renderMetrics();
  renderSelectedEvent(moveContextFocus);
  renderEvents(preserveScrollForPrepend, preserveTimelineFocus);
  renderArtifacts();
  loadMoreBtn.disabled = !state.canLoadMoreEvents;

  await Promise.all([loadLog(state.selectedLogKind), loadLog("agent_result")]);

  if (state.events.length > state.lastEventTotal) {
    const diff = state.events.length - state.lastEventTotal;
    if (diff <= 5) {
      setLiveAnnouncement(`${diff} new timeline event${diff === 1 ? "" : "s"}.`);
    }
  }
  state.lastEventTotal = state.events.length;

  statusLine.textContent = `Loaded ${state.selectedProject}/${state.selectedRun} | last event ${runData.last_event_type ?? "-"}`;
}

async function loadRunsAndRefresh(options = {}) {
  if (state.isLoading) return;
  state.isLoading = true;

  try {
    headerError.hidden = true;
    const data = await fetchJson("/api/runs");
    state.runs = data.runs ?? [];
    renderRunSelectors();

    if (!state.selectedProject || !state.selectedRun) {
      renderHeader();
      renderPhases();
      renderStepDetails();
      renderNextActions();
      renderMetrics();
      eventsList.innerHTML = "";
      artifactsList.innerHTML = '<li class="artifact-item meta">No artifacts captured for this run.</li>';
      statusLine.textContent = `No runs found under ${data.runs_root}`;
      state.isLoading = false;
      return;
    }

    await refreshRunData(options);
  } catch (err) {
    headerError.hidden = false;
    statusLine.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  state.isLoading = false;
}

projectSelect.addEventListener("change", async () => {
  state.selectedProject = projectSelect.value;
  state.selectedRun = "";
  state.eventsLimit = 160;
  state.followLatest = true;
  state.expandedPayload.clear();
  renderRunSelectors();
  await refreshRunData({ moveContextFocus: false, preserveTimelineFocus: false });
});

runSelect.addEventListener("change", async () => {
  state.selectedRun = runSelect.value;
  state.eventsLimit = 160;
  state.followLatest = true;
  state.expandedPayload.clear();
  await refreshRunData({ moveContextFocus: false, preserveTimelineFocus: false });
});

refreshBtn.addEventListener("click", async () => {
  await loadRunsAndRefresh({ preserveTimelineFocus: true });
});

manualSyncBtn.addEventListener("click", async () => {
  await loadRunsAndRefresh({ preserveTimelineFocus: true });
});

liveToggleBtn.addEventListener("click", () => {
  state.liveUpdates = !state.liveUpdates;
  renderHeader();
  statusLine.textContent = state.liveUpdates ? "Live updates resumed." : "Live updates paused. Use Sync now for manual refresh.";
});

loadMoreBtn.addEventListener("click", async () => {
  if (!state.canLoadMoreEvents) return;
  state.eventsLimit += 160;
  await refreshRunData({ preserveScrollForPrepend: true, preserveTimelineFocus: true });
});

jumpLatestBtn.addEventListener("click", () => {
  state.followLatest = true;
  eventsList.scrollTop = eventsList.scrollHeight;
  syncFollowNotice();
});

eventsList.addEventListener("scroll", () => {
  const nearBottom = eventsList.scrollHeight - (eventsList.scrollTop + eventsList.clientHeight) < 20;
  if (nearBottom) {
    state.followLatest = true;
  } else if (state.events.length > 0) {
    state.followLatest = false;
  }
  syncFollowNotice();
});

secondaryTabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    switchSecondaryPanel(button.dataset.panel);
  });
});

logTabButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    state.selectedLogKind = button.dataset.kind;
    setActiveLogTab(state.selectedLogKind);
    await loadLog(state.selectedLogKind);
  });
});

artifactsList.addEventListener("click", (event) => {
  handleArtifactAction(event).catch((err) => {
    statusLine.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  });
});

nextActionControls.addEventListener("click", (event) => {
  handleNextActionClick(event).catch((err) => {
    statusLine.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  });
});

stepDetailsToggle.addEventListener("click", () => {
  state.stepDetailsExpanded = !state.stepDetailsExpanded;
  renderStepDetails();
});

setInterval(async () => {
  if (!state.liveUpdates) return;
  await loadRunsAndRefresh({ preserveTimelineFocus: true });
}, 2500);

await loadRunsAndRefresh();
switchSecondaryPanel("artifacts");
setActiveLogTab(state.selectedLogKind);
