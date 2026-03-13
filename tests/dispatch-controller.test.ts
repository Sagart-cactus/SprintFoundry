import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  attachWorkspacePvcToJob,
  buildJobOwnerReference,
  buildK8sJobManifest,
  buildK8sWorkspacePvcManifest,
  registerDispatchRoutes,
  type DispatchRedisClient,
  type K8sJobManifest,
} from "../src/service/dispatch-controller.js";

type Handler = (
  req: {
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
    body?: unknown;
    rawBody: string;
  },
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
    rawBody?: string;
  }): Promise<{ status: number; body: unknown }> {
    const key = `${options.method} ${options.path}`;
    const handlers = this.routes.get(key);
    if (!handlers) {
      throw new Error(`Route not found: ${key}`);
    }

    let status = 200;
    let responseBody: unknown = undefined;
    let sent = false;

    const computedRawBody =
      options.rawBody ??
      (typeof options.body === "string" ? options.body : options.body === undefined ? "" : JSON.stringify(options.body));

    const req = {
      method: options.method,
      path: options.path,
      headers: Object.fromEntries(
        Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body: options.body,
      rawBody: computedRawBody,
    };

    const res: TestResponse = {
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

class FakeRedisClient implements DispatchRedisClient {
  private readonly kv = new Map<string, { value: string; expiresAt?: number }>();
  private readonly lists = new Map<string, string[]>();
  private readonly zsets = new Map<string, Map<string, number>>();
  private connected = false;

  private now(): number {
    return Date.now();
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.kv.entries()) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.kv.delete(key);
      }
    }
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async quit(): Promise<void> {
    this.connected = false;
  }

  async ping(): Promise<string> {
    if (!this.connected) {
      throw new Error("not connected");
    }
    return "PONG";
  }

  async lPush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  async brPop(keys: string | string[], _timeoutSeconds: number): Promise<{ key: string; element: string } | null> {
    const listKeys = Array.isArray(keys) ? keys : [keys];
    for (const key of listKeys) {
      const list = this.lists.get(key);
      if (!list || list.length === 0) continue;
      const element = list.pop();
      if (element === undefined) continue;
      this.lists.set(key, list);
      return { key, element };
    }
    return null;
  }

  async set(key: string, value: string, options?: { NX?: boolean; EX?: number }): Promise<string | null> {
    this.pruneExpired();

    if (options?.NX && this.kv.has(key)) {
      return null;
    }

    const expiresAt = options?.EX ? this.now() + options.EX * 1000 : undefined;
    this.kv.set(key, { value, expiresAt });
    return "OK";
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.pruneExpired();
    const current = this.kv.get(key);
    if (!current) return 0;
    current.expiresAt = this.now() + seconds * 1000;
    this.kv.set(key, current);
    return 1;
  }

  async lLen(key: string): Promise<number> {
    return (this.lists.get(key) ?? []).length;
  }

  async keys(pattern: string): Promise<string[]> {
    const escaped = pattern
      .replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&")
      .replace(/\*/g, ".*");
    const regex = new RegExp(`^${escaped}$`);
    const candidates = new Set<string>([...this.kv.keys(), ...this.lists.keys(), ...this.zsets.keys()]);
    return [...candidates].filter((key) => regex.test(key));
  }

  async zAdd(key: string, members: Array<{ score: number; value: string }>): Promise<number> {
    const set = this.zsets.get(key) ?? new Map<string, number>();
    let created = 0;
    for (const member of members) {
      if (!set.has(member.value)) {
        created += 1;
      }
      set.set(member.value, member.score);
    }
    this.zsets.set(key, set);
    return created;
  }

  async zCard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }

  async zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number> {
    const set = this.zsets.get(key);
    if (!set) return 0;

    const minValue = typeof min === "number" ? min : min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min);
    const maxValue = typeof max === "number" ? max : max === "+inf" ? Number.POSITIVE_INFINITY : Number(max);

    let removed = 0;
    for (const [member, score] of set.entries()) {
      if (score >= minValue && score <= maxValue) {
        set.delete(member);
        removed += 1;
      }
    }

    if (set.size === 0) {
      this.zsets.delete(key);
    } else {
      this.zsets.set(key, set);
    }

    return removed;
  }

  async zRem(key: string, members: string[]): Promise<number> {
    const set = this.zsets.get(key);
    if (!set) return 0;

    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) {
        removed += 1;
      }
    }

    if (set.size === 0) {
      this.zsets.delete(key);
    } else {
      this.zsets.set(key, set);
    }

    return removed;
  }
}

function githubSignature(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function makeProjectConfig(configDir: string, fileName: string, content: string): void {
  writeFileSync(path.join(configDir, fileName), content, "utf-8");
}

function queueKey(projectId: string): string {
  return `sprintfoundry:dispatch:${projectId}`;
}

function activeKey(projectId: string): string {
  return `sprintfoundry:dispatch:active:${projectId}`;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.SPRINTFOUNDRY_EVENT_SINK_URL;
  delete process.env.SPRINTFOUNDRY_INTERNAL_API_TOKEN;
  delete process.env.SPRINTFOUNDRY_SKIP_PR_FINALIZATION;
});

describe("dispatch-controller", () => {
  it("queues and dequeues dispatch runs", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "sf-dispatch-config-"));
    tempDirs.push(configDir);

    makeProjectConfig(
      configDir,
      "project.yaml",
      [
        "project_id: acme",
        "name: ACME",
        "repo:",
        "  url: git@github.com:acme/repo.git",
        "  default_branch: main",
        "api_keys:",
        "  anthropic: test",
        "branch_strategy:",
        "  prefix: feat/",
        "  include_ticket_id: true",
        "  naming: kebab-case",
        "integrations:",
        "  ticket_source:",
        "    type: github",
        "    config:",
        "      token: test",
        "      owner: acme",
        "      repo: repo",
        "rules: []",
        "",
      ].join("\n"),
    );

    const redis = new FakeRedisClient();
    const app = new FakeExpressApp();
    const executed: Array<{ run_id: string; ticket_id: string }> = [];

    const runtime = await registerDispatchRoutes(app, {
      configDir,
      redisClient: redis,
      autoStartConsumer: false,
      executeLocalRun: async (task) => {
        executed.push({ run_id: task.run_id, ticket_id: task.ticket_id });
      },
      idGenerator: () => "abc12345",
      now: () => 1_750_000_000_000,
    });

    const response = await app.inject({
      method: "POST",
      path: "/api/dispatch/run",
      body: {
        project_id: "acme",
        source: "github",
        ticket_id: "42",
      },
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: "queued" });
    expect(await redis.lLen(queueKey("acme"))).toBe(1);

    const processed = await runtime.processQueueOnce();

    expect(processed).toBe(true);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.ticket_id).toBe("42");
    expect(await redis.lLen(queueKey("acme"))).toBe(0);

    await runtime.close();
  });

  it("loads project configs from symlinked files (k8s ConfigMap layout)", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "sf-dispatch-config-symlink-"));
    tempDirs.push(configDir);
    const dataDir = path.join(configDir, "..data");
    mkdirSync(dataDir);

    const target = path.join(dataDir, "project-live-gaps-worktree.yaml");
    writeFileSync(
      target,
      [
        "project_id: live-gaps-worktree",
        "name: Live Gaps Worktree",
        "repo:",
        "  url: https://github.com/Sagart-cactus/sprintfoundry-dryrun.git",
        "  default_branch: main",
        "integrations:",
        "  ticket_source:",
        "    type: prompt",
        "    config: {}",
        "rules: []",
        "",
      ].join("\n"),
      "utf-8",
    );
    symlinkSync(target, path.join(configDir, "project-live-gaps-worktree.yaml"));

    const redis = new FakeRedisClient();
    const app = new FakeExpressApp();
    const runtime = await registerDispatchRoutes(app, {
      configDir,
      redisClient: redis,
      autoStartConsumer: false,
      idGenerator: () => "symlink01",
      now: () => 1_750_000_000_000,
    });

    const response = await app.inject({
      method: "POST",
      path: "/api/dispatch/run",
      body: {
        project_id: "live-gaps-worktree",
        source: "prompt",
        prompt: "smoke",
      },
    });

    expect(response.status).toBe(202);
    expect(await redis.lLen(queueKey("live-gaps-worktree"))).toBe(1);
    await runtime.close();
  });

  it("deduplicates github webhook deliveries via redis SET NX", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "sf-dispatch-config-"));
    tempDirs.push(configDir);

    makeProjectConfig(
      configDir,
      "project.yaml",
      [
        "project_id: gh-project",
        "name: GH Project",
        "repo:",
        "  url: git@github.com:acme/repo.git",
        "  default_branch: main",
        "api_keys:",
        "  anthropic: test",
        "branch_strategy:",
        "  prefix: feat/",
        "  include_ticket_id: true",
        "  naming: kebab-case",
        "integrations:",
        "  ticket_source:",
        "    type: github",
        "    config:",
        "      token: test",
        "      owner: acme",
        "      repo: repo",
        "autoexecute:",
        "  enabled: true",
        "  github:",
        "    enabled: true",
        "    webhook_secret: webhook-secret",
        "    allowed_events:",
        "      - issues.opened",
        "    require_command: false",
        "rules: []",
        "",
      ].join("\n"),
    );

    const redis = new FakeRedisClient();
    const app = new FakeExpressApp();

    const runtime = await registerDispatchRoutes(app, {
      configDir,
      redisClient: redis,
      autoStartConsumer: false,
      idGenerator: () => "evtid001",
      now: () => 1_750_000_000_000,
    });

    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 123, updated_at: "2026-03-04T10:00:00Z" },
      repository: { name: "repo", owner: { login: "acme" } },
    });

    const first = await app.inject({
      method: "POST",
      path: "/api/webhooks/github",
      rawBody: payload,
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "delivery-123",
        "x-hub-signature-256": githubSignature(payload, "webhook-secret"),
      },
    });

    const second = await app.inject({
      method: "POST",
      path: "/api/webhooks/github",
      rawBody: payload,
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "delivery-123",
        "x-hub-signature-256": githubSignature(payload, "webhook-secret"),
      },
    });

    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ accepted: true, queued: true, ticket_id: "123" });
    expect(second.status).toBe(202);
    expect(second.body).toMatchObject({ accepted: false, ignored: true, reason: "duplicate_event" });
    expect(await redis.lLen(queueKey("gh-project"))).toBe(1);

    await runtime.close();
  });

  it("enforces per-project quota before dispatching", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "sf-dispatch-config-"));
    tempDirs.push(configDir);

    makeProjectConfig(
      configDir,
      "project.yaml",
      [
        "project_id: quota-project",
        "name: Quota Project",
        "repo:",
        "  url: git@github.com:acme/repo.git",
        "  default_branch: main",
        "api_keys:",
        "  anthropic: test",
        "branch_strategy:",
        "  prefix: feat/",
        "  include_ticket_id: true",
        "  naming: kebab-case",
        "dispatch:",
        "  max_concurrent_runs: 1",
        "integrations:",
        "  ticket_source:",
        "    type: github",
        "    config:",
        "      token: test",
        "      owner: acme",
        "      repo: repo",
        "rules: []",
        "",
      ].join("\n"),
    );

    const redis = new FakeRedisClient();
    const app = new FakeExpressApp();
    const executed: string[] = [];

    const nowMs = 1_750_000_000_000;

    const runtime = await registerDispatchRoutes(app, {
      configDir,
      redisClient: redis,
      autoStartConsumer: false,
      executeLocalRun: async (task) => {
        executed.push(task.run_id);
      },
      now: () => nowMs,
      idGenerator: () => "quota001",
    });

    await app.inject({
      method: "POST",
      path: "/api/dispatch/run",
      body: {
        project_id: "quota-project",
        source: "github",
        ticket_id: "77",
      },
    });

    await redis.zAdd(activeKey("quota-project"), [{ score: nowMs + 60_000, value: "existing-run" }]);

    const processed = await runtime.processQueueOnce();

    expect(processed).toBe(false);
    expect(executed).toHaveLength(0);
    expect(await redis.lLen(queueKey("quota-project"))).toBe(1);

    await runtime.close();
  });

  it("builds a k8s job manifest with image, env, configmap mount, PVC workspace, and resources", () => {
    const manifest = buildK8sJobManifest(
      {
        run_id: "run-xyz",
        project_id: "proj-1",
        project_arg: "proj",
        source: "github",
        ticket_id: "55",
        agent: "qa",
        created_at: "2026-03-04T00:00:00.000Z",
      },
      {
        namespace: "proj-ns",
        image: "ghcr.io/acme/sprintfoundry:latest",
        projectSecretName: "proj-secret",
        projectConfigMapName: "proj-config",
      },
    );

    expect(manifest.kind).toBe("Job");
    expect(manifest.metadata.namespace).toBe("proj-ns");

    const container = manifest.spec.template.spec.containers[0];
    expect(container.image).toBe("ghcr.io/acme/sprintfoundry:latest");
    expect(container.args).toEqual([
      "run",
      "--source",
      "github",
      "--config",
      "/config",
      "--ticket",
      "55",
      "--project",
      "proj",
      "--agent",
      "qa",
    ]);
    expect(container.envFrom).toEqual([{ secretRef: { name: "proj-secret" } }]);
    expect(container.resources.requests).toEqual({ cpu: "500m", memory: "1Gi" });
    expect(container.resources.limits).toEqual({ cpu: "2", memory: "4Gi" });
    expect(container.env).toEqual(
      expect.arrayContaining([
        { name: "SPRINTFOUNDRY_RUN_ID", value: "run-xyz" },
        { name: "SPRINTFOUNDRY_RUN_SANDBOX_MODE", value: "k8s-whole-run" },
        { name: "SPRINTFOUNDRY_RUNS_ROOT", value: "/workspace" },
        { name: "SPRINTFOUNDRY_SESSIONS_DIR", value: "/workspace/.sprintfoundry/sessions" },
        { name: "SPRINTFOUNDRY_AUTO_RESUME_EXISTING_RUN", value: "1" },
        { name: "HOME", value: "/workspace/home" },
        { name: "CODEX_HOME", value: "/workspace/home/.codex" },
      ])
    );

    expect(manifest.spec.template.spec.volumes).toContainEqual({
      name: "project-config",
      configMap: { name: "proj-config" },
    });
    expect(manifest.spec.template.spec.volumes).toContainEqual({
      name: "workspace",
      persistentVolumeClaim: { claimName: "sf-run-ws-run-xyz" },
    });
    expect(manifest.spec.backoffLimit).toBe(1);
  });

  it("builds a k8s job manifest with event sink env when provided", () => {
    const manifest = buildK8sJobManifest(
      {
        run_id: "run-xyz",
        project_id: "proj-1",
        project_arg: "proj",
        source: "prompt",
        ticket_id: "prompt",
        prompt: "do the thing",
        created_at: "2026-03-04T00:00:00.000Z",
      },
      {
        namespace: "proj-ns",
        image: "ghcr.io/acme/sprintfoundry:latest",
        projectSecretName: "proj-secret",
        projectConfigMapName: "proj-config",
        eventSinkUrl: "https://sink.example/events",
        internalApiToken: "internal-token",
      },
    );

    expect(manifest.spec.template.spec.containers[0]?.env).toEqual(
      expect.arrayContaining([
        { name: "SPRINTFOUNDRY_EVENT_SINK_URL", value: "https://sink.example/events" },
        { name: "SPRINTFOUNDRY_INTERNAL_API_TOKEN", value: "internal-token" },
      ]),
    );
  });

  it("passes project-config event sink settings into dispatched k8s jobs", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "sf-dispatch-config-k8s-"));
    tempDirs.push(configDir);

    makeProjectConfig(
      configDir,
      "project-live-gaps-worktree.yaml",
      [
        "project_id: live-gaps-worktree",
        "name: Live Gaps Worktree",
        "repo:",
        "  url: https://github.com/Sagart-cactus/sprintfoundry-dryrun.git",
        "  default_branch: main",
        "integrations:",
        "  ticket_source:",
        "    type: prompt",
        "    config: {}",
        "  event_sink:",
        "    url: https://sink.example/from-config",
        "rules: []",
        "",
      ].join("\n"),
    );

    process.env.SPRINTFOUNDRY_INTERNAL_API_TOKEN = "internal-token";

    const redis = new FakeRedisClient();
    const app = new FakeExpressApp();
    const createdJobs: K8sJobManifest[] = [];
    const createdNamespaces: string[] = [];

    const runtime = await registerDispatchRoutes(app, {
      configDir,
      redisClient: redis,
      autoStartConsumer: false,
      k8sMode: true,
      createK8sJob: async (manifest, _task, namespace) => {
        createdJobs.push(manifest);
        createdNamespaces.push(namespace);
      },
      idGenerator: () => "k8sjob01",
      now: () => 1_750_000_000_000,
    });

    const response = await app.inject({
      method: "POST",
      path: "/api/dispatch/run",
      body: {
        project_id: "live-gaps-worktree",
        source: "prompt",
        prompt: "smoke",
      },
    });

    expect(response.status).toBe(202);

    const processed = await runtime.processQueueOnce();

    expect(processed).toBe(true);
    expect(createdNamespaces).toEqual(["live-gaps-worktree"]);
    expect(createdJobs).toHaveLength(1);
    expect(createdJobs[0]?.spec.template.spec.containers[0]?.env).toEqual(
      expect.arrayContaining([
        { name: "SPRINTFOUNDRY_EVENT_SINK_URL", value: "https://sink.example/from-config" },
        { name: "SPRINTFOUNDRY_INTERNAL_API_TOKEN", value: "internal-token" },
      ]),
    );

    await runtime.close();
  });

  it("builds a per-run PVC manifest for the runner workspace", () => {
    const manifest = buildK8sWorkspacePvcManifest(
      {
        run_id: "run-xyz",
        project_id: "proj-1",
        project_arg: "proj",
        source: "github",
        ticket_id: "55",
        created_at: "2026-03-04T00:00:00.000Z",
      },
      {
        namespace: "proj-ns",
        workspaceSizeLimit: "25Gi",
        workspaceStorageClassName: "fast-ssd",
      },
    );

    expect(manifest).toMatchObject({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: "sf-run-ws-run-xyz",
        namespace: "proj-ns",
        labels: {
          "sprintfoundry.io/project-id": "proj-1",
          "sprintfoundry.io/run-id": "run-xyz",
        },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: {
          requests: {
            storage: "25Gi",
          },
        },
        storageClassName: "fast-ssd",
      },
    });
  });

  it("buildJobOwnerReference creates a PVC cleanup owner reference from a Job", () => {
    expect(
      buildJobOwnerReference({
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: "sf-run-123",
          uid: "job-uid-123",
        },
      })
    ).toEqual({
      apiVersion: "batch/v1",
      kind: "Job",
      name: "sf-run-123",
      uid: "job-uid-123",
      controller: false,
      blockOwnerDeletion: false,
    });
  });

  it("retries PVC owner-reference attachment when the PVC changes underneath the first replace", async () => {
    const pvcManifest = buildK8sWorkspacePvcManifest(
      {
        run_id: "run-xyz",
        project_id: "proj-1",
        project_arg: "proj",
        source: "prompt",
        ticket_id: "prompt",
        prompt: "do the thing",
        created_at: "2026-03-04T00:00:00.000Z",
      },
      {
        namespace: "proj-ns",
      },
    );
    const ownerReference = buildJobOwnerReference({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: "sf-run-xyz",
        uid: "job-uid-123",
      },
    });

    const reads = [
      {
        body: {
          metadata: {
            name: pvcManifest.metadata.name,
            resourceVersion: "1",
          },
        },
      },
      {
        body: {
          metadata: {
            name: pvcManifest.metadata.name,
            resourceVersion: "2",
          },
        },
      },
    ];
    const replacedBodies: Array<Record<string, unknown>> = [];

    const coreApi = {
      async readNamespacedPersistentVolumeClaim(_args: { name: string; namespace: string }) {
        return reads.shift();
      },
      async replaceNamespacedPersistentVolumeClaim(args: {
        name: string;
        namespace: string;
        body: Record<string, unknown>;
      }) {
        replacedBodies.push(args.body);
        if (replacedBodies.length === 1) {
          throw new Error(
            "HTTP-Code: 409\nMessage: Operation cannot be fulfilled on persistentvolumeclaims \"sf-run-ws-run-xyz\": the object has been modified; please apply your changes to the latest version and try again",
          );
        }
      },
    };

    await attachWorkspacePvcToJob(coreApi, "proj-ns", pvcManifest, ownerReference);

    expect(replacedBodies).toHaveLength(2);
    expect((replacedBodies[1]?.metadata as { ownerReferences?: unknown[] } | undefined)?.ownerReferences).toEqual([
      ownerReference,
    ]);
  });
});
