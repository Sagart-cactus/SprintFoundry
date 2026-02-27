import { describe, it, expect, beforeEach } from "vitest";
import { PluginRegistry } from "../src/service/plugin-registry.js";
import type { PluginModule, NotifierPlugin, WorkspacePlugin } from "../src/shared/plugin-types.js";

// ---------- Test helpers ----------

function makeNotifierModule(name = "test-notifier"): PluginModule<NotifierPlugin> {
  return {
    manifest: {
      name,
      slot: "notifier",
      version: "1.0.0",
      description: "Test notifier",
    },
    create: () => ({
      name,
      notify: async () => {},
    }),
  };
}

function makeWorkspaceModule(name = "test-workspace"): PluginModule<WorkspacePlugin> {
  return {
    manifest: {
      name,
      slot: "workspace",
      version: "1.0.0",
    },
    create: () => ({
      name,
      create: async () => ({ path: "/tmp/test", branch: "feat/test" }),
      destroy: async () => {},
      commitStepChanges: async () => true,
      createPullRequest: async () => "https://github.com/test/repo/pull/1",
      getPath: () => "/tmp/test",
      list: async () => [],
    }),
  };
}

// ---------- Tests ----------

describe("PluginRegistry", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it("registers and retrieves a plugin by slot + name", () => {
    registry.register(makeNotifierModule("slack"));
    const plugin = registry.get<NotifierPlugin>("notifier", "slack");
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe("slack");
  });

  it("returns null for unregistered plugin", () => {
    const plugin = registry.get<NotifierPlugin>("notifier", "nonexistent");
    expect(plugin).toBeNull();
  });

  it("rejects duplicate registration for same slot + name", () => {
    registry.register(makeNotifierModule("slack"));
    expect(() => registry.register(makeNotifierModule("slack"))).toThrow(
      /already registered.*notifier.*slack/
    );
  });

  it("allows same name in different slots", () => {
    registry.register(makeNotifierModule("default"));
    registry.register(makeWorkspaceModule("default"));

    expect(registry.get<NotifierPlugin>("notifier", "default")).not.toBeNull();
    expect(registry.get<WorkspacePlugin>("workspace", "default")).not.toBeNull();
  });

  it("getFirst returns the first plugin registered for a slot", () => {
    registry.register(makeNotifierModule("first"));
    registry.register(makeNotifierModule("second"));

    const plugin = registry.getFirst<NotifierPlugin>("notifier");
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe("first");
  });

  it("getFirst returns null when no plugins registered for slot", () => {
    registry.register(makeNotifierModule("slack"));
    expect(registry.getFirst("workspace")).toBeNull();
  });

  it("list returns all manifests", () => {
    registry.register(makeNotifierModule("slack"));
    registry.register(makeWorkspaceModule("tmpdir"));

    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.name).sort()).toEqual(["slack", "tmpdir"]);
  });

  it("list filters by slot", () => {
    registry.register(makeNotifierModule("slack"));
    registry.register(makeNotifierModule("webhook"));
    registry.register(makeWorkspaceModule("tmpdir"));

    const notifiers = registry.list("notifier");
    expect(notifiers).toHaveLength(2);
    expect(notifiers.every((m) => m.slot === "notifier")).toBe(true);

    const workspaces = registry.list("workspace");
    expect(workspaces).toHaveLength(1);
  });

  it("has returns true for registered plugins", () => {
    registry.register(makeNotifierModule("slack"));
    expect(registry.has("notifier", "slack")).toBe(true);
    expect(registry.has("notifier", "webhook")).toBe(false);
  });

  it("remove deletes a registered plugin", () => {
    registry.register(makeNotifierModule("slack"));
    expect(registry.has("notifier", "slack")).toBe(true);

    const removed = registry.remove("notifier", "slack");
    expect(removed).toBe(true);
    expect(registry.has("notifier", "slack")).toBe(false);
    expect(registry.get("notifier", "slack")).toBeNull();
  });

  it("remove returns false for nonexistent plugin", () => {
    expect(registry.remove("notifier", "nonexistent")).toBe(false);
  });

  it("passes config to the create factory", () => {
    const module: PluginModule<{ webhookUrl: string }> = {
      manifest: { name: "custom", slot: "notifier", version: "1.0.0" },
      create: (config) => ({ webhookUrl: config.url as string }),
    };

    registry.register(module, { url: "https://hooks.example.com" });
    const instance = registry.get<{ webhookUrl: string }>("notifier", "custom");
    expect(instance!.webhookUrl).toBe("https://hooks.example.com");
  });
});
