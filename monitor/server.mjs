import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promises as fs, watchFile, unwatchFile, statSync, openSync, readSync, closeSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicV3Dir = path.join(__dirname, "public-v3");
const repoRoot = path.resolve(__dirname, "..");
const runsRoot = process.env.SPRINTFOUNDRY_RUNS_ROOT ?? process.env.AGENTSDLC_RUNS_ROOT ?? path.join(os.tmpdir(), "sprintfoundry");
const sessionsRoot = process.env.SPRINTFOUNDRY_SESSIONS_DIR ?? path.join(os.homedir(), ".sprintfoundry", "sessions");
const configRoot = process.env.SPRINTFOUNDRY_CONFIG_DIR ?? path.join(repoRoot, "config");
const autoexecuteDryRun = process.env.SPRINTFOUNDRY_AUTORUN_DRY_RUN === "1";
const monitorAuthRequired = process.env.SPRINTFOUNDRY_MONITOR_AUTH_REQUIRED !== "0";
const monitorReadToken = String(process.env.SPRINTFOUNDRY_MONITOR_API_TOKEN ?? "").trim();
const monitorWriteToken = String(process.env.SPRINTFOUNDRY_MONITOR_WRITE_TOKEN ?? "").trim();
const databaseUrl = String(process.env.SPRINTFOUNDRY_DATABASE_URL ?? "").trim();
const redisUrl = String(process.env.SPRINTFOUNDRY_REDIS_URL ?? "").trim();
const useDatabaseBackend = databaseUrl.length > 0;
const selectedDataSourceLabel = useDatabaseBackend
  ? `postgres+redis${redisUrl ? "" : " (redis_url_missing: polling_fallback)"}`
  : "filesystem";

const portArgIndex = process.argv.indexOf("--port");
const portArg = portArgIndex !== -1 ? process.argv[portArgIndex + 1] : undefined;
const port = Number(portArg ?? process.env.MONITOR_PORT ?? 4310);
const webhookPortEnv = process.env.SPRINTFOUNDRY_WEBHOOK_PORT;
const webhookPortCandidate = Number(webhookPortEnv ?? "");
const webhookSplitEnabled = Number.isFinite(webhookPortCandidate) && webhookPortCandidate > 0 && webhookPortCandidate !== port;
const webhookPort = webhookSplitEnabled ? webhookPortCandidate : port;
const monitorApiMaxBodyBytes = toPositiveInt(process.env.SPRINTFOUNDRY_MONITOR_API_MAX_BODY_BYTES, 262_144);
const monitorWebhookMaxBodyBytes = toPositiveInt(process.env.SPRINTFOUNDRY_MONITOR_WEBHOOK_MAX_BODY_BYTES, 1_048_576);
const monitorBodyReadTimeoutMs = toPositiveInt(process.env.SPRINTFOUNDRY_MONITOR_BODY_TIMEOUT_MS, 10_000);
const autoexecuteSeenStorePath = path.join(sessionsRoot, ".monitor-autoexecute-seen.json");

let autoexecuteCache = { loadedAt: 0, projects: [] };
let projectRepoUrlCache = { loadedAt: 0, byProjectId: new Map() };
let projectArgCache = { loadedAt: 0, byProjectId: new Map() };
let workspaceRepoUrlCache = { loadedAt: 0, byWorkspacePath: new Map() };
const autoexecuteQueue = [];
const autoexecuteHistory = [];
let autoexecuteRunning = false;
const autoexecuteSeen = new Map();
let autoexecuteSeenLoaded = false;
let autoexecuteSeenWritePromise = Promise.resolve();

function toPositiveInt(value, fallback) {
  const n = Number(value ?? "");
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function isProjectConfigFileName(name) {
  if (!/\.ya?ml$/i.test(name)) return false;
  const lower = name.toLowerCase();
  if (lower === "platform.yaml" || lower === "platform.yml") return false;
  if (lower === "project.example.yaml" || lower === "project.example.yml") return false;
  return true;
}

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

function readBody(req, options = {}) {
  const maxBytes = toPositiveInt(options.maxBytes, monitorApiMaxBodyBytes);
  const timeoutMs = toPositiveInt(options.timeoutMs, monitorBodyReadTimeoutMs);

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error("Request body read timeout");
      err.code = "BODY_TIMEOUT";
      reject(err);
    }, timeoutMs);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        const err = new Error("Request body too large");
        err.code = "BODY_TOO_LARGE";
        finish(reject, err);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      finish(resolve, Buffer.concat(chunks).toString("utf-8"));
    });

    req.on("error", (err) => {
      finish(reject, err);
    });
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

function sendBodyReadError(res, err) {
  const code = err?.code;
  if (code === "BODY_TOO_LARGE") {
    sendJson(res, 413, { error: "Payload too large" });
    return;
  }
  if (code === "BODY_TIMEOUT") {
    sendJson(res, 408, { error: "Request timeout" });
    return;
  }
  sendJson(res, 400, { error: "Invalid request body" });
}

function extractRequestToken(req, reqUrl) {
  const authHeader = req.headers.authorization;
  const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const bearer = String(authValue ?? "");
  if (bearer.toLowerCase().startsWith("bearer ")) {
    const token = bearer.slice(7).trim();
    if (token) return token;
  }
  const queryToken =
    String(reqUrl.searchParams.get("token") ?? "").trim() ||
    String(reqUrl.searchParams.get("access_token") ?? "").trim();
  return queryToken;
}

function authorizeApiRequest(req, reqUrl, scope) {
  if (!monitorAuthRequired) {
    return { ok: true };
  }

  if (!monitorReadToken && !monitorWriteToken) {
    return { ok: true };
  }

  const provided = extractRequestToken(req, reqUrl);
  if (!provided) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const accepted = new Set();
  if (scope === "write") {
    if (monitorWriteToken) accepted.add(monitorWriteToken);
    else if (monitorReadToken) accepted.add(monitorReadToken);
  } else {
    if (monitorReadToken) accepted.add(monitorReadToken);
    if (monitorWriteToken) accepted.add(monitorWriteToken);
  }

  if (!accepted.has(provided)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  return { ok: true };
}

function interpolateEnvVars(raw) {
  return raw.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

async function loadYamlFile(filePath) {
  const raw = await fs.readFile(filePath, "utf-8");
  return parseYaml(interpolateEnvVars(raw));
}

function projectArgFromFileName(fileName) {
  const lower = fileName.toLowerCase();
  if (lower === "project.yaml" || lower === "project.yml") return null;
  const prefixed = fileName.match(/^project-(.+)\.ya?ml$/i);
  if (prefixed) return prefixed[1];
  const match = fileName.match(/^(.+)\.ya?ml$/i);
  if (!match) return null;
  const baseName = match[1];
  if (!baseName) return null;
  return baseName;
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
    .filter((name) => isProjectConfigFileName(name))
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

async function loadProjectArgMap() {
  const now = Date.now();
  if (now - projectArgCache.loadedAt < 15_000) {
    return projectArgCache.byProjectId;
  }

  const entries = await fs.readdir(configRoot, { withFileTypes: true }).catch(() => []);
  const projectFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => isProjectConfigFileName(name))
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
    if (!projectId) continue;
    byProjectId.set(projectId, projectArgFromFileName(fileName));
  }

  projectArgCache = { loadedAt: now, byProjectId };
  return byProjectId;
}

async function getProjectArgForProjectId(projectId) {
  const map = await loadProjectArgMap();
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
    : ["issue_comment.created"];
  return {
    enabled,
    webhookSecret: String(github.webhook_secret ?? "").trim(),
    allowedEvents: new Set(allowedEvents),
    labelTrigger: String(github.label_trigger ?? "sf:auto-run"),
    commandTrigger: String(github.command_trigger ?? "/sf-run"),
    requireCommand: github.require_command == null ? true : github.require_command === true,
    dedupeWindowMinutes: Number(github.dedupe_window_minutes ?? 1440),
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
    .filter((name) => isProjectConfigFileName(name))
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

      const autoCfg = webhookHandlerApi.normalizeGitHubAutoexecuteConfig(project);
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
      const autoCfg = webhookHandlerApi.normalizeLinearAutoexecuteConfig(project);
      if (!autoCfg.enabled) continue;

      const teamId = String(ticketSource?.config?.team_id ?? "").trim().toLowerCase();
      const teamKey = String(ticketSource?.config?.team_key ?? "").trim().toLowerCase();
      if (!teamId && !teamKey) {
        console.warn(
          `[monitor] Skipping linear autoexecute for ${fileName}: team_id/team_key required to avoid ambiguous routing`
        );
        continue;
      }
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
    if (project.teamId && candidates.has(project.teamId)) return true;
    if (project.teamKey && candidates.has(project.teamKey)) return true;
    return false;
  });

  if (matches.length !== 1) return null;
  return matches[0];
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

function pruneAutoexecuteSeen(nowMs) {
  for (const [key, seen] of autoexecuteSeen.entries()) {
    if (nowMs - seen.seenAt > seen.windowMs * 2) {
      autoexecuteSeen.delete(key);
    }
  }
}

async function loadAutoexecuteSeen() {
  if (autoexecuteSeenLoaded) return;
  autoexecuteSeenLoaded = true;
  const raw = await fs.readFile(autoexecuteSeenStorePath, "utf-8").catch(() => "");
  if (!raw) return;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  for (const entry of entries) {
    const key = String(entry?.key ?? "");
    const seenAt = Number(entry?.seenAt ?? NaN);
    const windowMs = Number(entry?.windowMs ?? NaN);
    if (!key || !Number.isFinite(seenAt) || !Number.isFinite(windowMs) || windowMs <= 0) continue;
    autoexecuteSeen.set(key, { seenAt, windowMs });
  }

  pruneAutoexecuteSeen(Date.now());
}

async function persistAutoexecuteSeen() {
  const entries = [...autoexecuteSeen.entries()].map(([key, seen]) => ({
    key,
    seenAt: seen.seenAt,
    windowMs: seen.windowMs,
  }));
  const payload = JSON.stringify(
    {
      updated_at: new Date().toISOString(),
      entries,
    },
    null,
    2
  );

  await fs.mkdir(path.dirname(autoexecuteSeenStorePath), { recursive: true });
  const tmpPath = `${autoexecuteSeenStorePath}.tmp`;
  await fs.writeFile(tmpPath, payload, "utf-8");
  await fs.rename(tmpPath, autoexecuteSeenStorePath);
}

async function flushAutoexecuteSeenToDisk() {
  autoexecuteSeenWritePromise = autoexecuteSeenWritePromise
    .then(async () => {
      await persistAutoexecuteSeen();
    })
    .catch((err) => {
      console.warn(`[monitor] Failed to persist webhook dedupe state: ${err?.message ?? err}`);
    });
  await autoexecuteSeenWritePromise;
}

async function shouldDedupeRun(dedupeKey, dedupeWindowMinutes) {
  await loadAutoexecuteSeen();
  const now = Date.now();
  const windowMs = Math.max(1, dedupeWindowMinutes) * 60_000;
  const prev = autoexecuteSeen.get(dedupeKey);
  if (prev && now - prev.seenAt < windowMs) return true;
  autoexecuteSeen.set(dedupeKey, { seenAt: now, windowMs });
  pruneAutoexecuteSeen(now);
  await flushAutoexecuteSeenToDisk();
  return false;
}

async function loadSharedWebhookHandlerModule() {
  const compiledPath = path.join(repoRoot, "dist", "service", "webhook-handler.js");
  try {
    const imported = await import(pathToFileURL(compiledPath).href);
    if (imported && typeof imported === "object") {
      console.log(`[monitor] Using shared webhook handler module: ${compiledPath}`);
      return imported;
    }
  } catch {
    // Ignore missing compiled module and fall back to inline implementations.
  }
  return null;
}

const sharedWebhookModule = await loadSharedWebhookHandlerModule();
const webhookHandlerApi = {
  normalizeGitHubAutoexecuteConfig:
    sharedWebhookModule?.normalizeGitHubAutoexecuteConfig ?? normalizeGitHubAutoexecuteConfig,
  normalizeLinearAutoexecuteConfig:
    sharedWebhookModule?.normalizeLinearAutoexecuteConfig ?? normalizeLinearAutoexecuteConfig,
  verifyGitHubSignature: sharedWebhookModule?.verifyGitHubSignature ?? verifyGitHubSignature,
  verifyLinearSignature: sharedWebhookModule?.verifyLinearSignature ?? verifyLinearSignature,
  extractGitHubTrigger: sharedWebhookModule?.extractGitHubTrigger ?? extractGitHubTrigger,
  extractLinearTrigger: sharedWebhookModule?.extractLinearTrigger ?? extractLinearTrigger,
};

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
  let rawBody = "";
  try {
    rawBody = await readBody(req, {
      maxBytes: monitorWebhookMaxBodyBytes,
      timeoutMs: monitorBodyReadTimeoutMs,
    });
  } catch (err) {
    sendBodyReadError(res, err);
    return;
  }
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
    sendJson(res, 202, { accepted: false, ignored: true });
    return;
  }

  if (!matched.autoCfg.webhookSecret) {
    sendJson(res, 403, { accepted: false, error: "Forbidden" });
    return;
  }

  if (!webhookHandlerApi.verifyGitHubSignature(rawBody, signature, matched.autoCfg.webhookSecret)) {
    sendJson(res, 401, { accepted: false, error: "Unauthorized" });
    return;
  }

  if (!delivery) {
    sendJson(res, 400, { accepted: false, error: "Bad Request" });
    return;
  }

  const action = String(payload?.action ?? "");
  const trigger = webhookHandlerApi.extractGitHubTrigger(payload, event, action, matched.autoCfg);
  if (!trigger.allowed) {
    sendJson(res, 202, { accepted: false, ignored: true });
    return;
  }

  const dedupeKey = `${matched.projectId}:${delivery}`;
  if (await shouldDedupeRun(dedupeKey, matched.autoCfg.dedupeWindowMinutes)) {
    sendJson(res, 202, { accepted: false, ignored: true });
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
    dry_run: autoexecuteDryRun,
  });
}

async function handleLinearWebhookRequest(req, res) {
  let rawBody = "";
  try {
    rawBody = await readBody(req, {
      maxBytes: monitorWebhookMaxBodyBytes,
      timeoutMs: monitorBodyReadTimeoutMs,
    });
  } catch (err) {
    sendBodyReadError(res, err);
    return;
  }
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
    sendJson(res, 202, { accepted: false, ignored: true });
    return;
  }

  if (!matched.autoCfg.webhookSecret) {
    sendJson(res, 403, { accepted: false, error: "Forbidden" });
    return;
  }

  if (!webhookHandlerApi.verifyLinearSignature(rawBody, signature, matched.autoCfg.webhookSecret)) {
    sendJson(res, 401, { accepted: false, error: "Unauthorized" });
    return;
  }

  const webhookTimestamp = Number(payload?.webhookTimestamp ?? NaN);
  if (Number.isFinite(webhookTimestamp) && matched.autoCfg.maxTimestampAgeSeconds > 0) {
    const ageSeconds = Math.abs(Date.now() - webhookTimestamp) / 1000;
    if (ageSeconds > matched.autoCfg.maxTimestampAgeSeconds) {
      sendJson(res, 401, { accepted: false, error: "Unauthorized" });
      return;
    }
  }

  const trigger = webhookHandlerApi.extractLinearTrigger(payload, matched.autoCfg);
  if (!trigger.allowed) {
    sendJson(res, 202, { accepted: false, ignored: true });
    return;
  }

  const delivery = String(payload?.webhookId ?? "");
  if (!delivery) {
    sendJson(res, 400, { accepted: false, error: "Bad Request" });
    return;
  }
  const dedupeKey = `${matched.projectId}:${delivery}`;
  if (await shouldDedupeRun(dedupeKey, matched.autoCfg.dedupeWindowMinutes)) {
    sendJson(res, 202, { accepted: false, ignored: true });
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

function canonicalizeRunId(rawRunId) {
  let runId = String(rawRunId ?? "").trim();
  if (!runId) return "";
  while (runId.startsWith("run-run-")) {
    runId = `run-${runId.slice("run-run-".length)}`;
  }
  return runId;
}

function buildRunIdCandidates(rawRunId) {
  const provided = String(rawRunId ?? "").trim();
  const canonical = canonicalizeRunId(provided);
  const candidates = [];
  const seen = new Set();

  const push = (value) => {
    const runId = String(value ?? "").trim();
    if (!runId || seen.has(runId)) return;
    seen.add(runId);
    candidates.push(runId);
  };

  push(provided);
  push(canonical);

  if (canonical.startsWith("run-")) {
    // Worktree directories are typically prefixed as run-${run_id}.
    push(`run-${canonical}`);
  }
  if (provided.startsWith("run-run-")) {
    push(provided.slice(4));
  }

  return candidates;
}

function resolveCanonicalRunId(runId, events = [], session = null) {
  const eventRunId =
    events.find((evt) => typeof evt?.run_id === "string" && evt.run_id.trim())?.run_id ?? "";
  const sessionRunId =
    typeof session?.run_id === "string" && session.run_id.trim() ? session.run_id : "";

  return (
    canonicalizeRunId(eventRunId) ||
    canonicalizeRunId(sessionRunId) ||
    canonicalizeRunId(runId)
  );
}

let databasePoolPromise = null;
let redisSubscriberFactoryPromise = null;

async function getDatabasePool() {
  if (!useDatabaseBackend) return null;
  if (!databasePoolPromise) {
    databasePoolPromise = (async () => {
      let pgModule;
      try {
        pgModule = await import("pg");
      } catch (err) {
        throw new Error(`Database backend requested, but "pg" is unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
      const Pool = pgModule?.Pool ?? pgModule?.default?.Pool;
      if (!Pool) {
        throw new Error('Database backend requested, but "pg" did not expose Pool');
      }
      return new Pool({ connectionString: databaseUrl });
    })();
  }
  return databasePoolPromise;
}

async function getRedisSubscriberFactory() {
  if (!redisUrl) return null;
  if (!redisSubscriberFactoryPromise) {
    redisSubscriberFactoryPromise = (async () => {
      let redisModule;
      try {
        redisModule = await import("redis");
      } catch (err) {
        throw new Error(`Redis backend requested, but "redis" is unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
      const createClient = redisModule?.createClient ?? redisModule?.default?.createClient;
      if (!createClient) {
        throw new Error('Redis backend requested, but "redis" did not expose createClient');
      }
      return () => createClient({ url: redisUrl });
    })();
  }
  return redisSubscriberFactoryPromise;
}

function toIsoTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function normalizeMonitorEvent(rawEvent) {
  if (!rawEvent || typeof rawEvent !== "object") return null;
  const eventType = String(rawEvent.event_type ?? "").trim();
  if (!eventType) return null;
  const timestamp = toIsoTimestamp(rawEvent.timestamp) ?? new Date().toISOString();
  const data = rawEvent.data && typeof rawEvent.data === "object" ? rawEvent.data : {};
  return {
    event_type: eventType,
    timestamp,
    data,
  };
}

function trimToLineCount(text, lines) {
  const allLines = String(text ?? "").split("\n");
  return allLines.slice(Math.max(0, allLines.length - lines)).join("\n");
}

async function getDbRunRecord(projectId, runId) {
  const db = await getDatabasePool();
  if (!db) return null;
  const query = await db.query(
    `
      SELECT
        run_id,
        project_id,
        ticket_id,
        ticket_source,
        ticket_title,
        status,
        current_step,
        total_steps,
        plan_classification,
        workspace_path,
        branch,
        pr_url,
        total_tokens,
        total_cost_usd,
        created_at,
        updated_at,
        completed_at,
        error
      FROM runs
      WHERE project_id = $1 AND run_id = $2
      LIMIT 1
    `,
    [projectId, runId]
  );
  return query.rows[0] ?? null;
}

async function readEventsFromDb(runId, limit = null) {
  const db = await getDatabasePool();
  if (!db) return [];

  const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
  const queryResult = boundedLimit
    ? await db.query(
      `
        SELECT event_type, timestamp, data
        FROM (
          SELECT event_type, timestamp, data, received_at, event_id
          FROM events
          WHERE run_id = $1
          ORDER BY timestamp DESC, received_at DESC, event_id DESC
          LIMIT $2
        ) recent
        ORDER BY timestamp ASC, received_at ASC, event_id ASC
      `,
      [runId, boundedLimit]
    )
    : await db.query(
      `
        SELECT event_type, timestamp, data
        FROM events
        WHERE run_id = $1
        ORDER BY timestamp ASC, received_at ASC, event_id ASC
      `,
      [runId]
    );

  return queryResult.rows
    .map((row) => normalizeMonitorEvent(row))
    .filter(Boolean);
}

function buildDbSessionFallback(runRecord) {
  return {
    status: typeof runRecord.status === "string" ? runRecord.status : "unknown",
    plan_classification: runRecord.plan_classification ?? null,
    total_steps: Number.isFinite(runRecord.total_steps) ? runRecord.total_steps : 0,
    created_at: toIsoTimestamp(runRecord.created_at),
    updated_at: toIsoTimestamp(runRecord.updated_at),
    ticket_source: runRecord.ticket_source ?? null,
    ticket_id: runRecord.ticket_id ?? null,
    ticket_title: runRecord.ticket_title ?? null,
  };
}

function extractResultSummaryText(result) {
  return typeof result?.summary === "string" && result.summary.trim()
    ? result.summary.trim()
    : null;
}

async function loadRunSummaryFromDbRecord(runRecord) {
  const events = await readEventsFromDb(runRecord.run_id);
  const planEvent = events.find((e) => e.event_type === "task.plan_generated");
  const plan = planEvent?.data?.plan ?? null;
  const steps = buildStepStatus(plan, events);
  const last = events.at(-1);
  const hasEvents = events.length > 0;
  const projectRepoUrl = await getProjectRepoUrl(runRecord.project_id);
  const sessionFallback = buildDbSessionFallback(runRecord);
  const sourceMeta = extractRunSourceMetadata(events, sessionFallback, projectRepoUrl);
  let fallbackRepoUrl = sourceMeta.ticket_repo_url;
  if (!fallbackRepoUrl && typeof runRecord.workspace_path === "string" && runRecord.workspace_path) {
    fallbackRepoUrl = await getWorkspaceRepoUrl(runRecord.workspace_path);
  }

  return {
    project_id: runRecord.project_id,
    run_id: runRecord.run_id,
    status: hasEvents ? inferStatus(events) : (runRecord.status ?? "unknown"),
    classification: plan?.classification ?? runRecord.plan_classification ?? null,
    step_count: hasEvents ? (plan?.steps?.length ?? 0) : (runRecord.total_steps ?? 0),
    steps,
    started_at: events.find((e) => e.event_type === "task.created")?.timestamp ?? toIsoTimestamp(runRecord.created_at),
    last_event_type: last?.event_type ?? null,
    last_event_ts: last?.timestamp
      ? Date.parse(last.timestamp)
      : (runRecord.updated_at ? Date.parse(String(runRecord.updated_at)) : null),
    workspace_path: runRecord.workspace_path ?? "",
    ...sourceMeta,
    ticket_repo_url: fallbackRepoUrl,
  };
}

async function listRunsFromDb() {
  const db = await getDatabasePool();
  if (!db) return [];
  const result = await db.query(
    `
      SELECT
        run_id,
        project_id,
        ticket_id,
        ticket_source,
        ticket_title,
        status,
        current_step,
        total_steps,
        plan_classification,
        workspace_path,
        branch,
        pr_url,
        total_tokens,
        total_cost_usd,
        created_at,
        updated_at,
        completed_at,
        error
      FROM runs
    `
  );
  const runs = await Promise.all(result.rows.map((runRecord) => loadRunSummaryFromDbRecord(runRecord)));
  runs.sort((a, b) => (b.last_event_ts ?? 0) - (a.last_event_ts ?? 0));
  return runs;
}

async function loadRunFromDb(projectId, runId) {
  const runRecord = await getDbRunRecord(projectId, runId);
  if (!runRecord) {
    throw new Error(`Run not found: ${projectId}/${runId}`);
  }
  const summary = await loadRunSummaryFromDbRecord(runRecord);
  const events = await readEventsFromDb(runRecord.run_id);
  const planEvent = events.find((e) => e.event_type === "task.plan_generated");
  const db = await getDatabasePool();
  const stepResults = await db.query(
    `
      SELECT DISTINCT ON (step_number) step_number, result
      FROM step_results
      WHERE run_id = $1
      ORDER BY step_number ASC, step_attempt DESC
    `,
    [runRecord.run_id]
  );
  const summaryByStep = new Map(
    stepResults.rows.map((row) => [row.step_number, extractResultSummaryText(row.result)])
  );

  return {
    ...summary,
    steps: (summary.steps ?? []).map((step) => ({
      ...step,
      result_summary: summaryByStep.get(step.step_number) ?? null,
    })),
    plan: planEvent?.data?.plan ?? null,
    step_models: {},
  };
}

async function readLogTextFromDb(projectId, runId, kind, lines = 400, stepNumber = null) {
  const runRecord = await getDbRunRecord(projectId, runId);
  if (!runRecord) {
    throw new Error(`Run not found: ${projectId}/${runId}`);
  }
  const db = await getDatabasePool();

  if (kind === "agent_result") {
    const hasStep = Number.isFinite(stepNumber);
    const params = hasStep ? [runRecord.run_id, stepNumber] : [runRecord.run_id];
    const whereStep = hasStep ? "AND step_number = $2" : "";
    const result = await db.query(
      `
        SELECT result
        FROM step_results
        WHERE run_id = $1
        ${whereStep}
        ORDER BY step_number DESC, step_attempt DESC
        LIMIT 1
      `,
      params
    );
    const row = result.rows[0];
    if (!row) return "";
    return trimToLineCount(JSON.stringify(row.result ?? {}, null, 2), lines);
  }

  if (!["planner_stdout", "planner_stderr", "agent_stdout", "agent_stderr"].includes(kind)) {
    return "";
  }

  const isPlanner = kind.startsWith("planner_");
  const where = ["run_id = $1", "stream = 'activity'"];
  const params = [runRecord.run_id];
  const hasStepFilter = Number.isFinite(stepNumber);

  if (hasStepFilter) {
    params.push(stepNumber);
    where.push(`step_number = $${params.length}`);
  }

  if (isPlanner) {
    where.push("agent = 'planner'");
  } else {
    where.push("agent <> 'planner'");
  }

  if (hasStepFilter) {
    const attemptRows = await db.query(
      `
        SELECT MAX(step_attempt) AS step_attempt
        FROM run_logs
        WHERE run_id = $1
          AND stream = 'activity'
          AND step_number = $2
          AND ${isPlanner ? "agent = 'planner'" : "agent <> 'planner'"}
      `,
      [runRecord.run_id, stepNumber]
    );
    const latestAttempt = Number(attemptRows.rows?.[0]?.step_attempt ?? 0);
    if (!Number.isFinite(latestAttempt) || latestAttempt <= 0) {
      return "";
    }
    params.push(latestAttempt);
    where.push(`step_attempt = $${params.length}`);
  }

  const chunks = await db.query(
    `
      SELECT chunk
      FROM run_logs
      WHERE ${where.join(" AND ")}
      ORDER BY ${hasStepFilter ? "sequence ASC" : "step_number ASC, step_attempt ASC, sequence ASC"}
      LIMIT 50000
    `,
    params
  );
  const text = chunks.rows.map((row) => String(row.chunk ?? "")).join("");
  return trimToLineCount(text, lines);
}

async function readNewEventsFromDbSince(runIdOrNull, cursor) {
  const db = await getDatabasePool();
  if (!db) return { events: [], cursor };
  const cursorReceivedAt = toIsoTimestamp(cursor?.receivedAtIso) ?? new Date(0).toISOString();
  const cursorEventId = String(cursor?.eventId ?? "");
  const where = ["(received_at > $1 OR (received_at = $1 AND event_id > $2))"];
  const params = [cursorReceivedAt, cursorEventId];
  if (runIdOrNull) {
    params.push(runIdOrNull);
    where.push(`run_id = $${params.length}`);
  }
  const result = await db.query(
    `
      SELECT event_type, timestamp, data, received_at, event_id
      FROM events
      WHERE ${where.join(" AND ")}
      ORDER BY received_at ASC, event_id ASC
      LIMIT 500
    `,
    params
  );
  const events = result.rows
    .map((row) => normalizeMonitorEvent(row))
    .filter(Boolean);
  const lastRow = result.rows.at(-1);
  return {
    events,
    cursor: {
      receivedAtIso: toIsoTimestamp(lastRow?.received_at) ?? cursorReceivedAt,
      eventId: String(lastRow?.event_id ?? cursorEventId),
    },
  };
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
      const key = `${projectId}/${summary.run_id}`;
      const existing = byKey.get(key);
      if (!existing || Number(summary.last_event_ts ?? 0) >= Number(existing.last_event_ts ?? 0)) {
        byKey.set(key, summary);
      }
    }
  }

  const sessions = await listSessionMetadata();
  for (const session of sessions) {
    const runId = session?.run_id;
    const projectId = session?.project_id;
    const workspacePath = session?.workspace_path;
    if (!runId || !projectId || !workspacePath) continue;
    const summary = await loadRunSummary(projectId, runId, workspacePath, session);
    const key = `${projectId}/${summary.run_id}`;
    if (!byKey.has(key)) {
      byKey.set(key, summary);
    }
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
  const runIdCandidates = buildRunIdCandidates(runId);
  for (const runIdCandidate of runIdCandidates) {
    const runPath = safeJoin(runsRoot, projectId, runIdCandidate);
    const exists = await fs.stat(runPath).then((s) => s.isDirectory(), () => false);
    if (exists) return runPath;
  }

  const sessions = await listSessionMetadata();
  const canonicalRunId = canonicalizeRunId(runId);
  const match = sessions.find(
    (s) =>
      s?.project_id === projectId &&
      (
        runIdCandidates.includes(String(s?.run_id ?? "")) ||
        canonicalizeRunId(s?.run_id) === canonicalRunId
      ) &&
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
    if (t === "step.failed") return "failed";
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

function buildStepStatus(plan, events, options = {}) {
  const resumeSteps = options?.resumeSteps instanceof Set ? options.resumeSteps : new Set();
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
      resumed: resumeSteps.has(step.step_number),
      resume_with_prompt: false,
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
        resumed: resumeSteps.has(stepNum),
        resume_with_prompt: false,
      });
    }
    const st = byStep.get(stepNum);
    const runtimeSkills = extractRuntimeSkills(data.runtime_metadata);
    if (runtimeSkills) {
      st.runtime_skills = runtimeSkills;
    }
    if (typeof data.operator_prompt === "string" && data.operator_prompt.trim()) {
      st.resumed = true;
      st.resume_with_prompt = true;
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

function extractRunResumeMetadata(events) {
  const resumedStartEvents = events.filter(
    (evt) =>
      evt?.event_type === "task.started" &&
      evt?.data &&
      typeof evt.data === "object" &&
      evt.data.resumed === true
  );
  const resumeSteps = resumedStartEvents
    .map((evt) => Number(evt?.data?.resume_step))
    .filter((step) => Number.isInteger(step) && step > 0);
  const uniqueResumeSteps = [...new Set(resumeSteps)];
  return {
    resumed: resumedStartEvents.length > 0,
    resumed_count: resumedStartEvents.length,
    resume_step: uniqueResumeSteps.length ? uniqueResumeSteps[uniqueResumeSteps.length - 1] : null,
    resume_steps: uniqueResumeSteps,
  };
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
  const canonicalRunId = resolveCanonicalRunId(runId, events, session);
  const planEvent = events.find((e) => e.event_type === "task.plan_generated");
  const plan = planEvent?.data?.plan ?? null;
  const resumeMeta = extractRunResumeMetadata(events);
  const steps = buildStepStatus(plan, events, { resumeSteps: new Set(resumeMeta.resume_steps) });
  const last = events.at(-1);
  const hasEvents = events.length > 0;
  const projectRepoUrl = await getProjectRepoUrl(projectId);
  const sourceMeta = extractRunSourceMetadata(events, session, projectRepoUrl);
  const fallbackRepoUrl = sourceMeta.ticket_repo_url ?? await getWorkspaceRepoUrl(runPath);
  return {
    project_id: projectId,
    run_id: canonicalRunId,
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
    ...resumeMeta,
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

async function listRunsSelected() {
  if (useDatabaseBackend) return listRunsFromDb();
  return listRuns();
}

async function loadRunSelected(projectId, runId) {
  if (useDatabaseBackend) return loadRunFromDb(projectId, runId);
  return loadRun(projectId, runId);
}

async function listEventsSelected(projectId, runId, limit) {
  if (useDatabaseBackend) {
    const runRecord = await getDbRunRecord(projectId, runId);
    if (!runRecord) {
      throw new Error(`Run not found: ${projectId}/${runId}`);
    }
    return readEventsFromDb(runRecord.run_id, limit);
  }
  const runPath = await resolveRunPath(projectId, runId);
  const events = await readEvents(runPath);
  return events.slice(Math.max(0, events.length - limit));
}

async function readLogTextSelected(projectId, runId, kind, lines, stepNumber = null) {
  if (useDatabaseBackend) return readLogTextFromDb(projectId, runId, kind, lines, stepNumber);
  return readLogText(projectId, runId, kind, lines, stepNumber);
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

async function startDatabaseSSEFeed(project, run, res) {
  const cleanups = [];
  let targetRunId = null;

  if (project && run) {
    const runRecord = await getDbRunRecord(project, run);
    if (!runRecord) {
      return () => {
        for (const cleanup of cleanups) {
          try { cleanup(); } catch { /* best effort */ }
        }
      };
    }
    targetRunId = runRecord.run_id;
  }

  let redisAttached = false;
  if (redisUrl) {
    try {
      const createClient = await getRedisSubscriberFactory();
      if (createClient) {
        const subscriber = createClient();
        await subscriber.connect();
        const onMessage = (message) => {
          try {
            const parsed = JSON.parse(String(message ?? ""));
            const normalized = normalizeMonitorEvent(parsed);
            if (normalized) {
              sseWrite(res, "event", normalized);
            }
          } catch {
            // Invalid payload from pubsub; skip.
          }
        };
        if (targetRunId) {
          const channel = `sprintfoundry:events:${targetRunId}`;
          await subscriber.subscribe(channel, onMessage);
        } else {
          await subscriber.pSubscribe("sprintfoundry:events:*", onMessage);
        }
        cleanups.push(() => {
          void subscriber.quit().catch(() => undefined);
        });
        redisAttached = true;
      }
    } catch {
      // Redis unavailable; fallback to polling DB.
    }
  }

  if (!redisAttached) {
    let polling = false;
    let cursor = { receivedAtIso: new Date().toISOString(), eventId: "" };
    const pollHandle = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const { events, cursor: nextCursor } = await readNewEventsFromDbSince(targetRunId, cursor);
        cursor = nextCursor;
        for (const event of events) {
          sseWrite(res, "event", event);
        }
      } catch {
        // Transient poll failure; skip this tick.
      } finally {
        polling = false;
      }
    }, SSE_POLL_MS);
    cleanups.push(() => clearInterval(pollHandle));
  }

  return () => {
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* best effort */ }
    }
  };
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = reqUrl.pathname;

  try {
    const isApiRoute = pathname.startsWith("/api/");
    const isWebhookRoute = pathname === "/api/webhooks/github" || pathname === "/api/webhooks/linear";
    if (isApiRoute && !isWebhookRoute) {
      const method = String(req.method ?? "GET").toUpperCase();
      const isWriteScope = method !== "GET" && method !== "HEAD";
      const authResult = authorizeApiRequest(req, reqUrl, isWriteScope ? "write" : "read");
      if (!authResult.ok) {
        sendJson(res, authResult.status, { error: authResult.error });
        return;
      }
    }

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
      const runs = await listRunsSelected();
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
      const data = await loadRunSelected(project, run);
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
      const events = await listEventsSelected(project, run, limit);
      sendJson(res, 200, { events });
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

      let stopSelectedFeed = () => undefined;
      if (useDatabaseBackend) {
        stopSelectedFeed = await startDatabaseSSEFeed(project, run, res);
      } else {
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
        stopSelectedFeed = () => {
          for (const file of watchedFiles) {
            stopSSEWatcher(file, res);
          }
        };
      }

      // Also send periodic run summary refreshes so the list view stays current
      const summaryInterval = setInterval(async () => {
        try {
          const runs = await listRunsSelected();
          sseWrite(res, "runs", { runs });
        } catch {
          // Transient failure — skip this tick
        }
      }, 5000);

      req.on("close", () => {
        sseClients.delete(res);
        clearInterval(summaryInterval);
        stopSelectedFeed();
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
      const text = await readLogTextSelected(project, run, kind, lines, Number.isFinite(stepNumber) ? stepNumber : null);
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
      let body = "";
      try {
        body = await readBody(req, {
          maxBytes: monitorApiMaxBodyBytes,
          timeoutMs: monitorBodyReadTimeoutMs,
        });
      } catch (err) {
        sendBodyReadError(res, err);
        return;
      }
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

    if (pathname === "/api/run/resume" && req.method === "POST") {
      let body = "";
      try {
        body = await readBody(req, {
          maxBytes: monitorApiMaxBodyBytes,
          timeoutMs: monitorBodyReadTimeoutMs,
        });
      } catch (err) {
        sendBodyReadError(res, err);
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }

      const project = String(payload?.project ?? "").trim();
      const runId = String(payload?.run ?? "").trim();
      if (!project || !runId) {
        sendJson(res, 400, { error: "Missing project or run" });
        return;
      }

      let step = null;
      if (payload?.step != null && String(payload.step).trim() !== "") {
        const parsedStep = Number(payload.step);
        if (!Number.isInteger(parsedStep) || parsedStep <= 0) {
          sendJson(res, 400, { error: "step must be a positive integer" });
          return;
        }
        step = parsedStep;
      }

      const prompt =
        typeof payload?.prompt === "string"
          ? payload.prompt.trim()
          : "";
      if (payload?.prompt != null && typeof payload.prompt !== "string") {
        sendJson(res, 400, { error: "prompt must be a string" });
        return;
      }

      let canonicalRunId = canonicalizeRunId(runId) || runId;
      // Validate the run exists before spawning the command.
      try {
        const runPath = await resolveRunPath(project, runId);
        const summary = await loadRunSummary(project, runId, runPath);
        if (typeof summary?.run_id === "string" && summary.run_id.trim()) {
          canonicalRunId = summary.run_id.trim();
        }
      } catch {
        sendJson(res, 404, { error: "Run not found" });
        return;
      }
      const projectArg = await getProjectArgForProjectId(project);
      const args = ["dev", "--", "resume", canonicalRunId, "--config", configRoot];
      if (projectArg) {
        args.push("--project", projectArg);
      }
      if (step != null) {
        args.push("--step", String(step));
      }
      if (prompt) {
        args.push("--prompt", prompt);
      }

      let pid = null;
      await new Promise((resolve, reject) => {
        const child = spawn("pnpm", args, {
          cwd: repoRoot,
          env: process.env,
          detached: true,
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          pid = child.pid ?? null;
          resolve(null);
        });
      });

      sendJson(res, 202, {
        ok: true,
        queued: true,
        pid,
        command: `pnpm ${args.join(" ")}`,
        project,
        run: canonicalRunId,
        ...(step != null ? { step } : {}),
        ...(prompt ? { prompt_provided: true } : {}),
      });
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
  console.log(`[monitor] Data source: ${selectedDataSourceLabel}`);
  console.log(`[monitor] Watching runs under: ${runsRoot}`);
  if (monitorAuthRequired) {
    console.log("[monitor] API authentication enabled");
  } else {
    console.warn("[monitor] API authentication disabled (SPRINTFOUNDRY_MONITOR_AUTH_REQUIRED=0)");
  }
});

if (webhookServer) {
  webhookServer.listen(webhookPort, "127.0.0.1", () => {
    const actualWebhookPort = webhookServer.address()?.port ?? webhookPort;
    console.log(`[monitor] Webhook server listening at http://127.0.0.1:${actualWebhookPort}`);
  });
}
