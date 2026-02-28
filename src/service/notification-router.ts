// ============================================================
// SprintFoundry — Notification Router
// Routes notifications to multiple channels based on priority.
// ============================================================

import type {
  EventPriority,
  NotificationRoutingConfig,
} from "../shared/types.js";
import type { NotifierPlugin } from "../shared/plugin-types.js";

/**
 * Routes notifications to the appropriate notifier plugins based on
 * event priority. Falls back to console logging when no notifiers are
 * configured for a priority level.
 */
export class NotificationRouter {
  constructor(
    private plugins: Map<string, NotifierPlugin>,
    private routing: NotificationRoutingConfig
  ) {}

  /**
   * Send a notification to all channels configured for the given priority.
   * Uses Promise.allSettled so one failing notifier doesn't block others.
   */
  async notify(
    message: string,
    priority: EventPriority = "info"
  ): Promise<{ sent: number; failed: number }> {
    const notifierNames = this.routing[priority] ?? [];

    if (notifierNames.length === 0) {
      console.log(`[notify:${priority}] ${message}`);
      return { sent: 0, failed: 0 };
    }

    const results = await Promise.allSettled(
      notifierNames.map(async (name) => {
        const plugin = this.plugins.get(name);
        if (!plugin) {
          console.warn(`[notify] Notifier "${name}" not found, skipping`);
          throw new Error(`Notifier not found: ${name}`);
        }
        await plugin.notify(message, priority);
      })
    );

    let sent = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        sent++;
      } else {
        failed++;
        console.warn(`[notify] Delivery failed: ${result.reason}`);
      }
    }

    return { sent, failed };
  }

  /**
   * Convenience: infer priority from the event type string.
   */
  inferPriority(eventType: string): EventPriority {
    if (eventType.includes("failed") || eventType.includes("stuck")) return "urgent";
    if (eventType.includes("approved") || eventType.includes("merge")) return "action";
    if (eventType.includes("rework") || eventType.includes("warning")) return "warning";
    return "info";
  }

  /**
   * Send a notification with auto-inferred priority.
   */
  async notifyEvent(
    eventType: string,
    message: string
  ): Promise<{ sent: number; failed: number }> {
    const priority = this.inferPriority(eventType);
    return this.notify(message, priority);
  }
}

/**
 * Create a default routing config that sends everything to console.
 */
export function defaultRoutingConfig(): NotificationRoutingConfig {
  return {
    urgent: ["console"],
    action: ["console"],
    warning: ["console"],
    info: ["console"],
  };
}
