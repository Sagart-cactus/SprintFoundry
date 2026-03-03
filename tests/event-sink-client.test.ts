import { afterEach, describe, expect, it, vi } from "vitest";
import { EventSinkClient, createEventSinkClient } from "../src/service/event-sink-client.js";
import type { IntegrationConfig, TaskEvent } from "../src/shared/types.js";

const baseEvent: TaskEvent = {
  event_id: "evt-1",
  run_id: "run-1",
  event_type: "task.created",
  timestamp: new Date("2026-01-01T00:00:00.000Z"),
  data: { ticketId: "SF-123" },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("EventSinkClient", () => {
  it("posts successfully and is fire-and-forget", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const client = new EventSinkClient("https://sink.example/events", fetchMock);

    const result = client.emit(baseEvent);

    expect(result).toBeUndefined();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sink.example/events",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("retries once after a failed attempt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = new EventSinkClient("https://sink.example/events", fetchMock);

    client.emit(baseEvent);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("is a no-op when event sink URL is unset", async () => {
    const integrations: IntegrationConfig = {
      ticket_source: {
        type: "github",
        config: {},
      },
    };
    const fetchMock = vi.fn<typeof fetch>();
    const client = createEventSinkClient(integrations, fetchMock);

    client.emit(baseEvent);
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("times out requests at 2s and retries once", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;

        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }

        signal.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    });
    const client = new EventSinkClient("https://sink.example/events", fetchMock);

    client.emit(baseEvent);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
