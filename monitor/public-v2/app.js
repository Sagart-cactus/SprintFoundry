const projectFilter = document.getElementById("project-filter");
const refreshBtn = document.getElementById("refresh-btn");
const activeLane = document.getElementById("active-lane");
const failedLane = document.getElementById("failed-lane");
const completedLane = document.getElementById("completed-lane");
const statusLine = document.getElementById("status-line");

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

function shortText(value, length = 110) {
  const text = String(value ?? "");
  if (text.length <= length) return text;
  return `${text.slice(0, length)}...`;
}

function displayRunTitle(runId) {
  const text = String(runId ?? "");
  if (text.length <= 18) return text;
  return `…${text.slice(-18)}`;
}

function fmtDate(ts) {
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
  const hours = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function laneForStatus(status) {
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return "active";
}

function computeProgress(run) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const total = run.step_count || steps.length || 0;
  const done = steps.filter((step) => step.status === "completed").length;
  return total > 0 ? `${done}/${total} steps` : "0 steps";
}

function activeStepLabel(run) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const running = steps.find((step) => step.status === "running");
  if (running) {
    return `#${running.step_number} ${running.agent ?? "-"}`;
  }
  const pending = steps.find((step) => step.status === "pending");
  if (pending) {
    return `Next #${pending.step_number} ${pending.agent ?? "-"}`;
  }
  return "-";
}

function totalTokens(run) {
  return (run.steps ?? [])
    .map((step) => (typeof step.tokens === "number" ? step.tokens : 0))
    .reduce((sum, item) => sum + item, 0);
}

function cardAccentClass(status) {
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return "active";
}

function renderProjectFilter() {
  const projects = [...new Set(state.runs.map((run) => run.project_id))].sort();
  const options = ['<option value="all">All projects</option>']
    .concat(projects.map((project) => `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`))
    .join("");
  projectFilter.innerHTML = options;
  if (!projects.includes(state.selectedProject)) {
    state.selectedProject = "all";
  }
  projectFilter.value = state.selectedProject;
}

function renderCardsIntoLane(container, runs) {
  if (!runs.length) {
    container.innerHTML = '<p class="lane-empty">No runs in this lane.</p>';
    return;
  }

  container.innerHTML = runs
    .map((run) => {
      const accent = cardAccentClass(run.status);
      const classification = run.classification ?? "unclassified";
      const progress = computeProgress(run);
      const activeStep = activeStepLabel(run);
      const tokens = totalTokens(run);
      const description = shortText(
        `${run.status} - ${progress}${activeStep !== "-" ? ` - ${activeStep}` : ""}`,
        100
      );
      return `
        <a class="run-card-link" href="/v2/run?project=${encodeURIComponent(run.project_id)}&run=${encodeURIComponent(run.run_id)}" aria-label="Open ${escapeHtml(run.project_id)} ${escapeHtml(run.run_id)} details">
          <article class="run-card ${escapeHtml(accent)}">
            <div class="card-inner">
            <header>
              <h3 class="title" title="${escapeHtml(run.run_id)}">${escapeHtml(displayRunTitle(run.run_id))}</h3>
              <p class="desc">${escapeHtml(description)}</p>
            </header>
            <div class="chips">
              <span class="chip">${escapeHtml(run.project_id)}</span>
              <span class="chip">${escapeHtml(classification)}</span>
            </div>
            <div class="divider"></div>
            <div class="details">
              <div class="detail"><span class="detail-icon updated" aria-hidden="true">●</span><strong>Updated:</strong> <span>${escapeHtml(
                fmtDate(run.last_event_ts)
              )}</span></div>
              <div class="detail"><span class="detail-icon event" aria-hidden="true">◈</span><span>${escapeHtml(
                run.last_event_type ?? "-"
              )}</span></div>
              <div class="detail"><span class="detail-icon step" aria-hidden="true">→</span><span>${escapeHtml(activeStep)}</span></div>
              <div class="detail"><span class="detail-icon runtime" aria-hidden="true">⏱</span><span>${escapeHtml(
                `${fmtElapsed(run.started_at)} · ${tokens > 0 ? `${tokens} tok` : "no tokens"}`
              )}</span></div>
            </div>
            </div>
          </article>
        </a>
      `;
    })
    .join("");
}

function render() {
  renderProjectFilter();

  const filtered = state.selectedProject === "all" ? state.runs : state.runs.filter((run) => run.project_id === state.selectedProject);
  const activeRuns = filtered.filter((run) => laneForStatus(run.status) === "active");
  const failedRuns = filtered.filter((run) => laneForStatus(run.status) === "failed");
  const completedRuns = filtered.filter((run) => laneForStatus(run.status) === "completed");

  renderCardsIntoLane(activeLane, activeRuns);
  renderCardsIntoLane(failedLane, failedRuns);
  renderCardsIntoLane(completedLane, completedRuns);
  statusLine.textContent = `Loaded ${filtered.length} run${filtered.length === 1 ? "" : "s"} (${state.selectedProject}).`;
}

async function fetchRuns() {
  const response = await fetch("/api/runs");
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${response.status} ${message}`);
  }
  const data = await response.json();
  state.runs = Array.isArray(data.runs) ? data.runs : [];
  render();
}

projectFilter.addEventListener("change", () => {
  state.selectedProject = projectFilter.value;
  render();
});

refreshBtn.addEventListener("click", async () => {
  statusLine.textContent = "Refreshing runs...";
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
    // Keep current UI as-is; footer already shows last success state.
  }
}, 5000);

await fetchRuns();
