import http from "node:http";
import { URL } from "node:url";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { registerEventIngestionRoutes } from "./event-ingestion-api.js";

const require = createRequire(import.meta.url);

type RequestHeaders = Record<string, string | string[] | undefined>;
type NextFunction = (error?: unknown) => void;

interface RequestLike {
  headers: RequestHeaders;
  body?: unknown;
  authToken?: string;
}

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): void;
}

type Handler = (req: RequestLike, res: ResponseLike, next: NextFunction) => void | Promise<void>;

class RouteApp {
  private readonly routes = new Map<string, Handler[]>();

  post(path: string, ...handlers: Handler[]): void {
    this.routes.set(`POST ${path}`, handlers);
  }

  get(path: string, ...handlers: Handler[]): void {
    this.routes.set(`GET ${path}`, handlers);
  }

  match(method: string, pathname: string): Handler[] | undefined {
    return this.routes.get(`${method.toUpperCase()} ${pathname}`);
  }
}

function normalizeHeaders(raw: http.IncomingHttpHeaders): RequestHeaders {
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return undefined;

  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  const rawBody = Buffer.concat(chunks).toString("utf-8");
  if (!contentType.includes("application/json")) {
    return rawBody;
  }

  if (!rawBody.trim()) return undefined;
  return JSON.parse(rawBody);
}

async function main(): Promise<void> {
  if (process.argv.includes("--migrate-only")) {
    await applySqlMigrations();
    return;
  }

  await applySqlMigrations();

  const port = Number.parseInt(process.env.SPRINTFOUNDRY_EVENT_API_PORT ?? "3001", 10);
  const host = process.env.SPRINTFOUNDRY_EVENT_API_HOST ?? "0.0.0.0";

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("SPRINTFOUNDRY_EVENT_API_PORT must be a positive integer");
  }

  const app = new RouteApp();
  const runtime = registerEventIngestionRoutes(app);

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const parsedUrl = new URL(req.url ?? "/", "http://localhost");
      const handlers = app.match(method, parsedUrl.pathname);

      if (!handlers) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      const requestLike: RequestLike = {
        headers: normalizeHeaders(req.headers),
        body: ["POST", "PUT", "PATCH"].includes(method.toUpperCase()) ? await readJsonBody(req) : undefined,
      };

      let statusCode = 200;
      let finished = false;
      const responseLike: ResponseLike = {
        status(code: number): ResponseLike {
          statusCode = code;
          return responseLike;
        },
        json(body: unknown): void {
          if (finished) return;
          finished = true;
          res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(body));
        },
      };

      const runHandler = async (index: number): Promise<void> => {
        const handler = handlers[index];
        if (!handler || finished) return;
        let nextCalled = false;
        await handler(requestLike, responseLike, (error?: unknown) => {
          if (error) {
            throw error;
          }
          nextCalled = true;
        });
        if (nextCalled) {
          await runHandler(index + 1);
        }
      };

      await runHandler(0);

      if (!finished) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "not_found" }));
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      console.error(`[event-api] request failed: ${error instanceof Error ? error.message : String(error)}`);
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "internal_error" }));
    }
  });

  const shutdown = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await runtime.close();
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  server.listen(port, host, () => {
    console.log(`[event-api] listening on http://${host}:${port}`);
  });
}

async function applySqlMigrations(): Promise<void> {
  const databaseUrl = process.env.SPRINTFOUNDRY_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("SPRINTFOUNDRY_DATABASE_URL is required to apply event ingestion migrations");
  }

  const migrationsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "migrations"
  );
  const entries = (await fs.readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  const { Client } = require("pg") as {
    Client: new (config: { connectionString: string }) => {
      connect(): Promise<void>;
      query(sql: string): Promise<void>;
      end(): Promise<void>;
    };
  };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const fileName of entries) {
      const sql = await fs.readFile(path.join(migrationsDir, fileName), "utf-8");
      if (!sql.trim()) continue;
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[event-api] failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
