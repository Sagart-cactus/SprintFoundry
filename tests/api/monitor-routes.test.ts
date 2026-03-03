/**
 * API tests for monitor/server.mjs — v3 default, v1/v2 removal.
 * Sprint: SPR-5 (default monitor to v3, remove v1 and v2 routes).
 *
 * These tests spawn the monitor server on a random port and verify:
 *  - GET / serves v3 HTML
 *  - GET /v2 and /v2/* return 404
 *  - GET /v3 still works as a legacy alias
 *  - All API endpoints respond with correct status codes
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import net from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverMjs = path.resolve(__dirname, "../../monitor/server.mjs");
let BASE = "";
let tmpRunsRoot = "";
let tmpSessionsRoot = "";
let tmpWorkspacesRoot = "";
let tmpConfigRoot = "";
const MONITOR_API_TOKEN = "monitor-read-token";
const MONITOR_WRITE_TOKEN = "monitor-write-token";

function buildAuthHeader(token: string | null | undefined = MONITOR_API_TOKEN): Record<string, string> {
  if (!token) return {};
  return { authorization: `Bearer ${token}` };
}

function get(
  url: string,
  opts: { headers?: Record<string, string>; authToken?: string | null } = {}
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { ...buildAuthHeader(opts.authToken), ...(opts.headers ?? {}) } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body,
          contentType: String(res.headers["content-type"] ?? ""),
        })
      );
    }).on("error", reject);
  });
}

function post(
  url: string,
  body: string,
  headers: Record<string, string> = {},
  opts: { authToken?: string | null } = {}
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body).toString(),
          ...buildAuthHeader(opts.authToken),
          ...headers,
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: responseBody,
            contentType: String(res.headers["content-type"] ?? ""),
          })
        );
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function githubSignature(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function linearSignature(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

let serverProcess: ChildProcess;

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve port")));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

beforeAll(async () => {
  tmpRunsRoot = mkdtempSync(path.join(os.tmpdir(), "sf-monitor-runs-"));
  tmpSessionsRoot = mkdtempSync(path.join(os.tmpdir(), "sf-monitor-sessions-"));
  tmpWorkspacesRoot = mkdtempSync(path.join(os.tmpdir(), "sf-monitor-workspaces-"));
  tmpConfigRoot = mkdtempSync(path.join(os.tmpdir(), "sf-monitor-config-"));

  writeFileSync(
    path.join(tmpConfigRoot, "project.yaml"),
    [
      "project_id: monitor-test-project",
      "name: Monitor Test Project",
      "repo:",
      "  url: git@github.com:acme/monitor-test.git",
      "  default_branch: main",
      "api_keys:",
      "  anthropic: test",
      "branch_strategy:",
      "  prefix: feat/",
      "  include_ticket_id: true",
      "  naming: kebab-case",
      "integrations:",
      "  ticket_source:",
      "    type: github",
      "    config:",
      "      token: test",
      "      owner: acme",
      "      repo: monitor-test",
      "rules: []",
      "autoexecute:",
      "  enabled: true",
      "  github:",
      "    enabled: true",
      "    webhook_secret: test-secret",
      "    allowed_events:",
      "      - issues.opened",
      "      - issues.labeled",
      "      - issue_comment.created",
      "    label_trigger: sf:auto-run",
      "    command_trigger: /sf-run",
      "    require_command: false",
      "    dedupe_window_minutes: 30",
      "",
    ].join("\n"),
    "utf-8"
  );

  writeFileSync(
    path.join(tmpConfigRoot, "project-linear.yaml"),
    [
      "project_id: monitor-linear-project",
      "name: Monitor Linear Project",
      "repo:",
      "  url: git@github.com:acme/linear-test.git",
      "  default_branch: main",
      "api_keys:",
      "  anthropic: test",
      "branch_strategy:",
      "  prefix: feat/",
      "  include_ticket_id: true",
      "  naming: kebab-case",
      "integrations:",
      "  ticket_source:",
      "    type: linear",
      "    config:",
      "      api_key: linear-key",
      "      team_id: spr",
      "rules: []",
      "autoexecute:",
      "  enabled: true",
      "  linear:",
      "    enabled: true",
      "    webhook_secret: linear-test-secret",
      "    allowed_events:",
      "      - Issue.create",
      "    dedupe_window_minutes: 30",
      "    max_timestamp_age_seconds: 600",
      "",
    ].join("\n"),
    "utf-8"
  );

  writeFileSync(
    path.join(tmpConfigRoot, "named-github.yaml"),
    [
      "project_id: monitor-named-github-project",
      "name: Monitor Named GitHub Project",
      "repo:",
      "  url: git@github.com:acme/monitor-named.git",
      "  default_branch: main",
      "api_keys:",
      "  anthropic: test",
      "branch_strategy:",
      "  prefix: feat/",
      "  include_ticket_id: true",
      "  naming: kebab-case",
      "integrations:",
      "  ticket_source:",
      "    type: github",
      "    config:",
      "      token: test",
      "      owner: acme",
      "      repo: monitor-named",
      "rules: []",
      "autoexecute:",
      "  enabled: true",
      "  github:",
      "    enabled: true",
      "    webhook_secret: named-secret",
      "    allowed_events:",
      "      - issues.opened",
      "    require_command: false",
      "    dedupe_window_minutes: 30",
      "",
    ].join("\n"),
    "utf-8"
  );

  writeFileSync(
    path.join(tmpConfigRoot, "project-github-defaults.yaml"),
    [
      "project_id: monitor-default-github-project",
      "name: Monitor Default GitHub Project",
      "repo:",
      "  url: git@github.com:acme/default-secure.git",
      "  default_branch: main",
      "api_keys:",
      "  anthropic: test",
      "branch_strategy:",
      "  prefix: feat/",
      "  include_ticket_id: true",
      "  naming: kebab-case",
      "integrations:",
      "  ticket_source:",
      "    type: github",
      "    config:",
      "      token: test",
      "      owner: acme",
      "      repo: default-secure",
      "rules: []",
      "autoexecute:",
      "  enabled: true",
      "  github:",
      "    enabled: true",
      "    webhook_secret: default-secret",
      "",
    ].join("\n"),
    "utf-8"
  );

  writeFileSync(
    path.join(tmpConfigRoot, "project-linear-no-team.yaml"),
    [
      "project_id: monitor-linear-no-team-project",
      "name: Monitor Linear No Team Project",
      "repo:",
      "  url: git@github.com:acme/linear-no-team.git",
      "  default_branch: main",
      "api_keys:",
      "  anthropic: test",
      "branch_strategy:",
      "  prefix: feat/",
      "  include_ticket_id: true",
      "  naming: kebab-case",
      "integrations:",
      "  ticket_source:",
      "    type: linear",
      "    config:",
      "      api_key: linear-key",
      "rules: []",
      "autoexecute:",
      "  enabled: true",
      "  linear:",
      "    enabled: true",
      "    webhook_secret: linear-no-team-secret",
      "    allowed_events:",
      "      - Issue.create",
      "",
    ].join("\n"),
    "utf-8"
  );

  // Regular run under runsRoot
  const regularRunDir = path.join(tmpRunsRoot, "regular-project", "run-regular");
  mkdirSync(regularRunDir, { recursive: true });
  writeFileSync(
    path.join(regularRunDir, ".events.jsonl"),
    JSON.stringify({ event_type: "task.created", timestamp: new Date().toISOString(), data: {} }) + "\n",
    "utf-8"
  );

  // Run with runtime skills metadata embedded in step events
  const skillsRunDir = path.join(tmpRunsRoot, "skills-project", "run-skills");
  mkdirSync(skillsRunDir, { recursive: true });
  writeFileSync(
    path.join(skillsRunDir, ".events.jsonl"),
    [
      JSON.stringify({ event_type: "task.created", timestamp: "2026-03-01T00:00:00Z", data: {} }),
      JSON.stringify({
        event_type: "task.plan_generated",
        timestamp: "2026-03-01T00:00:10Z",
        data: {
          plan: {
            steps: [{ step_number: 1, agent: "developer", task: "Implement feature" }],
          },
        },
      }),
      JSON.stringify({
        event_type: "step.started",
        timestamp: "2026-03-01T00:01:00Z",
        data: {
          step: 1,
          agent: "developer",
          runtime_metadata: {
            provider_metadata: {
              skills: {
                names: ["secure-api", "code-quality"],
                warnings: ["Skill count 2 exceeds recommended threshold 1 for codex"],
                hashes: { "secure-api": "a1b2c3d4" },
                provider: "codex",
                skills_dir: ".codex-home/skills",
              },
            },
          },
        },
      }),
      JSON.stringify({
        event_type: "step.completed",
        timestamp: "2026-03-01T00:02:00Z",
        data: {
          step: 1,
          tokens: 123,
          runtime_metadata: {
            provider_metadata: {
              skills: {
                names: ["secure-api", "code-quality"],
                warnings: [],
                hashes: { "secure-api": "a1b2c3d4", "code-quality": "ddee1122" },
                provider: "codex",
                skills_dir: ".codex-home/skills",
              },
            },
          },
        },
      }),
    ].join("\n") + "\n",
    "utf-8"
  );

  // Run with explicit webhook trigger metadata
  const webhookRunDir = path.join(tmpRunsRoot, "webhook-project", "run-webhook");
  mkdirSync(webhookRunDir, { recursive: true });
  writeFileSync(
    path.join(webhookRunDir, ".events.jsonl"),
    [
      JSON.stringify({
        event_type: "task.created",
        timestamp: "2026-03-01T01:00:00Z",
        data: { ticketId: "22", source: "github", trigger_source: "github_webhook" },
      }),
      JSON.stringify({
        event_type: "task.created",
        timestamp: "2026-03-01T01:00:02Z",
        data: {
          source: "github",
          trigger_source: "github_webhook",
          ticket_url: "https://github.com/acme/monitor-test/issues/22",
          ticket: {
            id: "#22",
            source: "github",
            title: "Webhook-triggered test issue",
            raw: {
              html_url: "https://github.com/acme/monitor-test/issues/22",
              repository_url: "https://api.github.com/repos/acme/monitor-test",
            },
          },
        },
      }),
      JSON.stringify({
        event_type: "task.plan_generated",
        timestamp: "2026-03-01T01:00:05Z",
        data: { plan: { plan_id: "plan-1", ticket_id: "#22", classification: "infrastructure", steps: [] } },
      }),
    ].join("\n") + "\n",
    "utf-8"
  );

  // Run where repo URL should come from project config (not ticket raw payload)
  const configRepoRunDir = path.join(tmpRunsRoot, "monitor-test-project", "run-config-repo");
  mkdirSync(configRepoRunDir, { recursive: true });
  writeFileSync(
    path.join(configRepoRunDir, ".events.jsonl"),
    [
      JSON.stringify({
        event_type: "task.created",
        timestamp: "2026-03-01T01:10:00Z",
        data: { ticketId: "SPR-555", source: "linear", trigger_source: "linear_webhook" },
      }),
      JSON.stringify({
        event_type: "task.created",
        timestamp: "2026-03-01T01:10:02Z",
        data: {
          source: "linear",
          trigger_source: "linear_webhook",
          ticket: {
            id: "SPR-555",
            source: "linear",
            title: "Config repo fallback test",
            raw: {
              url: "https://linear.app/acme/issue/SPR-555/config-repo-fallback-test",
            },
          },
        },
      }),
      JSON.stringify({
        event_type: "task.plan_generated",
        timestamp: "2026-03-01T01:10:05Z",
        data: { plan: { plan_id: "plan-repo", ticket_id: "SPR-555", classification: "infrastructure", steps: [] } },
      }),
    ].join("\n") + "\n",
    "utf-8"
  );

  // Run with resume metadata
  const resumedRunDir = path.join(tmpRunsRoot, "resume-project", "run-resumed");
  mkdirSync(resumedRunDir, { recursive: true });
  writeFileSync(
    path.join(resumedRunDir, ".events.jsonl"),
    [
      JSON.stringify({
        event_type: "task.created",
        timestamp: "2026-03-01T02:00:00Z",
        data: { source: "prompt" },
      }),
      JSON.stringify({
        event_type: "task.plan_generated",
        timestamp: "2026-03-01T02:00:02Z",
        data: {
          plan: {
            plan_id: "plan-resume",
            classification: "bug_fix",
            steps: [
              { step_number: 1, agent: "qa", task: "Run checks", context_inputs: [{ type: "ticket" }], depends_on: [], estimated_complexity: "low" },
              { step_number: 2, agent: "qa", task: "Validate output", context_inputs: [{ type: "ticket" }], depends_on: [1], estimated_complexity: "low" },
            ],
          },
        },
      }),
      JSON.stringify({
        event_type: "step.started",
        timestamp: "2026-03-01T02:00:10Z",
        data: { step: 1, agent: "qa", task: "Run checks" },
      }),
      JSON.stringify({
        event_type: "step.completed",
        timestamp: "2026-03-01T02:00:12Z",
        data: { step: 1, tokens: 11 },
      }),
      JSON.stringify({
        event_type: "step.started",
        timestamp: "2026-03-01T02:00:14Z",
        data: { step: 2, agent: "qa", task: "Validate output" },
      }),
      JSON.stringify({
        event_type: "step.failed",
        timestamp: "2026-03-01T02:00:16Z",
        data: { step: 2, error: "forced failure" },
      }),
      JSON.stringify({
        event_type: "task.failed",
        timestamp: "2026-03-01T02:00:17Z",
        data: { error: "step failed" },
      }),
      JSON.stringify({
        event_type: "task.started",
        timestamp: "2026-03-01T02:00:20Z",
        data: { resumed: true, resume_step: 2 },
      }),
      JSON.stringify({
        event_type: "step.started",
        timestamp: "2026-03-01T02:00:22Z",
        data: { step: 2, agent: "qa", task: "Validate output", operator_prompt: "Re-check edge cases" },
      }),
    ].join("\n") + "\n",
    "utf-8"
  );

  // Session-backed run with workspace path outside runsRoot
  const externalWorkspace = path.join(tmpWorkspacesRoot, "run-session-only");
  mkdirSync(externalWorkspace, { recursive: true });
  writeFileSync(
    path.join(externalWorkspace, ".events.jsonl"),
    [
      JSON.stringify({ event_type: "task.created", timestamp: "2026-02-28T00:00:00Z", data: {} }),
      JSON.stringify({ event_type: "step.started", timestamp: "2026-02-28T00:01:00Z", data: { step: 1 } }),
    ].join("\n") + "\n",
    "utf-8"
  );
  writeFileSync(
    path.join(tmpSessionsRoot, "run-session-only.json"),
    JSON.stringify(
      {
        run_id: "run-session-only",
        project_id: "session-only-project",
        ticket_id: "PROMPT-1",
        ticket_source: "prompt",
        ticket_title: "Session-backed run",
        status: "executing",
        current_step: 1,
        total_steps: 3,
        plan_classification: "new_feature",
        workspace_path: externalWorkspace,
        branch: null,
        pr_url: null,
        total_tokens: 0,
        total_cost_usd: 0,
        created_at: "2026-02-28T00:00:00Z",
        updated_at: "2026-02-28T00:01:00Z",
        completed_at: null,
        error: null,
      },
      null,
      2
    ),
    "utf-8"
  );

  // Worktree-style run directory names are `run-${run_id}` (e.g. run-run-abc123).
  // Session metadata stores canonical run ids (e.g. run-abc123).
  // Monitor should dedupe these and resolve both forms.
  const aliasedRunDir = path.join(tmpRunsRoot, "aliased-project", "run-run-alias-123");
  mkdirSync(aliasedRunDir, { recursive: true });
  writeFileSync(
    path.join(aliasedRunDir, ".events.jsonl"),
    [
      JSON.stringify({
        run_id: "run-alias-123",
        event_type: "task.created",
        timestamp: "2026-03-01T03:00:00Z",
        data: {},
      }),
      JSON.stringify({
        run_id: "run-alias-123",
        event_type: "task.plan_generated",
        timestamp: "2026-03-01T03:00:02Z",
        data: { plan: { classification: "bug_fix", steps: [] } },
      }),
    ].join("\n") + "\n",
    "utf-8"
  );
  writeFileSync(
    path.join(tmpSessionsRoot, "run-alias-123.json"),
    JSON.stringify(
      {
        run_id: "run-alias-123",
        project_id: "aliased-project",
        ticket_id: "ALIAS-1",
        ticket_source: "prompt",
        ticket_title: "Aliased run",
        status: "planning",
        current_step: 0,
        total_steps: 0,
        plan_classification: "bug_fix",
        workspace_path: aliasedRunDir,
        branch: null,
        pr_url: null,
        total_tokens: 0,
        total_cost_usd: 0,
        created_at: "2026-03-01T03:00:00Z",
        updated_at: "2026-03-01T03:00:02Z",
        completed_at: null,
        error: null,
      },
      null,
      2
    ),
    "utf-8"
  );

  await new Promise<void>((resolve, reject) => {
    serverProcess = spawn("node", [serverMjs], {
      env: {
        ...process.env,
        MONITOR_PORT: "0",
        SPRINTFOUNDRY_RUNS_ROOT: tmpRunsRoot,
        SPRINTFOUNDRY_SESSIONS_DIR: tmpSessionsRoot,
        SPRINTFOUNDRY_CONFIG_DIR: tmpConfigRoot,
        SPRINTFOUNDRY_AUTORUN_DRY_RUN: "1",
        SPRINTFOUNDRY_MONITOR_API_TOKEN: MONITOR_API_TOKEN,
        SPRINTFOUNDRY_MONITOR_WRITE_TOKEN: MONITOR_WRITE_TOKEN,
        SPRINTFOUNDRY_MONITOR_WEBHOOK_MAX_BODY_BYTES: "65536",
        SPRINTFOUNDRY_MONITOR_API_MAX_BODY_BYTES: "65536",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => reject(new Error("Server start timeout")), 5000);
    let stderrOutput = "";
    serverProcess.stdout?.on("data", (data: Buffer) => {
      const output = data.toString();
      const match = output.match(/listening at http:\/\/([\d.]+):(\d+)/);
      if (match) {
        BASE = `http://${match[1]}:${match[2]}`;
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.stderr?.on("data", (data: Buffer) => {
      stderrOutput += data.toString();
    });
    serverProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    serverProcess.on("exit", (code) => {
      if (!BASE) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code} before ready: ${stderrOutput}`));
      }
    });
  });
});

afterAll(() => {
  serverProcess?.kill();
  if (tmpRunsRoot) rmSync(tmpRunsRoot, { recursive: true, force: true });
  if (tmpSessionsRoot) rmSync(tmpSessionsRoot, { recursive: true, force: true });
  if (tmpWorkspacesRoot) rmSync(tmpWorkspacesRoot, { recursive: true, force: true });
  if (tmpConfigRoot) rmSync(tmpConfigRoot, { recursive: true, force: true });
});

describe("GET / — v3 default route", () => {
  it("returns HTTP 200", async () => {
    const { status } = await get(`${BASE}/`);
    expect(status).toBe(200);
  });

  it("returns text/html content-type", async () => {
    const { contentType } = await get(`${BASE}/`);
    expect(contentType).toMatch(/text\/html/);
  });

  it("serves v3 HTML (title contains 'Run Monitor')", async () => {
    const { body } = await get(`${BASE}/`);
    expect(body).toContain("<title>");
    // v3 index.html must be served (not v1/v2)
    expect(body).not.toContain("Run Monitor v2");
    expect(body).not.toContain("public-v2");
  });
});

describe("GET /v2 — removed route", () => {
  it("returns HTTP 404 for /v2", async () => {
    const { status } = await get(`${BASE}/v2`);
    expect(status).toBe(404);
  });

  it("returns HTTP 404 for /v2/run subpath", async () => {
    const { status } = await get(`${BASE}/v2/run?project=foo&run=bar`);
    expect(status).toBe(404);
  });

  it("body mentions /v2 removal", async () => {
    const { body } = await get(`${BASE}/v2`);
    expect(body).toMatch(/\/v2 has been removed/i);
  });
});

describe("GET /v3 — legacy alias", () => {
  it("returns HTTP 200 for /v3", async () => {
    const { status } = await get(`${BASE}/v3`);
    expect(status).toBe(200);
  });

  it("serves the same v3 HTML as /", async () => {
    const [root, v3] = await Promise.all([get(`${BASE}/`), get(`${BASE}/v3`)]);
    expect(root.status).toBe(200);
    expect(v3.status).toBe(200);
    // Both should have identical body
    expect(v3.body).toBe(root.body);
  });
});

describe("GET /api/runs", () => {
  it("returns HTTP 200 with JSON", async () => {
    const { status, contentType, body } = await get(`${BASE}/api/runs`);
    expect(status).toBe(200);
    expect(contentType).toMatch(/application\/json/);
    const data = JSON.parse(body);
    expect(data).toHaveProperty("runs");
    expect(Array.isArray(data.runs)).toBe(true);
  });

  it("includes session-backed runs that are outside runs root", async () => {
    const { body } = await get(`${BASE}/api/runs`);
    const data = JSON.parse(body);
    const run = data.runs.find((r: any) => r.run_id === "run-session-only");
    expect(run).toBeDefined();
    expect(run.project_id).toBe("session-only-project");
  });

  it("includes resume metadata in run summaries", async () => {
    const { body } = await get(`${BASE}/api/runs`);
    const data = JSON.parse(body);
    const resumed = data.runs.find((r: any) => r.run_id === "run-resumed");
    expect(resumed).toBeDefined();
    expect(resumed.resumed).toBe(true);
    expect(resumed.resumed_count).toBe(1);
    expect(resumed.resume_step).toBe(2);
    expect(resumed.resume_steps).toEqual([2]);
  });

  it("deduplicates run-run directory aliases to canonical run ids", async () => {
    const { body } = await get(`${BASE}/api/runs`);
    const data = JSON.parse(body);
    const aliased = data.runs.filter((r: any) => r.project_id === "aliased-project");
    expect(aliased).toHaveLength(1);
    expect(aliased[0].run_id).toBe("run-alias-123");
  });
});

describe("GET /api/run", () => {
  it("returns 400 when project/run params are missing", async () => {
    const { status, body } = await get(`${BASE}/api/run`);
    expect(status).toBe(400);
    expect(JSON.parse(body)).toHaveProperty("error");
  });

  it("loads a session-backed run via workspace path fallback", async () => {
    const { status, body } = await get(`${BASE}/api/run?project=session-only-project&run=run-session-only`);
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.run_id).toBe("run-session-only");
    expect(data.project_id).toBe("session-only-project");
  });

  it("includes runtime skill summary on step objects when runtime metadata is present", async () => {
    const { status, body } = await get(`${BASE}/api/run?project=skills-project&run=run-skills`);
    expect(status).toBe(200);
    const data = JSON.parse(body);
    const step = data.steps?.find((s: any) => s.step_number === 1);
    expect(step).toBeDefined();
    expect(step.runtime_skills).toBeDefined();
    expect(step.runtime_skills.names).toEqual(["secure-api", "code-quality"]);
    expect(step.runtime_skills.provider).toBe("codex");
    expect(step.runtime_skills.hashes).toMatchObject({
      "secure-api": "a1b2c3d4",
      "code-quality": "ddee1122",
    });
  });

  it("includes webhook trigger source and ticket URL metadata when present in events", async () => {
    const { status, body } = await get(`${BASE}/api/run?project=webhook-project&run=run-webhook`);
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.ticket_source).toBe("github");
    expect(data.trigger_source).toBe("github_webhook");
    expect(data.ticket_id).toBe("#22");
    expect(data.ticket_url).toBe("https://github.com/acme/monitor-test/issues/22");
    expect(data.ticket_repo_url).toBe("https://github.com/acme/monitor-test");
  });

  it("uses project config repo URL for ticket_repo_url when available", async () => {
    const { status, body } = await get(`${BASE}/api/run?project=monitor-test-project&run=run-config-repo`);
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.ticket_source).toBe("linear");
    expect(data.trigger_source).toBe("linear_webhook");
    expect(data.ticket_id).toBe("SPR-555");
    expect(data.ticket_url).toBe("https://linear.app/acme/issue/SPR-555/config-repo-fallback-test");
    expect(data.ticket_repo_url).toBe("https://github.com/acme/monitor-test");
  });

  it("marks resumed runs and resumed steps from resume events", async () => {
    const { status, body } = await get(`${BASE}/api/run?project=resume-project&run=run-resumed`);
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.resumed).toBe(true);
    expect(data.resumed_count).toBe(1);
    expect(data.resume_step).toBe(2);
    const resumedStep = data.steps?.find((s: any) => s.step_number === 2);
    expect(resumedStep).toBeDefined();
    expect(resumedStep.resumed).toBe(true);
    expect(resumedStep.resume_with_prompt).toBe(true);
  });

  it("resolves canonical and run-run ids for the same aliased run", async () => {
    const canonical = await get(`${BASE}/api/run?project=aliased-project&run=run-alias-123`);
    const legacy = await get(`${BASE}/api/run?project=aliased-project&run=run-run-alias-123`);

    expect(canonical.status).toBe(200);
    expect(legacy.status).toBe(200);

    const canonicalBody = JSON.parse(canonical.body);
    const legacyBody = JSON.parse(legacy.body);
    expect(canonicalBody.run_id).toBe("run-alias-123");
    expect(legacyBody.run_id).toBe("run-alias-123");
    expect(canonicalBody.workspace_path).toBe(legacyBody.workspace_path);
  });
});

describe("POST /api/run/resume", () => {
  it("canonicalizes run-run aliases before enqueueing resume", async () => {
    const payload = JSON.stringify({
      project: "aliased-project",
      run: "run-run-alias-123",
    });
    const { status, body } = await post(
      `${BASE}/api/run/resume`,
      payload,
      {},
      { authToken: MONITOR_WRITE_TOKEN }
    );
    expect(status).toBe(202);
    const data = JSON.parse(body);
    expect(data.run).toBe("run-alias-123");
    expect(String(data.command)).toContain("resume run-alias-123");
  });
});

describe("GET /api/events", () => {
  it("returns 400 when project/run params are missing", async () => {
    const { status, body } = await get(`${BASE}/api/events`);
    expect(status).toBe(400);
    expect(JSON.parse(body)).toHaveProperty("error");
  });

  it("loads events for session-backed run via workspace path fallback", async () => {
    const { status, body } = await get(
      `${BASE}/api/events?project=session-only-project&run=run-session-only&limit=20`
    );
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(Array.isArray(data.events)).toBe(true);
    expect(data.events.length).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/log", () => {
  it("returns 400 when project/run/kind params are missing", async () => {
    const { status, body } = await get(`${BASE}/api/log`);
    expect(status).toBe(400);
    expect(JSON.parse(body)).toHaveProperty("error");
  });
});

describe("GET /api/files", () => {
  it("returns 400 when project/run params are missing", async () => {
    const { status, body } = await get(`${BASE}/api/files`);
    expect(status).toBe(400);
    expect(JSON.parse(body)).toHaveProperty("error");
  });
});

describe("GET /api/step-result", () => {
  it("returns 400 when project/run/step params are missing", async () => {
    const { status, body } = await get(`${BASE}/api/step-result`);
    expect(status).toBe(400);
    expect(JSON.parse(body)).toHaveProperty("error");
  });
});

describe("Monitor API authentication", () => {
  it("rejects unauthenticated monitor API requests", async () => {
    const { status, body } = await get(`${BASE}/api/runs`, { authToken: null });
    expect(status).toBe(401);
    expect(JSON.parse(body).error).toMatch(/unauthorized/i);
  });

  it("rejects monitor API requests with invalid token", async () => {
    const { status, body } = await get(`${BASE}/api/runs`, { authToken: "wrong-token" });
    expect(status).toBe(403);
    expect(JSON.parse(body).error).toMatch(/forbidden/i);
  });

  it("requires write token for review decision endpoint", async () => {
    const payload = JSON.stringify({
      project: "regular-project",
      run: "run-regular",
      review_id: "review-1",
      decision: "approved",
      feedback: "Looks good",
    });

    const denied = await post(`${BASE}/api/review/decide`, payload, {}, { authToken: MONITOR_API_TOKEN });
    expect(denied.status).toBe(403);

    const allowed = await post(`${BASE}/api/review/decide`, payload, {}, { authToken: MONITOR_WRITE_TOKEN });
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body)).toMatchObject({ ok: true });
  });

  it("requires write token for run resume endpoint", async () => {
    const payload = JSON.stringify({});

    const denied = await post(`${BASE}/api/run/resume`, payload, {}, { authToken: MONITOR_API_TOKEN });
    expect(denied.status).toBe(403);

    const allowed = await post(`${BASE}/api/run/resume`, payload, {}, { authToken: MONITOR_WRITE_TOKEN });
    expect(allowed.status).toBe(400);
  });

  it("rejects oversized monitor API payloads", async () => {
    const payload = JSON.stringify({
      project: "regular-project",
      run: "run-regular",
      review_id: "review-2",
      decision: "rejected",
      feedback: "x".repeat(70_000),
    });
    const resp = await post(`${BASE}/api/review/decide`, payload, {}, { authToken: MONITOR_WRITE_TOKEN });
    expect(resp.status).toBe(413);
  });
});

describe("POST /api/webhooks/github", () => {
  it("accepts a valid signed issues.opened event and queues execution", async () => {
    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 42, updated_at: "2026-03-01T10:00:00Z" },
      repository: { name: "monitor-test", owner: { login: "acme" } },
    });
    const signature = githubSignature(payload, "test-secret");
    const { status, body } = await post(`${BASE}/api/webhooks/github`, payload, {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": signature,
    });
    expect(status).toBe(202);
    const data = JSON.parse(body);
    expect(data.accepted).toBe(true);
    expect(data.queued).toBe(true);
    expect(data.dry_run).toBe(true);
  });

  it("rejects request with invalid signature", async () => {
    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 99, updated_at: "2026-03-01T10:05:00Z" },
      repository: { name: "monitor-test", owner: { login: "acme" } },
    });
    const { status, body } = await post(`${BASE}/api/webhooks/github`, payload, {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-bad-signature",
      "x-hub-signature-256": "sha256=invalid",
    });
    expect(status).toBe(401);
    expect(JSON.parse(body).error).toMatch(/unauthorized/i);
  });

  it("dedupes repeated delivery IDs", async () => {
    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 77, updated_at: "2026-03-01T10:10:00Z" },
      repository: { name: "monitor-test", owner: { login: "acme" } },
    });
    const signature = githubSignature(payload, "test-secret");

    const first = await post(`${BASE}/api/webhooks/github`, payload, {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-dup-1",
      "x-hub-signature-256": signature,
    });
    expect(first.status).toBe(202);
    expect(JSON.parse(first.body).accepted).toBe(true);

    const second = await post(`${BASE}/api/webhooks/github`, payload, {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-dup-1",
      "x-hub-signature-256": signature,
    });
    expect(second.status).toBe(202);
    const data = JSON.parse(second.body);
    expect(data.ignored).toBe(true);
    expect(data.accepted).toBe(false);
  });

  it("persists delivery dedupe state across monitor restarts", async () => {
    const startEphemeral = () =>
      new Promise<{ proc: ChildProcess; base: string }>((resolve, reject) => {
        const proc = spawn("node", [serverMjs], {
          env: {
            ...process.env,
            MONITOR_PORT: "0",
            SPRINTFOUNDRY_RUNS_ROOT: tmpRunsRoot,
            SPRINTFOUNDRY_SESSIONS_DIR: tmpSessionsRoot,
            SPRINTFOUNDRY_CONFIG_DIR: tmpConfigRoot,
            SPRINTFOUNDRY_AUTORUN_DRY_RUN: "1",
            SPRINTFOUNDRY_MONITOR_API_TOKEN: MONITOR_API_TOKEN,
            SPRINTFOUNDRY_MONITOR_WRITE_TOKEN: MONITOR_WRITE_TOKEN,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const timeout = setTimeout(() => reject(new Error("Ephemeral server start timeout")), 5000);
        let stderrOutput = "";
        proc.stdout?.on("data", (data: Buffer) => {
          const out = data.toString();
          const match = out.match(/listening at http:\/\/([\d.]+):(\d+)/);
          if (!match) return;
          clearTimeout(timeout);
          resolve({ proc, base: `http://${match[1]}:${match[2]}` });
        });
        proc.stderr?.on("data", (data: Buffer) => {
          stderrOutput += data.toString();
        });
        proc.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        proc.on("exit", (code) => {
          clearTimeout(timeout);
          if (code !== null && code !== 0) {
            reject(new Error(`Ephemeral server exited with code ${code}: ${stderrOutput}`));
          }
        });
      });

    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 78, updated_at: "2026-03-01T10:11:00Z" },
      repository: { name: "monitor-test", owner: { login: "acme" } },
    });
    const signature = githubSignature(payload, "test-secret");
    const delivery = "delivery-persisted-1";

    const s1 = await startEphemeral();
    const first = await post(`${s1.base}/api/webhooks/github`, payload, {
      "x-github-event": "issues",
      "x-github-delivery": delivery,
      "x-hub-signature-256": signature,
    });
    expect(first.status).toBe(202);
    expect(JSON.parse(first.body)).toMatchObject({ accepted: true });
    s1.proc.kill();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const s2 = await startEphemeral();
    const second = await post(`${s2.base}/api/webhooks/github`, payload, {
      "x-github-event": "issues",
      "x-github-delivery": delivery,
      "x-hub-signature-256": signature,
    });
    expect(second.status).toBe(202);
    expect(JSON.parse(second.body)).toMatchObject({ accepted: false, ignored: true });
    s2.proc.kill();
  });

  it("loads autoexecute config from <name>.yaml project files", async () => {
    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 111, updated_at: "2026-03-01T10:30:00Z" },
      repository: { name: "monitor-named", owner: { login: "acme" } },
    });
    const signature = githubSignature(payload, "named-secret");
    const { status, body } = await post(`${BASE}/api/webhooks/github`, payload, {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-named-yaml-1",
      "x-hub-signature-256": signature,
    });
    expect(status).toBe(202);
    const data = JSON.parse(body);
    expect(data.accepted).toBe(true);
  });

  it("requires x-github-delivery header", async () => {
    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 7, updated_at: "2026-03-01T10:45:00Z" },
      repository: { name: "monitor-test", owner: { login: "acme" } },
    });
    const signature = githubSignature(payload, "test-secret");
    const { status, body } = await post(`${BASE}/api/webhooks/github`, payload, {
      "x-github-event": "issues",
      "x-hub-signature-256": signature,
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/bad request/i);
  });

  it("uses secure defaults: issues.opened ignored when defaults are active", async () => {
    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 222, updated_at: "2026-03-01T11:00:00Z" },
      repository: { name: "default-secure", owner: { login: "acme" } },
    });
    const signature = githubSignature(payload, "default-secret");
    const { status, body } = await post(`${BASE}/api/webhooks/github`, payload, {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-default-opened",
      "x-hub-signature-256": signature,
    });
    expect(status).toBe(202);
    const data = JSON.parse(body);
    expect(data.accepted).toBe(false);
    expect(data.ignored).toBe(true);
  });

  it("uses secure defaults: issue comment command triggers run", async () => {
    const payload = JSON.stringify({
      action: "created",
      issue: { number: 223, updated_at: "2026-03-01T11:01:00Z" },
      comment: { body: "please run /sf-run now" },
      repository: { name: "default-secure", owner: { login: "acme" } },
    });
    const signature = githubSignature(payload, "default-secret");
    const { status, body } = await post(`${BASE}/api/webhooks/github`, payload, {
      "x-github-event": "issue_comment",
      "x-github-delivery": "delivery-default-comment",
      "x-hub-signature-256": signature,
    });
    expect(status).toBe(202);
    const data = JSON.parse(body);
    expect(data.accepted).toBe(true);
    expect(data.queued).toBe(true);
  });

  it("rejects oversized webhook payloads", async () => {
    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 5001,
        updated_at: "2026-03-01T11:05:00Z",
        body: "x".repeat(70_000),
      },
      repository: { name: "monitor-test", owner: { login: "acme" } },
    });
    const signature = githubSignature(payload, "test-secret");
    const { status } = await post(`${BASE}/api/webhooks/github`, payload, {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-too-large",
      "x-hub-signature-256": signature,
    });
    expect(status).toBe(413);
  });
});

describe("POST /api/webhooks/linear", () => {
  it("accepts a valid signed Issue.create event and queues execution", async () => {
    const payload = JSON.stringify({
      action: "create",
      type: "Issue",
      webhookId: "linear-delivery-1",
      webhookTimestamp: Date.now(),
      data: {
        id: "c73ba7db-e726-40bd-9b08-87b82acd80c6",
        identifier: "SPR-123",
        teamId: "spr",
      },
    });
    const signature = linearSignature(payload, "linear-test-secret");
    const { status, body } = await post(`${BASE}/api/webhooks/linear`, payload, {
      "linear-signature": signature,
    });
    expect(status).toBe(202);
    const data = JSON.parse(body);
    expect(data.accepted).toBe(true);
    expect(data.queued).toBe(true);
    expect(data.dry_run).toBe(true);
  });

  it("rejects request with invalid signature", async () => {
    const payload = JSON.stringify({
      action: "create",
      type: "Issue",
      webhookId: "linear-delivery-invalid-sig",
      webhookTimestamp: Date.now(),
      data: {
        id: "issue-2",
        identifier: "SPR-124",
        teamId: "spr",
      },
    });
    const { status, body } = await post(`${BASE}/api/webhooks/linear`, payload, {
      "linear-signature": "invalid",
    });
    expect(status).toBe(401);
    expect(JSON.parse(body).error).toMatch(/unauthorized/i);
  });

  it("dedupes repeated webhookId values", async () => {
    const payload = JSON.stringify({
      action: "create",
      type: "Issue",
      webhookId: "linear-delivery-dup-1",
      webhookTimestamp: Date.now(),
      data: {
        id: "issue-dup",
        identifier: "SPR-130",
        teamId: "spr",
      },
    });
    const signature = linearSignature(payload, "linear-test-secret");

    const first = await post(`${BASE}/api/webhooks/linear`, payload, {
      "linear-signature": signature,
    });
    expect(first.status).toBe(202);
    expect(JSON.parse(first.body).accepted).toBe(true);

    const second = await post(`${BASE}/api/webhooks/linear`, payload, {
      "linear-signature": signature,
    });
    expect(second.status).toBe(202);
    const data = JSON.parse(second.body);
    expect(data.ignored).toBe(true);
    expect(data.accepted).toBe(false);
  });

  it("requires webhookId for replay-safe dedupe", async () => {
    const payload = JSON.stringify({
      action: "create",
      type: "Issue",
      webhookTimestamp: Date.now(),
      data: {
        id: "issue-missing-delivery",
        identifier: "SPR-131",
        teamId: "spr",
      },
    });
    const signature = linearSignature(payload, "linear-test-secret");
    const { status, body } = await post(`${BASE}/api/webhooks/linear`, payload, {
      "linear-signature": signature,
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/bad request/i);
  });

  it("ignores linear projects without team_id/team_key (strict matching)", async () => {
    const payload = JSON.stringify({
      action: "create",
      type: "Issue",
      webhookId: "linear-nomatch-1",
      webhookTimestamp: Date.now(),
      data: {
        id: "issue-no-team-match",
        identifier: "ZZZ-1",
        teamId: "zzz",
      },
    });
    const signature = linearSignature(payload, "linear-no-team-secret");
    const { status, body } = await post(`${BASE}/api/webhooks/linear`, payload, {
      "linear-signature": signature,
    });
    expect(status).toBe(202);
    expect(JSON.parse(body)).toMatchObject({ accepted: false, ignored: true });
  });
});

describe("GET /api/autoexecute/queue", () => {
  it("returns queue status and execution history", async () => {
    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 501, updated_at: "2026-03-01T10:20:00Z" },
      repository: { name: "monitor-test", owner: { login: "acme" } },
    });
    const signature = githubSignature(payload, "test-secret");
    await post(`${BASE}/api/webhooks/github`, payload, {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-history-1",
      "x-hub-signature-256": signature,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const { status, body } = await get(`${BASE}/api/autoexecute/queue`);
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data).toHaveProperty("queue_depth");
    expect(data).toHaveProperty("running");
    expect(data).toHaveProperty("dry_run", true);
    expect(Array.isArray(data.history)).toBe(true);
    expect(data.history.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Split monitor/webhook ports", () => {
  let splitMonitorBase = "";
  let splitWebhookBase = "";
  let splitServerProcess: ChildProcess | null = null;

  beforeAll(async () => {
    const monitorPort = await reservePort();
    let webhookPort = await reservePort();
    if (webhookPort === monitorPort) {
      webhookPort = await reservePort();
    }

    splitMonitorBase = `http://127.0.0.1:${monitorPort}`;
    splitWebhookBase = `http://127.0.0.1:${webhookPort}`;

    await new Promise<void>((resolve, reject) => {
      splitServerProcess = spawn("node", [serverMjs], {
        env: {
          ...process.env,
          MONITOR_PORT: String(monitorPort),
          SPRINTFOUNDRY_WEBHOOK_PORT: String(webhookPort),
          SPRINTFOUNDRY_RUNS_ROOT: tmpRunsRoot,
          SPRINTFOUNDRY_SESSIONS_DIR: tmpSessionsRoot,
          SPRINTFOUNDRY_CONFIG_DIR: tmpConfigRoot,
          SPRINTFOUNDRY_AUTORUN_DRY_RUN: "1",
          SPRINTFOUNDRY_MONITOR_API_TOKEN: MONITOR_API_TOKEN,
          SPRINTFOUNDRY_MONITOR_WRITE_TOKEN: MONITOR_WRITE_TOKEN,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timeout = setTimeout(() => reject(new Error("Split server start timeout")), 5000);
      let stderrOutput = "";
      let monitorReady = false;
      let webhookReady = false;
      splitServerProcess?.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        if (output.includes(`Run Monitor listening at http://127.0.0.1:${monitorPort}`)) {
          monitorReady = true;
        }
        if (output.includes(`Webhook server listening at http://127.0.0.1:${webhookPort}`)) {
          webhookReady = true;
        }
        if (monitorReady && webhookReady) {
          clearTimeout(timeout);
          resolve();
        }
      });
      splitServerProcess?.stderr?.on("data", (data: Buffer) => {
        stderrOutput += data.toString();
      });
      splitServerProcess?.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      splitServerProcess?.on("exit", (code) => {
        if (!(monitorReady && webhookReady)) {
          clearTimeout(timeout);
          reject(new Error(`Split server exited with code ${code} before ready: ${stderrOutput}`));
        }
      });
    });
  });

  afterAll(() => {
    splitServerProcess?.kill();
    splitServerProcess = null;
  });

  it("keeps monitor APIs on monitor port", async () => {
    const { status } = await get(`${splitMonitorBase}/api/runs`);
    expect(status).toBe(200);
  });

  it("rejects webhook routes on monitor port when split is enabled", async () => {
    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 321, updated_at: "2026-03-01T12:00:00Z" },
      repository: { name: "monitor-test", owner: { login: "acme" } },
    });
    const signature = githubSignature(payload, "test-secret");
    const { status, body } = await post(`${splitMonitorBase}/api/webhooks/github`, payload, {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-split-monitor-port",
      "x-hub-signature-256": signature,
    });
    expect(status).toBe(404);
    expect(JSON.parse(body).error).toMatch(/dedicated webhook port/i);
  });

  it("accepts webhook routes on webhook port", async () => {
    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 322, updated_at: "2026-03-01T12:01:00Z" },
      repository: { name: "monitor-test", owner: { login: "acme" } },
    });
    const signature = githubSignature(payload, "test-secret");
    const { status, body } = await post(`${splitWebhookBase}/api/webhooks/github`, payload, {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-split-webhook-port",
      "x-hub-signature-256": signature,
    });
    expect(status).toBe(202);
    const data = JSON.parse(body);
    expect(data.accepted).toBe(true);
  });

  it("does not expose monitor APIs on webhook port", async () => {
    const { status } = await get(`${splitWebhookBase}/api/runs`);
    expect(status).toBe(404);
  });
});
