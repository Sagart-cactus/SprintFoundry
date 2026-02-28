import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginRegistry } from "../src/service/plugin-registry.js";
import { tmpdirWorkspaceModule } from "../src/plugins/workspace-tmpdir/index.js";
import { defaultTrackerModule } from "../src/plugins/tracker-default/index.js";
import { consoleNotifierModule } from "../src/plugins/notifier-console/index.js";
import type { WorkspacePlugin, TrackerPlugin, NotifierPlugin } from "../src/shared/plugin-types.js";

// Mock the underlying services so we don't hit the filesystem or network
vi.mock("../src/service/workspace-manager.js", () => ({
  WorkspaceManager: class {
    create = vi.fn().mockResolvedValue("/tmp/sprintfoundry/test/run-123");
    cleanup = vi.fn().mockResolvedValue(undefined);
    list = vi.fn().mockResolvedValue(["run-1", "run-2"]);
    getPath = vi.fn().mockReturnValue("/tmp/sprintfoundry/test/run-123");
  },
}));

vi.mock("../src/service/git-manager.js", () => ({
  GitManager: class {
    cloneAndBranch = vi.fn().mockResolvedValue("feat/test-branch");
    commitStepCheckpoint = vi.fn().mockResolvedValue(true);
    createPullRequest = vi.fn().mockResolvedValue("https://github.com/test/repo/pull/42");
  },
}));

vi.mock("../src/service/ticket-fetcher.js", () => ({
  TicketFetcher: class {
    fetch = vi.fn().mockResolvedValue({
      id: "TEST-1",
      source: "github",
      title: "Test ticket",
      description: "A test ticket",
      labels: [],
      priority: "p2",
      acceptance_criteria: [],
      linked_tickets: [],
      comments: [],
      author: "tester",
      raw: {},
    });
    updateStatus = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("../src/service/notification-service.js", () => ({
  NotificationService: class {
    send = vi.fn().mockResolvedValue(undefined);
  },
}));

// ---------- Helpers ----------

const makeTicket = () => ({
  id: "TEST-1",
  source: "github" as const,
  title: "Test ticket",
  description: "A test ticket",
  labels: [],
  priority: "p2" as const,
  acceptance_criteria: [],
  linked_tickets: [],
  comments: [],
  author: "tester",
  raw: {},
});

const makeIntegrations = () => ({
  ticket_source: {
    type: "github" as const,
    config: { token: "ghp_test", owner: "test-org", repo: "test-repo" },
  },
});

// ---------- Tests ----------

describe("workspace-tmpdir plugin", () => {
  it("registers and resolves from registry", () => {
    const registry = new PluginRegistry();
    registry.register(tmpdirWorkspaceModule, { project_id: "test-project" });

    const plugin = registry.get<WorkspacePlugin>("workspace", "tmpdir");
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe("tmpdir");
  });

  it("create delegates to WorkspaceManager + GitManager", async () => {
    const registry = new PluginRegistry();
    registry.register(tmpdirWorkspaceModule, { project_id: "test-project" });

    const plugin = registry.get<WorkspacePlugin>("workspace", "tmpdir")!;
    const result = await plugin.create(
      "run-123",
      { url: "https://github.com/test/repo.git", default_branch: "main" },
      { prefix: "feat/", include_ticket_id: true, naming: "kebab-case" },
      makeTicket()
    );

    expect(result.path).toBe("/tmp/sprintfoundry/test/run-123");
    expect(result.branch).toBe("feat/test-branch");
  });

  it("commitStepChanges delegates to GitManager", async () => {
    const registry = new PluginRegistry();
    registry.register(tmpdirWorkspaceModule, { project_id: "test-project" });

    const plugin = registry.get<WorkspacePlugin>("workspace", "tmpdir")!;
    // Must create first to initialize GitManager
    await plugin.create(
      "run-123",
      { url: "https://github.com/test/repo.git", default_branch: "main" },
      { prefix: "feat/", include_ticket_id: true, naming: "kebab-case" },
      makeTicket()
    );

    const committed = await plugin.commitStepChanges("/tmp/test", "run-123", 1, "developer");
    expect(committed).toBe(true);
  });

  it("throws if commitStepChanges called before create", async () => {
    const registry = new PluginRegistry();
    registry.register(tmpdirWorkspaceModule, { project_id: "test-project" });

    const plugin = registry.get<WorkspacePlugin>("workspace", "tmpdir")!;
    await expect(
      plugin.commitStepChanges("/tmp/test", "run-123", 1, "developer")
    ).rejects.toThrow(/not initialized/);
  });

  it("list delegates to WorkspaceManager", async () => {
    const registry = new PluginRegistry();
    registry.register(tmpdirWorkspaceModule, { project_id: "test-project" });

    const plugin = registry.get<WorkspacePlugin>("workspace", "tmpdir")!;
    const runs = await plugin.list();
    expect(runs).toEqual(["run-1", "run-2"]);
  });
});

describe("tracker-default plugin", () => {
  it("registers and resolves from registry", () => {
    const registry = new PluginRegistry();
    registry.register(defaultTrackerModule, { integrations: makeIntegrations() });

    const plugin = registry.get<TrackerPlugin>("tracker", "default");
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe("default");
  });

  it("fetch delegates to TicketFetcher", async () => {
    const registry = new PluginRegistry();
    registry.register(defaultTrackerModule, { integrations: makeIntegrations() });

    const plugin = registry.get<TrackerPlugin>("tracker", "default")!;
    const ticket = await plugin.fetch("TEST-1", "github");
    expect(ticket.id).toBe("TEST-1");
    expect(ticket.source).toBe("github");
  });

  it("updateStatus delegates to TicketFetcher", async () => {
    const registry = new PluginRegistry();
    registry.register(defaultTrackerModule, { integrations: makeIntegrations() });

    const plugin = registry.get<TrackerPlugin>("tracker", "default")!;
    await expect(
      plugin.updateStatus(makeTicket(), "in_review", "https://github.com/test/repo/pull/1")
    ).resolves.not.toThrow();
  });

  it("throws if integrations not provided", () => {
    const registry = new PluginRegistry();
    expect(() => registry.register(defaultTrackerModule, {})).toThrow(
      /requires.*integrations/
    );
  });
});

describe("notifier-console plugin", () => {
  it("registers and resolves from registry", () => {
    const registry = new PluginRegistry();
    registry.register(consoleNotifierModule, { integrations: makeIntegrations() });

    const plugin = registry.get<NotifierPlugin>("notifier", "console");
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe("console");
  });

  it("notify delegates to NotificationService.send", async () => {
    const registry = new PluginRegistry();
    registry.register(consoleNotifierModule, { integrations: makeIntegrations() });

    const plugin = registry.get<NotifierPlugin>("notifier", "console")!;
    await expect(plugin.notify("Test message", "info")).resolves.not.toThrow();
  });

  it("throws if integrations not provided", () => {
    const registry = new PluginRegistry();
    expect(() => registry.register(consoleNotifierModule, {})).toThrow(
      /requires.*integrations/
    );
  });
});

describe("full registry with all builtin plugins", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
    registry.register(tmpdirWorkspaceModule, { project_id: "test" });
    registry.register(defaultTrackerModule, { integrations: makeIntegrations() });
    registry.register(consoleNotifierModule, { integrations: makeIntegrations() });
  });

  it("lists all 3 builtin plugins", () => {
    const all = registry.list();
    expect(all).toHaveLength(3);
    expect(all.map((m) => m.slot).sort()).toEqual(["notifier", "tracker", "workspace"]);
  });

  it("getFirst resolves each slot", () => {
    expect(registry.getFirst<WorkspacePlugin>("workspace")).not.toBeNull();
    expect(registry.getFirst<TrackerPlugin>("tracker")).not.toBeNull();
    expect(registry.getFirst<NotifierPlugin>("notifier")).not.toBeNull();
    expect(registry.getFirst("scm")).toBeNull(); // not registered
  });
});
