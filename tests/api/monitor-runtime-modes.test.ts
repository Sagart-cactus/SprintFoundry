import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import os from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  truncateSync,
} from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const serverMjs = path.resolve(repoRoot, "monitor/server.mjs");
const pgModuleDir = path.join(repoRoot, "node_modules", "pg");
const redisModuleDir = path.join(repoRoot, "node_modules", "redis");

class MockResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  ended = false;

  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    for (const [key, value] of Object.entries(headers)) {
      this.headers[key.toLowerCase()] = String(value);
    }
  }

  write(chunk: string) {
    this.body += chunk;
    return true;
  }

  end(chunk = "") {
    if (chunk) this.body += chunk;
    this.ended = true;
    this.emit("finish");
  }
}

function installMockDbModules() {
  mkdirSync(pgModuleDir, { recursive: true });
  writeFileSync(
    path.join(pgModuleDir, "package.json"),
    JSON.stringify({ name: "pg", version: "0.0.0-test", type: "module", exports: "./index.js" }, null, 2),
    "utf-8",
  );
  writeFileSync(
    path.join(pgModuleDir, "index.js"),
    `import { readFileSync, appendFileSync } from "node:fs";
const fixturePath = process.env.SF_MOCK_DB_FIXTURE_PATH;
const queryLogPath = process.env.SF_MOCK_DB_QUERY_LOG_PATH;

function loadFixture() {
  if (!fixturePath) return { runs: [], events: [], step_results: [], run_logs: [] };
  return JSON.parse(readFileSync(fixturePath, "utf-8"));
}

function logQuery(sql, params) {
  if (!queryLogPath) return;
  appendFileSync(queryLogPath, JSON.stringify({ sql: String(sql), params }) + "\\n", "utf-8");
}

function toMs(value) {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : 0;
}

function cmpEventsAsc(a, b) {
  const tsA = toMs(a.timestamp);
  const tsB = toMs(b.timestamp);
  if (tsA !== tsB) return tsA - tsB;
  const recA = toMs(a.received_at);
  const recB = toMs(b.received_at);
  if (recA !== recB) return recA - recB;
  return Number(a.event_id ?? 0) - Number(b.event_id ?? 0);
}

function cmpEventsDesc(a, b) {
  return -cmpEventsAsc(a, b);
}

export class Pool {
  async query(sql, params = []) {
    const norm = String(sql).replace(/\\s+/g, " ").trim().toLowerCase();
    logQuery(sql, params);
    const fixture = loadFixture();

    if (norm.includes("from runs where project_id = $1 and run_id = $2")) {
      const row = fixture.runs.find((r) => r.project_id === params[0] && r.run_id === params[1]);
      return { rows: row ? [row] : [] };
    }

    if (norm.includes("from runs") && !norm.includes("where project_id = $1 and run_id = $2")) {
      return { rows: fixture.runs.slice() };
    }

    if (norm.includes("from events") && norm.includes("where received_at > $1")) {
      const cursor = String(params[0] ?? "");
      const runId = params[1] != null ? String(params[1]) : null;
      const rows = fixture.events
        .filter((e) => !runId || e.run_id === runId)
        .filter((e) => String(e.received_at ?? "") > cursor)
        .sort(cmpEventsAsc)
        .map((e) => ({ event_type: e.event_type, timestamp: e.timestamp, data: e.data, received_at: e.received_at }));
      return { rows };
    }

    if (norm.includes("from events") && norm.includes("where run_id = $1")) {
      const runId = String(params[0] ?? "");
      const rows = fixture.events.filter((e) => e.run_id === runId);
      if (norm.includes("limit $2")) {
        const limit = Number(params[1] ?? 0);
        const bounded = rows.sort(cmpEventsDesc).slice(0, Math.max(0, limit)).sort(cmpEventsAsc);
        return { rows: bounded.map((e) => ({ event_type: e.event_type, timestamp: e.timestamp, data: e.data })) };
      }
      return { rows: rows.sort(cmpEventsAsc).map((e) => ({ event_type: e.event_type, timestamp: e.timestamp, data: e.data })) };
    }

    if (norm.includes("select distinct on (step_number)") && norm.includes("from step_results")) {
      const runId = String(params[0] ?? "");
      const latestByStep = new Map();
      for (const row of fixture.step_results.filter((r) => r.run_id === runId)) {
        const existing = latestByStep.get(row.step_number);
        if (!existing || Number(row.step_attempt ?? 0) >= Number(existing.step_attempt ?? 0)) {
          latestByStep.set(row.step_number, row);
        }
      }
      return {
        rows: Array.from(latestByStep.values())
          .sort((a, b) => Number(a.step_number) - Number(b.step_number))
          .map((r) => ({ step_number: r.step_number, result: r.result })),
      };
    }

    if (norm.includes("from step_results") && norm.includes("order by step_number desc")) {
      const runId = String(params[0] ?? "");
      const stepNumber = params.length > 1 ? Number(params[1]) : null;
      const rows = fixture.step_results
        .filter((r) => r.run_id === runId)
        .filter((r) => stepNumber == null || Number(r.step_number) === stepNumber)
        .sort((a, b) => {
          const stepCmp = Number(b.step_number) - Number(a.step_number);
          if (stepCmp !== 0) return stepCmp;
          return Number(b.step_attempt ?? 0) - Number(a.step_attempt ?? 0);
        })
        .slice(0, 1)
        .map((r) => ({ result: r.result }));
      return { rows };
    }

    if (norm.includes("from run_logs")) {
      const runId = String(params[0] ?? "");
      const plannerOnly = norm.includes("agent = 'planner'");
      const nonPlannerOnly = norm.includes("agent <> 'planner'");
      let stepNumber = null;
      const stepMatch = norm.match(/step_number = \$(\d+)/);
      if (stepMatch) {
        const idx = Number(stepMatch[1]) - 1;
        stepNumber = Number(params[idx]);
      }

      const rows = fixture.run_logs
        .filter((r) => r.run_id === runId)
        .filter((r) => String(r.stream) === "activity")
        .filter((r) => !plannerOnly || String(r.agent) === "planner")
        .filter((r) => !nonPlannerOnly || String(r.agent) !== "planner")
        .filter((r) => stepNumber == null || Number(r.step_number) === stepNumber)
        .sort((a, b) => {
          const stepCmp = Number(a.step_number) - Number(b.step_number);
          if (stepCmp !== 0) return stepCmp;
          const attemptCmp = Number(a.step_attempt ?? 0) - Number(b.step_attempt ?? 0);
          if (attemptCmp !== 0) return attemptCmp;
          return Number(a.sequence ?? 0) - Number(b.sequence ?? 0);
        })
        .map((r) => ({ chunk: r.chunk }));
      return { rows };
    }

    return { rows: [] };
  }
}
`,
    "utf-8",
  );

  mkdirSync(redisModuleDir, { recursive: true });
  writeFileSync(
    path.join(redisModuleDir, "package.json"),
    JSON.stringify({ name: "redis", version: "0.0.0-test", type: "module", exports: "./index.js" }, null, 2),
    "utf-8",
  );
  writeFileSync(
    path.join(redisModuleDir, "index.js"),
    `import { appendFileSync } from "node:fs";
const redisLogPath = process.env.SF_MOCK_REDIS_LOG_PATH;
const redisEventPayload = process.env.SF_MOCK_REDIS_EVENT;

function log(line) {
  if (!redisLogPath) return;
  appendFileSync(redisLogPath, line + "\\n", "utf-8");
}

function maybePublish(handler) {
  if (!redisEventPayload) return;
  setTimeout(() => {
    handler(redisEventPayload);
  }, 120);
}

export function createClient() {
  return {
    async connect() {
      log("connect");
    },
    async subscribe(channel, handler) {
      log("subscribe:" + channel);
      maybePublish(handler);
    },
    async pSubscribe(pattern, handler) {
      log("psubscribe:" + pattern);
      maybePublish(handler);
    },
    async quit() {
      log("quit");
    },
  };
}
`,
    "utf-8",
  );
}

function removeMockDbModules() {
  rmSync(pgModuleDir, { recursive: true, force: true });
  rmSync(redisModuleDir, { recursive: true, force: true });
}

function parseSse(raw: string): Array<{ event?: string; data: string }> {
  return raw
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .filter((chunk) => !chunk.startsWith(":"))
    .map((chunk) => {
      const lines = chunk.split("\n");
      const evt = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "";
      return { event: evt, data };
    })
    .filter((msg) => msg.data.length > 0);
}

async function loadMonitorHandler(envOverrides: Record<string, string>) {
  vi.resetModules();
  vi.unmock("node:http");

  const handlers: Array<(req: any, res: any) => Promise<void> | void> = [];
  vi.doMock("node:http", () => {
    function createServer(handler: (req: any, res: any) => Promise<void> | void) {
      handlers.push(handler);
      const server = {
        on: () => server,
        listen: (...args: any[]) => {
          const maybeCb = args.at(-1);
          if (typeof maybeCb === "function") maybeCb();
          return server;
        },
        address: () => ({ port: 4310 }),
      };
      return server;
    }
    return { default: { createServer }, createServer };
  });

  for (const [key, value] of Object.entries(envOverrides)) {
    process.env[key] = value;
  }

  const moduleUrl = `${pathToFileURL(serverMjs).href}?test=${Date.now()}-${Math.random()}`;
  await import(moduleUrl);

  const handler = handlers[0];
  if (!handler) {
    throw new Error("failed to capture monitor route handler");
  }
  return handler;
}

async function request(handler: (req: any, res: any) => Promise<void> | void, url: string) {
  const req = new EventEmitter() as any;
  req.url = url;
  req.method = "GET";
  req.headers = { host: "localhost" };

  const res = new MockResponse();
  await handler(req, res as any);
  return { req, res };
}

describe("monitor runtime modes", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "sf-monitor-runtime-modes-"));
  const runsRoot = path.join(tempRoot, "runs");
  const fixturePath = path.join(tempRoot, "db-fixture.json");
  const queryLogPath = path.join(tempRoot, "pg-queries.jsonl");
  const redisLogPath = path.join(tempRoot, "redis.log");

  beforeAll(() => {
    installMockDbModules();
    mkdirSync(runsRoot, { recursive: true });

    const fsRunDir = path.join(runsRoot, "fs-project", "run-fs-001");
    mkdirSync(fsRunDir, { recursive: true });
    writeFileSync(
      path.join(fsRunDir, ".events.jsonl"),
      [
        JSON.stringify({ event_type: "task.created", timestamp: "2026-03-04T01:00:00.000Z", data: { ticket_id: "FS-1" } }),
        JSON.stringify({ event_type: "task.plan_generated", timestamp: "2026-03-04T01:00:01.000Z", data: { plan: { classification: "small", steps: [{ step_number: 1, agent: "developer", task: "do fs" }] } } }),
      ].join("\n") + "\n",
      "utf-8",
    );
    writeFileSync(path.join(fsRunDir, ".planner-runtime.stdout.log"), "planner filesystem log\n", "utf-8");

    writeFileSync(
      fixturePath,
      JSON.stringify(
        {
          runs: [
            {
              run_id: "run-db-001",
              project_id: "db-project",
              ticket_id: "DB-1",
              ticket_source: "jira",
              ticket_title: "Database mode run",
              status: "running",
              current_step: 1,
              total_steps: 1,
              plan_classification: "medium",
              workspace_path: "/tmp/db-run",
              branch: "feat/db",
              pr_url: null,
              total_tokens: 42,
              total_cost_usd: 0.05,
              created_at: "2026-03-04T00:00:00.000Z",
              updated_at: "2026-03-04T00:01:00.000Z",
              completed_at: null,
              error: null,
            },
          ],
          events: [
            {
              event_id: 1,
              run_id: "run-db-001",
              event_type: "task.created",
              timestamp: "2026-03-04T00:00:00.000Z",
              received_at: "2026-03-04T00:00:00.100Z",
              data: { ticket_id: "DB-1", ticket_source: "jira", ticket_title: "Database mode run" },
            },
            {
              event_id: 2,
              run_id: "run-db-001",
              event_type: "task.plan_generated",
              timestamp: "2026-03-04T00:00:05.000Z",
              received_at: "2026-03-04T00:00:05.100Z",
              data: {
                plan: {
                  classification: "medium",
                  steps: [{ step_number: 1, agent: "developer", task: "Implement DB path" }],
                },
              },
            },
            {
              event_id: 3,
              run_id: "run-db-001",
              event_type: "step.completed",
              timestamp: "2026-03-04T00:00:30.000Z",
              received_at: "2026-03-04T00:00:30.100Z",
              data: { step: 1, agent: "developer", status: "completed" },
            },
          ],
          step_results: [
            {
              run_id: "run-db-001",
              step_number: 1,
              step_attempt: 1,
              result: { status: "completed", summary: "DB-backed step summary" },
            },
          ],
          run_logs: [
            {
              run_id: "run-db-001",
              step_number: 0,
              step_attempt: 1,
              sequence: 1,
              stream: "activity",
              agent: "planner",
              chunk: "planner-db-log\\n",
            },
            {
              run_id: "run-db-001",
              step_number: 1,
              step_attempt: 1,
              sequence: 1,
              stream: "activity",
              agent: "developer",
              chunk: "agent-db-log\\n",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    writeFileSync(queryLogPath, "", "utf-8");
    writeFileSync(redisLogPath, "", "utf-8");
  });

  afterAll(() => {
    removeMockDbModules();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("uses runs/events/step_results/run_logs tables and redis pub/sub when DB mode is enabled", async () => {
    truncateSync(queryLogPath, 0);
    truncateSync(redisLogPath, 0);

    const redisEvent = JSON.stringify({
      event_type: "step.completed",
      timestamp: "2026-03-04T00:02:00.000Z",
      data: { step: 1, source: "redis-pubsub" },
    });

    const handler = await loadMonitorHandler({
      MONITOR_PORT: "0",
      SPRINTFOUNDRY_RUNS_ROOT: runsRoot,
      SPRINTFOUNDRY_DATABASE_URL: "postgres://mock-db/sprintfoundry",
      SPRINTFOUNDRY_REDIS_URL: "redis://mock-redis/0",
      SF_MOCK_DB_FIXTURE_PATH: fixturePath,
      SF_MOCK_DB_QUERY_LOG_PATH: queryLogPath,
      SF_MOCK_REDIS_LOG_PATH: redisLogPath,
      SF_MOCK_REDIS_EVENT: redisEvent,
    });

    const runsRes = await request(handler, "/api/runs");
    expect(runsRes.res.statusCode).toBe(200);
    const runsPayload = JSON.parse(runsRes.res.body);
    expect(runsPayload.runs.some((run: { run_id: string }) => run.run_id === "run-db-001")).toBe(true);
    expect(runsPayload.runs.some((run: { run_id: string }) => run.run_id === "run-fs-001")).toBe(false);

    const runRes = await request(handler, "/api/run?project=db-project&run=run-db-001");
    expect(runRes.res.statusCode).toBe(200);
    const runPayload = JSON.parse(runRes.res.body);
    expect(runPayload.plan?.classification).toBe("medium");
    expect(runPayload.steps?.[0]?.result_summary).toBe("DB-backed step summary");

    const eventsRes = await request(handler, "/api/events?project=db-project&run=run-db-001&limit=1");
    expect(eventsRes.res.statusCode).toBe(200);
    const eventsPayload = JSON.parse(eventsRes.res.body);
    expect(eventsPayload.events).toHaveLength(1);
    expect(eventsPayload.events[0].event_type).toBe("step.completed");

    const plannerLogRes = await request(handler, "/api/log?project=db-project&run=run-db-001&kind=planner_stdout&lines=50");
    expect(plannerLogRes.res.statusCode).toBe(200);
    expect(plannerLogRes.res.body).toContain("planner-db-log");

    const agentResultRes = await request(handler, "/api/log?project=db-project&run=run-db-001&kind=agent_result&step=1");
    expect(agentResultRes.res.statusCode).toBe(200);
    expect(agentResultRes.res.body).toContain("DB-backed step summary");

    const sseRes = await request(handler, "/api/events/stream");
    expect(sseRes.res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const sseMessages = parseSse(sseRes.res.body);
    const connected = sseMessages.find((m) => m.event === "connected");
    const streamedEvent = sseMessages.find((m) => m.event === "event");
    expect(connected).toBeDefined();
    expect(streamedEvent).toBeDefined();
    const streamedPayload = JSON.parse(streamedEvent?.data ?? "{}");
    expect(streamedPayload.data?.source).toBe("redis-pubsub");
    sseRes.req.emit("close");

    const redisLog = readFileSync(redisLogPath, "utf-8");
    expect(redisLog.includes("psubscribe:sprintfoundry:events:*") || redisLog.includes("subscribe:sprintfoundry:events:")).toBe(true);

    const queryLog = readFileSync(queryLogPath, "utf-8");
    expect(queryLog).toContain("FROM runs");
    expect(queryLog).toContain("FROM events");
    expect(queryLog).toContain("FROM step_results");
    expect(queryLog).toContain("FROM run_logs");
    expect(queryLog).not.toContain("received_at > $1");
  }, 15_000);

  it("keeps filesystem behavior unchanged when DB mode is disabled", async () => {
    truncateSync(queryLogPath, 0);

    const handler = await loadMonitorHandler({
      MONITOR_PORT: "0",
      SPRINTFOUNDRY_RUNS_ROOT: runsRoot,
      SPRINTFOUNDRY_DATABASE_URL: "",
      SF_MOCK_DB_FIXTURE_PATH: fixturePath,
      SF_MOCK_DB_QUERY_LOG_PATH: queryLogPath,
    });

    const runsRes = await request(handler, "/api/runs");
    expect(runsRes.res.statusCode).toBe(200);
    const runsPayload = JSON.parse(runsRes.res.body);
    expect(runsPayload.runs.some((run: { run_id: string }) => run.run_id === "run-fs-001")).toBe(true);
    expect(runsPayload.runs.some((run: { run_id: string }) => run.run_id === "run-db-001")).toBe(false);

    const eventsRes = await request(handler, "/api/events?project=fs-project&run=run-fs-001&limit=20");
    expect(eventsRes.res.statusCode).toBe(200);
    const eventsPayload = JSON.parse(eventsRes.res.body);
    expect(eventsPayload.events.some((event: { event_type: string }) => event.event_type === "task.plan_generated")).toBe(true);

    const logRes = await request(handler, "/api/log?project=fs-project&run=run-fs-001&kind=planner_stdout&lines=20");
    expect(logRes.res.statusCode).toBe(200);
    expect(logRes.res.body).toContain("planner filesystem log");

    const queryLog = existsSync(queryLogPath) ? readFileSync(queryLogPath, "utf-8") : "";
    expect(queryLog.trim()).toBe("");
  }, 15_000);
});
