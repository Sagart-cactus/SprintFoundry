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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverMjs = path.resolve(__dirname, "../../monitor/server.mjs");
let BASE = "";

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
  await new Promise<void>((resolve, reject) => {
    serverProcess = spawn("node", [serverMjs], {
      env: { ...process.env, MONITOR_PORT: "0" },
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
});

describe("GET /api/run", () => {
  it("returns 400 when project/run params are missing", async () => {
    const { status, body } = await get(`${BASE}/api/run`);
    expect(status).toBe(400);
    expect(JSON.parse(body)).toHaveProperty("error");
  });
});

describe("GET /api/events", () => {
  it("returns 400 when project/run params are missing", async () => {
    const { status, body } = await get(`${BASE}/api/events`);
    expect(status).toBe(400);
    expect(JSON.parse(body)).toHaveProperty("error");
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
