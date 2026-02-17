// ============================================================
// SprintFoundry — Notification Service
// Sends notifications via Slack webhook, email, or generic webhook
// ============================================================

import type { IntegrationConfig } from "../shared/types.js";

export class NotificationService {
  private type: string | undefined;
  private config: Record<string, string>;

  constructor(integrations: IntegrationConfig) {
    this.type = integrations.notifications?.type;
    this.config = integrations.notifications?.config ?? {};
  }

  async send(message: string): Promise<void> {
    // Always log to console
    console.log(`[notify] ${message}`);

    if (!this.type) return;

    switch (this.type) {
      case "slack":
        await this.sendSlack(message);
        break;
      case "webhook":
        await this.sendWebhook(message);
        break;
      case "email":
        // TODO: implement email via SMTP or SES
        console.log(`[notify:email] Email notifications not yet implemented`);
        break;
    }
  }

  private async sendSlack(message: string): Promise<void> {
    const webhookUrl = this.config.webhook_url;
    if (!webhookUrl) {
      console.warn("[notify:slack] No webhook_url configured, skipping");
      return;
    }

    try {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: message,
          channel: this.config.channel,
        }),
      });

      if (!resp.ok) {
        console.error(`[notify:slack] Failed: ${resp.status} ${resp.statusText}`);
      }
    } catch (err) {
      console.error(`[notify:slack] Error:`, err);
    }
  }

  private async sendWebhook(message: string): Promise<void> {
    const url = this.config.url;
    if (!url) {
      console.warn("[notify:webhook] No url configured, skipping");
      return;
    }

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          source: "sprintfoundry",
          timestamp: new Date().toISOString(),
        }),
      });

      if (!resp.ok) {
        console.error(`[notify:webhook] Failed: ${resp.status} ${resp.statusText}`);
      }
    } catch (err) {
      console.error(`[notify:webhook] Error:`, err);
    }
  }
}
