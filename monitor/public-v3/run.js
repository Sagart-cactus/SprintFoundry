const runTitle = document.getElementById("run-title");
const refreshBtn = document.getElementById("refresh-btn");
const summaryBar = document.getElementById("summary-bar");
const reviewPanel = document.getElementById("review-panel");
const planToggle = document.getElementById("plan-toggle");
const planBody = document.getElementById("plan-body");
const stepsGrid = document.getElementById("steps-grid");
const timelineList = document.getElementById("timeline-list");
const logTabs = Array.from(document.querySelectorAll(".log-tab"));
const logView = document.getElementById("log-view");
const statusLine = document.getElementById("status-line");
const lastRefreshed = document.getElementById("last-refreshed");

const query = new URLSearchParams(window.location.search);
const project = query.get("project") ?? "";
const run = query.get("run") ?? "";

const state = {
  logKind: "agent_stdout",
  selectedStep: null,
  expandedLogIds: new Set(),
  expandedPlanDetails: new Set(),
  runData: null,
  events: [],
  stepMeta: new Map(),
  plannerStdout: "",
  plannerStderr: "",
  reviews: [],
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseJsonLines(raw) {
  return String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJsonSafe(line))
    .filter((item) => item && typeof item === "object");
}

function pickString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function textFromContent(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        return pickString(item, ["text", "output_text", "message"]);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") return pickString(value, ["text", "output_text", "message"]);
  return "";
}

function fmtDate(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function fmtIso(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toISOString();
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

function durationBetween(start, end) {
  const s = Date.parse(start || "");
  const e = Date.parse(end || "");
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return Math.max(0, e - s);
}

function humanTokens(value) {
  const n = Number(value || 0);
  if (!n || Number.isNaN(n)) return "0 Tokens";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M Tokens`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K Tokens`;
  return `${n} Tokens`;
}

function relative(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return "-";
  const delta = Math.max(0, Math.floor((Date.now() - n) / 1000));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function fetchJson(url) {
  return fetch(url).then(async (res) => {
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  });
}

function fetchText(url) {
  return fetch(url).then(async (res) => {
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.text();
  });
}

function getStepNumber(item) {
  return (
    (typeof item?.step === "number" && item.step) ||
    (typeof item?.step_number === "number" && item.step_number) ||
    (typeof item?.data?.step === "number" && item.data.step) ||
    (typeof item?.data?.step_number === "number" && item.data.step_number) ||
    null
  );
}

function shortText(value, max = 110) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function eventLabel(rawType) {
  const t = String(rawType || "event").toLowerCase();
  if (t === "task.created") return "Run created";
  if (t === "task.plan_generated") return "Plan generated";
  if (t === "task.plan_validated") return "Plan validated";
  if (t === "step.started") return "Step started";
  if (t === "step.completed") return "Step completed";
  if (t === "step.failed") return "Step failed";
  if (t === "task.completed") return "Run completed";
  if (t === "task.failed") return "Run failed";
  if (t === "human_gate.requested") return "Human gate requested";
  if (t === "human_gate.approved") return "Human gate approved";
  if (t === "human_gate.rejected") return "Human gate rejected";
  return String(rawType || "event").replaceAll(/[._]/g, " ");
}

function stepHeading(event, runData) {
  const stepNum = event?.data?.step;
  if (typeof stepNum !== "number") return eventLabel(event.event_type);
  const step = (runData?.steps ?? []).find((s) => s.step_number === stepNum);
  const agent = step?.agent ? `${step.agent} ` : "";
  return `${agent}step ${stepNum} ${eventLabel(event.event_type).replace(/^Step\s/i, "").toLowerCase()}`;
}

function inferModel(value) {
  if (!value || typeof value !== "object") return "";
  return (
    pickString(value, ["model", "openai_model", "anthropic_model", "selected_model", "model_name"]) ||
    pickString(value?.metadata, ["model", "model_name"])
  );
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

function buildStepMeta(runData, events) {
  const byStep = new Map();
  for (const step of runData?.steps ?? []) {
    byStep.set(step.step_number, {
      startedAt: step.started_at || null,
      completedAt: step.completed_at || null,
      model: runData?.step_models?.[String(step.step_number)] || "",
      errors: [],
      outputs: new Set(),
    });
  }

  for (const evt of events) {
    const stepNum = evt?.data?.step;
    if (typeof stepNum !== "number") continue;
    if (!byStep.has(stepNum)) {
      byStep.set(stepNum, { startedAt: null, completedAt: null, model: "", errors: [], outputs: new Set() });
    }
    const meta = byStep.get(stepNum);
    if (evt.event_type === "step.started") meta.startedAt = evt.timestamp || meta.startedAt;
    if (evt.event_type === "step.completed" || evt.event_type === "step.failed") meta.completedAt = evt.timestamp || meta.completedAt;

    const model = inferModel(evt.data);
    if (model) meta.model = model;

    const outputs = []
      .concat(derivePaths(evt?.data?.files))
      .concat(derivePaths(evt?.data?.paths))
      .concat(derivePaths(evt?.data?.artifacts))
      .concat(derivePaths(evt?.data?.changed_files));
    outputs.forEach((o) => meta.outputs.add(o));

    if (String(evt.event_type).includes("failed") || String(evt.event_type).includes("error")) {
      meta.errors.push(String(evt?.data?.error || evt?.data?.reason || evt?.data?.message || evt.event_type));
    }
  }

  return byStep;
}

function renderSummary(runData) {
  const totalTokens = (runData.steps ?? []).reduce((sum, step) => sum + (Number(step.tokens) || 0), 0);
  runTitle.textContent = `${runData.project_id}/${runData.run_id}`;
  summaryBar.innerHTML = `
    <span class="sum-chip status ${escapeHtml(runData.status || "unknown")}">${escapeHtml(runData.status || "unknown")}</span>
    <span class="sum-chip">Project: ${escapeHtml(runData.project_id)}</span>
    <span class="sum-chip">Run: ${escapeHtml(runData.run_id)}</span>
    <span class="sum-chip">Classification: ${escapeHtml(runData.classification || "unclassified")}</span>
    <span class="sum-chip">${escapeHtml(humanTokens(totalTokens))}</span>
    <span class="sum-chip">Updated ${escapeHtml(relative(runData.last_event_ts))}</span>
  `;
}

function renderReviewPanel(reviews) {
  if (!reviews.length) {
    reviewPanel.innerHTML = "";
    return;
  }

  reviewPanel.innerHTML = reviews
    .map((review) => {
      const artifacts = Array.isArray(review.artifacts_to_review) ? review.artifacts_to_review : [];
      return `
        <div class="review-card">
          <div class="review-header">
            <span class="review-badge">Human Gate</span>
            <span class="review-meta">After step ${escapeHtml(String(review.after_step ?? "?"))} · ${escapeHtml(review.review_id || "")}</span>
          </div>
          <div class="review-summary">${escapeHtml(review.summary || "No summary provided.")}</div>
          ${artifacts.length ? `
            <details class="review-artifacts">
              <summary>Artifacts to review (${artifacts.length})</summary>
              <ul>${artifacts.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>
            </details>
          ` : ""}
          <textarea class="review-feedback" data-review-id="${escapeHtml(review.review_id)}" placeholder="Optional feedback..." rows="2"></textarea>
          <div class="review-actions">
            <button type="button" class="review-btn approve" data-review-id="${escapeHtml(review.review_id)}" data-decision="approved">Approve</button>
            <button type="button" class="review-btn reject" data-review-id="${escapeHtml(review.review_id)}" data-decision="rejected">Reject</button>
          </div>
        </div>
      `;
    })
    .join("");
}

async function submitReviewDecision(reviewId, decision) {
  const textarea = reviewPanel.querySelector(`textarea[data-review-id="${CSS.escape(reviewId)}"]`);
  const feedback = textarea?.value ?? "";
  const btn = reviewPanel.querySelector(`button[data-review-id="${CSS.escape(reviewId)}"][data-decision="${CSS.escape(decision)}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "Submitting..."; }
  try {
    const resp = await fetch("/api/review/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, run, review_id: reviewId, decision, feedback }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Unknown error" }));
      alert(`Review failed: ${err.error || "Unknown error"}`);
      return;
    }
    await refresh();
  } catch (err) {
    alert(`Review failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = decision === "approved" ? "Approve" : "Reject"; }
  }
}

reviewPanel.addEventListener("click", (event) => {
  const btn = event.target.closest(".review-btn");
  if (!btn) return;
  const reviewId = btn.dataset.reviewId;
  const decision = btn.dataset.decision;
  if (!reviewId || !decision) return;
  void submitReviewDecision(reviewId, decision);
});

function plannerItems(raw) {
  return parseJsonLines(raw).slice(-30);
}

function findPlanInPlanner(items) {
  for (const item of items) {
    if (item?.plan?.steps) return item.plan;
    if (item?.data?.plan?.steps) return item.data.plan;
    if (item?.steps && Array.isArray(item.steps)) return item;
  }
  return null;
}

function plannerFriendlyLabel(item) {
  const t = pickString(item, ["event_type", "type"]) || pickString(item?.item, ["type"]);
  return eventLabel(t || "planner.event");
}

function plannerSummary(item) {
  const msg =
    pickString(item?.data, ["message", "reasoning", "summary", "error"]) ||
    pickString(item, ["message", "reasoning", "summary", "error"]) ||
    textFromContent(item?.item?.content) ||
    textFromContent(item?.content);
  return msg || "Planner event";
}

function plannerDetailId(item, index) {
  return (
    pickString(item?.item, ["id"]) ||
    pickString(item, ["id", "event_id", "timestamp", "time"]) ||
    `planner-${index + 1}`
  );
}

function renderPlanPanel(runData, events) {
  const items = plannerItems(state.plannerStdout);
  const parsedPlan = findPlanInPlanner(items);
  const plan = runData.plan || parsedPlan;
  const failures = events.filter((e) => String(e.event_type).includes("failed") || String(e.event_type).includes("error"));
  const plannerErrLines = String(state.plannerStderr || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8);

  const stepCount = Array.isArray(plan?.steps) ? plan.steps.length : 0;

  planBody.innerHTML = `
    <div class="plan-grid">
      <div class="plan-card">
        <h3>Plan</h3>
        <p><strong>Plan ID:</strong> ${escapeHtml(plan?.plan_id || "-")}</p>
        <p><strong>Steps:</strong> ${escapeHtml(String(stepCount))}</p>
        <p><strong>Classification:</strong> ${escapeHtml(plan?.classification || runData.classification || "-")}</p>
        <details data-detail-id="plan-reasoning" ${state.expandedPlanDetails.has("plan-reasoning") ? "open" : ""}>
          <summary>Reasoning</summary>
          <pre>${escapeHtml(plan?.reasoning || "No reasoning captured")}</pre>
        </details>
      </div>
      <div class="plan-card error">
        <h3>Errors</h3>
        ${
          failures.length || plannerErrLines.length
            ? failures
                .slice(-6)
                .map(
                  (evt) => `<p><strong>${escapeHtml(eventLabel(evt.event_type))}:</strong> ${escapeHtml(shortText(evt?.data?.error || evt?.data?.reason || evt?.data?.message || "error", 140))}</p>`
                )
                .concat(plannerErrLines.map((line) => `<p><strong>Planner:</strong> ${escapeHtml(shortText(line, 140))}</p>`))
                .join("")
            : '<p>No errors recorded.</p>'
        }
      </div>
    </div>
    <div class="planner-stream">
      ${items
        .map((item, index) => {
          const id = `planner-${index}`;
          const detailId = `planner-raw-${plannerDetailId(item, index)}`;
          const time = pickString(item, ["timestamp", "time", "created_at"]);
          return `
            <article class="planner-item">
              <div class="planner-top">
                <span>${escapeHtml(plannerFriendlyLabel(item))}</span>
                <span class="mono">${escapeHtml(time || `#${index + 1}`)}</span>
              </div>
              <p>${escapeHtml(shortText(plannerSummary(item), 180))}</p>
              <details data-detail-id="${escapeHtml(detailId)}" ${state.expandedPlanDetails.has(detailId) ? "open" : ""}>
                <summary>Raw JSON</summary>
                <pre id="${escapeHtml(id)}">${escapeHtml(JSON.stringify(item, null, 2))}</pre>
              </details>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function dependencyCount(planStep) {
  const inputs = planStep?.context_inputs;
  if (!Array.isArray(inputs)) return 0;
  return inputs.filter((item) => item?.type === "step_output").length;
}

function outputsCount(meta) {
  return Array.from(meta?.outputs ?? []).length;
}

function renderSteps(runData, stepMeta) {
  const planByStep = new Map((runData.plan?.steps ?? []).map((s) => [s.step_number, s]));
  const steps = runData.steps ?? [];
  if (!steps.length) {
    stepsGrid.innerHTML = '<div class="empty">No steps found.</div>';
    return;
  }

  stepsGrid.innerHTML = steps
    .map((step) => {
      const meta = stepMeta.get(step.step_number) || { startedAt: null, completedAt: null, model: "", errors: [], outputs: new Set() };
      const started = meta.startedAt || step.started_at;
      const completed = meta.completedAt || step.completed_at;
      const ran = durationBetween(started, completed);
      const planStep = planByStep.get(step.step_number);
      const model = meta.model || planStep?.model || "-";
      const depCount = dependencyCount(planStep);
      const outCount = outputsCount(meta);
      const errCount = (meta.errors ?? []).length;
      const selected = state.selectedStep === step.step_number ? "selected" : "";

      return `
        <article class="step-card ${escapeHtml(step.status || "pending")} ${selected}" data-step="${escapeHtml(String(step.step_number))}">
          <header>
            <span class="step-status ${escapeHtml(step.status || "pending")}"></span>
            <strong>Step ${escapeHtml(String(step.step_number))} · ${escapeHtml(step.agent || "agent")}</strong>
            <span class="model-chip">${escapeHtml(model)}</span>
          </header>
          <p class="task">${escapeHtml(step.task || "-")}</p>
          <div class="chips-row">
            <span class="metric">Started ${escapeHtml(fmtDate(started))}</span>
            <span class="metric">Ran ${escapeHtml(fmtDuration(ran))}</span>
            <span class="metric">${escapeHtml(humanTokens(step.tokens))}</span>
          </div>
          <div class="chips-row">
            <span class="pill">Outputs ${escapeHtml(String(outCount))}</span>
            <span class="pill">Dependencies ${escapeHtml(String(depCount))}</span>
            <span class="pill error">Errors ${escapeHtml(String(errCount))}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function eventPreview(event) {
  return (
    pickString(event?.data, ["message", "error", "reason", "task"]) ||
    textFromContent(event?.data?.content) ||
    textFromContent(event?.data?.output) ||
    "No payload"
  );
}

function renderTimeline(events, runData) {
  const ascending = events.slice(-180);
  if (!ascending.length) {
    timelineList.innerHTML = '<li class="empty">No events</li>';
    return;
  }

  timelineList.innerHTML = ascending
    .map((evt) => {
      const stepNum = evt?.data?.step;
      const step = typeof stepNum === "number" ? (runData.steps ?? []).find((s) => s.step_number === stepNum) : null;
      const context = typeof stepNum === "number" ? `step ${stepNum}${step?.agent ? ` · ${step.agent}` : ""}` : "system";
      return `
        <li class="timeline-item">
          <span class="timeline-dot"></span>
          <div class="timeline-content">
            <div class="timeline-head">
              <strong>${escapeHtml(stepHeading(evt, runData))}</strong>
              <span>${escapeHtml(context)}</span>
            </div>
            <p>${escapeHtml(shortText(eventPreview(evt), 160))}</p>
            <code>${escapeHtml(fmtIso(evt.timestamp))}</code>
          </div>
        </li>
      `;
    })
    .join("");
}

function classifyAgentItem(item) {
  const nested = item?.item ?? {};
  const kind = pickString(nested, ["type"]) || pickString(item, ["type", "event_type"]);
  const command = pickString(nested, ["command", "cmd"]) || pickString(item, ["command", "cmd"]);
  const thought =
    pickString(nested, ["prompt", "instructions", "input"]) ||
    pickString(item, ["prompt", "instructions", "input"]) ||
    textFromContent(nested.input) ||
    textFromContent(item.input);
  const message =
    pickString(nested, ["text", "message", "assistant_message", "output_text"]) ||
    pickString(item, ["message", "assistant_message", "output_text"]) ||
    textFromContent(nested.output) ||
    textFromContent(item.output);

  const lower = String(kind).toLowerCase();
  if (lower === "command_execution" || command) {
    return { title: "Command executed", preview: shortText(command || message || thought, 130), code: true };
  }
  if (lower === "agent_message" || lower === "message") {
    return { title: "Agent message", preview: shortText(message || thought, 130), code: false };
  }
  if (lower === "thought" || lower === "reasoning") {
    return { title: "Thought", preview: shortText(thought || message, 130), code: false };
  }
  if (lower.includes("thread.started")) return { title: "Session started", preview: "", code: false };
  if (lower.includes("turn.started")) return { title: "Turn started", preview: "", code: false };
  if (lower.includes("item.completed")) return { title: "Item completed", preview: shortText(message || command || thought, 130), code: false };
  return { title: "Event", preview: shortText(message || command || thought, 130), code: false };
}

function renderAgentOut(raw, stepNumber) {
  const lines = String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return '<div class="empty">No output</div>';

  const parsed = lines.map((line) => parseJsonSafe(line)).filter((item) => item && typeof item === "object");
  const candidates = parsed.length ? parsed : [];
  const filtered = candidates.filter((item) => (typeof stepNumber === "number" ? getStepNumber(item) === stepNumber : true));
  const target = filtered.length ? filtered : candidates;

  if (!target.length) return '<div class="empty">No matching output</div>';

  return target
    .slice(-140)
    .map((item, index) => {
      const cls = classifyAgentItem(item);
      const step = getStepNumber(item);
      const id =
        pickString(item?.item, ["id"]) ||
        pickString(item, ["id", "event_id"]) ||
        `${pickString(item, ["type", "event_type"]) || "row"}-${step || "x"}-${index}`;
      const blockId = `log-json-${id}`;
      const expanded = state.expandedLogIds.has(blockId);
      return `
        <article class="log-item">
          <button class="log-row" type="button" data-json-id="${escapeHtml(blockId)}">
            <span class="title">${escapeHtml(cls.title)}</span>
            <span class="meta">#${index + 1}${step ? ` · step ${step}` : ""}</span>
          </button>
          ${cls.preview ? `<p class="preview ${cls.code ? "code" : ""}">${escapeHtml(cls.preview)}</p>` : ""}
          <pre id="${escapeHtml(blockId)}" class="json-block" ${expanded ? "" : "hidden"}>${escapeHtml(JSON.stringify(item, null, 2))}</pre>
        </article>
      `;
    })
    .join("");
}

function groupErrByStep(raw) {
  const lines = String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const map = new Map();

  for (const line of lines) {
    const parsed = parseJsonSafe(line);
    let step = null;
    let text = line;
    if (parsed) {
      step = getStepNumber(parsed);
      text =
        pickString(parsed, ["error", "message", "reason"]) ||
        pickString(parsed?.data, ["error", "message", "reason"]) ||
        textFromContent(parsed?.content) ||
        line;
    }
    const key = typeof step === "number" ? `step ${step}` : "unscoped";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(text);
  }

  return map;
}

function renderAgentErr(raw, stepNumber) {
  const grouped = groupErrByStep(raw);
  const sections = Array.from(grouped.entries()).filter(([key]) => {
    if (typeof stepNumber !== "number") return true;
    return key === `step ${stepNumber}`;
  });

  if (!sections.length) return '<div class="empty">No errors</div>';

  return sections
    .map(
      ([group, messages]) => `
      <section class="err-group">
        <h4>${escapeHtml(group)}</h4>
        ${messages.slice(-30).map((m) => `<p>${escapeHtml(shortText(m, 240))}</p>`).join("")}
      </section>
    `
    )
    .join("");
}

function renderValueTree(value, key = null, depth = 0) {
  const keyHtml = key !== null ? `<span class="json-key">${escapeHtml(String(key))}</span>: ` : "";

  if (value === null) return `<div class="tree-row">${keyHtml}<span class="json-null">null</span></div>`;
  if (typeof value === "string") return `<div class="tree-row">${keyHtml}<span class="json-string">"${escapeHtml(value)}"</span></div>`;
  if (typeof value === "number") return `<div class="tree-row">${keyHtml}<span class="json-number">${value}</span></div>`;
  if (typeof value === "boolean") return `<div class="tree-row">${keyHtml}<span class="json-bool">${value}</span></div>`;

  if (Array.isArray(value)) {
    if (!value.length) return `<div class="tree-row">${keyHtml}<span>[]</span></div>`;
    return `
      <details class="tree-node" ${depth < 2 ? "open" : ""}>
        <summary>${keyHtml}[${value.length}]</summary>
        <div class="tree-children">
          ${value.map((item, i) => renderValueTree(item, i, depth + 1)).join("")}
        </div>
      </details>
    `;
  }

  const entries = Object.entries(value);
  if (!entries.length) return `<div class="tree-row">${keyHtml}<span>{}</span></div>`;
  return `
    <details class="tree-node" ${depth < 2 ? "open" : ""}>
      <summary>${keyHtml}{${entries.length}}</summary>
      <div class="tree-children">
        ${entries.map(([k, v]) => renderValueTree(v, k, depth + 1)).join("")}
      </div>
    </details>
  `;
}

function findStepPayload(value, stepNumber) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStepPayload(item, stepNumber);
      if (found) return found;
    }
    return null;
  }
  if (value.step === stepNumber || value.step_number === stepNumber) return value;
  for (const child of Object.values(value)) {
    const found = findStepPayload(child, stepNumber);
    if (found) return found;
  }
  return null;
}

function renderResult(raw, stepNumber) {
  const parsed = parseJsonSafe(raw);
  if (!parsed) return `<pre class="json-block">${escapeHtml(raw || "(empty)")}</pre>`;
  const scoped = typeof stepNumber === "number" ? findStepPayload(parsed, stepNumber) || parsed : parsed;
  return `<div class="json-tree">${renderValueTree(scoped)}</div>`;
}

function errorCountFromErr(raw) {
  return String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function updateTabBadges(errRaw) {
  const errCount = errorCountFromErr(errRaw);
  for (const tab of logTabs) {
    const kind = tab.dataset.kind;
    if (kind === "agent_stderr") {
      tab.textContent = errCount > 0 ? `Agent Err (${errCount})` : "Agent Err";
    } else if (kind === "agent_stdout") {
      tab.textContent = "Agent Out";
    } else if (kind === "agent_result") {
      tab.textContent = "Result JSON";
    }
  }
}

async function loadLog(kind = state.logKind) {
  state.logKind = kind;
  for (const tab of logTabs) tab.classList.toggle("active", tab.dataset.kind === kind);

  const raw = await fetchText(
    `/api/log?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&kind=${encodeURIComponent(kind)}&lines=1400`
  ).catch(() => "");

  if (kind === "agent_stdout") {
    logView.innerHTML = renderAgentOut(raw, state.selectedStep);
    return;
  }
  if (kind === "agent_stderr") {
    logView.innerHTML = renderAgentErr(raw, state.selectedStep);
    return;
  }
  logView.innerHTML = renderResult(raw, state.selectedStep);
}

async function refresh() {
  if (!project || !run) {
    statusLine.textContent = "Missing project/run query params.";
    return;
  }

  try {
    const [runData, eventsRes, plannerStdout, plannerStderr, agentErrRaw] = await Promise.all([
      fetchJson(`/api/run?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}`),
      fetchJson(`/api/events?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&limit=800`),
      fetchText(`/api/log?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&kind=planner_stdout&lines=1000`).catch(() => ""),
      fetchText(`/api/log?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&kind=planner_stderr&lines=400`).catch(() => ""),
      fetchText(`/api/log?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&kind=agent_stderr&lines=1400`).catch(() => ""),
    ]);

    state.runData = runData;
    state.events = Array.isArray(eventsRes.events) ? eventsRes.events : [];
    state.plannerStdout = plannerStdout;
    state.plannerStderr = plannerStderr;
    state.stepMeta = buildStepMeta(runData, state.events);

    if (runData.status === "waiting_human_review") {
      const reviewRes = await fetchJson(`/api/reviews?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}`).catch(() => ({ reviews: [] }));
      state.reviews = Array.isArray(reviewRes.reviews) ? reviewRes.reviews : [];
    } else {
      state.reviews = [];
    }

    renderSummary(runData);
    renderReviewPanel(state.reviews);
    renderPlanPanel(runData, state.events);
    renderSteps(runData, state.stepMeta);
    renderTimeline(state.events, runData);
    updateTabBadges(agentErrRaw);

    await loadLog(state.logKind);

    statusLine.textContent = `Loaded ${project}/${run}`;
    lastRefreshed.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    statusLine.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

stepsGrid.addEventListener("click", async (event) => {
  const card = event.target.closest(".step-card");
  if (!card) return;
  const step = Number(card.dataset.step);
  if (!Number.isFinite(step)) return;
  state.selectedStep = state.selectedStep === step ? null : step;
  if (state.runData) renderSteps(state.runData, state.stepMeta);
  await loadLog(state.logKind);
});

logView.addEventListener("click", (event) => {
  const row = event.target.closest(".log-row");
  if (!row) return;
  const id = row.dataset.jsonId;
  if (!id) return;
  const block = logView.querySelector(`#${CSS.escape(id)}`);
  if (!block) return;
  block.hidden = !block.hidden;
  if (block.hidden) state.expandedLogIds.delete(id);
  else state.expandedLogIds.add(id);
});

planToggle.addEventListener("click", () => {
  const hidden = planBody.hasAttribute("hidden");
  if (hidden) {
    planBody.removeAttribute("hidden");
    planToggle.setAttribute("aria-expanded", "true");
  } else {
    planBody.setAttribute("hidden", "");
    planToggle.setAttribute("aria-expanded", "false");
  }
});

planBody.addEventListener(
  "toggle",
  (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement)) return;
    const detailId = details.dataset.detailId;
    if (!detailId) return;
    if (details.open) state.expandedPlanDetails.add(detailId);
    else state.expandedPlanDetails.delete(detailId);
  },
  true
);

refreshBtn.addEventListener("click", refresh);

for (const tab of logTabs) {
  tab.addEventListener("click", () => {
    void loadLog(tab.dataset.kind || "agent_stdout");
  });
}

setInterval(() => {
  void refresh();
}, 5000);

await refresh();
