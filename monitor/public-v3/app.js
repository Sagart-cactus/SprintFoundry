const projectFilter = document.getElementById("project-filter");
const resumeFilter = document.getElementById("resume-filter");
const searchInput = document.getElementById("search-input");
const refreshBtn = document.getElementById("refresh-btn");
const activeLane = document.getElementById("active-lane");
const failedLane = document.getElementById("failed-lane");
const completedLane = document.getElementById("completed-lane");
const statusLine = document.getElementById("status-line");
const lastRefreshed = document.getElementById("last-refreshed");
const resumePromptBackdrop = document.getElementById("resume-prompt-backdrop");
const resumePromptModal = document.getElementById("resume-prompt-modal");
const resumePromptTitle = document.getElementById("resume-prompt-title");
const resumePromptHint = document.getElementById("resume-prompt-hint");
const resumePromptInput = document.getElementById("resume-prompt-input");
const resumePromptForm = document.getElementById("resume-prompt-form");
const resumePromptCancel = document.getElementById("resume-prompt-cancel");
const boardPrefsStorageKey = "sf_monitor_v3_board_prefs";

function loadBoardPrefs() {
  const defaults = {
    selectedProject: "all",
    resumeFilter: "all",
    searchQuery: "",
    showHidden: false,
  };

  try {
    const raw = sessionStorage.getItem(boardPrefsStorageKey);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaults;
    return {
      selectedProject:
        typeof parsed.selectedProject === "string" && parsed.selectedProject
          ? parsed.selectedProject
          : defaults.selectedProject,
      resumeFilter:
        parsed.resumeFilter === "all" || parsed.resumeFilter === "resumed" || parsed.resumeFilter === "fresh"
          ? parsed.resumeFilter
          : defaults.resumeFilter,
      searchQuery:
        typeof parsed.searchQuery === "string" ? parsed.searchQuery : defaults.searchQuery,
      showHidden:
        typeof parsed.showHidden === "boolean" ? parsed.showHidden : defaults.showHidden,
    };
  } catch {
    return defaults;
  }
}

const initialPrefs = loadBoardPrefs();

const state = {
  runs: [],
  selectedProject: initialPrefs.selectedProject,
  resumeFilter: initialPrefs.resumeFilter,
  searchQuery: initialPrefs.searchQuery,
  collapsedLanes: JSON.parse(sessionStorage.getItem("collapsedLanes") || "{}"),
  showHidden: initialPrefs.showHidden,
};

const authStorageKey = "sf_monitor_api_token";
let resumePromptResolver = null;

function persistBoardPrefs() {
  const prefs = {
    selectedProject: state.selectedProject,
    resumeFilter: state.resumeFilter,
    searchQuery: state.searchQuery,
    showHidden: state.showHidden,
  };
  sessionStorage.setItem(boardPrefsStorageKey, JSON.stringify(prefs));
}

function initAuthToken() {
  const params = new URLSearchParams(window.location.search);
  const tokenFromQuery = params.get("token") || params.get("access_token");
  if (tokenFromQuery) {
    localStorage.setItem(authStorageKey, tokenFromQuery);
    params.delete("token");
    params.delete("access_token");
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash ?? ""}`;
    window.history.replaceState({}, "", nextUrl);
    return tokenFromQuery;
  }
  return localStorage.getItem(authStorageKey) || "";
}

const monitorApiToken = initAuthToken();

function authHeaders() {
  if (!monitorApiToken) return {};
  return { Authorization: `Bearer ${monitorApiToken}` };
}

function withAuthUrl(input) {
  if (!monitorApiToken) return input;
  const url = new URL(input, window.location.origin);
  url.searchParams.set("access_token", monitorApiToken);
  if (url.origin === window.location.origin) {
    return `${url.pathname}${url.search}${url.hash}`;
  }
  return url.toString();
}

function hasResumePromptDialog() {
  return Boolean(
    resumePromptBackdrop &&
    resumePromptModal &&
    resumePromptTitle &&
    resumePromptHint &&
    resumePromptInput &&
    resumePromptForm &&
    resumePromptCancel
  );
}

function closeResumePromptDialog(value = null) {
  if (!hasResumePromptDialog()) return false;
  if (!resumePromptResolver) return false;
  const resolve = resumePromptResolver;
  resumePromptResolver = null;
  resumePromptModal.classList.remove("open");
  resumePromptModal.hidden = true;
  resumePromptBackdrop.hidden = true;
  resumePromptInput.value = "";
  resolve(value);
  return true;
}

function openResumePromptDialog(runId, stepNumber = null) {
  if (!hasResumePromptDialog()) {
    return Promise.resolve("");
  }

  if (resumePromptResolver) {
    closeResumePromptDialog(null);
  }

  const stepLabel = Number.isInteger(stepNumber) && stepNumber > 0
    ? `step ${stepNumber}`
    : "latest failed step";

  resumePromptTitle.textContent = Number.isInteger(stepNumber) && stepNumber > 0
    ? `Resume from Step ${stepNumber}`
    : "Resume Run";
  resumePromptHint.textContent = `Run ${runId} · ${stepLabel}`;
  resumePromptInput.value = "";
  resumePromptBackdrop.hidden = false;
  resumePromptModal.hidden = false;
  requestAnimationFrame(() => {
    resumePromptModal.classList.add("open");
    resumePromptInput.focus();
  });

  return new Promise((resolve) => {
    resumePromptResolver = resolve;
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function prettyStatus(status) {
  const s = String(status ?? "unknown").toLowerCase();
  if (s === "executing") return "Executing";
  if (s === "planning") return "Planning";
  if (s === "completed") return "Completed";
  if (s === "failed") return "Failed";
  if (s === "pending") return "Pending";
  if (s === "waiting_human_review") return "Awaiting Review";
  return "Unknown";
}

function laneOf(status) {
  const s = String(status ?? "").toLowerCase();
  if (s === "failed") return "failed";
  if (s === "completed") return "completed";
  return "active";
}

function fmtRelative(ts) {
  if (!ts) return "-";
  const t = Number(ts);
  if (!Number.isFinite(t)) return "-";
  const diff = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return "-";
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min}m ${rem}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function humanTokens(tokens) {
  const n = Number(tokens || 0);
  if (!n || Number.isNaN(n)) return "0 Tokens";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M Tokens`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K Tokens`;
  return `${n} Tokens`;
}

function totalTokens(run) {
  return (run.steps ?? []).reduce((sum, step) => sum + (Number(step.tokens) || 0), 0);
}

function computeProgress(run) {
  const total = Number(run.step_count || run.steps?.length || 0);
  const done = (run.steps ?? []).filter((s) => s.status === "completed").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { done, total, pct };
}

function isEmptyRun(run) {
  const status = String(run.status ?? "").toLowerCase();
  const stepCount = Number(run.step_count || run.steps?.length || 0);
  return (status === "" || status === "unknown" || !run.status) && stepCount === 0;
}

function isStale(run) {
  const status = String(run.status ?? "").toLowerCase();
  if (status !== "executing" && status !== "planning") return false;
  const ts = Number(run.last_event_ts);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts > 3600000; // 1 hour
}

function runDuration(run) {
  const steps = run.steps ?? [];
  if (!steps.length) return null;
  const starts = steps.map((s) => Date.parse(s.started_at || "")).filter(Number.isFinite);
  const ends = steps.map((s) => Date.parse(s.completed_at || "")).filter(Number.isFinite);
  if (!starts.length || !ends.length) return null;
  return Math.max(...ends) - Math.min(...starts);
}

function runStartMs(run) {
  const starts = (run.steps ?? [])
    .map((s) => Date.parse(s.started_at || ""))
    .filter(Number.isFinite);
  return starts.length ? Math.min(...starts) : null;
}

function fmtElapsed(ms) {
  if (ms == null || Number.isNaN(ms) || ms < 0) return null;
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function activeAgent(run) {
  const status = String(run.status ?? "").toLowerCase();

  if (status === "completed") {
    const dur = runDuration(run);
    return dur != null ? `Ran ${fmtDuration(dur)}` : "Completed";
  }

  if (status === "failed") {
    const failedStep = (run.steps ?? []).find((s) => s.status === "failed");
    return failedStep ? `Failed at ${failedStep.agent || "step"} ${failedStep.step_number}` : "Failed";
  }

  const running = (run.steps ?? []).find((s) => s.status === "running");
  if (running) {
    const model = run.step_models?.[String(running.step_number)] || "";
    const startMs = runStartMs(run);
    const elapsed = startMs != null ? fmtElapsed(Date.now() - startMs) : null;
    const parts = [running.agent || "agent"];
    if (model) parts.push(model);
    if (elapsed) parts.push(elapsed);
    return parts.join(" · ");
  }

  const next = (run.steps ?? []).find((s) => s.status === "pending");
  if (next) return `${next.agent || "agent"} · next up`;
  return "-";
}

function renderStepPills(run) {
  const steps = run.steps ?? [];
  if (!steps.length) return "";
  return steps
    .map((step) => {
      const cls =
        step.status === "completed" ? "completed" :
        step.status === "running"   ? "running"   :
        step.status === "failed"    ? "failed"    : "";
      const label = step.agent || `step${step.step_number}`;
      return `<span class="step-pill ${escapeHtml(cls)}">${escapeHtml(label)}</span>`;
    })
    .join("");
}

function matchesSearch(run, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    (run.run_id || "").toLowerCase().includes(q) ||
    (run.project_id || "").toLowerCase().includes(q) ||
    (run.classification || "").toLowerCase().includes(q) ||
    (run.ticket_id || "").toLowerCase().includes(q) ||
    (run.ticket_title || "").toLowerCase().includes(q) ||
    (run.ticket_source || "").toLowerCase().includes(q)
  );
}

function isResumedRun(run) {
  if (run?.resumed === true) return true;
  const count = Number(run?.resumed_count ?? 0);
  return Number.isFinite(count) && count > 0;
}

function canResumeRun(run) {
  const status = String(run?.status ?? "").toLowerCase();
  return status === "failed" || status === "cancelled";
}

function failedStepNumber(run) {
  const failed = (run.steps ?? []).find((step) => step.status === "failed");
  return typeof failed?.step_number === "number" ? failed.step_number : null;
}

function applyResumeFilter(runs) {
  if (state.resumeFilter === "resumed") {
    return runs.filter((run) => isResumedRun(run));
  }
  if (state.resumeFilter === "fresh") {
    return runs.filter((run) => !isResumedRun(run));
  }
  return runs;
}

function sortByRecency(runs) {
  return [...runs].sort((a, b) => (Number(b.last_event_ts) || 0) - (Number(a.last_event_ts) || 0));
}

function renderFilter() {
  const projects = [...new Set(state.runs.map((r) => r.project_id))].sort();
  projectFilter.innerHTML = ['<option value="all">All projects</option>']
    .concat(projects.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`))
    .join("");

  if (!projects.includes(state.selectedProject)) state.selectedProject = "all";
  projectFilter.value = state.selectedProject;
  if (resumeFilter) {
    resumeFilter.value = state.resumeFilter;
  }
  if (searchInput.value !== state.searchQuery) {
    searchInput.value = state.searchQuery;
  }
}

function renderLane(container, runs) {
  if (!runs.length) {
    container.innerHTML = '<p class="empty">No runs</p>';
    return;
  }

  container.innerHTML = runs
    .map((run) => {
      const status = String(run.status || "unknown").toLowerCase();
      const stale = isStale(run);
      const progress = computeProgress(run);
      const cardClasses = ["run-card", escapeHtml(status)];
      if (stale) cardClasses.push("stale");
      const resumed = isResumedRun(run);
      const resumeCount = Number(run.resumed_count ?? 0);
      const failedStep = failedStepNumber(run);

      const pills = renderStepPills(run);
      const triggerSource = String(run.trigger_source || "");
      const webhookTriggered = triggerSource.endsWith("_webhook");
      const sourceLabel = run.ticket_source ? String(run.ticket_source).toUpperCase() : "";
      const runUrl = new URL("/v3/run", window.location.origin);
      runUrl.searchParams.set("project", run.project_id);
      runUrl.searchParams.set("run", run.run_id);
      if (monitorApiToken) {
        runUrl.searchParams.set("token", monitorApiToken);
      }
      return `
        <div class="run-card-wrap">
          <a class="${cardClasses.join(" ")}" href="${escapeHtml(`${runUrl.pathname}${runUrl.search}`)}">
            <div class="card-head">
              <span class="badge ${escapeHtml(status)}">${escapeHtml(prettyStatus(run.status))}</span>
              ${webhookTriggered ? '<span class="badge webhook-trigger">Webhook</span>' : ""}
              ${resumed ? `<span class="badge resumed">Resumed${resumeCount > 1 ? ` x${escapeHtml(String(resumeCount))}` : ""}</span>` : ""}
              ${stale ? '<span class="badge stale-badge">Stale</span>' : ""}
              <span class="updated">${escapeHtml(fmtRelative(run.last_event_ts))}</span>
            </div>
            <h3 title="${escapeHtml(run.run_id)}">${escapeHtml(run.run_id)}</h3>
            <div class="chip-row">
              <span class="chip">${escapeHtml(run.project_id)}</span>
              <span class="chip">${escapeHtml(run.classification || "unclassified")}</span>
              ${sourceLabel ? `<span class="chip">${escapeHtml(sourceLabel)}</span>` : ""}
              ${run.ticket_id ? `<span class="chip">${escapeHtml(run.ticket_id)}</span>` : ""}
            </div>
            <div class="progress"><span style="width:${progress.pct}%"></span></div>
            ${pills ? `<div class="step-pills">${pills}</div>` : ""}
            <p class="active-agent">${escapeHtml(activeAgent(run))}</p>
          </a>
          ${canResumeRun(run)
            ? `<button
                type="button"
                class="run-resume-btn"
                data-project="${escapeHtml(run.project_id)}"
                data-run="${escapeHtml(run.run_id)}"
                ${failedStep != null ? `data-step="${escapeHtml(String(failedStep))}"` : ""}
              >Resume</button>`
            : ""}
        </div>
      `;
    })
    .join("");
}

function renderLaneSection(laneId, container, allRuns, label) {
  const section = container.closest(".lane");
  const h2 = section.querySelector("h2");
  const collapsed = state.collapsedLanes[laneId] === true;

  // For active lane, separate real runs from empty/hidden
  let visibleRuns = allRuns;
  let hiddenCount = 0;
  if (laneId === "active") {
    const real = allRuns.filter((r) => !isEmptyRun(r));
    const empty = allRuns.filter((r) => isEmptyRun(r));
    hiddenCount = empty.length;
    visibleRuns = state.showHidden ? allRuns : real;
  }

  const sorted = sortByRecency(visibleRuns);
  h2.innerHTML = `${escapeHtml(label)} <span class="lane-count">(${allRuns.length})</span>`;
  h2.classList.add("lane-header");
  h2.setAttribute("role", "button");
  h2.setAttribute("aria-expanded", String(!collapsed));

  if (collapsed) {
    container.style.display = "none";
  } else {
    container.style.display = "";
    renderLane(container, sorted);

    // Show hidden runs toggle for active lane
    if (laneId === "active" && hiddenCount > 0) {
      const existingToggle = section.querySelector(".hidden-toggle");
      if (existingToggle) existingToggle.remove();
      const toggle = document.createElement("button");
      toggle.className = "hidden-toggle";
      toggle.type = "button";
      toggle.textContent = state.showHidden
        ? `Hide ${hiddenCount} empty runs`
        : `Show ${hiddenCount} hidden empty runs`;
      toggle.addEventListener("click", () => {
        state.showHidden = !state.showHidden;
        persistBoardPrefs();
        render();
      });
      section.appendChild(toggle);
    }
  }
}

async function postResumeFromBoard(projectId, runId, stepNumber = null) {
  const prompt = await openResumePromptDialog(runId, stepNumber);
  if (prompt === null) return false;

  const payload = { project: projectId, run: runId };
  if (Number.isInteger(stepNumber) && stepNumber > 0) {
    payload.step = stepNumber;
  }
  const trimmedPrompt = String(prompt).trim();
  if (trimmedPrompt) {
    payload.prompt = trimmedPrompt;
  }

  const resp = await fetch(withAuthUrl("/api/run/resume"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error || `Resume failed (${resp.status})`);
  }
  return true;
}

function render() {
  renderFilter();
  let runs = state.selectedProject === "all" ? state.runs : state.runs.filter((r) => r.project_id === state.selectedProject);
  runs = runs.filter((r) => matchesSearch(r, state.searchQuery));
  runs = applyResumeFilter(runs);

  // Clean up any existing hidden toggles
  document.querySelectorAll(".hidden-toggle").forEach((el) => el.remove());

  renderLaneSection("active", activeLane, runs.filter((r) => laneOf(r.status) === "active"), "Active Runs");
  renderLaneSection("failed", failedLane, runs.filter((r) => laneOf(r.status) === "failed"), "Failed Runs");
  renderLaneSection("completed", completedLane, runs.filter((r) => laneOf(r.status) === "completed"), "Completed Runs");

  const visibleCount = runs.filter((r) => laneOf(r.status) !== "active" || !isEmptyRun(r) || state.showHidden).length;
  statusLine.textContent = `Showing ${visibleCount} run${visibleCount === 1 ? "" : "s"}`;
  persistBoardPrefs();
}

function stampRefresh() {
  lastRefreshed.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;
}

async function fetchRuns() {
  const response = await fetch(withAuthUrl("/api/runs"), { headers: authHeaders() });
  if (!response.ok) throw new Error(await response.text());
  const payload = await response.json();
  state.runs = Array.isArray(payload.runs) ? payload.runs : [];
  render();
  stampRefresh();
}

// --- Event listeners ---

projectFilter.addEventListener("change", () => {
  state.selectedProject = projectFilter.value;
  persistBoardPrefs();
  render();
});

if (resumeFilter) {
  resumeFilter.addEventListener("change", () => {
    state.resumeFilter = resumeFilter.value;
    persistBoardPrefs();
    render();
  });
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const btn = event.target.closest(".run-resume-btn");
  if (!btn) return;
  event.preventDefault();
  event.stopPropagation();

  const projectId = btn.dataset.project;
  const runId = btn.dataset.run;
  const rawStep = Number(btn.dataset.step);
  const stepNumber = Number.isInteger(rawStep) && rawStep > 0 ? rawStep : null;
  if (!projectId || !runId) return;

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "Resuming...";
  statusLine.textContent = `Resuming ${runId}...`;
  void postResumeFromBoard(projectId, runId, stepNumber)
    .then(async (queued) => {
      if (!queued) {
        statusLine.textContent = "Resume canceled";
        return;
      }
      statusLine.textContent = `Resume queued for ${runId}`;
      await fetchRuns();
    })
    .catch((error) => {
      statusLine.textContent = `Resume failed: ${error instanceof Error ? error.message : String(error)}`;
      alert(statusLine.textContent);
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = originalText;
    });
});

if (hasResumePromptDialog()) {
  resumePromptCancel.addEventListener("click", () => {
    closeResumePromptDialog(null);
  });

  resumePromptBackdrop.addEventListener("click", () => {
    closeResumePromptDialog(null);
  });

  resumePromptForm.addEventListener("submit", (event) => {
    event.preventDefault();
    closeResumePromptDialog(resumePromptInput.value);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && resumePromptResolver) {
      event.preventDefault();
      closeResumePromptDialog(null);
    }
  });
}

let searchTimeout;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    state.searchQuery = searchInput.value.trim();
    persistBoardPrefs();
    render();
  }, 200);
});

refreshBtn.addEventListener("click", async () => {
  statusLine.textContent = "Refreshing...";
  try {
    await fetchRuns();
  } catch (error) {
    statusLine.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
});

// Collapsible lane headers
document.querySelectorAll(".lane h2").forEach((h2) => {
  h2.addEventListener("click", () => {
    const section = h2.closest(".lane");
    const grid = section.querySelector(".lane-grid");
    const laneId = grid.id.replace("-lane", "");
    state.collapsedLanes[laneId] = !(state.collapsedLanes[laneId] === true);
    sessionStorage.setItem("collapsedLanes", JSON.stringify(state.collapsedLanes));
    render();
  });
});

// ---- SSE real-time streaming with polling fallback ----

const sseStatus = document.getElementById("sse-status");
let sseSource = null;
let pollingInterval = null;
let sseConnected = false;

function updateSSEIndicator(status) {
  if (!sseStatus) return;
  sseStatus.className = `sse-indicator ${status}`;
  if (status === "connected") sseStatus.textContent = "Live";
  else if (status === "connecting") sseStatus.textContent = "Connecting...";
  else sseStatus.textContent = "Polling";
}

function startPolling() {
  if (pollingInterval) return;
  pollingInterval = setInterval(async () => {
    try {
      await fetchRuns();
    } catch {
      // keep current view on transient failure
    }
  }, 5000);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

function connectSSE() {
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }

  updateSSEIndicator("connecting");
  sseSource = new EventSource(withAuthUrl("/api/events/stream"));

  sseSource.addEventListener("connected", () => {
    sseConnected = true;
    updateSSEIndicator("connected");
    stopPolling();
  });

  sseSource.addEventListener("runs", (e) => {
    try {
      const payload = JSON.parse(e.data);
      if (Array.isArray(payload.runs)) {
        state.runs = payload.runs;
        render();
        stampRefresh();
      }
    } catch {
      // Malformed data
    }
  });

  sseSource.addEventListener("event", (e) => {
    try {
      const event = JSON.parse(e.data);
      const runId = event.run_id;
      if (runId) {
        const existing = state.runs.find((r) => r.run_id === runId);
        if (existing) {
          existing.last_event_type = event.event_type;
          existing.last_event_ts = event.timestamp ? Date.parse(event.timestamp) : Date.now();
          if (event.event_type === "task.completed") existing.status = "completed";
          else if (event.event_type === "task.failed") existing.status = "failed";
          else if (event.event_type === "step.started") existing.status = "executing";
          else if (event.event_type === "human_gate.requested") existing.status = "waiting_human_review";
          else if (event.event_type === "task.plan_generated") existing.status = "planning";
          render();
          stampRefresh();
        }
      }
    } catch {
      // Malformed event
    }
  });

  sseSource.onerror = () => {
    sseConnected = false;
    updateSSEIndicator("disconnected");
    startPolling();
  };

  sseSource.onopen = () => {
    if (sseConnected) return;
    sseConnected = true;
    updateSSEIndicator("connected");
    stopPolling();
  };
}

// Initial data load, then connect SSE
await fetchRuns();
connectSSE();
startPolling();
