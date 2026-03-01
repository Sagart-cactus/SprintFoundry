import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { promises as fs, watchFile, unwatchFile, statSync, openSync, readSync, closeSync } from "node:fs";
import { execFile } from "node:child_process";
import { parse as parseYaml } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicV3Dir = path.join(__dirname, "public-v3");
const repoRoot = path.resolve(__dirname, "..");
const runsRoot = process.env.SPRINTFOUNDRY_RUNS_ROOT ?? process.env.AGENTSDLC_RUNS_ROOT ?? path.join(os.tmpdir(), "sprintfoundry");
const sessionsRoot = process.env.SPRINTFOUNDRY_SESSIONS_DIR ?? path.join(os.homedir(), ".sprintfoundry", "sessions");
const configRoot = process.env.SPRINTFOUNDRY_CONFIG_DIR ?? path.join(repoRoot, "config");
const autoexecuteDryRun = process.env.SPRINTFOUNDRY_AUTORUN_DRY_RUN === "1";

const portArgIndex = process.argv.indexOf("--port");
const portArg = portArgIndex !== -1 ? process.argv[portArgIndex + 1] : undefined;
const port = Number(portArg ?? process.env.MONITOR_PORT ?? 4310);
const webhookPortEnv = process.env.SPRINTFOUNDRY_WEBHOOK_PORT;
const webhookPortCandidate = Number(webhookPortEnv ?? "");
const webhookSplitEnabled = Number.isFinite(webhookPortCandidate) && webhookPortCandidate > 0 && webhookPortCandidate !== port;
const webhookPort = webhookSplitEnabled ? webhookPortCandidate : port;

let autoexecuteCache = { loadedAt: 0, projects: [] };
let projectRepoUrlCache = { loadedAt: 0, byProjectId: new Map() };
let workspaceRepoUrlCache = { loadedAt: 0, byWorkspacePath: new Map() };
const autoexecuteQueue = [];
const autoexecuteHistory = [];
let autoexecuteRunning = false;
const autoexecuteSeen = new Map();

const LOG_KIND_TO_FILES = {
  planner_stdout: [".planner-runtime.stdout.log"],
  planner_stderr: [".planner-runtime.stderr.log"],
  // Prefer whichever runtime wrote most recently for agent logs.
  agent_stdout: [".codex-runtime.stdout.log", ".claude-runtime.stdout.log"],
  agent_stderr: [".codex-runtime.stderr.log", ".claude-runtime.stderr.log"],
  agent_result: [".agent-result.json"],
};

function parseResultJson(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readStepResult(runPath, stepNumber, maxCompletedStep = null) {
  const resultsDir = path.join(runPath, ".sprintfoundry", "step-results");
  const resultPattern = new RegExp(`^step-${stepNumber}\\.attempt-(\\d+)\\.[^.]+\\.json$`);
  const resultEntries = await fs.readdir(resultsDir, { withFileTypes: true }).catch(() => []);
  let bestSnapshot = null;
  for (const entry of resultEntries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(resultPattern);
    if (!match) continue;
    const attempt = Number(match[1]);
    if (!bestSnapshot || attempt >= bestSnapshot.attempt) {
      bestSnapshot = {
        path: path.join(resultsDir, entry.name),
        attempt: Number.isFinite(attempt) ? attempt : 0,
      };
    }
  }
  if (bestSnapshot) {
    const raw = await fs.readFile(bestSnapshot.path, "utf-8").catch(() => "");
    const parsed = parseResultJson(raw);
    if (parsed) {
      return {
        result: parsed,
        source: "step_snapshot",
      };
    }
  }

  const contextDir = path.join(runPath, ".agent-context");
  const contextEntries = await fs.readdir(contextDir, { withFileTypes: true }).catch(() => []);
  const contextMatches = contextEntries
    .filter((entry) => entry.isFile() && entry.name.startsWith(`step-${stepNumber}-`) && entry.name.endsWith(".json"))
    .map((entry) => entry.name);
  if (contextMatches.length > 0) {
    const bestContextFile = contextMatches.sort().at(-1);
    if (bestContextFile) {
      const raw = await fs.readFile(path.join(contextDir, bestContextFile), "utf-8").catch(() => "");
      const parsed = parseResultJson(raw);
      if (parsed) {
        return {
          result: parsed,
          source: "agent_context",
        };
      }
    }
  }

  // Only use .agent-result.json for the latest completed step; for older steps this would be stale.
  if (maxCompletedStep != null && stepNumber === maxCompletedStep) {
    const latestRaw = await fs.readFile(path.join(runPath, ".agent-result.json"), "utf-8").catch(() => "");
    const latestParsed = parseResultJson(latestRaw);
    if (latestParsed) {
      return {
        result: latestParsed,
        source: "latest_agent_result",
      };
    }
  }

  return { result: null, source: "none" };
}

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

function interpolateEnvVars(raw) {
  return raw.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

async function loadYamlFile(filePath) {
  const raw = await fs.readFile(filePath, "utf-8");
  return parseYaml(interpolateEnvVars(raw));
}

function projectArgFromFileName(fileName) {
  if (fileName === "project.yaml") return null;
  const match = fileName.match(/^project-(.+)\.ya?ml$/);
  if (!match) return null;
  return match[1];
}

function normalizeRepoUrlForDisplay(rawUrl) {
  const input = String(rawUrl ?? "").trim();
  if (!input) return null;

  const sshMatch = input.match(/^git@([^:]+):(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`.replace(/\/+$/, "");
  }

  const sshUrlMatch = input.match(/^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshUrlMatch) {
    return `https://${sshUrlMatch[1]}/${sshUrlMatch[2]}`.replace(/\/+$/, "");
  }

  try {
    const parsed = new URL(input);
    parsed.username = "";
    parsed.password = "";
    const cleanPath = parsed.pathname.replace(/\.git$/i, "").replace(/\/+$/, "");
    parsed.pathname = cleanPath;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return input;
  }
}

async function loadProjectRepoUrlMap() {
  const now = Date.now();
  if (now - projectRepoUrlCache.loadedAt < 15_000) {
    return projectRepoUrlCache.byProjectId;
  }

  const entries = await fs.readdir(configRoot, { withFileTypes: true }).catch(() => []);
  const projectFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name === "project.yaml" || /^project-.+\.ya?ml$/.test(name))
    .sort();

  const byProjectId = new Map();
  for (const fileName of projectFiles) {
    const filePath = path.join(configRoot, fileName);
    let project;
    try {
      project = await loadYamlFile(filePath);
    } catch {
      continue;
    }
    const projectId = String(project?.project_id ?? "").trim();
    const repoUrlRaw = String(project?.repo?.url ?? "").trim();
    const repoUrl = normalizeRepoUrlForDisplay(repoUrlRaw);
    if (!projectId || !repoUrl) continue;
    byProjectId.set(projectId, repoUrl);
  }

  projectRepoUrlCache = { loadedAt: now, byProjectId };
  return byProjectId;
}

async function getProjectRepoUrl(projectId) {
  const map = await loadProjectRepoUrlMap();
  return map.get(projectId) ?? null;
}

async function getWorkspaceRepoUrl(runPath) {
  const now = Date.now();
  const cached = workspaceRepoUrlCache.byWorkspacePath.get(runPath);
  if (cached && now - cached.loadedAt < 60_000) {
    return cached.repoUrl;
  }

  const repoUrl = await new Promise((resolve) => {
    execFile(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: runPath, timeout: 1500, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const normalized = normalizeRepoUrlForDisplay(String(stdout ?? "").trim());
        resolve(normalized);
      }
    );
  });

  workspaceRepoUrlCache.byWorkspacePath.set(runPath, { loadedAt: now, repoUrl });
  return repoUrl;
}

function normalizeGitHubAutoexecuteConfig(raw) {
  const github = raw?.autoexecute?.github ?? {};
  const topEnabled = raw?.autoexecute?.enabled;
  const enabled = (github.enabled ?? topEnabled) === true;
  const allowedEvents = Array.isArray(github.allowed_events) && github.allowed_events.length
    ? github.allowed_events.map((v) => String(v))
    : ["issues.opened", "issues.labeled", "issue_comment.created"];
  return {
    enabled,
    webhookSecret: String(github.webhook_secret ?? "").trim(),
    allowedEvents: new Set(allowedEvents),
    labelTrigger: String(github.label_trigger ?? "sf:auto-run"),
    commandTrigger: String(github.command_trigger ?? "/sf-run"),
    requireCommand: github.require_command === true,
    dedupeWindowMinutes: Number(github.dedupe_window_minutes ?? 30),
  };
}

function normalizeLinearAutoexecuteConfig(raw) {
  const linear = raw?.autoexecute?.linear ?? {};
  const topEnabled = raw?.autoexecute?.enabled;
  const enabled = (linear.enabled ?? topEnabled) === true;
  const allowedEvents = Array.isArray(linear.allowed_events) && linear.allowed_events.length
    ? linear.allowed_events.map((v) => String(v))
    : ["Issue.create"];
  return {
    enabled,
    webhookSecret: String(linear.webhook_secret ?? "").trim(),
    allowedEvents: new Set(allowedEvents),
    commandTrigger: String(linear.command_trigger ?? "/sf-run"),
    requireCommand: linear.require_command === true,
    dedupeWindowMinutes: Number(linear.dedupe_window_minutes ?? 30),
    maxTimestampAgeSeconds: Number(linear.max_timestamp_age_seconds ?? 120),
  };
}

async function loadAutoexecuteProjects() {
  const now = Date.now();
  if (now - autoexecuteCache.loadedAt < 15_000) {
    return autoexecuteCache.projects;
  }

  const entries = await fs.readdir(configRoot, { withFileTypes: true }).catch(() => []);
  const projectFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name === "project.yaml" || /^project-.+\.ya?ml$/.test(name))
    .sort();

  const projects = [];
  for (const fileName of projectFiles) {
    const filePath = path.join(configRoot, fileName);
    let project;
    try {
      project = await loadYamlFile(filePath);
    } catch {
      continue;
    }

    const ticketSource = project?.integrations?.ticket_source;
    const sourceType = String(ticketSource?.type ?? "");
    if (sourceType === "github") {
      const owner = String(ticketSource?.config?.owner ?? "").trim();
      const repo = String(ticketSource?.config?.repo ?? "").trim();
      if (!owner || !repo) continue;

      const autoCfg = normalizeGitHubAutoexecuteConfig(project);
      if (!autoCfg.enabled) continue;

      projects.push({
        fileName,
        projectId: String(project.project_id ?? ""),
        projectArg: projectArgFromFileName(fileName),
        provider: "github",
        owner: owner.toLowerCase(),
        repo: repo.toLowerCase(),
        autoCfg,
      });
      continue;
    }

    if (sourceType === "linear") {
      const autoCfg = normalizeLinearAutoexecuteConfig(project);
      if (!autoCfg.enabled) continue;

      const teamId = String(ticketSource?.config?.team_id ?? "").trim().toLowerCase();
      const teamKey = String(ticketSource?.config?.team_key ?? "").trim().toLowerCase();
      projects.push({
        fileName,
        projectId: String(project.project_id ?? ""),
        projectArg: projectArgFromFileName(fileName),
        provider: "linear",
        teamId,
        teamKey,
        autoCfg,
      });
    }
  }

  autoexecuteCache = { loadedAt: now, projects };
  return projects;
}

function findAutoexecuteProject(owner, repo, projects) {
  const ownerNorm = String(owner ?? "").toLowerCase();
  const repoNorm = String(repo ?? "").toLowerCase();
  return projects.find(
    (project) => project.provider === "github" && project.owner === ownerNorm && project.repo === repoNorm
  ) ?? null;
}

function findLinearAutoexecuteProject(payload, projects) {
  const linearProjects = projects.filter((project) => project.provider === "linear");
  if (linearProjects.length === 0) return null;

  const data = payload?.data ?? {};
  const identifier = String(data?.identifier ?? data?.issue?.identifier ?? "");
  const identifierPrefix = identifier.includes("-")
    ? identifier.split("-")[0].toLowerCase()
    : "";
  const candidates = new Set([
    String(data?.teamId ?? "").toLowerCase(),
    String(data?.team?.id ?? "").toLowerCase(),
    String(data?.team?.key ?? "").toLowerCase(),
    identifierPrefix,
  ].filter(Boolean));

  const matches = linearProjects.filter((project) => {
    if (!project.teamId && !project.teamKey) return true;
    if (project.teamId && candidates.has(project.teamId)) return true;
    if (project.teamKey && candidates.has(project.teamKey)) return true;
    return false;
  });

  return matches[0] ?? null;
}

function verifyGitHubSignature(rawBody, signatureHeader, secret) {
  if (!secret) return false;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuf = Buffer.from(expected, "utf-8");
  const providedBuf = Buffer.from(signatureHeader, "utf-8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function verifyLinearSignature(rawBody, signatureHeader, secret) {
  if (!secret) return false;
  const provided = String(signatureHeader ?? "").trim();
  if (!provided) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf-8");
  const providedBuf = Buffer.from(provided, "utf-8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function extractGitHubTrigger(payload, event, action, config) {
  const issue = payload?.issue;
  if (!issue || typeof issue !== "object") return { allowed: false, reason: "missing_issue" };
  if (issue.pull_request) return { allowed: false, reason: "pull_request_issue_ignored" };

  const normalizedEvent = `${event}.${action}`;
  if (!config.allowedEvents.has(normalizedEvent)) {
    return { allowed: false, reason: `event_not_allowed:${normalizedEvent}` };
  }

  if (event === "issues" && action === "opened") {
    if (config.requireCommand) {
      return { allowed: false, reason: "command_required" };
    }
    return { allowed: true, ticketId: String(issue.number) };
  }

  if (event === "issues" && action === "labeled") {
    const labelName = String(payload?.label?.name ?? "");
    if (!labelName || labelName !== config.labelTrigger) {
      return { allowed: false, reason: "label_trigger_not_matched" };
    }
    return { allowed: true, ticketId: String(issue.number) };
  }

  if (event === "issue_comment" && action === "created") {
    const body = String(payload?.comment?.body ?? "");
    if (!body.includes(config.commandTrigger)) {
      return { allowed: false, reason: "command_not_found" };
    }
    return { allowed: true, ticketId: String(issue.number) };
  }

  return { allowed: false, reason: "unsupported_action" };
}

function extractLinearTrigger(payload, config) {
  const type = String(payload?.type ?? "");
  const action = String(payload?.action ?? "");
  const normalizedEvent = `${type}.${action}`;
  if (!config.allowedEvents.has(normalizedEvent)) {
    return { allowed: false, reason: `event_not_allowed:${normalizedEvent}` };
  }

  const data = payload?.data ?? {};
  const issueIdentifier = String(data?.identifier ?? data?.issue?.identifier ?? "");
  const issueIdFallback = String(data?.id ?? data?.issueId ?? data?.issue?.id ?? "");
  const ticketId = issueIdentifier || issueIdFallback;
  if (!ticketId) return { allowed: false, reason: "missing_ticket_identifier" };

  if (type === "Comment" && action === "create") {
    const body = String(data?.body ?? "");
    if (!body.includes(config.commandTrigger)) {
      return { allowed: false, reason: "command_not_found" };
    }
    return { allowed: true, ticketId };
  }

  if (config.requireCommand) {
    return { allowed: false, reason: "command_required" };
  }

  return { allowed: true, ticketId };
}

function shouldDedupeRun(dedupeKey, dedupeWindowMinutes) {
  const now = Date.now();
  const windowMs = Math.max(1, dedupeWindowMinutes) * 60_000;
  const prev = autoexecuteSeen.get(dedupeKey);
  if (prev && now - prev < windowMs) return true;
  autoexecuteSeen.set(dedupeKey, now);

  for (const [key, seenAt] of autoexecuteSeen.entries()) {
    if (now - seenAt > windowMs * 2) {
      autoexecuteSeen.delete(key);
    }
  }
  return false;
}

function enqueueAutoexecuteTask(task) {
  autoexecuteQueue.push(task);
  void processAutoexecuteQueue();
}

async function executeAutoexecuteTask(task) {
  const args = ["dev", "--", "run", "--source", task.source, "--ticket", task.ticketId, "--config", configRoot];
  if (task.projectArg) {
    args.push("--project", task.projectArg);
  }

  if (autoexecuteDryRun) {
    autoexecuteHistory.push({
      ts: new Date().toISOString(),
      status: "dry_run",
      task,
      command: `pnpm ${args.join(" ")}`,
    });
    return;
  }

  await new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      SPRINTFOUNDRY_TRIGGER_SOURCE: task.source === "linear" ? "linear_webhook" : "github_webhook",
    };
    execFile("pnpm", args, { cwd: repoRoot, env: childEnv, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      autoexecuteHistory.push({
        ts: new Date().toISOString(),
        status: err ? "failed" : "completed",
        task,
        stdout: String(stdout ?? "").slice(-4000),
        stderr: String(stderr ?? "").slice(-4000),
      });
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function processAutoexecuteQueue() {
  if (autoexecuteRunning) return;
  autoexecuteRunning = true;
  try {
    while (autoexecuteQueue.length > 0) {
      const task = autoexecuteQueue.shift();
      if (!task) continue;
      try {
        await executeAutoexecuteTask(task);
      } catch (err) {
        autoexecuteHistory.push({
          ts: new Date().toISOString(),
          status: "failed",
          task,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    autoexecuteRunning = false;
  }
}

async function handleGitHubWebhookRequest(req, res) {
  const rawBody = await readBody(req);
  const signature = String(req.headers["x-hub-signature-256"] ?? "");
  const delivery = String(req.headers["x-github-delivery"] ?? "");
  const event = String(req.headers["x-github-event"] ?? "");

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const owner = payload?.repository?.owner?.login;
  const repo = payload?.repository?.name;
  if (!owner || !repo) {
    sendJson(res, 400, { error: "Missing repository owner/name in payload" });
    return;
  }

  const projects = await loadAutoexecuteProjects();
  const matched = findAutoexecuteProject(owner, repo, projects);
  if (!matched) {
    sendJson(res, 202, {
      accepted: false,
      ignored: true,
      reason: "no_matching_project",
      owner: String(owner),
      repo: String(repo),
    });
    return;
  }

  if (!matched.autoCfg.webhookSecret) {
    sendJson(res, 403, {
      accepted: false,
      error: "Webhook secret not configured for matched project",
      project_id: matched.projectId,
    });
    return;
  }

  if (!verifyGitHubSignature(rawBody, signature, matched.autoCfg.webhookSecret)) {
    sendJson(res, 401, { accepted: false, error: "Invalid webhook signature" });
    return;
  }

  const action = String(payload?.action ?? "");
  const trigger = extractGitHubTrigger(payload, event, action, matched.autoCfg);
  if (!trigger.allowed) {
    sendJson(res, 202, {
      accepted: false,
      ignored: true,
      reason: trigger.reason,
      project_id: matched.projectId,
      event,
      action,
    });
    return;
  }

  const dedupeKey = delivery
    ? `${matched.projectId}:${delivery}`
    : `${matched.projectId}:${event}:${action}:${trigger.ticketId}:${payload?.issue?.updated_at ?? payload?.comment?.updated_at ?? ""}`;
  if (shouldDedupeRun(dedupeKey, matched.autoCfg.dedupeWindowMinutes)) {
    sendJson(res, 202, {
      accepted: false,
      ignored: true,
      reason: "duplicate_event",
      project_id: matched.projectId,
      ticket_id: trigger.ticketId,
    });
    return;
  }

  enqueueAutoexecuteTask({
    projectId: matched.projectId,
    projectArg: matched.projectArg,
    ticketId: trigger.ticketId,
    source: "github",
    owner: matched.owner,
    repo: matched.repo,
    event,
    action,
    delivery,
  });

  sendJson(res, 202, {
    accepted: true,
    queued: true,
    queue_depth: autoexecuteQueue.length,
    project_id: matched.projectId,
    ticket_id: trigger.ticketId,
    dry_run: autoexecuteDryRun,
  });
}

async function handleLinearWebhookRequest(req, res) {
  const rawBody = await readBody(req);
  const signature = String(req.headers["linear-signature"] ?? "");

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const projects = await loadAutoexecuteProjects();
  const matched = findLinearAutoexecuteProject(payload, projects);
  if (!matched) {
    sendJson(res, 202, {
      accepted: false,
      ignored: true,
      reason: "no_matching_project",
      type: String(payload?.type ?? ""),
      action: String(payload?.action ?? ""),
    });
    return;
  }

  if (!matched.autoCfg.webhookSecret) {
    sendJson(res, 403, {
      accepted: false,
      error: "Webhook secret not configured for matched project",
      project_id: matched.projectId,
    });
    return;
  }

  if (!verifyLinearSignature(rawBody, signature, matched.autoCfg.webhookSecret)) {
    sendJson(res, 401, { accepted: false, error: "Invalid webhook signature" });
    return;
  }

  const webhookTimestamp = Number(payload?.webhookTimestamp ?? NaN);
  if (Number.isFinite(webhookTimestamp) && matched.autoCfg.maxTimestampAgeSeconds > 0) {
    const ageSeconds = Math.abs(Date.now() - webhookTimestamp) / 1000;
    if (ageSeconds > matched.autoCfg.maxTimestampAgeSeconds) {
      sendJson(res, 401, { accepted: false, error: "Webhook timestamp outside accepted window" });
      return;
    }
  }

  const trigger = extractLinearTrigger(payload, matched.autoCfg);
  if (!trigger.allowed) {
    sendJson(res, 202, {
      accepted: false,
      ignored: true,
      reason: trigger.reason,
      project_id: matched.projectId,
      type: String(payload?.type ?? ""),
      action: String(payload?.action ?? ""),
    });
    return;
  }

  const delivery = String(payload?.webhookId ?? "");
  const dedupeKey = delivery
    ? `${matched.projectId}:${delivery}`
    : `${matched.projectId}:${payload?.type ?? ""}:${payload?.action ?? ""}:${trigger.ticketId}:${payload?.createdAt ?? ""}`;
  if (shouldDedupeRun(dedupeKey, matched.autoCfg.dedupeWindowMinutes)) {
    sendJson(res, 202, {
      accepted: false,
      ignored: true,
      reason: "duplicate_event",
      project_id: matched.projectId,
      ticket_id: trigger.ticketId,
    });
    return;
  }

  enqueueAutoexecuteTask({
    projectId: matched.projectId,
    projectArg: matched.projectArg,
    ticketId: trigger.ticketId,
    source: "linear",
    type: String(payload?.type ?? ""),
    action: String(payload?.action ?? ""),
    delivery,
  });

  sendJson(res, 202, {
    accepted: true,
    queued: true,
    queue_depth: autoexecuteQueue.length,
    project_id: matched.projectId,
    ticket_id: trigger.ticketId,
    dry_run: autoexecuteDryRun,
  });
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
  const byKey = new Map();

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
      byKey.set(`${projectId}/${runId}`, summary);
    }
  }

  const sessions = await listSessionMetadata();
  for (const session of sessions) {
    const runId = session?.run_id;
    const projectId = session?.project_id;
    const workspacePath = session?.workspace_path;
    if (!runId || !projectId || !workspacePath) continue;
    const key = `${projectId}/${runId}`;
    if (byKey.has(key)) continue;
    const summary = await loadRunSummary(projectId, runId, workspacePath, session);
    byKey.set(key, summary);
  }

  const runs = Array.from(byKey.values());
  runs.sort((a, b) => (b.last_event_ts ?? 0) - (a.last_event_ts ?? 0));
  return runs;
}

async function listSessionMetadata() {
  const entries = await fs.readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const fullPath = path.join(sessionsRoot, entry.name);
    const raw = await fs.readFile(fullPath, "utf-8").catch(() => "");
    if (!raw) continue;
    try {
      sessions.push(JSON.parse(raw));
    } catch {
      // Skip malformed session files.
    }
  }
  return sessions;
}

async function resolveRunPath(projectId, runId) {
  const runPath = safeJoin(runsRoot, projectId, runId);
  const exists = await fs.stat(runPath).then((s) => s.isDirectory(), () => false);
  if (exists) return runPath;

  const sessions = await listSessionMetadata();
  const match = sessions.find(
    (s) =>
      s?.project_id === projectId &&
      s?.run_id === runId &&
      typeof s?.workspace_path === "string" &&
      s.workspace_path.length > 0
  );
  if (match?.workspace_path) {
    const sessionPathExists = await fs
      .stat(match.workspace_path)
      .then((s) => s.isDirectory(), () => false);
    if (sessionPathExists) return match.workspace_path;
  }

  throw new Error(`Run not found: ${projectId}/${runId}`);
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

function extractRuntimeSkills(runtimeMetadata) {
  if (!runtimeMetadata || typeof runtimeMetadata !== "object") return null;
  const providerMeta = runtimeMetadata.provider_metadata;
  if (!providerMeta || typeof providerMeta !== "object") return null;
  const skills = providerMeta.skills;
  if (!skills || typeof skills !== "object") return null;

  const names = Array.isArray(skills.names)
    ? skills.names.map((name) => String(name)).filter(Boolean)
    : [];
  const warnings = Array.isArray(skills.warnings)
    ? skills.warnings.map((warning) => String(warning)).filter(Boolean)
    : [];

  const hashes = {};
  if (skills.hashes && typeof skills.hashes === "object") {
    for (const [key, value] of Object.entries(skills.hashes)) {
      if (!key) continue;
      hashes[String(key)] = String(value ?? "");
    }
  }

  return {
    names,
    warnings,
    hashes,
    provider: typeof skills.provider === "string" ? skills.provider : "",
    skills_dir: typeof skills.skills_dir === "string" ? skills.skills_dir : "",
  };
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
      runtime_skills: null,
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
        runtime_skills: null,
        is_rework: stepNum >= 900,
      });
    }
    const st = byStep.get(stepNum);
    const runtimeSkills = extractRuntimeSkills(data.runtime_metadata);
    if (runtimeSkills) {
      st.runtime_skills = runtimeSkills;
    }
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

function extractTicketUrl(ticket) {
  if (!ticket || typeof ticket !== "object") return null;
  const raw = ticket.raw;
  if (!raw || typeof raw !== "object") return null;
  const htmlUrl = raw.html_url;
  const url = raw.url;
  if (typeof htmlUrl === "string" && htmlUrl.trim()) return htmlUrl;
  if (typeof url === "string" && url.trim()) return url;
  return null;
}

function extractRepoUrl(ticket) {
  if (!ticket || typeof ticket !== "object") return null;
  const raw = ticket.raw;
  if (!raw || typeof raw !== "object") return null;

  const repositoryApiUrl = raw.repository_url;
  if (typeof repositoryApiUrl === "string") {
    const m = repositoryApiUrl.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/);
    if (m) return `https://github.com/${m[1]}`;
  }

  const htmlUrl = raw.html_url;
  if (typeof htmlUrl === "string") {
    try {
      const u = new URL(htmlUrl);
      const parts = u.pathname.split("/").filter(Boolean);
      if (u.hostname === "github.com" && parts.length >= 2) {
        return `${u.protocol}//${u.hostname}/${parts[0]}/${parts[1]}`;
      }
    } catch {
      // ignore invalid URL
    }
  }

  return null;
}

function extractRunSourceMetadata(events, session = null, projectRepoUrl = null) {
  const taskCreatedEvents = events.filter((evt) => evt?.event_type === "task.created");
  const initialCreated = taskCreatedEvents.find((evt) => typeof evt?.data?.source === "string") ?? null;
  const ticketCreated = taskCreatedEvents.find((evt) => evt?.data?.ticket && typeof evt.data.ticket === "object") ?? null;
  const ticket = ticketCreated?.data?.ticket ?? null;
  const explicitTicketUrl = ticketCreated?.data?.ticket_url;
  const explicitTicketRepoUrl = ticketCreated?.data?.ticket_repo_url;
  const ticketUrl = (typeof explicitTicketUrl === "string" && explicitTicketUrl.trim())
    ? explicitTicketUrl
    : extractTicketUrl(ticket);
  const ticketRepoUrl = (
    typeof explicitTicketRepoUrl === "string" && explicitTicketRepoUrl.trim()
      ? explicitTicketRepoUrl
      : (projectRepoUrl || extractRepoUrl(ticket))
  );

  const triggerSource = (
    ticketCreated?.data?.trigger_source ??
    initialCreated?.data?.trigger_source ??
    null
  );

  const ticketSource = (
    ticket?.source ??
    ticketCreated?.data?.source ??
    initialCreated?.data?.source ??
    session?.ticket_source ??
    null
  );

  return {
    ticket_source: typeof ticketSource === "string" ? ticketSource : null,
    ticket_id: typeof ticket?.id === "string" ? ticket.id : (session?.ticket_id ?? null),
    ticket_title: typeof ticket?.title === "string" ? ticket.title : (session?.ticket_title ?? null),
    ticket_url: typeof ticketUrl === "string" && ticketUrl.trim() ? ticketUrl : null,
    ticket_repo_url: typeof ticketRepoUrl === "string" && ticketRepoUrl.trim() ? ticketRepoUrl : null,
    trigger_source: typeof triggerSource === "string" && triggerSource.trim() ? triggerSource : null,
  };
}

async function loadRunSummary(projectId, runId, runPath, session = null) {
  const events = await readEvents(runPath);
  const planEvent = events.find((e) => e.event_type === "task.plan_generated");
  const plan = planEvent?.data?.plan ?? null;
  const steps = buildStepStatus(plan, events);
  const last = events.at(-1);
  const hasEvents = events.length > 0;
  const projectRepoUrl = await getProjectRepoUrl(projectId);
  const sourceMeta = extractRunSourceMetadata(events, session, projectRepoUrl);
  const fallbackRepoUrl = sourceMeta.ticket_repo_url ?? await getWorkspaceRepoUrl(runPath);
  return {
    project_id: projectId,
    run_id: runId,
    status: hasEvents ? inferStatus(events) : (session?.status ?? "unknown"),
    classification: plan?.classification ?? session?.plan_classification ?? null,
    step_count: hasEvents ? (plan?.steps?.length ?? 0) : (session?.total_steps ?? 0),
    steps,
    started_at: events.find((e) => e.event_type === "task.created")?.timestamp ?? session?.created_at ?? null,
    last_event_type: last?.event_type ?? null,
    last_event_ts: last?.timestamp
      ? Date.parse(last.timestamp)
      : (session?.updated_at ? Date.parse(session.updated_at) : null),
    workspace_path: runPath,
    ...sourceMeta,
    ticket_repo_url: fallbackRepoUrl,
  };
}

async function loadRun(projectId, runId) {
  const runPath = await resolveRunPath(projectId, runId);
  const summary = await loadRunSummary(projectId, runId, runPath);
  const events = await readEvents(runPath);
  const planEvent = events.find((e) => e.event_type === "task.plan_generated");
  const step_models = await loadStepModels(runPath);
  const maxCompletedStep = summary.steps
    .filter((step) => step.status === "completed" || step.status === "failed")
    .map((step) => step.step_number)
    .sort((a, b) => b - a)[0] ?? null;
  const steps = await Promise.all(
    (summary.steps ?? []).map(async (step) => {
      const { result } = await readStepResult(runPath, step.step_number, maxCompletedStep);
      const summaryText =
        typeof result?.summary === "string" && result.summary.trim()
          ? result.summary.trim()
          : null;
      return {
        ...step,
        result_summary: summaryText,
      };
    })
  );
  return {
    ...summary,
    steps,
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
  const runPath = await resolveRunPath(projectId, runId);

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
  const runPath = await resolveRunPath(projectId, runId);
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

// ---- SSE (Server-Sent Events) infrastructure ----

/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();

/** @type {Map<string, { offset: number, clients: Set<http.ServerResponse> }>} */
const sseWatchers = new Map();

const SSE_HEARTBEAT_MS = 15_000;
const SSE_POLL_MS = 1_000;

function sseWrite(res, event, data) {
  try {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Client disconnected
  }
}

function readNewEventsFromOffset(filePath, offset) {
  let content = "";
  let newOffset = offset;
  try {
    const stat = statSync(filePath);
    if (stat.size <= offset) return { events: [], newOffset: offset };
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(stat.size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    content = buf.toString("utf-8");
    newOffset = stat.size;
  } catch {
    return { events: [], newOffset: offset };
  }
  const events = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  return { events, newOffset };
}

function startSSEWatcher(eventsFilePath, res) {
  let watcher = sseWatchers.get(eventsFilePath);
  if (!watcher) {
    let currentOffset = 0;
    try {
      const stat = statSync(eventsFilePath);
      currentOffset = stat.size; // Start from current end — only stream NEW events
    } catch {
      currentOffset = 0;
    }
    watcher = { offset: currentOffset, clients: new Set() };
    sseWatchers.set(eventsFilePath, watcher);

    // Use watchFile for reliable cross-platform JSONL append detection
    watchFile(eventsFilePath, { interval: SSE_POLL_MS }, () => {
      const w = sseWatchers.get(eventsFilePath);
      if (!w || w.clients.size === 0) return;
      const { events, newOffset } = readNewEventsFromOffset(eventsFilePath, w.offset);
      w.offset = newOffset;
      for (const event of events) {
        for (const client of w.clients) {
          sseWrite(client, "event", event);
        }
      }
    });
  }
  watcher.clients.add(res);
}

function stopSSEWatcher(eventsFilePath, res) {
  const watcher = sseWatchers.get(eventsFilePath);
  if (!watcher) return;
  watcher.clients.delete(res);
  if (watcher.clients.size === 0) {
    unwatchFile(eventsFilePath);
    sseWatchers.delete(eventsFilePath);
  }
}

// Heartbeat to keep SSE connections alive through proxies
const sseHeartbeatInterval = setInterval(() => {
  for (const client of sseClients) {
    try { client.write(`:heartbeat\n\n`); } catch { /* ignore */ }
  }
}, SSE_HEARTBEAT_MS);
sseHeartbeatInterval.unref?.();

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
      const runPath = await resolveRunPath(project, run);
      const events = await readEvents(runPath);
      sendJson(res, 200, { events: events.slice(Math.max(0, events.length - limit)) });
      return;
    }

    // ---- SSE event stream ----
    if (pathname === "/api/events/stream") {
      const project = reqUrl.searchParams.get("project");
      const run = reqUrl.searchParams.get("run");

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no", // Disable buffering in nginx
      });

      // Send initial connected message
      sseWrite(res, "connected", { ts: Date.now() });
      sseClients.add(res);

      // If project+run specified, watch that specific run's events file
      const watchedFiles = [];
      if (project && run) {
        try {
          const runPath = await resolveRunPath(project, run);
          const eventsFile = path.join(runPath, ".events.jsonl");
          startSSEWatcher(eventsFile, res);
          watchedFiles.push(eventsFile);
        } catch {
          // Invalid path — just stream heartbeats
        }
      } else {
        // No specific run — watch all known runs' event files
        // (scan once at connection time; new runs picked up on reconnect)
        try {
          const runs = await listRuns();
          for (const summary of runs) {
            if (!summary.workspace_path) continue;
            const eventsFile = path.join(summary.workspace_path, ".events.jsonl");
            startSSEWatcher(eventsFile, res);
            watchedFiles.push(eventsFile);
          }
        } catch {
          // Scan failed — just stream heartbeats
        }
      }

      // Also send periodic run summary refreshes so the list view stays current
      const summaryInterval = setInterval(async () => {
        try {
          const runs = await listRuns();
          sseWrite(res, "runs", { runs });
        } catch {
          // Transient failure — skip this tick
        }
      }, 5000);

      req.on("close", () => {
        sseClients.delete(res);
        clearInterval(summaryInterval);
        for (const file of watchedFiles) {
          stopSSEWatcher(file, res);
        }
      });
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

    if (pathname === "/api/step-result") {
      const project = reqUrl.searchParams.get("project");
      const run = reqUrl.searchParams.get("run");
      const stepParam = reqUrl.searchParams.get("step");
      const stepNumber = Number(stepParam);
      if (!project || !run || !Number.isFinite(stepNumber)) {
        sendJson(res, 400, { error: "Missing or invalid project/run/step query params" });
        return;
      }
      const runPath = await resolveRunPath(project, run);
      const runSummary = await loadRunSummary(project, run, runPath);
      const maxCompletedStep = runSummary.steps
        .filter((step) => step.status === "completed" || step.status === "failed")
        .map((step) => step.step_number)
        .sort((a, b) => b - a)[0] ?? null;
      const payload = await readStepResult(runPath, stepNumber, maxCompletedStep);
      sendJson(res, 200, {
        step: stepNumber,
        source: payload.source,
        result: payload.result,
      });
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

    if (pathname === "/api/diff") {
      const project = reqUrl.searchParams.get("project");
      const run = reqUrl.searchParams.get("run");
      const file = reqUrl.searchParams.get("file");
      if (!project || !run || !file) {
        sendJson(res, 400, { error: "Missing project, run, or file" });
        return;
      }
      const runPath = await resolveRunPath(project, run);
      const absFile = path.resolve(runPath, file);
      if (!absFile.startsWith(runPath + path.sep) && absFile !== runPath) {
        sendJson(res, 400, { error: "Invalid file path" });
        return;
      }
      const relFile = path.relative(runPath, absFile);
      const git = (args) => new Promise((resolve) => {
        execFile("git", args, { cwd: runPath, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
          resolve({ ok: !err, stdout: stdout || "" });
        });
      });
      // Try last-commit diff first
      const diff = await git(["diff", "HEAD~1..HEAD", "--", relFile]);
      if (diff.ok && diff.stdout.trim()) {
        sendJson(res, 200, { diff: diff.stdout, kind: "diff" });
        return;
      }
      // Fallback: show the file as entirely new (single-commit workspace)
      const show = await git(["show", `HEAD:${relFile}`]);
      if (show.ok && show.stdout) {
        const body = show.stdout.split("\n").map((l) => `+${l}`).join("\n");
        const synth = `--- /dev/null\n+++ b/${relFile}\n@@ -0,0 +1 @@\n${body}`;
        sendJson(res, 200, { diff: synth, kind: "new" });
        return;
      }
      // Final fallback: file is untracked (e.g. in .gitignore like artifacts/) — read directly
      const raw = await fs.readFile(absFile, "utf-8").catch(() => null);
      if (raw != null) {
        const body = raw.split("\n").map((l) => `+${l}`).join("\n");
        const synth = `--- /dev/null\n+++ b/${relFile}\n@@ -0,0 +1 @@\n${body}`;
        sendJson(res, 200, { diff: synth, kind: "untracked" });
        return;
      }
      sendJson(res, 200, { diff: "", kind: "none" });
      return;
    }

    if (pathname === "/api/reviews") {
      const project = reqUrl.searchParams.get("project");
      const run = reqUrl.searchParams.get("run");
      if (!project || !run) {
        sendJson(res, 400, { error: "Missing project/run query params" });
        return;
      }
      const runPath = await resolveRunPath(project, run);
      const reviewDir = path.join(runPath, ".sprintfoundry", "reviews");
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
      const runPath = await resolveRunPath(project, runId);
      const reviewDir = path.join(runPath, ".sprintfoundry", "reviews");
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

    if (pathname === "/api/webhooks/github" && req.method === "POST") {
      if (webhookSplitEnabled) {
        sendJson(res, 404, { error: "Webhook endpoints are hosted on dedicated webhook port" });
        return;
      }
      await handleGitHubWebhookRequest(req, res);
      return;
    }

    if (pathname === "/api/webhooks/linear" && req.method === "POST") {
      if (webhookSplitEnabled) {
        sendJson(res, 404, { error: "Webhook endpoints are hosted on dedicated webhook port" });
        return;
      }
      await handleLinearWebhookRequest(req, res);
      return;
    }

    if (pathname === "/api/autoexecute/queue") {
      sendJson(res, 200, {
        queue_depth: autoexecuteQueue.length,
        running: autoexecuteRunning,
        dry_run: autoexecuteDryRun,
        history: autoexecuteHistory.slice(-20),
      });
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

const webhookServer = webhookSplitEnabled
  ? http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = reqUrl.pathname;
      try {
        if (pathname === "/api/webhooks/github" && req.method === "POST") {
          await handleGitHubWebhookRequest(req, res);
          return;
        }
        if (pathname === "/api/webhooks/linear" && req.method === "POST") {
          await handleLinearWebhookRequest(req, res);
          return;
        }
        sendText(res, 404, "Not found");
      } catch (err) {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  : null;

if (webhookServer) {
  webhookServer.on("error", (err) => {
    console.error(`[monitor] Webhook server error: ${err.message}`);
    process.exitCode = 1;
  });
}

server.listen(port, "127.0.0.1", () => {
  const actualPort = server.address()?.port ?? port;
  console.log(`[monitor] Run Monitor listening at http://127.0.0.1:${actualPort}`);
  console.log(`[monitor] Watching runs under: ${runsRoot}`);
});

if (webhookServer) {
  webhookServer.listen(webhookPort, "127.0.0.1", () => {
    const actualWebhookPort = webhookServer.address()?.port ?? webhookPort;
    console.log(`[monitor] Webhook server listening at http://127.0.0.1:${actualWebhookPort}`);
  });
}
