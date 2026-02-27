/**
 * Integration tests: Plugin Registry
 * Register/get/list plugins, slot conflicts, missing plugins.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PluginRegistry } from "../../src/service/plugin-registry.js";
import type { PluginModule, WorkspacePlugin, TrackerPlugin, SCMPlugin, NotifierPlugin } from "../../src/shared/plugin-types.js";
import {
  mockWorkspaceModule,
  mockTrackerModule,
  mockSCMModule,
  mockNotifierModule,
  createMockWorkspacePlugin,
  createMockNotifierPlugin,
} from "../helpers/plugin-mocks.js";

let registry: PluginRegistry;

beforeEach(() => {
  registry = new PluginRegistry();
});

describe("Plugin Registry — registration and retrieval", () => {
  it("registers and retrieves a workspace plugin", () => {
    registry.register(mockWorkspaceModule);
    const plugin = registry.get<WorkspacePlugin>("workspace", "mock-workspace");
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe("mock-workspace");
  });

  it("registers all 4 plugin slots", () => {
    registry.register(mockWorkspaceModule);
    registry.register(mockTrackerModule);
    registry.register(mockSCMModule);
    registry.register(mockNotifierModule);

    expect(registry.get<WorkspacePlugin>("workspace", "mock-workspace")).not.toBeNull();
    expect(registry.get<TrackerPlugin>("tracker", "mock-tracker")).not.toBeNull();
    expect(registry.get<SCMPlugin>("scm", "mock-scm")).not.toBeNull();
    expect(registry.get<NotifierPlugin>("notifier", "mock-notifier")).not.toBeNull();
  });

  it("returns null for unregistered slot/name", () => {
    expect(registry.get("workspace", "nonexistent")).toBeNull();
    expect(registry.get("notifier", "nonexistent")).toBeNull();
  });

  it("getFirst returns the first plugin for a slot", () => {
    registry.register(mockWorkspaceModule);
    const first = registry.getFirst<WorkspacePlugin>("workspace");
    expect(first).not.toBeNull();
    expect(first!.name).toBe("mock-workspace");
  });

  it("getFirst returns null when no plugins in slot", () => {
    expect(registry.getFirst("workspace")).toBeNull();
  });
});

describe("Plugin Registry — slot conflicts", () => {
  it("throws when registering duplicate slot+name", () => {
    registry.register(mockWorkspaceModule);
    expect(() => registry.register(mockWorkspaceModule)).toThrow(
      /already registered.*workspace.*mock-workspace/i
    );
  });

  it("allows multiple plugins in the same slot with different names", () => {
    registry.register(mockNotifierModule);

    const secondModule: PluginModule<NotifierPlugin> = {
      manifest: { name: "slack", slot: "notifier", version: "1.0.0" },
      create: () => createMockNotifierPlugin({ name: "slack" }),
    };
    registry.register(secondModule);

    expect(registry.get<NotifierPlugin>("notifier", "mock-notifier")).not.toBeNull();
    expect(registry.get<NotifierPlugin>("notifier", "slack")).not.toBeNull();
  });

  it("allows same name across different slots", () => {
    const wsModule: PluginModule<WorkspacePlugin> = {
      manifest: { name: "shared-name", slot: "workspace", version: "1.0.0" },
      create: () => createMockWorkspacePlugin({ name: "shared-name" }),
    };
    const notifierModule: PluginModule<NotifierPlugin> = {
      manifest: { name: "shared-name", slot: "notifier", version: "1.0.0" },
      create: () => createMockNotifierPlugin({ name: "shared-name" }),
    };

    registry.register(wsModule);
    registry.register(notifierModule);

    expect(registry.has("workspace", "shared-name")).toBe(true);
    expect(registry.has("notifier", "shared-name")).toBe(true);
  });
});

describe("Plugin Registry — listing and removal", () => {
  it("lists all registered manifests", () => {
    registry.register(mockWorkspaceModule);
    registry.register(mockNotifierModule);

    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.name).sort()).toEqual(["mock-notifier", "mock-workspace"]);
  });

  it("lists manifests filtered by slot", () => {
    registry.register(mockWorkspaceModule);
    registry.register(mockNotifierModule);
    registry.register(mockSCMModule);

    expect(registry.list("workspace")).toHaveLength(1);
    expect(registry.list("notifier")).toHaveLength(1);
    expect(registry.list("scm")).toHaveLength(1);
    expect(registry.list("tracker")).toHaveLength(0);
  });

  it("removes a plugin", () => {
    registry.register(mockWorkspaceModule);
    expect(registry.has("workspace", "mock-workspace")).toBe(true);

    const removed = registry.remove("workspace", "mock-workspace");
    expect(removed).toBe(true);
    expect(registry.has("workspace", "mock-workspace")).toBe(false);
    expect(registry.get("workspace", "mock-workspace")).toBeNull();
  });

  it("remove returns false for non-existent plugin", () => {
    expect(registry.remove("workspace", "doesnt-exist")).toBe(false);
  });

  it("can re-register after removal", () => {
    registry.register(mockWorkspaceModule);
    registry.remove("workspace", "mock-workspace");
    expect(() => registry.register(mockWorkspaceModule)).not.toThrow();
    expect(registry.has("workspace", "mock-workspace")).toBe(true);
  });
});

describe("Plugin Registry — create factory is called with config", () => {
  it("passes config to the create factory", () => {
    let receivedConfig: Record<string, unknown> = {};
    const module: PluginModule<NotifierPlugin> = {
      manifest: { name: "config-test", slot: "notifier", version: "1.0.0" },
      create(config) {
        receivedConfig = config;
        return createMockNotifierPlugin({ name: "config-test" });
      },
    };

    registry.register(module, { webhook_url: "https://hooks.example.com", channel: "#alerts" });
    expect(receivedConfig).toEqual({ webhook_url: "https://hooks.example.com", channel: "#alerts" });
  });
});
