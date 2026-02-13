const projectSelect = document.getElementById("project-select");
const runSelect = document.getElementById("run-select");
const refreshBtn = document.getElementById("refresh-btn");
const autoRefresh = document.getElementById("auto-refresh");
const planMeta = document.getElementById("plan-meta");
const stepsList = document.getElementById("steps-list");
const eventsList = document.getElementById("events-list");
const eventCount = document.getElementById("event-count");
const statusLine = document.getElementById("status-line");
const logView = document.getElementById("log-view");
const tabButtons = Array.from(document.querySelectorAll(".tab"));

let runs = [];
let selectedProject = "";
let selectedRun = "";
let selectedLogKind = "planner_stdout";

function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function badgeClass(status) {
  return `badge ${status ?? "pending"}`;
}

function shortText(text, n = 96) {
  if (!text) return "";
  return text.length > n ? `${text.slice(0, n)}...` : text;
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

function renderRuns() {
  const projects = [...new Set(runs.map((r) => r.project_id))];
  projectSelect.innerHTML = projects.map((p) => `<option value="${p}">${p}</option>`).join("");
  if (!selectedProject || !projects.includes(selectedProject)) {
    selectedProject = projects[0] ?? "";
  }
  projectSelect.value = selectedProject;

  const runsForProject = runs.filter((r) => r.project_id === selectedProject);
  runSelect.innerHTML = runsForProject
    .map((r) => `<option value="${r.run_id}">${r.run_id} (${r.status})</option>`)
    .join("");
  if (!selectedRun || !runsForProject.some((r) => r.run_id === selectedRun)) {
    selectedRun = runsForProject[0]?.run_id ?? "";
  }
  runSelect.value = selectedRun;
}

function renderPlan(runData) {
  const plan = runData.plan;
  if (!plan) {
    planMeta.textContent = "No plan found for this run.";
    stepsList.innerHTML = "";
    return;
  }
  planMeta.innerHTML = [
    `status: <strong>${runData.status}</strong>`,
    `classification: <strong>${plan.classification ?? "-"}</strong>`,
    `steps: <strong>${plan.steps?.length ?? 0}</strong>`,
    `started: <strong>${fmtTime(runData.started_at)}</strong>`,
  ].join(" | ");

  stepsList.innerHTML = (runData.steps ?? [])
    .map(
      (s) => `
      <li class="step">
        <div class="step-top">
          <span>#${s.step_number} ${s.agent}</span>
          <span class="${badgeClass(s.status)}">${s.status}</span>
        </div>
        <div class="task">${shortText(s.task, 160)}</div>
        <div class="meta">started: ${fmtTime(s.started_at)} | completed: ${fmtTime(s.completed_at)} | tokens: ${s.tokens ?? "-"}</div>
      </li>`
    )
    .join("");
}

function renderEvents(events) {
  eventCount.textContent = String(events.length);
  eventsList.innerHTML = events
    .map((e) => {
      const when = fmtTime(e.timestamp);
      const data = e.data ? shortText(JSON.stringify(e.data), 180) : "";
      return `<div class="event"><span class="t">${when}</span><strong>${e.event_type}</strong><div>${data}</div></div>`;
    })
    .join("");
}

async function loadLog() {
  if (!selectedProject || !selectedRun) return;
  const text = await fetchText(
    `/api/log?project=${encodeURIComponent(selectedProject)}&run=${encodeURIComponent(selectedRun)}&kind=${encodeURIComponent(selectedLogKind)}&lines=700`
  );
  logView.textContent = text || "(empty)";
}

async function refreshData() {
  try {
    const runData = await fetchJson(
      `/api/run?project=${encodeURIComponent(selectedProject)}&run=${encodeURIComponent(selectedRun)}`
    );
    const eventsData = await fetchJson(
      `/api/events?project=${encodeURIComponent(selectedProject)}&run=${encodeURIComponent(selectedRun)}&limit=600`
    );
    renderPlan(runData);
    renderEvents(eventsData.events ?? []);
    await loadLog();
    statusLine.textContent = `Loaded ${selectedProject}/${selectedRun} • last event ${runData.last_event_type ?? "-"}`;
  } catch (err) {
    statusLine.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function loadRuns() {
  try {
    const data = await fetchJson("/api/runs");
    runs = data.runs ?? [];
    renderRuns();
    await refreshData();
    statusLine.textContent = `${runs.length} runs loaded from ${data.runs_root}`;
  } catch (err) {
    statusLine.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

projectSelect.addEventListener("change", async () => {
  selectedProject = projectSelect.value;
  selectedRun = "";
  renderRuns();
  await refreshData();
});

runSelect.addEventListener("change", async () => {
  selectedRun = runSelect.value;
  await refreshData();
});

refreshBtn.addEventListener("click", async () => {
  await loadRuns();
});

tabButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    tabButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    selectedLogKind = btn.dataset.kind;
    await loadLog();
  });
});

setInterval(async () => {
  if (!autoRefresh.checked) return;
  await loadRuns();
}, 2000);

await loadRuns();
