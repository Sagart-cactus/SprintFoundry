const projectFilter = document.getElementById("project-filter");
const refreshBtn = document.getElementById("refresh-btn");
const activeLane = document.getElementById("active-lane");
const failedLane = document.getElementById("failed-lane");
const completedLane = document.getElementById("completed-lane");
const statusLine = document.getElementById("status-line");
const lastRefreshed = document.getElementById("last-refreshed");

const state = {
  runs: [],
  selectedProject: "all",
};

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

function activeAgent(run) {
  const running = (run.steps ?? []).find((s) => s.status === "running");
  if (running) return `${running.agent || "agent"} · step ${running.step_number}`;
  const next = (run.steps ?? []).find((s) => s.status === "pending");
  if (next) return `${next.agent || "agent"} · next ${next.step_number}`;
  return "-";
}

function renderFilter() {
  const projects = [...new Set(state.runs.map((r) => r.project_id))].sort();
  projectFilter.innerHTML = ['<option value="all">All projects</option>']
    .concat(projects.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`))
    .join("");

  if (!projects.includes(state.selectedProject)) state.selectedProject = "all";
  projectFilter.value = state.selectedProject;
}

function renderLane(container, runs) {
  if (!runs.length) {
    container.innerHTML = '<p class="empty">No runs</p>';
    return;
  }

  container.innerHTML = runs
    .map((run) => {
      const status = String(run.status || "unknown").toLowerCase();
      const progress = computeProgress(run);
      return `
        <a class="run-card ${escapeHtml(status)}" href="/v3/run?project=${encodeURIComponent(run.project_id)}&run=${encodeURIComponent(run.run_id)}">
          <div class="card-head">
            <span class="badge ${escapeHtml(status)}">${escapeHtml(prettyStatus(run.status))}</span>
            <span class="updated">${escapeHtml(fmtRelative(run.last_event_ts))}</span>
          </div>
          <h3 title="${escapeHtml(run.run_id)}">${escapeHtml(run.run_id)}</h3>
          <div class="chip-row">
            <span class="chip">${escapeHtml(run.project_id)}</span>
            <span class="chip">${escapeHtml(run.classification || "unclassified")}</span>
          </div>
          <div class="metric-row">
            <span>${escapeHtml(`${progress.done} of ${progress.total} steps`)}</span>
            <span>${escapeHtml(humanTokens(totalTokens(run)))}</span>
          </div>
          <div class="progress"><span style="width:${progress.pct}%"></span></div>
          <p class="active-agent">${escapeHtml(activeAgent(run))}</p>
        </a>
      `;
    })
    .join("");
}

function render() {
  renderFilter();
  const runs = state.selectedProject === "all" ? state.runs : state.runs.filter((r) => r.project_id === state.selectedProject);

  renderLane(
    activeLane,
    runs.filter((r) => laneOf(r.status) === "active")
  );
  renderLane(
    failedLane,
    runs.filter((r) => laneOf(r.status) === "failed")
  );
  renderLane(
    completedLane,
    runs.filter((r) => laneOf(r.status) === "completed")
  );

  statusLine.textContent = `Showing ${runs.length} run${runs.length === 1 ? "" : "s"}`;
}

function stampRefresh() {
  lastRefreshed.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;
}

async function fetchRuns() {
  const response = await fetch("/api/runs");
  if (!response.ok) throw new Error(await response.text());
  const payload = await response.json();
  state.runs = Array.isArray(payload.runs) ? payload.runs : [];
  render();
  stampRefresh();
}

projectFilter.addEventListener("change", () => {
  state.selectedProject = projectFilter.value;
  render();
});

refreshBtn.addEventListener("click", async () => {
  statusLine.textContent = "Refreshing...";
  try {
    await fetchRuns();
  } catch (error) {
    statusLine.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
});

setInterval(async () => {
  try {
    await fetchRuns();
  } catch {
    // keep current view on transient failure
  }
}, 5000);

await fetchRuns();
