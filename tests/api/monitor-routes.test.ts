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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverMjs = path.resolve(__dirname, "../../monitor/server.mjs");
let BASE = "";
let tmpRunsRoot = "";
let tmpSessionsRoot = "";
let tmpWorkspacesRoot = "";

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

let serverProcess: ChildProcess;

beforeAll(async () => {
  tmpRunsRoot = mkdtempSync(path.join(os.tmpdir(), "sf-monitor-runs-"));
  tmpSessionsRoot = mkdtempSync(path.join(os.tmpdir(), "sf-monitor-sessions-"));
  tmpWorkspacesRoot = mkdtempSync(path.join(os.tmpdir(), "sf-monitor-workspaces-"));

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
