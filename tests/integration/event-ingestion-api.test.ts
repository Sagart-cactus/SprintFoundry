import { describe, expect, it } from "vitest";
import { registerEventIngestionRoutes } from "../../src/service/event-ingestion-api.js";

type Handler = (
  req: { headers: Record<string, string | string[] | undefined>; body?: unknown },
  res: TestResponse,
  next: (error?: unknown) => void,
) => void | Promise<void>;

interface TestResponse {
  status(code: number): TestResponse;
  json(body: unknown): void;
}

class FakeExpressApp {
  private readonly routes = new Map<string, Handler[]>();

  post(path: string, ...handlers: Handler[]): void {
    this.routes.set(`POST ${path}`, handlers);
  }

  get(path: string, ...handlers: Handler[]): void {
    this.routes.set(`GET ${path}`, handlers);
  }

  async inject(options: {
    method: "GET" | "POST";
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; body: unknown }> {
    const key = `${options.method} ${options.path}`;
    const handlers = this.routes.get(key);
    if (!handlers) {
      throw new Error(`Route not found: ${key}`);
    }

    let status = 200;
    let responseBody: unknown = undefined;
    let sent = false;

    const req = {
      headers: Object.fromEntries(
        Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body: options.body,
    };

    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(body: unknown) {
        responseBody = body;
        sent = true;
      },
    };

    const runHandler = async (index: number): Promise<void> => {
      const handler = handlers[index];
      if (!handler || sent) return;

      let nextCalled = false;
      const next = (error?: unknown): void => {
        if (error) {
          throw error;
        }
        nextCalled = true;
      };

      await handler(req, res, next);
      if (nextCalled) {
        await runHandler(index + 1);
      }
    };

    await runHandler(0);

    return { status, body: responseBody };
  }
}

interface RunRow {
  run_id: string;
  status: string;
  current_step: number;
}

interface StepRow {
  run_id: string;
  step_number: number;
  step_attempt: number;
  status: string;
  result: Record<string, unknown>;
}

interface LogRow {
  run_id: string;
  step_number: number;
  step_attempt: number;
  sequence: number;
  stream: string;
}

class InMemoryDatabase {
  readonly runs = new Map<string, RunRow>();
  readonly events = new Map<string, { run_id: string; event_type: string }>();
  readonly stepResults = new Map<string, StepRow>();
  readonly logs: LogRow[] = [];
  private readonly logKeys = new Set<string>();
  available = true;

  async query<Row = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
    if (!this.available) {
      throw new Error("db unavailable");
    }

    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("SELECT 1")) {
      return { rows: [{ one: 1 } as Row], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO events")) {
      const eventId = String(params[0]);
      const runId = String(params[1]);
      const eventType = String(params[2]);
      if (this.events.has(eventId)) {
        return { rows: [], rowCount: 0 };
      }
      this.events.set(eventId, { run_id: runId, event_type: eventType });
      return { rows: [{ event_id: eventId } as Row], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO runs")) {
      const runId = String(params[0]);
      const status = String(params[5]);
      const currentStep = Number(params[6]);
      const existed = this.runs.has(runId);
      this.runs.set(runId, { run_id: runId, status, current_step: currentStep });
      return { rows: [{ inserted: !existed } as Row], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO step_results")) {
      const runId = String(params[0]);
      const stepNumber = Number(params[1]);
      const stepAttempt = Number(params[2]);
      const status = String(params[4]);
      const result = JSON.parse(String(params[7])) as Record<string, unknown>;
      const key = `${runId}:${stepNumber}:${stepAttempt}`;
      const existed = this.stepResults.has(key);
      this.stepResults.set(key, {
        run_id: runId,
        step_number: stepNumber,
        step_attempt: stepAttempt,
        status,
        result,
      });
      return { rows: [{ inserted: !existed } as Row], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO run_logs")) {
      const runId = String(params[0]);
      const stepNumber = Number(params[1]);
      const stepAttempt = Number(params[2]);
      const sequence = Number(params[5]);
      const stream = String(params[6]);
      const key = `${runId}:${stepNumber}:${stepAttempt}:${sequence}:${stream}`;
      if (this.logKeys.has(key)) {
        return { rows: [], rowCount: 0 };
      }
      this.logKeys.add(key);
      this.logs.push({
        run_id: runId,
        step_number: stepNumber,
        step_attempt: stepAttempt,
        sequence,
        stream,
      });
      return { rows: [{ id: this.logs.length } as Row], rowCount: 1 };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

class FakeRedisPublisher {
  readonly published: Array<{ channel: string; message: string }> = [];
  available = true;

  async publish(channel: string, message: string): Promise<number> {
    if (!this.available) {
      throw new Error("redis unavailable");
    }
    this.published.push({ channel, message });
    return 1;
  }

  async ping(): Promise<string> {
    if (!this.available) {
      throw new Error("redis unavailable");
    }
    return "PONG";
  }

  async quit(): Promise<void> {
    return;
  }
}

const validToken = "test-token";

function authHeader(token = validToken): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function runPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "run-1",
    project_id: "project-1",
    ticket_id: "TCK-1",
    ticket_source: "github",
    ticket_title: "Example",
    status: "executing",
    current_step: 1,
    total_steps: 3,
    plan_classification: "new_feature",
    workspace_path: "/tmp/workspace",
    branch: "feat/tck-1",
    pr_url: null,
    total_tokens: 42,
    total_cost_usd: 0.12,
    created_at: "2026-03-04T00:00:00.000Z",
    updated_at: "2026-03-04T00:00:01.000Z",
    completed_at: null,
    error: null,
    ...overrides,
  };
}

describe("event-ingestion-api integration", () => {
  it("POST /events writes row and publishes to redis channel", async () => {
    const app = new FakeExpressApp();
    const db = new InMemoryDatabase();
    const redis = new FakeRedisPublisher();

    registerEventIngestionRoutes(app, {
      internalApiToken: validToken,
      database: db,
      redisPublisher: redis,
    });

    await app.inject({
      method: "POST",
      path: "/runs",
      headers: authHeader(),
      body: runPayload(),
    });

    const response = await app.inject({
      method: "POST",
      path: "/events",
      headers: authHeader(),
      body: {
        event_id: "evt-1",
        run_id: "run-1",
        event_type: "step.started",
        timestamp: "2026-03-04T00:00:02.000Z",
        data: { step: 1 },
      },
    });

    expect(response.status).toBe(201);
    expect(db.events.has("evt-1")).toBe(true);
    expect(redis.published).toHaveLength(1);
    expect(redis.published[0]?.channel).toBe("sprintfoundry:events:run-1");
  });

  it("POST /events succeeds when redis is disabled", async () => {
    const app = new FakeExpressApp();
    const db = new InMemoryDatabase();

    registerEventIngestionRoutes(app, {
      internalApiToken: validToken,
      database: db,
      redisPublisher: null,
    });

    await app.inject({ method: "POST", path: "/runs", headers: authHeader(), body: runPayload() });

    const response = await app.inject({
      method: "POST",
      path: "/events",
      headers: authHeader(),
      body: {
        event_id: "evt-2",
        run_id: "run-1",
        event_type: "task.created",
        timestamp: "2026-03-04T00:00:03.000Z",
        data: { source: "github" },
      },
    });

    expect(response.status).toBe(201);
    expect(db.events.has("evt-2")).toBe(true);
  });

  it("POST /runs upserts by run_id", async () => {
    const app = new FakeExpressApp();
    const db = new InMemoryDatabase();

    registerEventIngestionRoutes(app, {
      internalApiToken: validToken,
      database: db,
      redisPublisher: null,
    });

    const insertResponse = await app.inject({
      method: "POST",
      path: "/runs",
      headers: authHeader(),
      body: runPayload({ status: "executing", current_step: 1 }),
    });

    const updateResponse = await app.inject({
      method: "POST",
      path: "/runs",
      headers: authHeader(),
      body: runPayload({ status: "completed", current_step: 3 }),
    });

    const stored = db.runs.get("run-1");
    expect(insertResponse.status).toBe(200);
    expect(updateResponse.status).toBe(200);
    expect(db.runs.size).toBe(1);
    expect(stored?.status).toBe("completed");
    expect(stored?.current_step).toBe(3);
  });

  it("POST /step-results upserts by run_id/step_number/step_attempt", async () => {
    const app = new FakeExpressApp();
    const db = new InMemoryDatabase();

    registerEventIngestionRoutes(app, {
      internalApiToken: validToken,
      database: db,
      redisPublisher: null,
    });

    await app.inject({ method: "POST", path: "/runs", headers: authHeader(), body: runPayload() });

    await app.inject({
      method: "POST",
      path: "/step-results",
      headers: authHeader(),
      body: {
        run_id: "run-1",
        step_number: 1,
        step_attempt: 1,
        agent: "developer",
        status: "failed",
        started_at: "2026-03-04T00:00:04.000Z",
        completed_at: "2026-03-04T00:00:05.000Z",
        result: { summary: "first" },
      },
    });

    await app.inject({
      method: "POST",
      path: "/step-results",
      headers: authHeader(),
      body: {
        run_id: "run-1",
        step_number: 1,
        step_attempt: 1,
        agent: "developer",
        status: "completed",
        started_at: "2026-03-04T00:00:04.000Z",
        completed_at: "2026-03-04T00:00:06.000Z",
        result: { summary: "updated" },
      },
    });

    expect(db.stepResults.size).toBe(1);
    expect(db.stepResults.get("run-1:1:1")?.status).toBe("completed");
    expect(db.stepResults.get("run-1:1:1")?.result.summary).toBe("updated");
  });

  it("POST /logs appends ordered rows and dedupes conflicts", async () => {
    const app = new FakeExpressApp();
    const db = new InMemoryDatabase();

    registerEventIngestionRoutes(app, {
      internalApiToken: validToken,
      database: db,
      redisPublisher: null,
    });

    await app.inject({ method: "POST", path: "/runs", headers: authHeader(), body: runPayload() });

    await app.inject({
      method: "POST",
      path: "/logs",
      headers: authHeader(),
      body: {
        run_id: "run-1",
        step_number: 1,
        step_attempt: 1,
        agent: "developer",
        runtime_provider: "codex",
        sequence: 1,
        stream: "activity",
        chunk: "alpha",
        byte_length: 5,
        is_final: false,
        timestamp: "2026-03-04T00:00:07.000Z",
      },
    });

    await app.inject({
      method: "POST",
      path: "/logs",
      headers: authHeader(),
      body: {
        run_id: "run-1",
        step_number: 1,
        step_attempt: 1,
        agent: "developer",
        runtime_provider: "codex",
        sequence: 2,
        stream: "activity",
        chunk: "beta",
        byte_length: 4,
        is_final: true,
        timestamp: "2026-03-04T00:00:08.000Z",
      },
    });

    const duplicateResponse = await app.inject({
      method: "POST",
      path: "/logs",
      headers: authHeader(),
      body: {
        run_id: "run-1",
        step_number: 1,
        step_attempt: 1,
        agent: "developer",
        runtime_provider: "codex",
        sequence: 2,
        stream: "activity",
        chunk: "beta",
        byte_length: 4,
        is_final: true,
        timestamp: "2026-03-04T00:00:08.000Z",
      },
    });

    const sequences = db.logs.map((log) => log.sequence);
    expect(sequences).toEqual([1, 2]);
    expect(duplicateResponse.status).toBe(200);
  });

  it("enforces bearer token auth for protected routes", async () => {
    const app = new FakeExpressApp();
    const db = new InMemoryDatabase();

    registerEventIngestionRoutes(app, {
      internalApiToken: validToken,
      database: db,
      redisPublisher: null,
    });

    const missing = await app.inject({
      method: "POST",
      path: "/events",
      body: {
        event_id: "evt-3",
        run_id: "run-1",
        event_type: "task.created",
        timestamp: "2026-03-04T00:00:09.000Z",
        data: {},
      },
    });

    const invalid = await app.inject({
      method: "POST",
      path: "/events",
      headers: authHeader("wrong-token"),
      body: {
        event_id: "evt-4",
        run_id: "run-1",
        event_type: "task.created",
        timestamp: "2026-03-04T00:00:10.000Z",
        data: {},
      },
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(403);
  });

  it("GET /health reports dependency status with redis enabled/disabled", async () => {
    const appWithRedis = new FakeExpressApp();
    const dbUp = new InMemoryDatabase();
    const redisUp = new FakeRedisPublisher();

    registerEventIngestionRoutes(appWithRedis, {
      internalApiToken: validToken,
      database: dbUp,
      redisPublisher: redisUp,
    });

    const healthy = await appWithRedis.inject({ method: "GET", path: "/health" });

    const appNoRedis = new FakeExpressApp();
    const dbOnly = new InMemoryDatabase();
    registerEventIngestionRoutes(appNoRedis, {
      internalApiToken: validToken,
      database: dbOnly,
      redisPublisher: null,
    });

    const disabled = await appNoRedis.inject({ method: "GET", path: "/health" });

    expect(healthy.status).toBe(200);
    expect(healthy.body).toMatchObject({ status: "ok", database: "up", redis: "up" });
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ status: "ok", database: "up", redis: "disabled" });
  });

  it("POST /events is idempotent on duplicate event_id", async () => {
    const app = new FakeExpressApp();
    const db = new InMemoryDatabase();
    const redis = new FakeRedisPublisher();

    registerEventIngestionRoutes(app, {
      internalApiToken: validToken,
      database: db,
      redisPublisher: redis,
    });

    await app.inject({ method: "POST", path: "/runs", headers: authHeader(), body: runPayload() });

    const first = await app.inject({
      method: "POST",
      path: "/events",
      headers: authHeader(),
      body: {
        event_id: "evt-dup",
        run_id: "run-1",
        event_type: "task.created",
        timestamp: "2026-03-04T00:00:11.000Z",
        data: {},
      },
    });

    const second = await app.inject({
      method: "POST",
      path: "/events",
      headers: authHeader(),
      body: {
        event_id: "evt-dup",
        run_id: "run-1",
        event_type: "task.created",
        timestamp: "2026-03-04T00:00:11.000Z",
        data: {},
      },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(db.events.size).toBe(1);
    expect(redis.published).toHaveLength(1);
  });

  it("returns 413 for oversized request bodies", async () => {
    const app = new FakeExpressApp();
    const db = new InMemoryDatabase();

    registerEventIngestionRoutes(app, {
      internalApiToken: validToken,
      database: db,
      redisPublisher: null,
      limits: {
        logsBodyMaxBytes: 128,
      },
    });

    await app.inject({ method: "POST", path: "/runs", headers: authHeader(), body: runPayload() });

    const response = await app.inject({
      method: "POST",
      path: "/logs",
      headers: authHeader(),
      body: {
        run_id: "run-1",
        step_number: 1,
        step_attempt: 1,
        agent: "developer",
        runtime_provider: "codex",
        sequence: 1,
        stream: "activity",
        chunk: "x".repeat(300),
        byte_length: 300,
        is_final: false,
        timestamp: "2026-03-04T00:00:12.000Z",
      },
    });

    expect(response.status).toBe(413);
  });

  it("returns 429 when per-token route rate limit is exceeded", async () => {
    const app = new FakeExpressApp();
    const db = new InMemoryDatabase();

    registerEventIngestionRoutes(app, {
      internalApiToken: validToken,
      database: db,
      redisPublisher: null,
      rateLimit: {
        eventsPerWindow: 1,
      },
    });

    await app.inject({ method: "POST", path: "/runs", headers: authHeader(), body: runPayload() });

    const first = await app.inject({
      method: "POST",
      path: "/events",
      headers: authHeader(),
      body: {
        event_id: "evt-rate-1",
        run_id: "run-1",
        event_type: "task.created",
        timestamp: "2026-03-04T00:00:13.000Z",
        data: {},
      },
    });

    const second = await app.inject({
      method: "POST",
      path: "/events",
      headers: authHeader(),
      body: {
        event_id: "evt-rate-2",
        run_id: "run-1",
        event_type: "task.created",
        timestamp: "2026-03-04T00:00:14.000Z",
        data: {},
      },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
  });

  it("rejects unknown log stream names", async () => {
    const app = new FakeExpressApp();
    const db = new InMemoryDatabase();

    registerEventIngestionRoutes(app, {
      internalApiToken: validToken,
      database: db,
      redisPublisher: null,
    });

    await app.inject({ method: "POST", path: "/runs", headers: authHeader(), body: runPayload() });

    const response = await app.inject({
      method: "POST",
      path: "/logs",
      headers: authHeader(),
      body: {
        run_id: "run-1",
        step_number: 1,
        step_attempt: 1,
        agent: "developer",
        runtime_provider: "codex",
        sequence: 1,
        stream: "stderr",
        chunk: "x",
        byte_length: 1,
        is_final: false,
        timestamp: "2026-03-04T00:00:15.000Z",
      },
    });

    expect(response.status).toBe(422);
  });
});
