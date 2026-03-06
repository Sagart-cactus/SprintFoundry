import type {
  IntegrationConfig,
  RunSessionMetadata,
  TaskEvent,
} from "../shared/types.js";

const EVENT_SINK_TIMEOUT_MS = 2_000;
const EVENT_SINK_RETRY_COUNT = 1;
const RUN_UPSERT_PATH = "/v1/runs/upsert";
const LOG_CHUNK_PATH = "/v1/logs/chunk";

export interface RuntimeLogChunk {
  step_number: number;
  step_attempt: number;
  agent: string;
  runtime_provider: string;
  sequence: number;
  chunk: string;
  byte_length: number;
  stream: "activity";
  is_final: boolean;
  timestamp: string;
}

type FetchFn = typeof fetch;

export class EventSinkClient {
  constructor(
    private readonly url: string | undefined,
    private readonly fetchFn: FetchFn = globalThis.fetch,
    private readonly internalApiToken?: string,
  ) {}

  emit(event: TaskEvent): void {
    if (!this.url) return;

    // fire-and-forget by design: failures should never block the caller.
    void this.postEvent(event).catch(() => undefined);
  }

  async postEvent(event: TaskEvent): Promise<void> {
    if (!this.url) return;

    const delivered = await this.postWithRetry(this.url, event);
    if (!delivered) {
      throw new Error("Failed to post event to sink");
    }
  }

  async upsertRun(session: RunSessionMetadata): Promise<void> {
    if (!this.url) return;

    const delivered = await this.postWithRetry(this.resolveRunUpsertUrl(), session);
    if (!delivered) {
      throw new Error("Failed to upsert run to sink");
    }
  }

  async postLog(chunk: RuntimeLogChunk): Promise<void> {
    if (!this.url) return;

    const delivered = await this.postWithRetry(this.resolveLogChunkUrl(), chunk);
    if (!delivered) {
      throw new Error("Failed to post log chunk to sink");
    }
  }

  private async postWithRetry(url: string, body: unknown): Promise<boolean> {
    for (let attempt = 0; attempt <= EVENT_SINK_RETRY_COUNT; attempt += 1) {
      const delivered = await this.postOnce(url, body);
      if (delivered) return true;
    }
    return false;
  }

  private async postOnce(url: string, body: unknown): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, EVENT_SINK_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.internalApiToken) {
        headers.Authorization = `Bearer ${this.internalApiToken}`;
      }

      const response = await this.fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveRunUpsertUrl(): string {
    return this.resolveDerivedUrl(RUN_UPSERT_PATH);
  }

  private resolveLogChunkUrl(): string {
    return this.resolveDerivedUrl(LOG_CHUNK_PATH);
  }

  private resolveDerivedUrl(targetPath: string): string {
    if (!this.url) return targetPath;

    try {
      const parsed = new URL(this.url);
      parsed.pathname = this.resolveDerivedPathname(parsed.pathname, targetPath);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      const trimmed = this.url.replace(/\/+$/, "");
      if (trimmed.endsWith(targetPath)) return trimmed;
      if (trimmed.endsWith("/events")) {
        return `${trimmed.slice(0, -"/events".length)}${targetPath}`;
      }
      return `${trimmed}${targetPath}`;
    }
  }

  private resolveDerivedPathname(pathname: string, targetPath: string): string {
    const normalizedPath = pathname.replace(/\/+$/, "");

    if (normalizedPath.endsWith(targetPath)) {
      return normalizedPath;
    }

    if (normalizedPath.endsWith("/events")) {
      const prefix = normalizedPath.slice(0, -"/events".length);
      return prefix ? `${prefix}${targetPath}` : targetPath;
    }

    const base = normalizedPath && normalizedPath !== "/" ? normalizedPath : "";
    return `${base}${targetPath}`;
  }
}

export function createEventSinkClient(
  integrations: IntegrationConfig,
  fetchFn: FetchFn = globalThis.fetch,
): EventSinkClient {
  const url = integrations.event_sink?.url?.trim();
  return new EventSinkClient(url ? url : undefined, fetchFn);
}
