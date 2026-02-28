// ============================================================
// SprintFoundry — Console Notifier Plugin
// Adapter that wraps the existing NotificationService behind
// the NotifierPlugin interface.
// ============================================================

import type {
  NotifierPlugin,
  EventPriority,
  PluginModule,
} from "../../shared/plugin-types.js";
import type { IntegrationConfig } from "../../shared/types.js";
import { NotificationService } from "../../service/notification-service.js";

class ConsoleNotifierPlugin implements NotifierPlugin {
  readonly name = "console";
  private service: NotificationService;

  constructor(integrations: IntegrationConfig) {
    this.service = new NotificationService(integrations);
  }

  async notify(message: string, _priority?: EventPriority): Promise<void> {
    return this.service.send(message);
  }
}

export const consoleNotifierModule: PluginModule<NotifierPlugin> = {
  manifest: {
    name: "console",
    slot: "notifier",
    version: "1.0.0",
    description: "Built-in notifier that logs to console + optional Slack/webhook via NotificationService",
  },
  create: (config) => {
    const integrations = config.integrations as IntegrationConfig;
    if (!integrations) {
      throw new Error("notifier-console plugin requires 'integrations' in config");
    }
    return new ConsoleNotifierPlugin(integrations);
  },
};
