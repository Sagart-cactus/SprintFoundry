// ============================================================
// SprintFoundry — Default Tracker Plugin
// Adapter that wraps the existing TicketFetcher behind
// the TrackerPlugin interface.
// ============================================================

import type {
  TrackerPlugin,
  PluginModule,
} from "../../shared/plugin-types.js";
import type {
  IntegrationConfig,
  TaskSource,
  TicketDetails,
} from "../../shared/types.js";
import { TicketFetcher } from "../../service/ticket-fetcher.js";

class DefaultTrackerPlugin implements TrackerPlugin {
  readonly name = "default";
  private fetcher: TicketFetcher;

  constructor(integrations: IntegrationConfig) {
    this.fetcher = new TicketFetcher(integrations);
  }

  async fetch(ticketId: string, source: TaskSource): Promise<TicketDetails> {
    return this.fetcher.fetch(ticketId, source);
  }

  async updateStatus(
    ticket: TicketDetails,
    status: string,
    prUrl?: string
  ): Promise<void> {
    return this.fetcher.updateStatus(ticket, status, prUrl);
  }
}

export const defaultTrackerModule: PluginModule<TrackerPlugin> = {
  manifest: {
    name: "default",
    slot: "tracker",
    version: "1.0.0",
    description: "Built-in tracker supporting GitHub, Linear, and Jira via TicketFetcher",
  },
  create: (config) => {
    const integrations = config.integrations as IntegrationConfig;
    if (!integrations) {
      throw new Error("tracker-default plugin requires 'integrations' in config");
    }
    return new DefaultTrackerPlugin(integrations);
  },
};
