import type { IntegrationConfig, TaskEvent } from "../shared/types.js";

const EVENT_SINK_TIMEOUT_MS = 2_000;
const EVENT_SINK_RETRY_COUNT = 1;

type FetchFn = typeof fetch;

export class EventSinkClient {
  constructor(
    private readonly url: string | undefined,
    private readonly fetchFn: FetchFn = globalThis.fetch,
  ) {}

  emit(event: TaskEvent): void {
    if (!this.url) return;

    // fire-and-forget by design: failures should never block the caller.
    void this.postEvent(event).catch(() => undefined);
  }

  async postEvent(event: TaskEvent): Promise<void> {
    if (!this.url) return;

    const delivered = await this.postWithRetry(event);
    if (!delivered) {
      throw new Error("Failed to post event to sink");
    }
  }

  private async postWithRetry(event: TaskEvent): Promise<boolean> {
    for (let attempt = 0; attempt <= EVENT_SINK_RETRY_COUNT; attempt += 1) {
      const delivered = await this.postOnce(event);
      if (delivered) return true;
    }
    return false;
  }

  private async postOnce(event: TaskEvent): Promise<boolean> {
    if (!this.url) return false;

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, EVENT_SINK_TIMEOUT_MS);

    try {
      const response = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createEventSinkClient(
  integrations: IntegrationConfig,
  fetchFn: FetchFn = globalThis.fetch,
): EventSinkClient {
  const url = integrations.event_sink?.url?.trim();
  return new EventSinkClient(url ? url : undefined, fetchFn);
}
