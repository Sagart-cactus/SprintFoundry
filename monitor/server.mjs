import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicV3Dir = path.join(__dirname, "public-v3");
const runsRoot = process.env.AGENTSDLC_RUNS_ROOT ?? path.join(os.tmpdir(), "sprintfoundry");

const portArgIndex = process.argv.indexOf("--port");
const portArg = portArgIndex !== -1 ? process.argv[portArgIndex + 1] : undefined;
const port = Number(portArg ?? process.env.MONITOR_PORT ?? 4310);

const LOG_KIND_TO_FILES = {
  planner_stdout: [".planner-runtime.stdout.log"],
  planner_stderr: [".planner-runtime.stderr.log"],
  // Prefer whichever runtime wrote most recently for agent logs.
  agent_stdout: [".codex-runtime.stdout.log", ".claude-runtime.stdout.log"],
  agent_stderr: [".codex-runtime.stderr.log", ".claude-runtime.stderr.log"],
  agent_result: [".agent-result.json"],
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function parseJsonLines(raw) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function safeJoin(base, ...parts) {
  const resolved = path.resolve(base, ...parts);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    throw new Error("Invalid path traversal attempt");
  }
  return resolved;
}

async function listRuns() {
  const projects = await fs.readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const runs = [];

  for (const projectDir of projects) {
    if (!projectDir.isDirectory()) continue;
    const projectId = projectDir.name;
    const projectPath = path.join(runsRoot, projectId);
    const runDirs = await fs.readdir(projectPath, { withFileTypes: true }).catch(() => []);

    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      const runId = runDir.name;
      if (!runId.startsWith("run-")) continue;
      const runPath = path.join(projectPath, runId);
      const summary = await loadRunSummary(projectId, runId, runPath);
      runs.push(summary);
    }
  }

  runs.sort((a, b) => (b.last_event_ts ?? 0) - (a.last_event_ts ?? 0));
  return runs;
}

async function readEvents(runPath) {
  const eventsPath = path.join(runPath, ".events.jsonl");
  const raw = await fs.readFile(eventsPath, "utf-8").catch(() => "");
  return parseJsonLines(raw);
}

function inferStatus(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.event_type;
    if (t === "task.completed") return "completed";
    if (t === "task.failed") return "failed";
    if (t === "human_gate.requested") return "waiting_human_review";
    if (t === "human_gate.approved" || t === "human_gate.rejected") return "executing";
    if (t === "step.started") return "executing";
    if (t === "task.plan_generated") return "planning";
    if (t === "task.created") return "pending";
  }
  return "unknown";
}

function buildStepStatus(plan, events) {
  const byStep = new Map();
  for (const step of plan?.steps ?? []) {
    byStep.set(step.step_number, {
      step_number: step.step_number,
      agent: step.agent,
      task: step.task,
      status: "pending",
      started_at: null,
      completed_at: null,
      tokens: null,
    });
  }

  for (const evt of events) {
    const data = evt?.data ?? {};
    const stepNum = data.step;
    if (typeof stepNum !== "number") continue;
    if (!byStep.has(stepNum)) {
      // Rework steps (900+) are generated dynamically and not in the original plan.
      // Materialise them from their events so they appear in the monitor.
      byStep.set(stepNum, {
        step_number: stepNum,
        agent: data.agent ?? (stepNum >= 900 ? "rework" : "unknown"),
        task: data.task ?? (stepNum >= 900 ? `Rework step ${stepNum}` : ""),
        status: "pending",
        started_at: null,
        completed_at: null,
        tokens: null,
        is_rework: stepNum >= 900,
      });
    }
    const st = byStep.get(stepNum);
    if (evt.event_type === "step.started") {
      st.status = "running";
      st.started_at = evt.timestamp ?? null;
    } else if (evt.event_type === "step.completed") {
      st.status = "completed";
      st.completed_at = evt.timestamp ?? null;
      st.tokens = data.tokens ?? null;
    } else if (evt.event_type === "step.failed") {
      st.status = "failed";
      st.completed_at = evt.timestamp ?? null;
    }
  }

  return Array.from(byStep.values()).sort((a, b) => a.step_number - b.step_number);
}

async function loadRunSummary(projectId, runId, runPath) {
  const events = await readEvents(runPath);
  const planEvent = events.find((e) => e.event_type === "task.plan_generated");
  const plan = planEvent?.data?.plan ?? null;
  const steps = buildStepStatus(plan, events);
  const last = events.at(-1);
  return {
    project_id: projectId,
    run_id: runId,
    status: inferStatus(events),
    classification: plan?.classification ?? null,
    step_count: plan?.steps?.length ?? 0,
    steps,
    started_at: events.find((e) => e.event_type === "task.created")?.timestamp ?? null,
    last_event_type: last?.event_type ?? null,
    last_event_ts: last?.timestamp ? Date.parse(last.timestamp) : null,
    workspace_path: runPath,
  };
}

async function loadRun(projectId, runId) {
  const runPath = safeJoin(runsRoot, projectId, runId);
  const summary = await loadRunSummary(projectId, runId, runPath);
  const events = await readEvents(runPath);
  const planEvent = events.find((e) => e.event_type === "task.plan_generated");
  const step_models = await loadStepModels(runPath);
  return {
    ...summary,
    plan: planEvent?.data?.plan ?? null,
    step_models,
  };
}

function extractModelNameFromDebug(payload) {
  if (!payload || typeof payload !== "object") return "";
  return (
    payload.model ||
    payload.openai_model ||
    payload.anthropic_model ||
    payload.google_model ||
    payload.selected_model ||
    payload.model_name ||
    ""
  );
}

async function loadStepModels(runPath) {
  const entries = await fs.readdir(runPath, { withFileTypes: true }).catch(() => []);
  const byStep = new Map();
  const stepPattern = /\.(?:codex|claude)-runtime\.step-(\d+)\.attempt-(\d+)\.debug\.json$/;
  const genericPattern = /\.(?:codex|claude)-runtime\.debug\.json$/;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(runPath, entry.name);
    const raw = await fs.readFile(filePath, "utf-8").catch(() => "");
    if (!raw) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!parsed) continue;

    let stepNumber = null;
    let attempt = 0;
    const stepMatch = entry.name.match(stepPattern);
    if (stepMatch) {
      stepNumber = Number(stepMatch[1]);
      attempt = Number(stepMatch[2]);
    } else if (genericPattern.test(entry.name) && typeof parsed.step_number === "number") {
      stepNumber = parsed.step_number;
      attempt = typeof parsed.step_attempt === "number" ? parsed.step_attempt : 0;
    }
    if (typeof stepNumber !== "number" || Number.isNaN(stepNumber) || Number.isNaN(attempt)) continue;

    const model = extractModelNameFromDebug(parsed);
    if (!model) continue;
    const existing = byStep.get(stepNumber);
    if (!existing || attempt >= existing.attempt) {
      byStep.set(stepNumber, { model, attempt });
    }
  }

  const out = {};
  for (const [step, value] of byStep.entries()) {
    out[String(step)] = value.model;
  }
  return out;
}

async function readStepLogText(runPath, kind, stepNumber, lines) {
  const suffix = kind === "agent_stdout" ? ".stdout.log" : ".stderr.log";
  const entries = await fs.readdir(runPath, { withFileTypes: true }).catch(() => []);
  let best = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    for (const rt of ["claude", "codex"]) {
      const prefix = `.${rt}-runtime.step-${stepNumber}.attempt-`;
      if (entry.name.startsWith(prefix) && entry.name.endsWith(suffix)) {
        const attempt = parseInt(entry.name.slice(prefix.length, -suffix.length), 10);
        if (!best || attempt >= best.attempt) {
          best = { logPath: path.join(runPath, entry.name), attempt: isNaN(attempt) ? 0 : attempt };
        }
      }
    }
  }
  if (!best) return "";
  const raw = await fs.readFile(best.logPath, "utf-8").catch(() => "");
  const allLines = raw.split("\n");
  return allLines.slice(Math.max(0, allLines.length - lines)).join("\n");
}

async function readLogText(projectId, runId, kind, lines = 400, stepNumber = null) {
  const runPath = safeJoin(runsRoot, projectId, runId);

  // Per-step log requested: read the step-specific file directly.
  if (stepNumber != null && (kind === "agent_stdout" || kind === "agent_stderr")) {
    return readStepLogText(runPath, kind, stepNumber, lines);
  }

  const files = LOG_KIND_TO_FILES[kind];
  if (!files || files.length === 0) return "";
  const candidates = await Promise.all(
    files.map(async (file) => {
      const logPath = path.join(runPath, file);
      const stat = await fs.stat(logPath).catch(() => null);
      return stat ? { logPath, mtimeMs: stat.mtimeMs } : null;
    })
  );
  const selected = candidates
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!selected) return "";
  const logPath = selected.logPath;
  const raw = await fs.readFile(logPath, "utf-8").catch(() => "");
  const allLines = raw.split("\n");
  return allLines.slice(Math.max(0, allLines.length - lines)).join("\n");
}

async function listFiles(projectId, runId, root = "") {
  const runPath = safeJoin(runsRoot, projectId, runId);
  const start = safeJoin(runPath, root || ".");
  const out = [];

  async function walk(current) {
    if (out.length >= 1000) return;
    const ents = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const ent of ents) {
      if (out.length >= 1000) return;
      const abs = path.join(current, ent.name);
      const rel = path.relative(runPath, abs).replace(/\\/g, "/");
      if (ent.isDirectory()) {
        if (rel.startsWith(".git")) continue;
        await walk(abs);
      } else {
        const stat = await fs.stat(abs).catch(() => null);
        if (!stat) continue;
        out.push({
          path: rel,
          size: stat.size,
          mtime_ms: stat.mtimeMs,
        });
      }
    }
  }

  await walk(start);
  out.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return out;
}

async function serveStatic(res, pathname, rootDir = publicV3Dir) {
  const filePath = pathname === "/" ? path.join(rootDir, "index.html") : safeJoin(rootDir, pathname.slice(1));
  const contentType = filePath.endsWith(".css")
    ? "text/css; charset=utf-8"
    : filePath.endsWith(".js")
      ? "application/javascript; charset=utf-8"
      : "text/html; charset=utf-8";
  const body = await fs.readFile(filePath, "utf-8").catch(() => null);
  if (body === null) {
    sendText(res, 404, "Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = reqUrl.pathname;

  try {
    if (pathname === "/v2" || pathname.startsWith("/v2/")) {
      // /v2 is removed. Returning 404 rather than redirecting to / so that
      // any stale bookmarks or scripts that check for a 2xx response fail
      // loudly, making it obvious the old path is gone.
      sendText(res, 404, "Not found — /v2 has been removed. Use / instead.");
      return;
    }

    if (pathname === "/v3" || pathname.startsWith("/v3/")) {
      const v3Path = pathname === "/v3" ? "/" : pathname.slice(3);
      if (v3Path === "/run") {
        await serveStatic(res, "/run.html", publicV3Dir);
        return;
      }
      await serveStatic(res, v3Path, publicV3Dir);
      return;
    }

    if (pathname === "/api/runs") {
      const runs = await listRuns();
      sendJson(res, 200, { runs, runs_root: runsRoot });
      return;
    }

    if (pathname === "/api/run") {
      const project = reqUrl.searchParams.get("project");
      const run = reqUrl.searchParams.get("run");
      if (!project || !run) {
        sendJson(res, 400, { error: "Missing project/run query params" });
        return;
      }
      const data = await loadRun(project, run);
      sendJson(res, 200, data);
      return;
    }

    if (pathname === "/api/events") {
      const project = reqUrl.searchParams.get("project");
      const run = reqUrl.searchParams.get("run");
      const limit = Number(reqUrl.searchParams.get("limit") ?? "300");
      if (!project || !run) {
        sendJson(res, 400, { error: "Missing project/run query params" });
        return;
      }
      const runPath = safeJoin(runsRoot, project, run);
      const events = await readEvents(runPath);
      sendJson(res, 200, { events: events.slice(Math.max(0, events.length - limit)) });
      return;
    }

    if (pathname === "/api/log") {
      const project = reqUrl.searchParams.get("project");
      const run = reqUrl.searchParams.get("run");
      const kind = reqUrl.searchParams.get("kind");
      const lines = Number(reqUrl.searchParams.get("lines") ?? "400");
      const stepParam = reqUrl.searchParams.get("step");
      const stepNumber = stepParam != null ? Number(stepParam) : null;
      if (!project || !run || !kind) {
        sendJson(res, 400, { error: "Missing project/run/kind query params" });
        return;
      }
      const text = await readLogText(project, run, kind, lines, Number.isFinite(stepNumber) ? stepNumber : null);
      sendText(res, 200, text);
      return;
    }

    if (pathname === "/api/files") {
      const project = reqUrl.searchParams.get("project");
      const run = reqUrl.searchParams.get("run");
      const root = reqUrl.searchParams.get("root") ?? "";
      if (!project || !run) {
        sendJson(res, 400, { error: "Missing project/run query params" });
        return;
      }
      const files = await listFiles(project, run, root);
      sendJson(res, 200, { files });
      return;
    }

    if (pathname === "/api/reviews") {
      const project = reqUrl.searchParams.get("project");
      const run = reqUrl.searchParams.get("run");
      if (!project || !run) {
        sendJson(res, 400, { error: "Missing project/run query params" });
        return;
      }
      const runPath = safeJoin(runsRoot, project, run);
      const reviewDir = path.join(runPath, ".agentsdlc", "reviews");
      const entries = await fs.readdir(reviewDir).catch(() => []);
      const reviews = [];
      for (const entry of entries) {
        if (!entry.endsWith(".pending.json")) continue;
        const raw = await fs.readFile(path.join(reviewDir, entry), "utf-8").catch(() => "");
        if (!raw) continue;
        try {
          reviews.push(JSON.parse(raw));
        } catch { /* skip malformed */ }
      }
      sendJson(res, 200, { reviews });
      return;
    }

    if (pathname === "/api/review/decide" && req.method === "POST") {
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const { project, run: runId, review_id, decision, feedback } = payload;
      if (!project || !runId || !review_id) {
        sendJson(res, 400, { error: "Missing project, run, or review_id" });
        return;
      }
      if (decision !== "approved" && decision !== "rejected") {
        sendJson(res, 400, { error: "decision must be 'approved' or 'rejected'" });
        return;
      }
      if (!/^review-\d+$/.test(review_id)) {
        sendJson(res, 400, { error: "Invalid review_id format" });
        return;
      }
      const runPath = safeJoin(runsRoot, project, runId);
      const reviewDir = path.join(runPath, ".agentsdlc", "reviews");
      await fs.mkdir(reviewDir, { recursive: true });
      const decisionPath = path.join(reviewDir, `${review_id}.decision.json`);
      await fs.writeFile(
        decisionPath,
        JSON.stringify({
          status: decision,
          reviewer_feedback: feedback ?? "",
          decided_at: new Date().toISOString(),
        }, null, 2),
        "utf-8"
      );
      sendJson(res, 200, { ok: true, path: decisionPath });
      return;
    }

    // Default route: serve the v3 UI from /
    await serveStatic(res, pathname, publicV3Dir);
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

server.on("error", (err) => {
  console.error(`[monitor] Server error: ${err.message}`);
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  const actualPort = server.address()?.port ?? port;
  console.log(`[monitor] Run Monitor listening at http://127.0.0.1:${actualPort}`);
  console.log(`[monitor] Watching runs under: ${runsRoot}`);
});
