const runTitle = document.getElementById("run-title");
const runStatusBadge = document.getElementById("run-status-badge");
const refreshBtn = document.getElementById("refresh-btn");
const reviewPanel = document.getElementById("review-panel");
const sidebarMeta = document.getElementById("sidebar-meta");
const sidebarSteps = document.getElementById("sidebar-steps");
const sidebarPlan = document.getElementById("sidebar-plan");
const runFeed = document.getElementById("run-feed");
const statusLine = document.getElementById("status-line");
const lastRefreshed = document.getElementById("last-refreshed");
const detailDrawer = document.getElementById("detail-drawer");
const detailDrawerBackdrop = document.getElementById("detail-drawer-backdrop");
const detailDrawerTitle = document.getElementById("detail-drawer-title");
const detailDrawerKicker = document.getElementById("detail-drawer-kicker");
const detailDrawerBody = document.getElementById("detail-drawer-body");
const detailDrawerClose = document.getElementById("detail-drawer-close");

const query = new URLSearchParams(window.location.search);
const project = query.get("project") ?? "";
const run = query.get("run") ?? "";

const state = {
  selectedStep: null,
  expandedLogIds: new Set(),
  expandedPlanDetails: new Set(),
  expandedFeedSections: new Set(),
  runData: null,
  events: [],
  stepMeta: new Map(),
  plannerStdout: "",
  plannerStderr: "",
  agentStdout: "",
  agentStderr: "",
  stepResults: new Map(),
  reviews: [],
  // Per-step logs: stepNumber → { stdout, stderr }
  stepLogs: new Map(),
  // Step numbers whose logs are final (completed/failed) — skip re-fetching
  completedStepNums: new Set(),
  // Track open artifact diff <details> across refreshes: "reviewId:filePath"
  expandedReviewSections: new Set(),
  // Cached diff content: "reviewId:filePath" → diff string
  artifactDiffs: new Map(),
  drawer: {
    open: false,
    step: null,
    mode: "output", // output | result
  },
};

// ── Helpers (unchanged) ──

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

function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  if (!n || Number.isNaN(n)) return "0";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
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
  if (t === "agent.token_limit_exceeded") return "Token limit exceeded";
  if (t === "agent_tool_call") return "Tool call";
  if (t === "agent_file_edit") return "File edit";
  if (t === "agent_command_run") return "Command run";
  if (t === "agent_thinking") return "Thinking";
  if (t === "step.rework_triggered") return "Rework triggered";
  return String(rawType || "event").replaceAll(/[._]/g, " ");
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
      tokenLimitExceeded: null,
      reworkEvents: [],
    });
  }

  for (const evt of events) {
    const stepNum = evt?.data?.step;
    if (typeof stepNum !== "number") continue;
    if (!byStep.has(stepNum)) {
      byStep.set(stepNum, { startedAt: null, completedAt: null, model: "", errors: [], outputs: new Set(), tokenLimitExceeded: null, reworkEvents: [] });
    }
    const meta = byStep.get(stepNum);
    if (evt.event_type === "step.started") meta.startedAt = evt.timestamp || meta.startedAt;
    if (evt.event_type === "step.completed" || evt.event_type === "step.failed") meta.completedAt = evt.timestamp || meta.completedAt;

    if (evt.event_type === "agent.token_limit_exceeded") meta.tokenLimitExceeded = evt.data ?? true;
    if (evt.event_type === "step.rework_triggered") meta.reworkEvents.push(evt.data ?? {});

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

// ── Agent log rendering helpers (reused from old code) ──

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

  // Claude SDK JSONL shape:
  // { type: "assistant", message: { content: [{ type: "thinking" | "text" | "tool_use", ... }] } }
  if (lower === "assistant" && item?.message?.content && Array.isArray(item.message.content)) {
    const content = item.message.content;
    const thinking = content.find((c) => c?.type === "thinking");
    if (thinking?.thinking) {
      return { title: "Thought", preview: shortText(thinking.thinking, 130), code: false };
    }

    const toolUse = content.find((c) => c?.type === "tool_use");
    if (toolUse) {
      const toolName = String(toolUse?.name || "");
      const input = toolUse?.input && typeof toolUse.input === "object" ? toolUse.input : {};
      const toolCmd = pickString(input, ["command", "cmd"]);
      const toolPath = pickString(input, ["file_path", "path"]);
      const toolPreview = toolCmd || toolPath || toolName || "tool call";
      const isCommandTool = /^(bash|task|taskoutput)$/i.test(toolName) || Boolean(toolCmd);
      return {
        title: isCommandTool ? "Command executed" : "Tool call",
        preview: shortText(toolPreview, 130),
        code: isCommandTool,
      };
    }

    const textBlock = content.find((c) => c?.type === "text" && typeof c?.text === "string");
    if (textBlock?.text) {
      return { title: "Agent message", preview: shortText(textBlock.text, 130), code: false };
    }
  }

  if (lower === "result") {
    const resultText = pickString(item, ["result"]);
    return { title: "Result", preview: shortText(resultText || "Run completed", 130), code: false };
  }
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

  const rows = target
    .map((item, index) => ({ item, index, cls: classifyAgentItem(item) }))
    .filter((row) => row.cls.title !== "Event");

  if (!rows.length) return '<div class="empty">No output</div>';

  return rows
    .slice(-140)
    .map(({ item, index, cls }, visibleIndex) => {
      const step = getStepNumber(item);
      const id =
        pickString(item?.item, ["id"]) ||
        pickString(item, ["id", "event_id"]) ||
        // Stable fallback: hash item content so ID doesn't shift as new output arrives
        (() => {
          const raw = JSON.stringify(item);
          let h = 0;
          for (let i = 0; i < Math.min(raw.length, 256); i++) h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
          return `${pickString(item, ["type", "event_type"]) || "row"}-${step || "x"}-${(h >>> 0).toString(16)}`;
        })();
      const blockId = `log-json-${id}`;
      const expanded = state.expandedLogIds.has(blockId);
      return `
        <article class="log-item">
          <button class="log-row" type="button" data-json-id="${escapeHtml(blockId)}">
            <span class="title">${escapeHtml(cls.title)}</span>
            <span class="meta">#${visibleIndex + 1}${step ? ` · step ${step}` : ""}</span>
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

function errorCountForStep(raw, stepNumber) {
  const grouped = groupErrByStep(raw);
  if (typeof stepNumber !== "number") {
    let total = 0;
    for (const msgs of grouped.values()) total += msgs.length;
    return total;
  }
  return (grouped.get(`step ${stepNumber}`) || []).length;
}

function agentOutCountForStep(raw, stepNumber) {
  const lines = String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = lines.map((line) => parseJsonSafe(line)).filter((item) => item && typeof item === "object");
  if (typeof stepNumber !== "number") return parsed.length;
  return parsed.filter((item) => getStepNumber(item) === stepNumber).length;
}

// ── Planner helpers ──

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

// ── Review panel ──

function renderDiff(diffText) {
  if (!diffText || !diffText.trim()) return '<div class="empty">No diff available</div>';
  const lines = diffText.split("\n");
  const html = lines.map((line) => {
    let cls = "diff-ctx";
    if (line.startsWith("+++") || line.startsWith("---")) cls = "diff-meta";
    else if (line.startsWith("@@")) cls = "diff-hunk";
    else if (line.startsWith("+")) cls = "diff-add";
    else if (line.startsWith("-")) cls = "diff-del";
    return `<div class="${cls}">${escapeHtml(line)}</div>`;
  }).join("");
  return `<div class="diff-view">${html}</div>`;
}

async function loadArtifactDiff(reviewId, filePath, detailsEl) {
  const key = `${reviewId}:${filePath}`;
  state.artifactDiffs.set(key, null); // mark as loading
  const contentEl = detailsEl?.querySelector(".diff-content");
  if (contentEl) contentEl.innerHTML = '<div class="diff-loading">Loading diff\u2026</div>';
  try {
    const res = await fetchJson(
      `/api/diff?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&file=${encodeURIComponent(filePath)}`
    );
    state.artifactDiffs.set(key, res.diff || "");
    if (contentEl) contentEl.innerHTML = renderDiff(res.diff || "");
  } catch (err) {
    state.artifactDiffs.set(key, "");
    if (contentEl) contentEl.innerHTML = `<div class="empty">Error: ${escapeHtml(String(err))}</div>`;
  }
}

function renderReviewPanel(reviews) {
  if (!reviews.length) {
    reviewPanel.innerHTML = "";
    return;
  }

  // Don't wipe the DOM while the user is interacting with the panel
  if (reviewPanel.contains(document.activeElement)) {
    return;
  }

  // Preserve feedback text across re-renders
  const savedFeedback = new Map();
  reviewPanel.querySelectorAll("textarea[data-review-id]").forEach((el) => {
    if (el.value) savedFeedback.set(el.dataset.reviewId, el.value);
  });

  reviewPanel.innerHTML = reviews
    .map((review) => {
      const artifacts = Array.isArray(review.artifacts_to_review) ? review.artifacts_to_review : [];
      const artifactItems = artifacts.map((a) => {
        const key = `${review.review_id}:${a}`;
        const isOpen = state.expandedReviewSections.has(key);
        const cached = state.artifactDiffs.get(key);
        const diffHtml = (isOpen && cached != null) ? renderDiff(cached) : '<div class="diff-loading">Loading diff\u2026</div>';
        return `
          <details class="artifact-diff-details" data-review-id="${escapeHtml(review.review_id)}" data-artifact-path="${escapeHtml(a)}" ${isOpen ? "open" : ""}>
            <summary><span class="artifact-path">${escapeHtml(a)}</span></summary>
            <div class="diff-content">${isOpen ? diffHtml : ""}</div>
          </details>
        `;
      }).join("");

      const feedback = savedFeedback.get(review.review_id) ?? "";
      return `
        <div class="review-card">
          <div class="review-header">
            <span class="review-badge">Human Gate</span>
            <span class="review-meta">After step ${escapeHtml(String(review.after_step ?? "?"))} · ${escapeHtml(review.review_id || "")}</span>
          </div>
          <div class="review-summary">${escapeHtml(review.summary || "No summary provided.")}</div>
          ${artifacts.length ? `
            <div class="review-artifacts-list">
              <div class="review-artifacts-heading">Artifacts to review (${artifacts.length})</div>
              ${artifactItems}
            </div>
          ` : ""}
          <textarea class="review-feedback" data-review-id="${escapeHtml(review.review_id)}" placeholder="Optional feedback..." rows="2">${escapeHtml(feedback)}</textarea>
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

// Track artifact diff <details> open state + lazy-load diffs
reviewPanel.addEventListener("toggle", (event) => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement)) return;
  const artifactPath = details.dataset.artifactPath;
  const reviewId = details.dataset.reviewId;
  if (!artifactPath || !reviewId) return;
  const key = `${reviewId}:${artifactPath}`;
  if (details.open) {
    state.expandedReviewSections.add(key);
    if (!state.artifactDiffs.has(key)) {
      void loadArtifactDiff(reviewId, artifactPath, details);
    }
  } else {
    state.expandedReviewSections.delete(key);
  }
}, true);

// ── NEW: Sidebar rendering ──

function renderSidebarMeta(runData) {
  const totalTokens = (runData.steps ?? []).reduce((sum, step) => sum + (Number(step.tokens) || 0), 0);
  const status = runData.status || "unknown";

  runTitle.textContent = `${runData.project_id}/${runData.run_id}`;
  runStatusBadge.className = `badge ${escapeHtml(status)}`;
  runStatusBadge.textContent = status.replace(/_/g, " ");

  sidebarMeta.innerHTML = `
    <div class="meta-list">
      <div class="meta-item">
        <span class="meta-label">Status</span>
        <span class="meta-value status-dot ${escapeHtml(status)}">${escapeHtml(status.replace(/_/g, " "))}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Tokens</span>
        <span class="meta-value">${escapeHtml(humanTokens(totalTokens))}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Updated</span>
        <span class="meta-value">${escapeHtml(relative(runData.last_event_ts))}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Classification</span>
        <span class="meta-value">${escapeHtml(runData.classification || "unclassified")}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Project</span>
        <span class="meta-value">${escapeHtml(runData.project_id)}</span>
      </div>
    </div>
  `;
}

function renderSidebarSteps(runData) {
  const steps = runData.steps ?? [];
  if (!steps.length) {
    sidebarSteps.innerHTML = '<div class="empty">No steps</div>';
    return;
  }

  sidebarSteps.innerHTML = `
    <div class="sidebar-heading">Steps</div>
    ${steps
      .map((step) => {
        const active = state.selectedStep === step.step_number ? "active" : "";
        return `
          <div class="sidebar-step ${escapeHtml(step.status || "pending")} ${active}" data-step="${escapeHtml(String(step.step_number))}">
            <span class="step-dot ${escapeHtml(step.status || "pending")}"></span>
            <span class="step-label">Step ${escapeHtml(String(step.step_number))}</span>
            <span class="step-agent">${escapeHtml(step.agent || "agent")}</span>
          </div>
        `;
      })
      .join("")}
  `;
}

function renderSidebarPlan(runData, events) {
  const items = plannerItems(state.plannerStdout);
  const parsedPlan = findPlanInPlanner(items);
  const plan = runData.plan || parsedPlan;
  const failures = events.filter((e) => String(e.event_type).includes("failed") || String(e.event_type).includes("error"));
  const plannerErrLines = String(state.plannerStderr || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8);

  const errCount = failures.length + plannerErrLines.length;
  const stepCount = Array.isArray(plan?.steps) ? plan.steps.length : 0;

  sidebarPlan.innerHTML = `
    <div class="sidebar-heading">Plan</div>
    <details class="sidebar-detail" data-detail-id="sidebar-plan-view" ${state.expandedPlanDetails.has("sidebar-plan-view") ? "open" : ""}>
      <summary>View Plan <span class="detail-count">${escapeHtml(String(stepCount))} steps</span></summary>
      <div class="sidebar-detail-body">
        <div class="meta-item"><span class="meta-label">Plan ID</span><span class="meta-value">${escapeHtml(plan?.plan_id || "-")}</span></div>
        <div class="meta-item"><span class="meta-label">Classification</span><span class="meta-value">${escapeHtml(plan?.classification || runData.classification || "-")}</span></div>
        ${plan?.reasoning ? `<p class="plan-reasoning">${escapeHtml(shortText(plan.reasoning, 300))}</p>` : ""}
      </div>
    </details>
    <details class="sidebar-detail ${errCount ? "has-errors" : ""}" data-detail-id="sidebar-plan-errors" ${state.expandedPlanDetails.has("sidebar-plan-errors") ? "open" : ""}>
      <summary>Errors <span class="detail-count">${escapeHtml(String(errCount))}</span></summary>
      <div class="sidebar-detail-body">
        ${errCount
          ? failures
              .slice(-6)
              .map((evt) => `<p class="err-line">${escapeHtml(shortText(evt?.data?.error || evt?.data?.reason || evt?.data?.message || "error", 140))}</p>`)
              .concat(plannerErrLines.map((line) => `<p class="err-line">${escapeHtml(shortText(line, 140))}</p>`))
              .join("")
          : '<p class="empty">None</p>'
        }
      </div>
    </details>
  `;
}

// ── NEW: Main feed rendering ──

function stepEventsForStep(events, stepNumber) {
  return events.filter((evt) => {
    const sn = evt?.data?.step;
    return typeof sn === "number" && sn === stepNumber;
  });
}

function stepActivitySummary(evt) {
  const type = String(evt?.event_type || "");
  const data = evt?.data || {};
  if (type === "agent_command_run") {
    return shortText(data.command || data.cmd || data.tool_name || "command", 80);
  }
  if (type === "agent_file_edit") {
    return shortText(data.path || data.file_path || data.tool_name || "file", 80);
  }
  if (type === "agent_tool_call") {
    return shortText(data.tool_name || data.name || "tool", 80);
  }
  if (type === "agent_thinking") {
    return shortText(data.text || data.kind || "thinking", 80);
  }
  return "";
}

function activityEventsForStep(events, stepNumber) {
  const set = new Set(["agent_tool_call", "agent_file_edit", "agent_command_run", "agent_thinking"]);
  return stepEventsForStep(events, stepNumber).filter((evt) => set.has(String(evt?.event_type || "")));
}

function stepByNumber(stepNumber) {
  return (state.runData?.steps ?? []).find((step) => step.step_number === stepNumber) || null;
}

async function ensureStepResult(stepNumber) {
  if (!Number.isFinite(stepNumber)) return null;
  if (state.stepResults.has(stepNumber)) return state.stepResults.get(stepNumber);
  const res = await fetchJson(
    `/api/step-result?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&step=${stepNumber}`
  ).catch(() => ({ result: null, source: "error" }));
  const payload = {
    result: res?.result && typeof res.result === "object" ? res.result : null,
    source: typeof res?.source === "string" ? res.source : "none",
  };
  state.stepResults.set(stepNumber, payload);
  return payload;
}

function stepResultSummary(step) {
  if (!step) return "";
  if (typeof step.result_summary === "string" && step.result_summary.trim()) {
    return step.result_summary.trim();
  }
  return "";
}

function closeDrawer() {
  state.drawer.open = false;
  state.drawer.step = null;
  detailDrawer.classList.remove("open");
  detailDrawer.setAttribute("aria-hidden", "true");
  detailDrawerBackdrop.hidden = true;
}

function openDrawer(mode, stepNumber) {
  state.drawer.open = true;
  state.drawer.mode = mode;
  state.drawer.step = stepNumber;
  detailDrawer.classList.add("open");
  detailDrawer.setAttribute("aria-hidden", "false");
  detailDrawerBackdrop.hidden = false;
  void renderDrawer();
}

function renderArtifactDiffDetails(stepNumber, files) {
  if (!Array.isArray(files) || !files.length) return '<p class="empty">None</p>';
  return files
    .map((filePath) => {
      const key = `step-${stepNumber}:${filePath}`;
      const cached = state.artifactDiffs.get(key);
      const isOpen = state.expandedReviewSections.has(key);
      const diffHtml = isOpen && cached != null
        ? renderDiff(cached)
        : '<div class="diff-loading">Loading diff\u2026</div>';
      return `
        <details class="artifact-diff-details" data-step="${escapeHtml(String(stepNumber))}" data-artifact-path="${escapeHtml(filePath)}" ${isOpen ? "open" : ""}>
          <summary><span class="artifact-path">${escapeHtml(filePath)}</span></summary>
          <div class="diff-content">${isOpen ? diffHtml : ""}</div>
        </details>
      `;
    })
    .join("");
}

async function loadDrawerArtifactDiff(stepNumber, filePath, detailsEl) {
  const key = `step-${stepNumber}:${filePath}`;
  state.artifactDiffs.set(key, null);
  const contentEl = detailsEl?.querySelector(".diff-content");
  if (contentEl) contentEl.innerHTML = '<div class="diff-loading">Loading diff\u2026</div>';
  try {
    const res = await fetchJson(
      `/api/diff?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&file=${encodeURIComponent(filePath)}`
    );
    state.artifactDiffs.set(key, res.diff || "");
    if (contentEl) contentEl.innerHTML = renderDiff(res.diff || "");
  } catch (err) {
    state.artifactDiffs.set(key, "");
    if (contentEl) contentEl.innerHTML = `<div class="empty">Error: ${escapeHtml(String(err))}</div>`;
  }
}

async function renderDrawer() {
  if (!state.drawer.open || !Number.isFinite(state.drawer.step)) return;
  const stepNumber = state.drawer.step;
  const step = stepByNumber(stepNumber);
  if (!step) {
    detailDrawerTitle.textContent = "Step not found";
    detailDrawerBody.innerHTML = '<p class="empty">No step data available.</p>';
    return;
  }
  detailDrawerKicker.textContent = `Step ${stepNumber} · ${step.agent || "agent"}`;

  if (state.drawer.mode === "output") {
    detailDrawerTitle.textContent = "Agent Output";
    const stepLog = state.stepLogs.get(stepNumber);
    const stepStdout = stepLog?.stdout ?? state.agentStdout;
    const stepStderr = stepLog?.stderr ?? state.agentStderr;
    const stepNumFilter = stepLog ? null : stepNumber;
    detailDrawerBody.innerHTML = `
      <section class="drawer-section">
        <h3>Output</h3>
        <div>${renderAgentOut(stepStdout, stepNumFilter)}</div>
      </section>
      <section class="drawer-section">
        <h3>Errors</h3>
        <div>${renderAgentErr(stepStderr, stepNumFilter)}</div>
      </section>
    `;
    return;
  }

  detailDrawerTitle.textContent = "Step Result";
  detailDrawerBody.innerHTML = '<p class="empty">Loading step result…</p>';
  const payload = await ensureStepResult(stepNumber);
  const result = payload?.result;
  if (!result) {
    detailDrawerBody.innerHTML = '<p class="empty">No step result found yet.</p>';
    return;
  }
  const artifactsCreated = Array.isArray(result.artifacts_created) ? result.artifacts_created : [];
  const artifactsModified = Array.isArray(result.artifacts_modified) ? result.artifacts_modified : [];
  const issues = Array.isArray(result.issues) ? result.issues : [];
  detailDrawerBody.innerHTML = `
    <section class="drawer-section">
      <h3>Summary</h3>
      <div class="result-grid">
        <div class="result-key">Status</div>
        <div class="result-value">${escapeHtml(result.status || "-")}</div>
        <div class="result-key">Source</div>
        <div class="result-value">${escapeHtml(payload?.source || "-")}</div>
        <div class="result-key">Summary</div>
        <div class="result-value">${escapeHtml(result.summary || "-")}</div>
      </div>
    </section>
    <section class="drawer-section">
      <h3>Artifacts Created (${artifactsCreated.length})</h3>
      <div>${renderArtifactDiffDetails(stepNumber, artifactsCreated)}</div>
    </section>
    <section class="drawer-section">
      <h3>Files Modified (${artifactsModified.length})</h3>
      <div>${renderArtifactDiffDetails(stepNumber, artifactsModified)}</div>
    </section>
    <section class="drawer-section">
      <h3>Issues (${issues.length})</h3>
      ${issues.length ? `<ul class="result-list">${issues.map((issue) => `<li>${escapeHtml(String(issue))}</li>`).join("")}</ul>` : '<p class="empty">None</p>'}
    </section>
    <section class="drawer-section">
      <h3>Metadata</h3>
      <div class="json-tree">${renderValueTree(result.metadata ?? {})}</div>
    </section>
  `;
}

function renderFeed(runData, events, stepMeta) {
  const steps = runData.steps ?? [];
  const planByStep = new Map((runData.plan?.steps ?? []).map((s) => [s.step_number, s]));

  const stepCards = steps
    .map((step) => {
      const meta = stepMeta.get(step.step_number) || { startedAt: null, completedAt: null, model: "", errors: [], outputs: new Set() };
      const started = meta.startedAt || step.started_at;
      const completed = meta.completedAt || step.completed_at;
      const ran = durationBetween(started, completed);
      const planStep = planByStep.get(step.step_number);
      const model = meta.model || planStep?.model || "";
      // Use per-step logs (served directly from step-specific files on the server).
      // Falls back to the shared latest log filtered by step number for backward compat.
      const stepLog = state.stepLogs.get(step.step_number);
      const stepStdout = stepLog?.stdout ?? state.agentStdout;
      const stepNumFilter = stepLog ? null : step.step_number; // null = no filter needed (content is already step-specific)

      const outCount = agentOutCountForStep(stepStdout, stepNumFilter);
      const isPending = !started && step.status !== "completed" && step.status !== "failed" && step.status !== "running";

      const summary = stepResultSummary(step);

      const tokenAlert = meta.tokenLimitExceeded
        ? `<div class="feed-alert feed-alert--token">
            <span class="feed-alert-icon">⛔</span>
            <span><strong>Token / budget limit exceeded</strong>${meta.tokenLimitExceeded.reason ? ` — ${escapeHtml(meta.tokenLimitExceeded.reason)}` : meta.tokenLimitExceeded.cost_limit ? ` — cost cap $${escapeHtml(String(meta.tokenLimitExceeded.cost_limit))} reached` : " — run halted before this step"}</span>
          </div>`
        : "";

      const reworkAlerts = meta.reworkEvents.map((r, i) =>
        `<div class="feed-alert feed-alert--rework">
          <span class="feed-alert-icon">↺</span>
          <span><strong>Rework triggered${r.rework_count != null ? ` (attempt ${escapeHtml(String(r.rework_count))})` : ""}</strong>${r.reason ? ` — ${escapeHtml(String(r.reason))}` : ""}</span>
        </div>`
      ).join("");

      const isRework = step.is_rework || step.step_number >= 900;
      return `
        <article class="feed-card ${escapeHtml(step.status || "pending")}${isRework ? " rework-step" : ""}" id="step-card-${escapeHtml(String(step.step_number))}" data-step="${escapeHtml(String(step.step_number))}">
          <header class="feed-card-header">
            <span class="step-dot ${escapeHtml(step.status || "pending")}"></span>
            <strong>Step ${escapeHtml(String(step.step_number))} · ${escapeHtml(step.agent || "agent")}</strong>
            ${isRework ? '<span class="rework-label">↺ Rework</span>' : ""}
            <div class="header-pills">
              ${model ? `<span class="header-pill model-chip">${escapeHtml(model)}</span>` : ""}
              ${ran != null ? `<span class="header-pill">${escapeHtml(fmtDuration(ran))}</span>` : ""}
              ${step.tokens ? `<span class="header-pill">${escapeHtml(humanTokens(step.tokens))} tokens</span>` : ""}
              ${meta.reworkEvents.length ? `<span class="header-pill pill--rework">↺ ${escapeHtml(String(meta.reworkEvents.length))} rework</span>` : ""}
            </div>
          </header>
          ${tokenAlert}${reworkAlerts}
          <div class="feed-block">
            <span class="feed-block-label">Input</span>
            <p class="feed-task">${escapeHtml(step.task || "-")}</p>
          </div>
          ${isPending
            ? '<p class="feed-pending">Pending...</p>'
            : `
              ${summary ? `
                <div class="feed-block">
                  <span class="feed-block-label">Output</span>
                  <p class="feed-summary">${escapeHtml(summary)}</p>
                </div>
              ` : ""}
              <div class="feed-actions">
                <button class="feed-action-btn" type="button" data-drawer-action="output" data-step="${escapeHtml(String(step.step_number))}">
                  Agent Output (${escapeHtml(String(outCount))})
                </button>
                <button class="feed-action-btn" type="button" data-drawer-action="result" data-step="${escapeHtml(String(step.step_number))}">
                  Step Result
                </button>
              </div>
            `
          }
        </article>
      `;
    })
    .join("");

  // Planner stream at the bottom
  const items = plannerItems(state.plannerStdout);
  const plannerStreamId = "feed-planner-stream";
  const plannerStream = items.length
    ? `
      <details class="feed-section planner-section" data-detail-id="${plannerStreamId}" ${state.expandedFeedSections.has(plannerStreamId) ? "open" : ""}>
        <summary>Planner Stream (${items.length})</summary>
        <div class="feed-section-body">
          <div class="planner-stream">
            ${items
              .map((item, index) => {
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
                      <pre class="json-block">${escapeHtml(JSON.stringify(item, null, 2))}</pre>
                    </details>
                  </article>
                `;
              })
              .join("")}
          </div>
        </div>
      </details>
    `
    : "";

  runFeed.innerHTML = stepCards + plannerStream;
}

// ── Per-step log fetching ──

async function fetchStepLogs(steps) {
  const toFetch = steps.filter((s) => {
    if (s.status === "pending") return false;
    if (state.completedStepNums.has(s.step_number)) return false;
    return true;
  });
  if (!toFetch.length) return;

  await Promise.all(
    toFetch.map(async (step) => {
      const base = `/api/log?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&step=${step.step_number}&lines=1400`;
      const [stdout, stderr] = await Promise.all([
        fetchText(`${base}&kind=agent_stdout`).catch(() => ""),
        fetchText(`${base}&kind=agent_stderr`).catch(() => ""),
      ]);
      state.stepLogs.set(step.step_number, { stdout, stderr });
      if (step.status === "completed" || step.status === "failed") {
        state.completedStepNums.add(step.step_number);
      }
    })
  );
}

// ── Data fetching & refresh ──

async function refresh() {
  if (!project || !run) {
    statusLine.textContent = "Missing project/run query params.";
    return;
  }

  try {
    const [runData, eventsRes, plannerStdout, plannerStderr, agentStdout, agentStderr] = await Promise.all([
      fetchJson(`/api/run?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}`),
      fetchJson(`/api/events?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&limit=800`),
      fetchText(`/api/log?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&kind=planner_stdout&lines=1000`).catch(() => ""),
      fetchText(`/api/log?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&kind=planner_stderr&lines=400`).catch(() => ""),
      fetchText(`/api/log?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&kind=agent_stdout&lines=1400`).catch(() => ""),
      fetchText(`/api/log?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&kind=agent_stderr&lines=1400`).catch(() => ""),
    ]);

    state.runData = runData;
    state.events = Array.isArray(eventsRes.events) ? eventsRes.events : [];
    state.plannerStdout = plannerStdout;
    state.plannerStderr = plannerStderr;
    state.agentStdout = agentStdout;
    state.agentStderr = agentStderr;
    state.stepMeta = buildStepMeta(runData, state.events);

    await fetchStepLogs(runData.steps ?? []);

    if (runData.status === "waiting_human_review") {
      const reviewRes = await fetchJson(`/api/reviews?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}`).catch(() => ({ reviews: [] }));
      state.reviews = Array.isArray(reviewRes.reviews) ? reviewRes.reviews : [];
    } else {
      state.reviews = [];
    }

    // Snapshot scroll positions before wiping innerHTML
    const savedWindowScrollY = window.scrollY;
    const savedSectionScrolls = new Map();
    runFeed.querySelectorAll("details[data-detail-id]").forEach((el) => {
      if (!(el instanceof HTMLDetailsElement) || !el.open) return;
      const body = el.querySelector(".feed-section-body");
      if (body && body.scrollTop > 0) {
        savedSectionScrolls.set(el.dataset.detailId, body.scrollTop);
      }
    });

    renderSidebarMeta(runData);
    renderSidebarSteps(runData);
    renderSidebarPlan(runData, state.events);
    renderReviewPanel(state.reviews);
    renderFeed(runData, state.events, state.stepMeta);
    if (state.drawer.open) {
      void renderDrawer();
    }

    // Restore scroll positions after DOM has been repainted
    requestAnimationFrame(() => {
      window.scrollTo(0, savedWindowScrollY);
      if (savedSectionScrolls.size > 0) {
        runFeed.querySelectorAll("details[data-detail-id]").forEach((el) => {
          if (!(el instanceof HTMLDetailsElement) || !el.open) return;
          const saved = savedSectionScrolls.get(el.dataset.detailId);
          if (saved != null) {
            const body = el.querySelector(".feed-section-body");
            if (body) body.scrollTop = saved;
          }
        });
      }
    });

    statusLine.textContent = `Loaded ${project}/${run}`;
    lastRefreshed.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    statusLine.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── Event listeners ──

// Sidebar step click → scroll to step card in feed
sidebarSteps.addEventListener("click", (event) => {
  const el = event.target.closest(".sidebar-step");
  if (!el) return;
  const step = Number(el.dataset.step);
  if (!Number.isFinite(step)) return;
  state.selectedStep = state.selectedStep === step ? null : step;
  if (state.runData) renderSidebarSteps(state.runData);
  const card = document.getElementById(`step-card-${step}`);
  if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
});

runFeed.addEventListener("click", (event) => {
  const actionBtn = event.target.closest("[data-drawer-action]");
  if (!actionBtn) return;
  const mode = actionBtn.dataset.drawerAction;
  const stepNumber = Number(actionBtn.dataset.step);
  if (!Number.isFinite(stepNumber)) return;
  if (mode === "output" || mode === "result") {
    openDrawer(mode, stepNumber);
  }
});

// Toggle JSON blocks in agent output
runFeed.addEventListener("click", (event) => {
  const row = event.target.closest(".log-row");
  if (!row) return;
  const id = row.dataset.jsonId;
  if (!id) return;
  const block = runFeed.querySelector(`#${CSS.escape(id)}`);
  if (!block) return;
  block.hidden = !block.hidden;
  if (block.hidden) state.expandedLogIds.delete(id);
  else state.expandedLogIds.add(id);
});

// Track expanded <details> in feed to preserve across refresh
runFeed.addEventListener(
  "toggle",
  (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement)) return;
    const detailId = details.dataset.detailId;
    if (!detailId) return;
    if (details.open) state.expandedFeedSections.add(detailId);
    else state.expandedFeedSections.delete(detailId);
  },
  true
);

// Track expanded <details> in sidebar plan
sidebarPlan.addEventListener(
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

detailDrawer.addEventListener("toggle", (event) => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement)) return;
  const artifactPath = details.dataset.artifactPath;
  const step = Number(details.dataset.step);
  if (!artifactPath || !Number.isFinite(step)) return;
  const key = `step-${step}:${artifactPath}`;
  if (details.open) {
    state.expandedReviewSections.add(key);
    if (!state.artifactDiffs.has(key)) {
      void loadDrawerArtifactDiff(step, artifactPath, details);
    }
  } else {
    state.expandedReviewSections.delete(key);
  }
}, true);

detailDrawerBackdrop.addEventListener("click", closeDrawer);
detailDrawerClose.addEventListener("click", closeDrawer);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.drawer.open) {
    closeDrawer();
  }
});

refreshBtn.addEventListener("click", refresh);

setInterval(() => {
  void refresh();
}, 5000);

await refresh();
