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

function get(url: string): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
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
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body).toString(),
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

  await new Promise<void>((resolve, reject) => {
    serverProcess = spawn("node", [serverMjs], {
      env: {
        ...process.env,
        MONITOR_PORT: "0",
        SPRINTFOUNDRY_RUNS_ROOT: tmpRunsRoot,
        SPRINTFOUNDRY_SESSIONS_DIR: tmpSessionsRoot,
        SPRINTFOUNDRY_CONFIG_DIR: tmpConfigRoot,
        SPRINTFOUNDRY_AUTORUN_DRY_RUN: "1",
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
    expect(data.project_id).toBe("monitor-test-project");
    expect(data.ticket_id).toBe("42");
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
    expect(JSON.parse(body).error).toMatch(/invalid webhook signature/i);
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
    expect(data.reason).toBe("duplicate_event");
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
    expect(data.project_id).toBe("monitor-linear-project");
    expect(data.ticket_id).toBe("SPR-123");
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
    expect(JSON.parse(body).error).toMatch(/invalid webhook signature/i);
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
    expect(data.reason).toBe("duplicate_event");
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
    expect(data.project_id).toBe("monitor-test-project");
  });

  it("does not expose monitor APIs on webhook port", async () => {
    const { status } = await get(`${splitWebhookBase}/api/runs`);
    expect(status).toBe(404);
  });
});
