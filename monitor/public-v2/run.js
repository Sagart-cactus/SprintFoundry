const runTitle = document.getElementById("run-title");
const refreshBtn = document.getElementById("refresh-btn");
const heroChips = document.getElementById("hero-chips");
const heroSummary = document.getElementById("hero-summary");
const planPanel = document.getElementById("plan-panel");
const errorPanel = document.getElementById("error-panel");
const stepsList = document.getElementById("steps-list");
const eventsList = document.getElementById("events-list");
const logView = document.getElementById("log-view");
const statusLine = document.getElementById("status-line");
const logButtons = Array.from(document.querySelectorAll(".log-kind"));

const query = new URLSearchParams(window.location.search);
const project = query.get("project") ?? "";
const run = query.get("run") ?? "";

let selectedLogKind = "agent_stdout";
let selectedStepNumber = null;
let latestRunData = null;
let latestStepMeta = new Map();
const expandedLogJsonIds = new Set();

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtDate(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function durationMs(startTs, endTs) {
  const start = startTs ? Date.parse(startTs) : NaN;
  const end = endTs ? Date.parse(endTs) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return "-";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtElapsed(startedAt) {
  if (!startedAt) return "-";
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "-";
  return fmtDuration(Date.now() - start);
}

function humanTokens(value) {
  const tokens = Number(value || 0);
  if (!tokens || Number.isNaN(tokens)) return "No Tokens";
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M Tokens`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K Tokens`;
  return `${tokens} Tokens`;
}

function shortText(text, max = 140) {
  const raw = String(text ?? "");
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}...`;
}

function fetchJson(url) {
  return fetch(url).then(async (response) => {
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} ${text}`);
    }
    return response.json();
  });
}

function fetchText(url) {
  return fetch(url).then(async (response) => {
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} ${text}`);
    }
    return response.text();
  });
}

function derivePaths(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === "string") out.push(item);
    if (item && typeof item.path === "string") out.push(item.path);
  }
  return out;
}

function eventPreview(event) {
  const data = event?.data ?? {};
  if (typeof data.message === "string") return shortText(data.message);
  if (typeof data.error === "string") return shortText(data.error);
  if (typeof data.reason === "string") return shortText(data.reason);
  if (typeof data.task === "string") return shortText(data.task);
  return "No payload";
}

function extractModelName(value) {
  if (!value || typeof value !== "object") return "";
  const direct =
    pickString(value, ["model", "model_name", "modelName", "runtime_model", "selected_model", "used_model"]) ||
    pickString(value?.metadata, ["model", "model_name", "modelName"]) ||
    pickString(value?.runtime, ["model", "model_name", "modelName"]) ||
    pickString(value?.agent, ["model", "model_name", "modelName"]);
  return direct || "";
}

function buildStepMeta(runData, events) {
  const map = new Map();
  for (const step of runData?.steps ?? []) {
    const stepModelFromRun = runData?.step_models?.[String(step.step_number)] || null;
    map.set(step.step_number, {
      errors: [],
      outputs: new Set(),
      startedAt: step.started_at ?? null,
      completedAt: step.completed_at ?? null,
      model: stepModelFromRun,
    });
  }

  for (const event of events) {
    const data = event?.data ?? {};
    const stepNumber = data.step;
    if (typeof stepNumber !== "number") continue;
    if (!map.has(stepNumber)) {
      map.set(stepNumber, { errors: [], outputs: new Set(), startedAt: null, completedAt: null, model: null });
    }
    const item = map.get(stepNumber);
    const eventType = String(event.event_type ?? "");

    if (eventType === "step.started") item.startedAt = event.timestamp ?? item.startedAt;
    if (eventType === "step.completed" || eventType === "step.failed") item.completedAt = event.timestamp ?? item.completedAt;
    const modelName = extractModelName(data);
    if (modelName) item.model = modelName;

    const outputPaths = []
      .concat(derivePaths(data.files))
      .concat(derivePaths(data.paths))
      .concat(derivePaths(data.changed_files))
      .concat(derivePaths(data.impacted_files))
      .concat(derivePaths(data.artifacts));
    outputPaths.forEach((path) => item.outputs.add(path));

    if (eventType.includes("failed") || eventType.includes("error")) {
      const errorText = data.error || data.reason || data.message || eventType;
      item.errors.push(String(errorText));
    }
  }

  return map;
}

async function loadLog(kind = selectedLogKind) {
  if (!project || !run) return;
  selectedLogKind = kind;
  logButtons.forEach((button) => button.classList.toggle("active", button.dataset.kind === kind));
  try {
    const text = await fetchText(
      `/api/log?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&kind=${encodeURIComponent(kind)}&lines=1000`
    );
    logView.innerHTML = formatLogOutput(kind, text, selectedStepNumber);
  } catch (error) {
    logView.innerHTML = '<div class="muted">(unable to load log)</div>';
    statusLine.textContent = `Log load warning: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseJsonLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJsonSafe(line))
    .filter((item) => item && typeof item === "object");
}

function pickString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function textFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item.text === "string") return item.text;
        if (item && typeof item.output_text === "string") return item.output_text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") return pickString(content, ["text", "message", "output_text"]);
  return "";
}

function getStepNumberFromItem(item) {
  if (typeof item?.step === "number") return item.step;
  if (typeof item?.step_number === "number") return item.step_number;
  if (typeof item?.data?.step === "number") return item.data.step;
  if (typeof item?.data?.step_number === "number") return item.data.step_number;
  return null;
}

function renderField(label, value) {
  if (!value) return "";
  return `<div class="log-field"><strong>${escapeHtml(label)}:</strong><div class="log-wrap">${escapeHtml(value)}</div></div>`;
}

function primaryTextForAgentOut(label, values) {
  const lower = String(label || "").toLowerCase();
  const message = String(values.message || "").trim();
  const agentMessage = String(values.agentMessage || "").trim();
  const command = String(values.command || "").trim();
  const thought = String(values.thought || "").trim();

  if (lower.includes("command")) return command || message || thought || agentMessage;
  if (lower.includes("agent message") || lower === "message") return agentMessage || message || thought || command;
  if (lower.includes("thought")) return thought || message || agentMessage || command;
  return message || agentMessage || thought || command;
}

function toTitle(text) {
  return String(text || "")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function humanEventLabel(item) {
  const nestedType = pickString(item?.item, ["type"]);
  const raw = nestedType || pickString(item, ["event_type", "type"]) || "event";
  const lower = raw.toLowerCase();
  const command = pickString(item?.item, ["command", "cmd", "tool_name"]) || pickString(item, ["command", "cmd", "tool_name"]);
  const prompt =
    pickString(item?.item, ["prompt", "instructions", "input"]) ||
    pickString(item, ["prompt", "instructions", "input"]) ||
    textFromContent(item?.item?.input) ||
    textFromContent(item.input);

  if (lower === "command_execution") return "Command executed";
  if (lower === "command_start" || lower === "command_started") return "Command started";
  if (lower === "reasoning" || lower === "thought") return "Thought";
  if (lower === "message") return "Message";
  if (lower === "error") return "Error";

  if (lower.includes("thread.started")) return "Session started";
  if (lower.includes("turn.started")) return "Turn started";
  if (lower.includes("turn.completed")) return "Turn completed";
  if (lower.includes("item.started") && command) return "Command started";
  if (lower.includes("item.completed") && command) return "Command executed";
  if (lower.includes("item.started") && prompt) return "Thought started";
  if (lower.includes("item.completed") && prompt) return "Thought completed";
  if (lower.includes("failed") || lower.includes("error")) return "Error";
  return toTitle(raw.replaceAll(/[._]+/g, " "));
}

function previewForAgentOut(item, label) {
  const nested = item?.item ?? {};
  const command = pickString(nested, ["command", "cmd", "tool_name"]) || pickString(item, ["command", "cmd", "tool_name"]);
  const thought =
    pickString(nested, ["prompt", "instructions", "input"]) ||
    pickString(item, ["prompt", "instructions", "input"]) ||
    textFromContent(nested.input) ||
    textFromContent(item.input);
  const agentMessage =
    pickString(nested, ["message", "assistant_message", "response", "output_text", "text"]) ||
    pickString(item, ["message", "assistant_message", "response", "output_text"]) ||
    textFromContent(nested.output) ||
    textFromContent(item?.output);
  const message =
    pickString(item, ["message", "summary", "reason", "error", "task"]) ||
    pickString(nested, ["text", "summary", "reason", "error", "task"]) ||
    textFromContent(nested.content) ||
    textFromContent(item?.content) ||
    textFromContent(item?.output);

  const prefersCommand = label.toLowerCase().includes("command");
  const source = prefersCommand ? command || message || thought : message || agentMessage || thought || command;
  const maxChars = 120;
  if (!source) return "";
  return source.length > maxChars ? `${source.slice(0, maxChars)}...` : source;
}

function plannerEventLabel(item) {
  const nestedType = pickString(item?.item, ["type"]);
  const raw = nestedType || pickString(item, ["event_type", "type"]) || "planner_event";
  const lower = raw.toLowerCase();
  if (lower.includes("task.plan_generated") || lower.includes("plan_generated")) return "Plan generated";
  if (lower.includes("task.plan_validated") || lower.includes("plan_validated")) return "Plan validated";
  if (lower.includes("command_execution")) return "Planner command executed";
  if (lower.includes("turn.started")) return "Planner turn started";
  if (lower.includes("item.completed")) return "Planner item completed";
  if (lower.includes("failed") || lower.includes("error")) return "Planner error";
  return toTitle(raw.replaceAll(/[._]+/g, " "));
}

function plannerEventSummary(item) {
  const data = item?.data ?? {};
  const classification = pickString(data, ["classification"]) || pickString(item, ["classification"]);
  const reasoning = pickString(data, ["reasoning"]) || pickString(item, ["reasoning"]);
  const message =
    pickString(data, ["message", "summary", "task", "reason"]) ||
    pickString(item, ["message", "summary", "task", "reason"]) ||
    textFromContent(item?.item?.content) ||
    textFromContent(item?.content);
  if (classification) return `Classification: ${classification}`;
  if (reasoning) return reasoning;
  if (message) return message;
  return "Planner event";
}

function renderAgentOut(text, stepNumber) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return '<div class="muted">(empty)</div>';

  const items = lines
    .map((line) => ({ raw: line, json: parseJsonSafe(line) }))
    .filter((item) => item.json && typeof item.json === "object");

  if (!items.length) {
    return `<pre class="log-plain">${escapeHtml(filterLogByStep(text, stepNumber))}</pre>`;
  }

  const filtered = items.filter((item) => {
    if (typeof stepNumber !== "number") return true;
    return getStepNumberFromItem(item.json) === stepNumber;
  });
  const target = filtered.length ? filtered : items;

  return `<div class="log-entries">${target
    .slice(-120)
    .map((entry, index) => {
      const item = entry.json;
      const nested = item?.item ?? {};
      const label = humanEventLabel(item);
      const step = getStepNumberFromItem(item);
      const time = pickString(item, ["timestamp", "time", "created_at"]);
      const message =
        pickString(nested, ["text", "message", "summary", "reason", "error", "task"]) ||
        pickString(item, ["message", "summary", "reason", "error", "task"]) ||
        textFromContent(nested.content) ||
        textFromContent(item.content) ||
        textFromContent(nested.output) ||
        textFromContent(item.output) ||
        "";
      const command = pickString(nested, ["command", "cmd", "tool_name"]) || pickString(item, ["command", "cmd", "tool_name"]);
      const thought =
        pickString(nested, ["prompt", "instructions", "input"]) ||
        pickString(item, ["prompt", "instructions", "input"]) ||
        textFromContent(nested.input) ||
        textFromContent(item.input);
      const agentMessage =
        pickString(nested, ["message", "assistant_message", "response", "output_text", "text"]) ||
        pickString(item, ["message", "assistant_message", "response", "output_text"]) ||
        textFromContent(nested.output) ||
        textFromContent(item?.output);
      const preview = previewForAgentOut(item, label);
      const stableItemId =
        pickString(nested, ["id"]) ||
        pickString(item, ["event_id", "id"]) ||
        `${pickString(item, ["type", "event_type"])}-${step ?? "x"}-${index}`;
      const jsonId = `log-json-${stableItemId}`;
      const prettyJson = JSON.stringify(item, null, 2);
      const primaryText = primaryTextForAgentOut(label, { message, agentMessage, command, thought });
      const displayText = preview || primaryText;
      const isCommand = label.toLowerCase().includes("command");

      return `
        <article class="log-entry">
          <button type="button" class="log-line" data-json-id="${escapeHtml(jsonId)}">
            <div class="log-head">
              <span class="log-badge">${escapeHtml(label)}</span>
              <span class="log-meta">#${escapeHtml(String(index + 1))}${step !== null ? ` · step ${escapeHtml(String(step))}` : ""}${
                time ? ` · ${escapeHtml(time)}` : ""
              }</span>
            </div>
          </button>
          ${displayText ? `<div class="log-preview${isCommand ? " log-preview-code" : ""}">${escapeHtml(displayText)}</div>` : ""}
          <pre id="${escapeHtml(jsonId)}" class="log-json" ${expandedLogJsonIds.has(jsonId) ? "" : "hidden"}>${escapeHtml(
            prettyJson
          )}</pre>
        </article>
      `;
    })
    .join("")}</div>`;
}

function findStepObject(value, stepNumber) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStepObject(item, stepNumber);
      if (found) return found;
    }
    return null;
  }

  if (
    (typeof value.step_number === "number" && value.step_number === stepNumber) ||
    (typeof value.step === "number" && value.step === stepNumber)
  ) {
    return value;
  }

  for (const child of Object.values(value)) {
    const found = findStepObject(child, stepNumber);
    if (found) return found;
  }
  return null;
}

function findPlanCandidate(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPlanCandidate(item);
      if (found) return found;
    }
    return null;
  }

  if (value.plan && typeof value.plan === "object" && Array.isArray(value.plan.steps)) {
    return value.plan;
  }
  if (Array.isArray(value.steps) && (value.classification || value.reasoning || value.plan_id)) {
    return value;
  }

  for (const child of Object.values(value)) {
    const found = findPlanCandidate(child);
    if (found) return found;
  }
  return null;
}

function filterLogByStep(text, stepNumber) {
  if (!text || typeof stepNumber !== "number") return text || "(empty)";
  const lines = text.split("\n");
  const pattern = new RegExp(`\\b(step\\s*#?\\s*${stepNumber}|\"step\"\\s*:\\s*${stepNumber}|\"step_number\"\\s*:\\s*${stepNumber})\\b`, "i");
  const filtered = lines.filter((line) => pattern.test(line));
  if (filtered.length) {
    return filtered.join("\n");
  }
  return `(No step-specific lines detected for step #${stepNumber}. Showing full log.)\n\n${text}`;
}

function formatResultJson(text, stepNumber) {
  const parsed = parseJsonSafe(text);
  if (!parsed) return text || "(empty)";
  if (typeof stepNumber !== "number") {
    return JSON.stringify(parsed, null, 2);
  }
  const stepSlice = findStepObject(parsed, stepNumber);
  if (!stepSlice) {
    return JSON.stringify(
      {
        note: `No explicit step payload found for step #${stepNumber}.`,
        full_result: parsed,
      },
      null,
      2
    );
  }
  return JSON.stringify(
    {
      selected_step: stepNumber,
      step_result: stepSlice,
    },
    null,
    2
  );
}

function formatLogOutput(kind, text, stepNumber) {
  if (kind === "agent_stdout") return renderAgentOut(text, stepNumber);
  if (kind === "agent_result") return `<pre class="log-plain">${escapeHtml(formatResultJson(text, stepNumber))}</pre>`;
  return `<pre class="log-plain">${escapeHtml(filterLogByStep(text, stepNumber))}</pre>`;
}

function totalTokens(steps) {
  return (steps ?? [])
    .map((step) => (typeof step.tokens === "number" ? step.tokens : 0))
    .reduce((sum, item) => sum + item, 0);
}

function stepDependencySummary(stepPlan, stepMeta) {
  const inputs = stepPlan?.context_inputs ?? [];
  const fromSteps = inputs.filter((item) => item?.type === "step_output" && typeof item.step_number === "number");
  if (!fromSteps.length) return "Consumes: none";

  const parts = fromSteps.map((item) => {
    const outputs = Array.from(stepMeta.get(item.step_number)?.outputs ?? []);
    if (!outputs.length) return `#${item.step_number} (no recorded outputs)`;
    return `#${item.step_number}: ${outputs.slice(0, 2).join(", ")}${outputs.length > 2 ? "..." : ""}`;
  });
  return `Consumes: ${parts.join(" | ")}`;
}

function renderSummary(runData, events) {
  const tokens = totalTokens(runData.steps);
  runTitle.textContent = `${runData.project_id}/${runData.run_id}`;
  heroChips.innerHTML = `
    <span class="chip">${escapeHtml(runData.status ?? "unknown")}</span>
    <span class="chip">${escapeHtml(runData.classification ?? "unclassified")}</span>
    <span class="chip">${escapeHtml(`${(runData.steps ?? []).length}/${runData.step_count || (runData.steps ?? []).length || 0} steps`)}</span>
    <span class="chip">${escapeHtml(humanTokens(tokens))}</span>
  `;
  heroSummary.innerHTML = `
    <div class="detail"><span class="detail-icon updated" aria-hidden="true">●</span><strong>Started:</strong><span>${escapeHtml(
      fmtDate(runData.started_at)
    )}</span></div>
    <div class="detail"><span class="detail-icon runtime" aria-hidden="true">⏱</span><strong>Elapsed:</strong><span>${escapeHtml(
      fmtElapsed(runData.started_at)
    )}</span></div>
    <div class="detail"><span class="detail-icon event" aria-hidden="true">◈</span><strong>Last event:</strong><span>${escapeHtml(
      runData.last_event_type ?? "-"
    )}</span></div>
    <div class="detail"><span class="detail-icon updated" aria-hidden="true">●</span><strong>Updated:</strong><span>${escapeHtml(
      fmtDate(runData.last_event_ts)
    )}</span></div>
    <div class="detail"><span class="detail-icon event" aria-hidden="true">◈</span><strong>Total events:</strong><span>${escapeHtml(
      String(events.length)
    )}</span></div>
  `;
}

function renderPlanAndErrors(runData, events, stepMeta) {
  const plan = runData.plan;
  const plannerItems = parseJsonLines(runData._planner_stdout_raw || "");
  const plannerPlan = plannerItems.map((item) => findPlanCandidate(item)).find(Boolean);
  const effectivePlan = plan || plannerPlan || null;
  const failedEvents = events.filter((event) => {
    const type = String(event.event_type ?? "");
    return type.includes("failed") || type.includes("error");
  });
  const plannerErrors = parseJsonLines(runData._planner_stderr_raw || "")
    .map((item) => plannerEventSummary(item))
    .filter((msg) => msg && msg !== "Planner event");

  planPanel.innerHTML = `
    <div class="detail"><strong>Plan ID:</strong><span>${escapeHtml(effectivePlan?.plan_id ?? "Not generated")}</span></div>
    <div class="detail"><strong>Classification:</strong><span>${escapeHtml(effectivePlan?.classification ?? "Not set")}</span></div>
    <div class="detail"><strong>Reasoning:</strong><span>${escapeHtml(shortText(effectivePlan?.reasoning ?? "No reasoning captured.", 260))}</span></div>
    <div class="detail"><strong>Parallel groups:</strong><span>${escapeHtml(
      Array.isArray(effectivePlan?.parallel_groups) && effectivePlan.parallel_groups.length ? JSON.stringify(effectivePlan.parallel_groups) : "None"
    )}</span></div>
    <div class="detail"><strong>Human gates:</strong><span>${escapeHtml(
      Array.isArray(effectivePlan?.human_gates) && effectivePlan.human_gates.length ? `${effectivePlan.human_gates.length}` : "None"
    )}</span></div>
    <div class="detail"><strong>Steps:</strong><span>${escapeHtml(
      Array.isArray(effectivePlan?.steps) ? String(effectivePlan.steps.length) : "0"
    )}</span></div>
    <div class="detail"><strong>Planner stream:</strong><span>${escapeHtml(
      plannerItems.length ? `${plannerItems.length} events` : "No JSON events"
    )}</span></div>
    ${
      plannerItems.length
        ? `<div class="planner-entries">${plannerItems
            .slice(-12)
            .map((item, index) => {
              const label = plannerEventLabel(item);
              const summary = shortText(plannerEventSummary(item), 180);
              const time = pickString(item, ["timestamp", "time", "created_at"]);
              const id = `planner-json-${index}`;
              return `
                <article class="planner-entry">
                  <button type="button" class="planner-line" data-planner-json-id="${escapeHtml(id)}">
                    <span class="planner-badge">${escapeHtml(label)}</span>
                    <span class="planner-meta">${escapeHtml(time || `event #${index + 1}`)}</span>
                  </button>
                  <div class="detail-sub">${escapeHtml(summary)}</div>
                  <pre id="${escapeHtml(id)}" class="planner-json" hidden>${escapeHtml(JSON.stringify(item, null, 2))}</pre>
                </article>
              `;
            })
            .join("")}</div>`
        : ""
    }
  `;

  if (!failedEvents.length && !plannerErrors.length) {
    errorPanel.innerHTML = '<div class="detail muted"><strong>Errors:</strong><span>No errors recorded yet.</span></div>';
    return;
  }

  const lines = failedEvents.slice(-6).map((event) => {
    const data = event.data ?? {};
    const step = typeof data.step === "number" ? `#${data.step}` : "-";
    const err = String(data.error || data.reason || data.message || event.event_type || "error");
    return `<div class="detail"><strong>${escapeHtml(step)}:</strong><span>${escapeHtml(shortText(err, 180))}</span></div>`;
  });
  const plannerLines = plannerErrors
    .slice(-6)
    .map((message) => `<div class="detail"><strong>planner:</strong><span>${escapeHtml(shortText(message, 180))}</span></div>`);
  errorPanel.innerHTML = lines.concat(plannerLines).join("");
}

function renderSteps(runData, stepMeta) {
  const steps = runData.steps ?? [];
  const planStepsByNum = new Map((runData.plan?.steps ?? []).map((step) => [step.step_number, step]));
  if (!steps.length) {
    stepsList.innerHTML = '<li class="detail-item muted">No plan steps found.</li>';
    return;
  }

  stepsList.innerHTML = steps
    .map((step) => {
      const status = step.status ?? "pending";
      const stepNumber = step.step_number;
      const meta = stepMeta.get(stepNumber) ?? { errors: [], outputs: new Set(), startedAt: step.started_at, completedAt: step.completed_at };
      const started = meta.startedAt ?? step.started_at;
      const completed = meta.completedAt ?? step.completed_at;
      const ranFor = fmtDuration(durationMs(started, completed));
      const startText = fmtDate(started);
      const outputs = Array.from(meta.outputs).slice(0, 2);
      const errorCount = meta.errors.length;
      const stepPlan = planStepsByNum.get(stepNumber);
      const modelName = meta.model || stepPlan?.model || "-";
      return `
        <li class="detail-item step-item ${selectedStepNumber === stepNumber ? "selected" : ""}" data-step="${escapeHtml(String(stepNumber))}">
          <div class="detail-row">
            <span class="step-pill ${escapeHtml(status)}">${escapeHtml(status)}</span>
            <strong>#${escapeHtml(String(stepNumber))} ${escapeHtml(step.agent ?? "-")}</strong>
            <span class="step-model">${escapeHtml(modelName)}</span>
          </div>
          <div class="detail-sub">${escapeHtml(step.task ?? "-")}</div>
          <div class="step-metrics">
            <span class="metric-pill"><strong>Started</strong><span>${escapeHtml(startText)}</span></span>
            <span class="metric-pill"><strong>Ran</strong><span>${escapeHtml(ranFor)}</span></span>
            <span class="metric-pill"><strong>Tokens</strong><span>${escapeHtml(humanTokens(step.tokens))}</span></span>
          </div>
          <div class="detail-sub">${escapeHtml(stepDependencySummary(stepPlan, stepMeta))}</div>
          <div class="detail-sub">Outputs: ${escapeHtml(outputs.length ? outputs.join(", ") : "None recorded")}</div>
          <div class="detail-sub">Errors: ${escapeHtml(errorCount ? String(errorCount) : "0")}</div>
        </li>
      `;
    })
    .join("");
}

function timelineStepLabel(event, runData) {
  const stepNumber = event?.data?.step;
  if (typeof stepNumber !== "number") return "system";
  const step = (runData?.steps ?? []).find((item) => item.step_number === stepNumber);
  return `step #${stepNumber}${step?.agent ? ` · ${step.agent}` : ""}`;
}

function humanTimelineEventLabel(eventType) {
  const value = String(eventType || "").toLowerCase();
  if (value === "task.plan_generated") return "Plan generated";
  if (value === "task.plan_validated") return "Plan validated";
  if (value === "step.started") return "Step started";
  if (value === "step.completed") return "Step completed";
  if (value === "step.failed") return "Step failed";
  if (value === "task.completed") return "Run completed";
  if (value === "task.failed") return "Run failed";
  return toTitle(String(eventType || "event").replaceAll(/[._]+/g, " "));
}

function timelineHeading(event, runData) {
  const eventType = String(event?.event_type || "");
  const stepNumber = event?.data?.step;
  const step = typeof stepNumber === "number" ? (runData?.steps ?? []).find((item) => item.step_number === stepNumber) : null;
  const agent = step?.agent ? toTitle(String(step.agent).replaceAll("-", " ")) : "";

  if (eventType === "step.started" && agent) return `${agent} step started`;
  if (eventType === "step.completed" && agent) return `${agent} step completed`;
  if (eventType === "step.failed" && agent) return `${agent} step failed`;
  return humanTimelineEventLabel(eventType);
}

function renderEvents(events, runData) {
  if (!events.length) {
    eventsList.innerHTML = '<li class="timeline-item muted">No events found.</li>';
    return;
  }

  // Ascending order: oldest -> newest
  const ascending = events.slice(-120);
  eventsList.innerHTML = ascending
    .map((event) => {
      const label = timelineStepLabel(event, runData);
      return `
      <li class="timeline-item">
        <div class="timeline-dot" aria-hidden="true"></div>
        <div class="timeline-card">
          <div class="timeline-top">
            <strong>${escapeHtml(timelineHeading(event, runData))}</strong>
            <span class="timeline-meta">${escapeHtml(label)}</span>
          </div>
          <div class="detail-sub">${escapeHtml(eventPreview(event))}</div>
          <div class="timeline-time">${escapeHtml(fmtDate(event.timestamp))}</div>
        </div>
      </li>
    `;
    })
    .join("");
}

stepsList.addEventListener("click", async (event) => {
  if (!latestRunData) return;
  const stepItem = event.target.closest(".step-item");
  if (!stepItem) return;
  const stepNumber = Number(stepItem.dataset.step);
  if (Number.isNaN(stepNumber)) return;
  selectedStepNumber = stepNumber;
  renderSteps(latestRunData, latestStepMeta);
  await loadLog(selectedLogKind);
  statusLine.textContent = `Loaded ${project}/${run} · filtered to step #${stepNumber}`;
});

logView.addEventListener("click", (event) => {
  const trigger = event.target.closest(".log-line");
  if (!trigger) return;
  const jsonId = trigger.dataset.jsonId;
  if (!jsonId) return;
  const jsonBlock = logView.querySelector(`#${CSS.escape(jsonId)}`);
  if (!jsonBlock) return;
  jsonBlock.hidden = !jsonBlock.hidden;
  if (jsonBlock.hidden) {
    expandedLogJsonIds.delete(jsonId);
  } else {
    expandedLogJsonIds.add(jsonId);
  }
});

planPanel.addEventListener("click", (event) => {
  const trigger = event.target.closest(".planner-line");
  if (!trigger) return;
  const jsonId = trigger.dataset.plannerJsonId;
  if (!jsonId) return;
  const jsonBlock = planPanel.querySelector(`#${CSS.escape(jsonId)}`);
  if (!jsonBlock) return;
  jsonBlock.hidden = !jsonBlock.hidden;
});

async function refresh() {
  if (!project || !run) {
    statusLine.textContent = "Missing project/run query params.";
    return;
  }

  try {
    const [runData, eventsData, plannerStdout, plannerStderr] = await Promise.all([
      fetchJson(`/api/run?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}`),
      fetchJson(`/api/events?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&limit=800`),
      fetchText(`/api/log?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&kind=planner_stdout&lines=1200`).catch(() => ""),
      fetchText(`/api/log?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&kind=planner_stderr&lines=1200`).catch(() => ""),
    ]);

    const events = eventsData.events ?? [];
    runData._planner_stdout_raw = plannerStdout;
    runData._planner_stderr_raw = plannerStderr;
    const stepMeta = buildStepMeta(runData, events);

    latestRunData = runData;
    latestStepMeta = stepMeta;

    renderSummary(runData, events);
    renderPlanAndErrors(runData, events, stepMeta);
    renderSteps(runData, stepMeta);
    renderEvents(events, runData);

    // Keep logs independent so timeline/steps always render.
    await loadLog(selectedLogKind);
    statusLine.textContent = `Loaded ${project}/${run}`;
  } catch (error) {
    statusLine.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

refreshBtn.addEventListener("click", async () => {
  statusLine.textContent = "Refreshing...";
  await refresh();
});

logButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    await loadLog(button.dataset.kind ?? "agent_stdout");
  });
});

setInterval(async () => {
  await refresh();
}, 5000);

await refresh();
