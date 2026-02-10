import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { EventStore } from "../src/service/event-store.js";
import type { TaskEvent } from "../src/shared/types.js";

function makeEvent(overrides?: Partial<TaskEvent>): TaskEvent {
  return {
    event_id: overrides?.event_id ?? `evt-${Date.now()}`,
    run_id: overrides?.run_id ?? "run-123",
    event_type: overrides?.event_type ?? "task.created",
    timestamp: overrides?.timestamp ?? new Date(),
    data: overrides?.data ?? { test: true },
  };
}

describe("EventStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "eventstore-test-"));
  });

  it("stores and retrieves events in memory", async () => {
    const store = new EventStore();
    const event = makeEvent();

    await store.store(event);
    const all = await store.getAll();

    expect(all).toHaveLength(1);
    expect(all[0].event_id).toBe(event.event_id);
  });

  it("filters by run_id", async () => {
    const store = new EventStore();
    await store.store(makeEvent({ run_id: "run-a" }));
    await store.store(makeEvent({ run_id: "run-b" }));
    await store.store(makeEvent({ run_id: "run-a" }));

    const result = await store.getByRunId("run-a");

    expect(result).toHaveLength(2);
    result.forEach((e) => expect(e.run_id).toBe("run-a"));
  });

  it("filters by event_type", async () => {
    const store = new EventStore();
    await store.store(makeEvent({ event_type: "task.created" }));
    await store.store(makeEvent({ event_type: "step.started" }));
    await store.store(makeEvent({ event_type: "task.created" }));

    const result = await store.getByType("task.created");

    expect(result).toHaveLength(2);
    result.forEach((e) => expect(e.event_type).toBe("task.created"));
  });

  it("persists to global JSONL file", async () => {
    const eventsDir = path.join(tmpDir, "global-events");
    const store = new EventStore(eventsDir);
    await store.initialize();

    const event = makeEvent();
    await store.store(event);

    const content = await fs.readFile(
      path.join(eventsDir, "events.jsonl"),
      "utf-8"
    );
    const parsed = JSON.parse(content.trim());
    expect(parsed.event_id).toBe(event.event_id);
  });

  it("persists to run-specific JSONL file", async () => {
    const workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const store = new EventStore();
    await store.initialize(workspaceDir);

    const event = makeEvent();
    await store.store(event);

    const content = await fs.readFile(
      path.join(workspaceDir, ".events.jsonl"),
      "utf-8"
    );
    const parsed = JSON.parse(content.trim());
    expect(parsed.event_id).toBe(event.event_id);
  });

  it("loadFromFile parses JSONL correctly", async () => {
    const filePath = path.join(tmpDir, "test.jsonl");
    const events = [
      makeEvent({ event_id: "e1", run_id: "run-1" }),
      makeEvent({ event_id: "e2", run_id: "run-1" }),
    ];
    const content = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.writeFile(filePath, content, "utf-8");

    const store = new EventStore();
    const loaded = await store.loadFromFile(filePath);

    expect(loaded).toHaveLength(2);
    expect(loaded[0].event_id).toBe("e1");
    expect(loaded[1].event_id).toBe("e2");

    // Events should also be in the in-memory store
    const all = await store.getAll();
    expect(all).toHaveLength(2);
  });

  it("handles missing eventsDir gracefully (no global log)", async () => {
    const store = new EventStore(); // no eventsDir
    await store.initialize();

    // Should not throw
    const event = makeEvent();
    await store.store(event);

    const all = await store.getAll();
    expect(all).toHaveLength(1);
  });

  it("handles missing workspacePath gracefully (no run log)", async () => {
    const store = new EventStore();
    await store.initialize(); // no workspacePath

    const event = makeEvent();
    await store.store(event);

    const all = await store.getAll();
    expect(all).toHaveLength(1);
  });

  it("initialize is idempotent", async () => {
    const eventsDir = path.join(tmpDir, "idempotent-events");
    const store = new EventStore(eventsDir);

    await store.initialize();
    await store.initialize(); // second call should be a no-op

    const event = makeEvent();
    await store.store(event);

    const all = await store.getAll();
    expect(all).toHaveLength(1);
  });
});
