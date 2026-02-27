// ============================================================
// SprintFoundry — Plugin Registry
// Registers and retrieves plugin instances by slot + name
// ============================================================

import type {
  PluginSlot,
  PluginManifest,
  PluginModule,
} from "../shared/plugin-types.js";

export class PluginRegistry {
  private plugins = new Map<string, { manifest: PluginManifest; instance: unknown }>();

  private key(slot: PluginSlot, name: string): string {
    return `${slot}:${name}`;
  }

  /**
   * Register a plugin module. The `create` factory is called immediately with the
   * provided config and the resulting instance is stored for retrieval.
   */
  register<T>(module: PluginModule<T>, config: Record<string, unknown> = {}): void {
    const { manifest } = module;
    const k = this.key(manifest.slot, manifest.name);
    if (this.plugins.has(k)) {
      throw new Error(
        `Plugin already registered for slot "${manifest.slot}" with name "${manifest.name}"`
      );
    }
    const instance = module.create(config);
    this.plugins.set(k, { manifest, instance });
  }

  /**
   * Get a plugin instance by slot and name.
   * Returns null if not found.
   */
  get<T>(slot: PluginSlot, name: string): T | null {
    const entry = this.plugins.get(this.key(slot, name));
    return entry ? (entry.instance as T) : null;
  }

  /**
   * Get the first registered plugin for a slot.
   * Useful when there's only one plugin per slot (common case).
   */
  getFirst<T>(slot: PluginSlot): T | null {
    for (const [, entry] of this.plugins) {
      if (entry.manifest.slot === slot) {
        return entry.instance as T;
      }
    }
    return null;
  }

  /**
   * List all registered plugin manifests, optionally filtered by slot.
   */
  list(slot?: PluginSlot): PluginManifest[] {
    const manifests: PluginManifest[] = [];
    for (const [, entry] of this.plugins) {
      if (!slot || entry.manifest.slot === slot) {
        manifests.push(entry.manifest);
      }
    }
    return manifests;
  }

  /**
   * Check if a plugin is registered for a slot + name.
   */
  has(slot: PluginSlot, name: string): boolean {
    return this.plugins.has(this.key(slot, name));
  }

  /**
   * Remove a plugin by slot + name. Returns true if it existed.
   */
  remove(slot: PluginSlot, name: string): boolean {
    return this.plugins.delete(this.key(slot, name));
  }
}
