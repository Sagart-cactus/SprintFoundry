import { createRequire } from "node:module";
import { createHash, timingSafeEqual } from "node:crypto";

const require = createRequire(import.meta.url);

interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

interface DatabaseClient {
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<Row>>;
  end?(): Promise<void>;
}

interface RedisPublisher {
  publish(channel: string, message: string): Promise<number>;
  ping?(): Promise<string>;
  quit?(): Promise<void>;
}

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  authToken?: string;
}

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): void;
}

type NextFunction = (error?: unknown) => void;
type Handler = (req: RequestLike, res: ResponseLike, next: NextFunction) => void | Promise<void>;

interface ExpressLikeApp {
  post(path: string, ...handlers: Handler[]): void;
  get(path: string, ...handlers: Handler[]): void;
}

export interface EventIngestionApiOptions {
  internalApiToken?: string;
  databaseUrl?: string;
  redisUrl?: string;
  database?: DatabaseClient;
  redisPublisher?: RedisPublisher | null;
  rateLimit?: Partial<RateLimitConfig>;
  limits?: Partial<IngestionLimits>;
  rateLimiter?: RateLimiter;
  logger?: Pick<Console, "warn" | "error">;
}

export interface EventIngestionApiRuntime {
  database: DatabaseClient;
  redisPublisher: RedisPublisher | null;
  close(): Promise<void>;
}

interface EventPayload {
  event_id: string;
  run_id: string;
  event_type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

interface RunPayload {
  run_id: string;
  project_id: string;
  ticket_id: string;
  ticket_source: string;
  ticket_title: string;
  status: string;
  current_step: number;
  total_steps: number;
  plan_classification: string;
  workspace_path: string | null;
  branch: string | null;
  pr_url: string | null;
  total_tokens: number;
  total_cost_usd: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error: string | null;
}

interface StepResultPayload {
  run_id: string;
  step_number: number;
  step_attempt: number;
  agent: string;
  status: string;
  started_at: string;
  completed_at: string;
  result: Record<string, unknown>;
}

interface LogPayload {
  run_id: string;
  step_number: number;
  step_attempt: number;
  agent: string;
  runtime_provider: string;
  sequence: number;
  stream: string;
  chunk: string;
  byte_length: number;
  is_final: boolean;
  timestamp: string;
}

interface IngestionLimits {
  eventsBodyMaxBytes: number;
  runsBodyMaxBytes: number;
  stepResultsBodyMaxBytes: number;
  logsBodyMaxBytes: number;
  eventDataMaxBytes: number;
  stepResultMaxBytes: number;
  logChunkMaxBytes: number;
  genericFieldMaxChars: number;
  errorFieldMaxChars: number;
}

interface RateLimitConfig {
  windowMs: number;
  eventsPerWindow: number;
  runsPerWindow: number;
  stepResultsPerWindow: number;
  logsPerWindow: number;
}

interface RateLimitResult {
  allowed: boolean;
}

interface RateLimiter {
  consume(token: string, route: keyof Pick<RateLimitConfig, "eventsPerWindow" | "runsPerWindow" | "stepResultsPerWindow" | "logsPerWindow">): RateLimitResult;
}

const DEFAULT_LIMITS: IngestionLimits = {
  eventsBodyMaxBytes: 64 * 1024,
  runsBodyMaxBytes: 32 * 1024,
  stepResultsBodyMaxBytes: 64 * 1024,
  logsBodyMaxBytes: 128 * 1024,
  eventDataMaxBytes: 48 * 1024,
  stepResultMaxBytes: 48 * 1024,
  logChunkMaxBytes: 64 * 1024,
  genericFieldMaxChars: 512,
  errorFieldMaxChars: 4096,
};

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  eventsPerWindow: 240,
  runsPerWindow: 120,
  stepResultsPerWindow: 240,
  logsPerWindow: 360,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringRaw(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInteger(value: unknown, min: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) return null;
  return value;
}

function asNumber(value: unknown, min: number): number | null {
  if (typeof value !== "number" || Number.isNaN(value) || value < min) return null;
  return value;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asString(value);
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asIsoDateString(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? null : raw;
}

function parsePositiveIntegerEnv(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function loadLimits(overrides?: Partial<IngestionLimits>): IngestionLimits {
  const envLimits: Partial<IngestionLimits> = {
    eventsBodyMaxBytes: parsePositiveIntegerEnv(process.env.SPRINTFOUNDRY_INGEST_EVENTS_MAX_BODY_BYTES) ?? undefined,
    runsBodyMaxBytes: parsePositiveIntegerEnv(process.env.SPRINTFOUNDRY_INGEST_RUNS_MAX_BODY_BYTES) ?? undefined,
    stepResultsBodyMaxBytes: parsePositiveIntegerEnv(process.env.SPRINTFOUNDRY_INGEST_STEP_RESULTS_MAX_BODY_BYTES) ?? undefined,
    logsBodyMaxBytes: parsePositiveIntegerEnv(process.env.SPRINTFOUNDRY_INGEST_LOGS_MAX_BODY_BYTES) ?? undefined,
    eventDataMaxBytes: parsePositiveIntegerEnv(process.env.SPRINTFOUNDRY_INGEST_EVENT_DATA_MAX_BYTES) ?? undefined,
    stepResultMaxBytes: parsePositiveIntegerEnv(process.env.SPRINTFOUNDRY_INGEST_STEP_RESULT_MAX_BYTES) ?? undefined,
    logChunkMaxBytes: parsePositiveIntegerEnv(process.env.SPRINTFOUNDRY_INGEST_LOG_CHUNK_MAX_BYTES) ?? undefined,
    genericFieldMaxChars: parsePositiveIntegerEnv(process.env.SPRINTFOUNDRY_INGEST_GENERIC_FIELD_MAX_CHARS) ?? undefined,
    errorFieldMaxChars: parsePositiveIntegerEnv(process.env.SPRINTFOUNDRY_INGEST_ERROR_FIELD_MAX_CHARS) ?? undefined,
  };

  return {
    ...DEFAULT_LIMITS,
    ...envLimits,
    ...overrides,
  };
}

function loadRateLimit(overrides?: Partial<RateLimitConfig>): RateLimitConfig {
  const envRate: Partial<RateLimitConfig> = {
    windowMs: parsePositiveIntegerEnv(process.env.SPRINTFOUNDRY_INGEST_RATE_LIMIT_WINDOW_MS) ?? undefined,
    eventsPerWindow: parsePositiveIntegerEnv(process.env.SPRINTFOUNDRY_INGEST_RATE_LIMIT_EVENTS_PER_WINDOW) ?? undefined,
    runsPerWindow: parsePositiveIntegerEnv(process.env.SPRINTFOUNDRY_INGEST_RATE_LIMIT_RUNS_PER_WINDOW) ?? undefined,
    stepResultsPerWindow: parsePositiveIntegerEnv(process.env.SPRINTFOUNDRY_INGEST_RATE_LIMIT_STEP_RESULTS_PER_WINDOW) ?? undefined,
    logsPerWindow: parsePositiveIntegerEnv(process.env.SPRINTFOUNDRY_INGEST_RATE_LIMIT_LOGS_PER_WINDOW) ?? undefined,
  };

  return {
    ...DEFAULT_RATE_LIMIT,
    ...envRate,
    ...overrides,
  };
}

class FixedWindowRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; windowStartedAtMs: number }>();
  private readonly routeLimits: Record<string, number>;

  constructor(private readonly config: RateLimitConfig) {
    this.routeLimits = {
      eventsPerWindow: config.eventsPerWindow,
      runsPerWindow: config.runsPerWindow,
      stepResultsPerWindow: config.stepResultsPerWindow,
      logsPerWindow: config.logsPerWindow,
    };
  }

  consume(
    token: string,
    route: keyof Pick<RateLimitConfig, "eventsPerWindow" | "runsPerWindow" | "stepResultsPerWindow" | "logsPerWindow">,
  ): RateLimitResult {
    const nowMs = Date.now();
    const bucketKey = `${route}:${token}`;
    const existing = this.buckets.get(bucketKey);
    const routeLimit = this.routeLimits[route];

    if (!existing || nowMs - existing.windowStartedAtMs >= this.config.windowMs) {
      this.buckets.set(bucketKey, { count: 1, windowStartedAtMs: nowMs });
      return { allowed: true };
    }

    if (existing.count >= routeLimit) {
      return { allowed: false };
    }

    existing.count += 1;
    return { allowed: true };
  }
}

function safeJsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function enforceMaxLength(fieldName: string, value: string, maxChars: number, errors: string[]): void {
  if (value.length > maxChars) {
    errors.push(`${fieldName} exceeds max length ${maxChars}`);
  }
}

function parseEventPayload(body: unknown, limits: IngestionLimits): { value?: EventPayload; errors: string[] } {
  if (!isRecord(body)) return { errors: ["body must be a JSON object"] };

  const event_id = asString(body.event_id);
  const run_id = asString(body.run_id);
  const event_type = asString(body.event_type);
  const timestamp = asIsoDateString(body.timestamp);
  const data = isRecord(body.data) ? body.data : null;

  const errors: string[] = [];
  if (!event_id) errors.push("event_id is required");
  if (!run_id) errors.push("run_id is required");
  if (!event_type) errors.push("event_type is required");
  if (!timestamp) errors.push("timestamp must be a valid ISO date-time string");
  if (!data) errors.push("data must be an object");
  if (event_id) enforceMaxLength("event_id", event_id, limits.genericFieldMaxChars, errors);
  if (run_id) enforceMaxLength("run_id", run_id, limits.genericFieldMaxChars, errors);
  if (event_type) enforceMaxLength("event_type", event_type, limits.genericFieldMaxChars, errors);
  if (data && safeJsonByteLength(data) > limits.eventDataMaxBytes) {
    errors.push(`data exceeds max size ${limits.eventDataMaxBytes} bytes`);
  }

  if (errors.length > 0 || !event_id || !run_id || !event_type || !timestamp || !data) {
    return { errors };
  }

  return {
    errors,
    value: {
      event_id,
      run_id,
      event_type,
      timestamp,
      data,
    },
  };
}

function parseRunPayload(body: unknown, limits: IngestionLimits): { value?: RunPayload; errors: string[] } {
  if (!isRecord(body)) return { errors: ["body must be a JSON object"] };

  const run_id = asString(body.run_id);
  const project_id = asString(body.project_id);
  const ticket_id = asString(body.ticket_id);
  const ticket_source = asString(body.ticket_source);
  const ticket_title = asString(body.ticket_title);
  const status = asString(body.status);
  const current_step = asInteger(body.current_step, 0);
  const total_steps = asInteger(body.total_steps, 0);
  const plan_classification = asString(body.plan_classification);
  const workspace_path = asNullableString(body.workspace_path);
  const branch = asNullableString(body.branch);
  const pr_url = asNullableString(body.pr_url);
  const total_tokens = asInteger(body.total_tokens, 0);
  const total_cost_usd = asNumber(body.total_cost_usd, 0);
  const created_at = asIsoDateString(body.created_at);
  const updated_at = asIsoDateString(body.updated_at);
  const completed_at = body.completed_at === null || body.completed_at === undefined
    ? null
    : asIsoDateString(body.completed_at);
  const error = body.error === null || body.error === undefined ? null : asString(body.error);

  const errors: string[] = [];
  if (!run_id) errors.push("run_id is required");
  if (!project_id) errors.push("project_id is required");
  if (!ticket_id) errors.push("ticket_id is required");
  if (!ticket_source) errors.push("ticket_source is required");
  if (!ticket_title) errors.push("ticket_title is required");
  if (!status) errors.push("status is required");
  if (current_step === null) errors.push("current_step must be an integer >= 0");
  if (total_steps === null) errors.push("total_steps must be an integer >= 0");
  if (!plan_classification) errors.push("plan_classification is required");
  if (total_tokens === null) errors.push("total_tokens must be an integer >= 0");
  if (total_cost_usd === null) errors.push("total_cost_usd must be a number >= 0");
  if (!created_at) errors.push("created_at must be a valid ISO date-time string");
  if (!updated_at) errors.push("updated_at must be a valid ISO date-time string");
  if (body.completed_at !== null && body.completed_at !== undefined && !completed_at) {
    errors.push("completed_at must be null or a valid ISO date-time string");
  }
  if (run_id) enforceMaxLength("run_id", run_id, limits.genericFieldMaxChars, errors);
  if (project_id) enforceMaxLength("project_id", project_id, limits.genericFieldMaxChars, errors);
  if (ticket_id) enforceMaxLength("ticket_id", ticket_id, limits.genericFieldMaxChars, errors);
  if (ticket_source) enforceMaxLength("ticket_source", ticket_source, limits.genericFieldMaxChars, errors);
  if (ticket_title) enforceMaxLength("ticket_title", ticket_title, limits.genericFieldMaxChars, errors);
  if (status) enforceMaxLength("status", status, limits.genericFieldMaxChars, errors);
  if (plan_classification) enforceMaxLength("plan_classification", plan_classification, limits.genericFieldMaxChars, errors);
  if (workspace_path) enforceMaxLength("workspace_path", workspace_path, limits.genericFieldMaxChars, errors);
  if (branch) enforceMaxLength("branch", branch, limits.genericFieldMaxChars, errors);
  if (pr_url) enforceMaxLength("pr_url", pr_url, limits.genericFieldMaxChars, errors);
  if (error) enforceMaxLength("error", error, limits.errorFieldMaxChars, errors);

  if (
    errors.length > 0 ||
    !run_id ||
    !project_id ||
    !ticket_id ||
    !ticket_source ||
    !ticket_title ||
    !status ||
    current_step === null ||
    total_steps === null ||
    !plan_classification ||
    total_tokens === null ||
    total_cost_usd === null ||
    !created_at ||
    !updated_at
  ) {
    return { errors };
  }

  return {
    errors,
    value: {
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
      error,
    },
  };
}

function parseStepResultPayload(body: unknown, limits: IngestionLimits): { value?: StepResultPayload; errors: string[] } {
  if (!isRecord(body)) return { errors: ["body must be a JSON object"] };

  const run_id = asString(body.run_id);
  const step_number = asInteger(body.step_number, 1);
  const step_attempt = asInteger(body.step_attempt, 1);
  const agent = asString(body.agent);
  const status = asString(body.status);
  const started_at = asIsoDateString(body.started_at);
  const completed_at = asIsoDateString(body.completed_at);
  const result = isRecord(body.result) ? body.result : null;

  const errors: string[] = [];
  if (!run_id) errors.push("run_id is required");
  if (step_number === null) errors.push("step_number must be an integer >= 1");
  if (step_attempt === null) errors.push("step_attempt must be an integer >= 1");
  if (!agent) errors.push("agent is required");
  if (!status) errors.push("status is required");
  if (!started_at) errors.push("started_at must be a valid ISO date-time string");
  if (!completed_at) errors.push("completed_at must be a valid ISO date-time string");
  if (!result) errors.push("result must be an object");
  if (run_id) enforceMaxLength("run_id", run_id, limits.genericFieldMaxChars, errors);
  if (agent) enforceMaxLength("agent", agent, limits.genericFieldMaxChars, errors);
  if (status) enforceMaxLength("status", status, limits.genericFieldMaxChars, errors);
  if (result && safeJsonByteLength(result) > limits.stepResultMaxBytes) {
    errors.push(`result exceeds max size ${limits.stepResultMaxBytes} bytes`);
  }

  if (
    errors.length > 0 ||
    !run_id ||
    step_number === null ||
    step_attempt === null ||
    !agent ||
    !status ||
    !started_at ||
    !completed_at ||
    !result
  ) {
    return { errors };
  }

  return {
    errors,
    value: {
      run_id,
      step_number,
      step_attempt,
      agent,
      status,
      started_at,
      completed_at,
      result,
    },
  };
}

function parseLogPayload(body: unknown, limits: IngestionLimits): { value?: LogPayload; errors: string[] } {
  if (!isRecord(body)) return { errors: ["body must be a JSON object"] };

  const run_id = asString(body.run_id);
  const step_number = asInteger(body.step_number, 1);
  const step_attempt = asInteger(body.step_attempt, 1);
  const agent = asString(body.agent);
  const runtime_provider = asString(body.runtime_provider);
  const sequence = asInteger(body.sequence, 0);
  const stream = asString(body.stream);
  const chunk = asStringRaw(body.chunk);
  const byte_length = asInteger(body.byte_length, 0);
  const is_final = asBoolean(body.is_final);
  const timestamp = asIsoDateString(body.timestamp);

  const errors: string[] = [];
  if (!run_id) errors.push("run_id is required");
  if (step_number === null) errors.push("step_number must be an integer >= 1");
  if (step_attempt === null) errors.push("step_attempt must be an integer >= 1");
  if (!agent) errors.push("agent is required");
  if (!runtime_provider) errors.push("runtime_provider is required");
  if (sequence === null) errors.push("sequence must be an integer >= 0");
  if (!stream) errors.push("stream is required");
  if (stream && stream !== "activity") errors.push("stream must be 'activity'");
  if (chunk === null) errors.push("chunk is required");
  if (byte_length === null) errors.push("byte_length must be an integer >= 0");
  if (is_final === null) errors.push("is_final must be a boolean");
  if (!timestamp) errors.push("timestamp must be a valid ISO date-time string");
  if (run_id) enforceMaxLength("run_id", run_id, limits.genericFieldMaxChars, errors);
  if (agent) enforceMaxLength("agent", agent, limits.genericFieldMaxChars, errors);
  if (runtime_provider) enforceMaxLength("runtime_provider", runtime_provider, limits.genericFieldMaxChars, errors);
  if (stream) enforceMaxLength("stream", stream, limits.genericFieldMaxChars, errors);
  if (chunk !== null && Buffer.byteLength(chunk) > limits.logChunkMaxBytes) {
    errors.push(`chunk exceeds max size ${limits.logChunkMaxBytes} bytes`);
  }
  if (byte_length !== null && byte_length > limits.logChunkMaxBytes) {
    errors.push(`byte_length exceeds max size ${limits.logChunkMaxBytes} bytes`);
  }
  if (chunk !== null && byte_length !== null && Buffer.byteLength(chunk) !== byte_length) {
    errors.push("byte_length must match chunk byte length");
  }

  if (
    errors.length > 0 ||
    !run_id ||
    step_number === null ||
    step_attempt === null ||
    !agent ||
    !runtime_provider ||
    sequence === null ||
    !stream ||
    chunk === null ||
    byte_length === null ||
    is_final === null ||
    !timestamp
  ) {
    return { errors };
  }

  return {
    errors,
    value: {
      run_id,
      step_number,
      step_attempt,
      agent,
      runtime_provider,
      sequence,
      stream,
      chunk,
      byte_length,
      is_final,
      timestamp,
    },
  };
}

function getAuthorizationHeader(req: RequestLike): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  if (Array.isArray(header)) return header[0] ?? null;
  return header;
}

function secureTokenEquals(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

function createAuthMiddleware(token: string): Handler {
  return (req, res, next) => {
    const authorization = getAuthorizationHeader(req);
    if (!authorization) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const parts = authorization.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    if (!secureTokenEquals(token, parts[1])) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    req.authToken = parts[1];
    next();
  };
}

function createBodySizeGuard(maxBytes: number): Handler {
  return (req, res, next) => {
    if (safeJsonByteLength(req.body) > maxBytes) {
      res.status(413).json({ error: "payload_too_large" });
      return;
    }
    next();
  };
}

function createRateLimitGuard(
  rateLimiter: RateLimiter,
  route: keyof Pick<RateLimitConfig, "eventsPerWindow" | "runsPerWindow" | "stepResultsPerWindow" | "logsPerWindow">,
): Handler {
  return (req, res, next) => {
    const token = req.authToken;
    if (!token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const tokenKey = createHash("sha256").update(token).digest("hex");
    const result = rateLimiter.consume(tokenKey, route);
    if (!result.allowed) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }

    next();
  };
}

function buildDatabaseClient(options: EventIngestionApiOptions): DatabaseClient {
  if (options.database) return options.database;

  const databaseUrl = options.databaseUrl ?? process.env.SPRINTFOUNDRY_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("SPRINTFOUNDRY_DATABASE_URL is required for event ingestion API");
  }

  const pgModule = require("pg") as { Pool: new (config: { connectionString: string }) => DatabaseClient };
  return new pgModule.Pool({ connectionString: databaseUrl });
}

function buildRedisPublisher(options: EventIngestionApiOptions): RedisPublisher | null {
  if (options.redisPublisher !== undefined) return options.redisPublisher;

  const redisUrl = options.redisUrl ?? process.env.SPRINTFOUNDRY_REDIS_URL;
  if (!redisUrl) return null;

  const redisModule = require("redis") as {
    createClient(config: { url: string }): {
      connect(): Promise<void>;
      publish(channel: string, message: string): Promise<number>;
      ping(): Promise<string>;
      quit(): Promise<void>;
    };
  };

  const client = redisModule.createClient({ url: redisUrl });
  let connected = false;
  let connecting: Promise<void> | null = null;

  async function ensureConnected(): Promise<void> {
    if (connected) return;
    if (!connecting) {
      connecting = client.connect().then(() => {
        connected = true;
      });
    }
    await connecting;
  }

  return {
    async publish(channel: string, message: string): Promise<number> {
      await ensureConnected();
      return client.publish(channel, message);
    },
    async ping(): Promise<string> {
      await ensureConnected();
      return client.ping();
    },
    async quit(): Promise<void> {
      if (!connected && !connecting) return;
      await ensureConnected();
      await client.quit();
    },
  };
}

function wrapHandler(logger: Pick<Console, "warn" | "error">, handler: Handler): Handler {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      logger.error(
        `[event-ingestion] request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.status(503).json({ error: "service_unavailable" });
    }
  };
}

export function registerEventIngestionRoutes(
  app: ExpressLikeApp,
  options: EventIngestionApiOptions = {},
): EventIngestionApiRuntime {
  const logger = options.logger ?? console;
  const database = buildDatabaseClient(options);
  const redisPublisher = buildRedisPublisher(options);
  const limits = loadLimits(options.limits);
  const rateLimiter = options.rateLimiter ?? new FixedWindowRateLimiter(loadRateLimit(options.rateLimit));

  const token = options.internalApiToken ?? process.env.SPRINTFOUNDRY_INTERNAL_API_TOKEN;
  if (!token) {
    throw new Error("SPRINTFOUNDRY_INTERNAL_API_TOKEN is required for event ingestion API");
  }

  const requireAuth = createAuthMiddleware(token);

  const eventHandlers: Handler[] = [
    requireAuth,
    createRateLimitGuard(rateLimiter, "eventsPerWindow"),
    createBodySizeGuard(limits.eventsBodyMaxBytes),
    wrapHandler(logger, async (req, res) => {
      const parsed = parseEventPayload(req.body, limits);
      if (!parsed.value) {
        res.status(422).json({ error: "validation_failed", details: parsed.errors });
        return;
      }

      const payload = parsed.value;
      const insert = await database.query<{ event_id: string }>(
        `
          INSERT INTO events (event_id, run_id, event_type, timestamp, data)
          VALUES ($1, $2, $3, $4, $5::jsonb)
          ON CONFLICT (event_id) DO NOTHING
          RETURNING event_id
        `,
        [payload.event_id, payload.run_id, payload.event_type, payload.timestamp, JSON.stringify(payload.data)],
      );

      const inserted = insert.rowCount > 0;
      let redisPublished = false;

      if (inserted && redisPublisher) {
        const channel = `sprintfoundry:events:${payload.run_id}`;
        const message = JSON.stringify(payload);
        try {
          await redisPublisher.publish(channel, message);
          redisPublished = true;
        } catch (error) {
          logger.warn(
            `[event-ingestion] redis publish failed for run ${payload.run_id} event ${payload.event_id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      res.status(inserted ? 201 : 200).json({
        status: inserted ? "inserted" : "duplicate",
        event_id: payload.event_id,
        run_id: payload.run_id,
        redis_published: redisPublished,
      });
    }),
  ];
  app.post("/events", ...eventHandlers);

  const runHandlers: Handler[] = [
    requireAuth,
    createRateLimitGuard(rateLimiter, "runsPerWindow"),
    createBodySizeGuard(limits.runsBodyMaxBytes),
    wrapHandler(logger, async (req, res) => {
      const parsed = parseRunPayload(req.body, limits);
      if (!parsed.value) {
        res.status(422).json({ error: "validation_failed", details: parsed.errors });
        return;
      }

      const payload = parsed.value;
      const upsert = await database.query<{ inserted: boolean }>(
        `
          INSERT INTO runs (
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
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15, $16, $17, $18
          )
          ON CONFLICT (run_id)
          DO UPDATE SET
            project_id = EXCLUDED.project_id,
            ticket_id = EXCLUDED.ticket_id,
            ticket_source = EXCLUDED.ticket_source,
            ticket_title = EXCLUDED.ticket_title,
            status = EXCLUDED.status,
            current_step = EXCLUDED.current_step,
            total_steps = EXCLUDED.total_steps,
            plan_classification = EXCLUDED.plan_classification,
            workspace_path = EXCLUDED.workspace_path,
            branch = EXCLUDED.branch,
            pr_url = EXCLUDED.pr_url,
            total_tokens = EXCLUDED.total_tokens,
            total_cost_usd = EXCLUDED.total_cost_usd,
            updated_at = EXCLUDED.updated_at,
            completed_at = EXCLUDED.completed_at,
            error = EXCLUDED.error
          RETURNING (xmax = 0) AS inserted
        `,
        [
          payload.run_id,
          payload.project_id,
          payload.ticket_id,
          payload.ticket_source,
          payload.ticket_title,
          payload.status,
          payload.current_step,
          payload.total_steps,
          payload.plan_classification,
          payload.workspace_path,
          payload.branch,
          payload.pr_url,
          payload.total_tokens,
          payload.total_cost_usd,
          payload.created_at,
          payload.updated_at,
          payload.completed_at,
          payload.error,
        ],
      );

      const inserted = upsert.rows[0]?.inserted ?? false;
      res.status(200).json({
        status: inserted ? "inserted" : "updated",
        run_id: payload.run_id,
      });
    }),
  ];
  app.post("/runs", ...runHandlers);
  app.post("/v1/runs/upsert", ...runHandlers);

  app.post(
    "/step-results",
    requireAuth,
    createRateLimitGuard(rateLimiter, "stepResultsPerWindow"),
    createBodySizeGuard(limits.stepResultsBodyMaxBytes),
    wrapHandler(logger, async (req, res) => {
      const parsed = parseStepResultPayload(req.body, limits);
      if (!parsed.value) {
        res.status(422).json({ error: "validation_failed", details: parsed.errors });
        return;
      }

      const payload = parsed.value;
      const upsert = await database.query<{ inserted: boolean }>(
        `
          INSERT INTO step_results (
            run_id,
            step_number,
            step_attempt,
            agent,
            status,
            started_at,
            completed_at,
            result
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
          ON CONFLICT (run_id, step_number, step_attempt)
          DO UPDATE SET
            agent = EXCLUDED.agent,
            status = EXCLUDED.status,
            started_at = EXCLUDED.started_at,
            completed_at = EXCLUDED.completed_at,
            result = EXCLUDED.result,
            updated_at = NOW()
          RETURNING (xmax = 0) AS inserted
        `,
        [
          payload.run_id,
          payload.step_number,
          payload.step_attempt,
          payload.agent,
          payload.status,
          payload.started_at,
          payload.completed_at,
          JSON.stringify(payload.result),
        ],
      );

      const inserted = upsert.rows[0]?.inserted ?? false;
      res.status(200).json({
        status: inserted ? "inserted" : "updated",
        run_id: payload.run_id,
        step_number: payload.step_number,
        step_attempt: payload.step_attempt,
      });
    }),
  );

  const logHandlers: Handler[] = [
    requireAuth,
    createRateLimitGuard(rateLimiter, "logsPerWindow"),
    createBodySizeGuard(limits.logsBodyMaxBytes),
    wrapHandler(logger, async (req, res) => {
      const parsed = parseLogPayload(req.body, limits);
      if (!parsed.value) {
        res.status(422).json({ error: "validation_failed", details: parsed.errors });
        return;
      }

      const payload = parsed.value;
      const insert = await database.query<{ id: number }>(
        `
          INSERT INTO run_logs (
            run_id,
            step_number,
            step_attempt,
            agent,
            runtime_provider,
            sequence,
            stream,
            chunk,
            byte_length,
            is_final,
            timestamp
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (run_id, step_number, step_attempt, sequence, stream) DO NOTHING
          RETURNING id
        `,
        [
          payload.run_id,
          payload.step_number,
          payload.step_attempt,
          payload.agent,
          payload.runtime_provider,
          payload.sequence,
          payload.stream,
          payload.chunk,
          payload.byte_length,
          payload.is_final,
          payload.timestamp,
        ],
      );

      const inserted = insert.rowCount > 0;
      res.status(inserted ? 201 : 200).json({
        status: inserted ? "inserted" : "duplicate",
        run_id: payload.run_id,
        sequence: payload.sequence,
      });
    }),
  ];
  app.post("/logs", ...logHandlers);
  app.post("/v1/logs/chunk", ...logHandlers);

  app.get(
    "/health",
    wrapHandler(logger, async (_req, res) => {
      let databaseState: "up" | "down" = "up";
      let redisState: "up" | "down" | "disabled" = redisPublisher ? "up" : "disabled";

      try {
        await database.query("SELECT 1");
      } catch {
        databaseState = "down";
      }

      if (redisPublisher) {
        try {
          if (redisPublisher.ping) {
            await redisPublisher.ping();
          }
        } catch {
          redisState = "down";
        }
      }

      const status = databaseState === "up" && redisState !== "down" ? "ok" : "degraded";
      res.status(200).json({
        status,
        database: databaseState,
        redis: redisState,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  return {
    database,
    redisPublisher,
    async close(): Promise<void> {
      if (redisPublisher?.quit) {
        await redisPublisher.quit();
      }
      if (database.end) {
        await database.end();
      }
    },
  };
}
