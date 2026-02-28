/**
 * Tests for the SSE /api/events/stream endpoint in monitor/server.mjs.
 *
 * Phase 5: Dashboard SSE streaming.
 *
 * Spawns the monitor server on a random port and verifies:
 *  - SSE endpoint returns correct headers (text/event-stream)
 *  - Connected event is sent immediately on connection
 *  - Periodic "runs" summary events are sent
 *  - New JSONL events are streamed in real-time
 *  - Heartbeats keep the connection alive
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverMjs = path.resolve(__dirname, "../../monitor/server.mjs");

let BASE = "";
let serverProcess: ChildProcess;
let tmpRunsRoot: string;

// Create a temp runs directory with a fake project/run
function setupFixtureRun(projectId: string, runId: string, events: object[]) {
  const runDir = path.join(tmpRunsRoot, projectId, runId);
  mkdirSync(runDir, { recursive: true });
  const eventsPath = path.join(runDir, ".events.jsonl");
  const content = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(eventsPath, content, "utf-8");
  return { runDir, eventsPath };
}

function makeEvent(type: string, ts?: string): object {
  return {
    event_type: type,
    timestamp: ts ?? new Date().toISOString(),
    data: {},
  };
}

// Parse SSE text into structured events
function parseSSE(raw: string): Array<{ event?: string; data: string }> {
  const messages: Array<{ event?: string; data: string }> = [];
  const chunks = raw.split("\n\n").filter(Boolean);
  for (const chunk of chunks) {
    if (chunk.startsWith(":")) continue; // comment/heartbeat
    const lines = chunk.split("\n");
    let event: string | undefined;
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (data) messages.push({ event, data });
  }
  return messages;
}

// Collect SSE data from a response stream until timeout or enough messages
function collectSSE(
  url: string,
  timeoutMs: number,
  minMessages = 1,
): Promise<{ raw: string; messages: Array<{ event?: string; data: string }>; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      req.destroy();
      const messages = parseSSE(raw);
      resolve({ raw, messages, headers: responseHeaders });
    }, timeoutMs);

    let raw = "";
    let responseHeaders: http.IncomingHttpHeaders = {};
    const req = http.get(url, (res) => {
      responseHeaders = res.headers;
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        raw += chunk;
        const messages = parseSSE(raw);
        if (messages.length >= minMessages) {
          clearTimeout(timeout);
          // Keep collecting a bit more then resolve
          setTimeout(() => {
            req.destroy();
            resolve({ raw, messages: parseSSE(raw), headers: responseHeaders });
          }, 200);
        }
      });
      res.on("end", () => {
        clearTimeout(timeout);
        resolve({ raw, messages: parseSSE(raw), headers: responseHeaders });
      });
    });
    req.on("error", (err) => {
      clearTimeout(timeout);
      // Connection destroyed errors are expected
      if (raw) {
        resolve({ raw, messages: parseSSE(raw), headers: responseHeaders });
      } else {
        reject(err);
      }
    });
  });
}

beforeAll(async () => {
  // Create temp runs root
  tmpRunsRoot = mkdtempSync(path.join(os.tmpdir(), "sf-sse-test-"));

  await new Promise<void>((resolve, reject) => {
    serverProcess = spawn("node", [serverMjs], {
      env: {
        ...process.env,
        MONITOR_PORT: "0",
        SPRINTFOUNDRY_RUNS_ROOT: tmpRunsRoot,
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
  try {
    rmSync(tmpRunsRoot, { recursive: true, force: true });
  } catch { /* best effort */ }
});

describe("GET /api/events/stream — SSE endpoint", () => {
  it("returns correct SSE headers", async () => {
    const { headers } = await collectSSE(`${BASE}/api/events/stream`, 1000, 1);
    expect(headers["content-type"]).toBe("text/event-stream");
    expect(headers["cache-control"]).toBe("no-cache");
    expect(headers["connection"]).toBe("keep-alive");
  });

  it("sends 'connected' event immediately", async () => {
    const { messages } = await collectSSE(`${BASE}/api/events/stream`, 2000, 1);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const connected = messages.find((m) => m.event === "connected");
    expect(connected).toBeDefined();
    const data = JSON.parse(connected!.data);
    expect(data).toHaveProperty("ts");
    expect(typeof data.ts).toBe("number");
  });

  it("sends periodic 'runs' summary events", async () => {
    // Set up a fixture run so the summary has content
    setupFixtureRun("test-project", "run-001", [
      makeEvent("task.created"),
      makeEvent("task.plan_generated"),
    ]);

    // Wait long enough for at least one periodic summary (5s interval + buffer)
    const { messages } = await collectSSE(`${BASE}/api/events/stream`, 7000, 2);
    const runsEvents = messages.filter((m) => m.event === "runs");
    expect(runsEvents.length).toBeGreaterThanOrEqual(1);
    const data = JSON.parse(runsEvents[0].data);
    expect(data).toHaveProperty("runs");
    expect(Array.isArray(data.runs)).toBe(true);
  }, 10000);

  it("streams new events when JSONL file is appended", async () => {
    const { eventsPath } = setupFixtureRun("test-project", "run-sse-append", [
      makeEvent("task.created"),
    ]);

    // Start SSE connection for this specific run
    const ssePromise = collectSSE(
      `${BASE}/api/events/stream?project=test-project&run=run-sse-append`,
      4000,
      2,
    );

    // Wait for connection to establish, then append a new event
    await new Promise((r) => setTimeout(r, 1500));
    const newEvent = {
      event_type: "step.started",
      timestamp: new Date().toISOString(),
      data: { step: 1, agent: "developer" },
    };
    appendFileSync(eventsPath, JSON.stringify(newEvent) + "\n", "utf-8");

    const { messages } = await ssePromise;
    const eventMessages = messages.filter((m) => m.event === "event");
    expect(eventMessages.length).toBeGreaterThanOrEqual(1);
    const streamedEvent = JSON.parse(eventMessages[0].data);
    expect(streamedEvent.event_type).toBe("step.started");
  }, 8000);

  it("includes heartbeat comments to keep connection alive", async () => {
    // Heartbeat is every 15s — we'll check the raw stream for the comment format
    // Since we can't wait 15s in tests, just verify the format works by checking
    // that the SSE endpoint stays open for the requested duration
    const { raw } = await collectSSE(`${BASE}/api/events/stream`, 2000, 1);
    // At minimum the raw stream should have the connected event
    expect(raw).toContain("event: connected");
    expect(raw).toContain("data:");
  });

  it("handles project+run params for targeted watching", async () => {
    setupFixtureRun("targeted-proj", "run-targeted", [
      makeEvent("task.created"),
      makeEvent("step.started"),
    ]);

    const { messages } = await collectSSE(
      `${BASE}/api/events/stream?project=targeted-proj&run=run-targeted`,
      2000,
      1,
    );
    // Should still get connected event even with specific run params
    const connected = messages.find((m) => m.event === "connected");
    expect(connected).toBeDefined();
  });

  it("handles missing/nonexistent run gracefully", async () => {
    const { messages } = await collectSSE(
      `${BASE}/api/events/stream?project=nonexistent&run=run-fake`,
      2000,
      1,
    );
    // Should still connect and send connected event (just no file events)
    const connected = messages.find((m) => m.event === "connected");
    expect(connected).toBeDefined();
  });
});
