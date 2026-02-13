const projectSelect = document.getElementById("project-select");
const runSelect = document.getElementById("run-select");
const liveToggleBtn = document.getElementById("live-toggle");
const manualSyncBtn = document.getElementById("manual-sync");
const refreshBtn = document.getElementById("refresh-btn");

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
const nextActionEl = document.getElementById("next-action");
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
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
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
  const payload = evt?.data ? JSON.stringify(evt.data) : "";
  return `${evt?.timestamp ?? ""}|${evt?.event_type ?? ""}|${payload}`;
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
  if (runStatus === "pending") {
    if (normalized.includes("plan")) return "pending";
  }
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

function eventPreview(evt) {
  const d = evt?.data ?? {};
  if (typeof d.message === "string") return shortText(d.message, 140);
  if (typeof d.error === "string") return shortText(d.error, 140);
  if (typeof d.task === "string") return shortText(d.task, 140);
  if (typeof d.reason === "string") return shortText(d.reason, 140);
  if (typeof d.agent === "string" && typeof d.step === "number") {
    return `Step #${d.step} assigned to ${d.agent}`;
  }
  const raw = JSON.stringify(d);
  return raw && raw !== "{}" ? shortText(raw, 140) : "No payload";
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

function renderRunSelectors() {
  const projects = [...new Set(state.runs.map((r) => r.project_id))];
  projectSelect.innerHTML = projects.map((p) => `<option value="${p}">${p}</option>`).join("");

  if (!state.selectedProject || !projects.includes(state.selectedProject)) {
    state.selectedProject = projects[0] ?? "";
  }
  projectSelect.value = state.selectedProject;

  const runsForProject = state.runs.filter((r) => r.project_id === state.selectedProject);
  runSelect.innerHTML = runsForProject
    .map((r) => `<option value="${r.run_id}">${r.run_id} (${r.status})</option>`)
    .join("");

  if (!state.selectedRun || !runsForProject.some((r) => r.run_id === state.selectedRun)) {
    state.selectedRun = runsForProject[0]?.run_id ?? "";
  }
  runSelect.value = state.selectedRun;
}

function renderHeader() {
  const runData = state.runData;
  const project = state.selectedProject || "-";
  const run = state.selectedRun || "-";
  runLabel.textContent = `${project}/${run}`;

  const status = runData?.status ?? "unknown";
  runStatus.className = badgeClass(status);
  runStatus.textContent = status;
  runElapsed.textContent = `Elapsed: ${fmtElapsed(runData?.started_at)}`;

  liveToggleBtn.setAttribute("aria-pressed", String(state.liveUpdates));
  liveToggleBtn.textContent = state.liveUpdates ? "Pause updates" : "Resume updates";
}

function renderPhases() {
  const phases = derivePhases(state.runData);
  const active = phases.find((p) => p.status === "active") ?? phases.find((p) => p.status === "failed");
  currentPhase.textContent = `Current phase: ${active?.label ?? "-"}`;

  phaseList.innerHTML = phases
    .map((phase) => {
      const cls = phase.status === "active" ? "active" : phase.status;
      return `<li role="listitem" class="phase-item ${cls}" ${phase.status === "active" ? "aria-current=\"step\"" : ""}>${phase.label} · ${phase.status}</li>`;
    })
    .join("");
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

function createEventRow(evt, key) {
  const li = document.createElement("li");
  li.className = "event-row";
  li.dataset.key = key;
  li.setAttribute("role", "option");

  const summaryBtn = document.createElement("button");
  summaryBtn.type = "button";
  summaryBtn.className = "event-summary";
  summaryBtn.dataset.eventKey = key;
  summaryBtn.addEventListener("click", () => {
    state.selectedEventKey = key;
    renderSelectedEvent();
    renderEvents(false, false);
  });

  const tools = document.createElement("div");
  tools.className = "event-tools";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "payload-toggle";
  toggle.dataset.eventKey = key;
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (state.expandedPayload.has(key)) {
      state.expandedPayload.delete(key);
    } else {
      state.expandedPayload.add(key);
    }
    renderEvents(false, false);
  });

  const payload = document.createElement("pre");
  payload.className = "payload";
  payload.id = `payload-${encodeURIComponent(key).replace(/%/g, "_")}`;

  tools.appendChild(toggle);
  li.appendChild(summaryBtn);
  li.appendChild(tools);
  li.appendChild(payload);

  updateEventRow(li, evt, key);
  return li;
}

function updateEventRow(li, evt, key) {
  const summaryBtn = li.querySelector(".event-summary");
  const toggle = li.querySelector(".payload-toggle");
  const payload = li.querySelector(".payload");
  const isSelected = key === state.selectedEventKey;
  const expanded = state.expandedPayload.has(key);
  const preview = eventPreview(evt);

  li.setAttribute("aria-selected", String(isSelected));

  summaryBtn.innerHTML = `
    <div class="event-head">
      <span><span class="event-type">${escapeHtml(evt.event_type)}</span></span>
      <span class="meta">${escapeHtml(fmtTime(evt.timestamp))}</span>
    </div>
    <div class="event-preview">${escapeHtml(preview)}</div>
  `;
  summaryBtn.setAttribute(
    "aria-label",
    `${evt.event_type} at ${fmtTime(evt.timestamp)}. ${preview || "No payload preview"}`
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

  const focusedKey = preserveFocus ? document.activeElement?.dataset?.eventKey ?? "" : "";
  const existing = new Map(Array.from(eventsList.children).map((node) => [node.dataset.key, node]));
  const desiredNodes = [];

  state.events.forEach((evt, index) => {
    const key = keys[index];
    const row = existing.get(key) ?? createEventRow(evt, key);
    updateEventRow(row, evt, key);
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

  if (focusedKey) {
    const target = eventsList.querySelector(`.event-summary[data-event-key="${CSS.escape(focusedKey)}"]`);
    if (target) target.focus();
  }

  syncFollowNotice();
}

function renderSelectedEvent(moveFocus = false) {
  const keys = deriveEventKey(state.events);
  const index = keys.indexOf(state.selectedEventKey);
  const evt = index >= 0 ? state.events[index] : null;

  if (!evt) {
    selectedEventEl.innerHTML = "<h3>Selected Timeline Event</h3><p class=\"meta\">Select an event to inspect details.</p>";
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

function renderDerivedContext() {
  const activeStep = deriveActiveStep(state.runData);
  const nextAction = deriveNextAction(state.runData, state.events);

  if (!activeStep) {
    activeStepEl.textContent = "No active step yet.";
  } else {
    activeStepEl.innerHTML = `#${escapeHtml(activeStep.step_number)} ${escapeHtml(activeStep.agent)} <span class="${badgeClass(activeStep.status)}">${escapeHtml(activeStep.status)}</span><div class="meta">${escapeHtml(shortText(activeStep.task || "", 150))}</div>`;
  }

  nextActionEl.textContent = nextAction;
}

function parseImpactedPaths(evt) {
  const d = evt?.data ?? {};
  const candidates = [d.files, d.paths, d.changed_files, d.impacted_files, d.artifacts];
  const values = [];
  for (const item of candidates) {
    if (Array.isArray(item)) {
      for (const value of item) {
        if (typeof value === "string") values.push(value);
      }
    }
  }
  return values;
}

function renderArtifacts() {
  const keys = deriveEventKey(state.events);
  const idx = keys.indexOf(state.selectedEventKey);
  const selectedEvent = idx >= 0 ? state.events[idx] : null;
  const impacted = new Set(parseImpactedPaths(selectedEvent));

  if (!state.files.length) {
    artifactsList.innerHTML = '<li class="artifact-item meta">No artifacts captured for this run.</li>';
    return;
  }

  artifactsList.innerHTML = state.files
    .slice(0, 60)
    .map((f) => {
      const touched = impacted.has(f.path) ? " • touched by selection" : "";
      return `<li class="artifact-item"><div>${f.path}${touched}</div><div class="meta">${Math.round(f.size / 1024)}KB • ${fmtTime(f.mtime_ms)}</div></li>`;
    })
    .join("");
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

  renderHeader();
  renderPhases();
  renderDerivedContext();
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

  statusLine.textContent = `Loaded ${state.selectedProject}/${state.selectedRun} • last event ${runData.last_event_type ?? "-"}`;
}

async function loadRunsAndRefresh(options = {}) {
  if (state.isLoading) return;
  state.isLoading = true;

  try {
    const data = await fetchJson("/api/runs");
    state.runs = data.runs ?? [];
    renderRunSelectors();

    if (!state.selectedProject || !state.selectedRun) {
      statusLine.textContent = `No runs found under ${data.runs_root}`;
      state.isLoading = false;
      return;
    }

    await refreshRunData(options);
    statusLine.textContent = `${state.runs.length} runs available • synced ${fmtTime(new Date().toISOString())}`;
  } catch (err) {
    statusLine.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  state.isLoading = false;
}

projectSelect.addEventListener("change", async () => {
  state.selectedProject = projectSelect.value;
  state.selectedRun = "";
  state.eventsLimit = 160;
  state.followLatest = true;
  renderRunSelectors();
  await refreshRunData({ moveContextFocus: false, preserveTimelineFocus: false });
});

runSelect.addEventListener("change", async () => {
  state.selectedRun = runSelect.value;
  state.eventsLimit = 160;
  state.followLatest = true;
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

secondaryTabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    switchSecondaryPanel(btn.dataset.panel);
  });
});

logTabButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    logTabButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.selectedLogKind = btn.dataset.kind;
    await loadLog(state.selectedLogKind);
  });
});

setInterval(async () => {
  if (!state.liveUpdates) return;
  await loadRunsAndRefresh({ preserveTimelineFocus: true });
}, 2500);

await loadRunsAndRefresh();
switchSecondaryPanel("artifacts");
