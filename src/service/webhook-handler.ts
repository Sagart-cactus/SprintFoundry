import crypto from "node:crypto";

export type TriggerResult = {
  allowed: boolean;
  ticketId?: string;
  reason?: string;
};

export type GitHubAutoexecuteConfig = {
  enabled: boolean;
  webhookSecret: string;
  allowedEvents: Set<string>;
  labelTrigger: string;
  commandTrigger: string;
  requireCommand: boolean;
  dedupeWindowMinutes: number;
};

export type LinearAutoexecuteConfig = {
  enabled: boolean;
  webhookSecret: string;
  allowedEvents: Set<string>;
  commandTrigger: string;
  requireCommand: boolean;
  dedupeWindowMinutes: number;
  maxTimestampAgeSeconds: number;
};

type AnyRecord = Record<string, unknown>;

export function normalizeGitHubAutoexecuteConfig(raw: AnyRecord): GitHubAutoexecuteConfig {
  const github = (raw?.autoexecute as AnyRecord | undefined)?.github as AnyRecord | undefined ?? {};
  const topEnabled = (raw?.autoexecute as AnyRecord | undefined)?.enabled;
  const enabled = (github.enabled ?? topEnabled) === true;
  const allowedEvents = Array.isArray(github.allowed_events) && github.allowed_events.length
    ? github.allowed_events.map((v) => String(v))
    : ["issues.opened", "issues.labeled", "issue_comment.created"];
  return {
    enabled,
    webhookSecret: String(github.webhook_secret ?? "").trim(),
    allowedEvents: new Set(allowedEvents),
    labelTrigger: String(github.label_trigger ?? "sf:auto-run"),
    commandTrigger: String(github.command_trigger ?? "/sf-run"),
    requireCommand: github.require_command === true,
    dedupeWindowMinutes: Number(github.dedupe_window_minutes ?? 30),
  };
}

export function normalizeLinearAutoexecuteConfig(raw: AnyRecord): LinearAutoexecuteConfig {
  const linear = (raw?.autoexecute as AnyRecord | undefined)?.linear as AnyRecord | undefined ?? {};
  const topEnabled = (raw?.autoexecute as AnyRecord | undefined)?.enabled;
  const enabled = (linear.enabled ?? topEnabled) === true;
  const allowedEvents = Array.isArray(linear.allowed_events) && linear.allowed_events.length
    ? linear.allowed_events.map((v) => String(v))
    : ["Issue.create"];
  return {
    enabled,
    webhookSecret: String(linear.webhook_secret ?? "").trim(),
    allowedEvents: new Set(allowedEvents),
    commandTrigger: String(linear.command_trigger ?? "/sf-run"),
    requireCommand: linear.require_command === true,
    dedupeWindowMinutes: Number(linear.dedupe_window_minutes ?? 30),
    maxTimestampAgeSeconds: Number(linear.max_timestamp_age_seconds ?? 120),
  };
}

export function verifyGitHubSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  if (!secret) return false;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuf = Buffer.from(expected, "utf-8");
  const providedBuf = Buffer.from(signatureHeader, "utf-8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export function verifyLinearSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  if (!secret) return false;
  const provided = String(signatureHeader ?? "").trim();
  if (!provided) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf-8");
  const providedBuf = Buffer.from(provided, "utf-8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export function extractGitHubTrigger(
  payload: AnyRecord,
  event: string,
  action: string,
  config: GitHubAutoexecuteConfig
): TriggerResult {
  const issue = payload?.issue as AnyRecord | undefined;
  if (!issue || typeof issue !== "object") return { allowed: false, reason: "missing_issue" };
  if (issue.pull_request) return { allowed: false, reason: "pull_request_issue_ignored" };

  const normalizedEvent = `${event}.${action}`;
  if (!config.allowedEvents.has(normalizedEvent)) {
    return { allowed: false, reason: `event_not_allowed:${normalizedEvent}` };
  }

  if (event === "issues" && action === "opened") {
    if (config.requireCommand) {
      return { allowed: false, reason: "command_required" };
    }
    return { allowed: true, ticketId: String(issue.number) };
  }

  if (event === "issues" && action === "labeled") {
    const labelName = String((payload?.label as AnyRecord | undefined)?.name ?? "");
    if (!labelName || labelName !== config.labelTrigger) {
      return { allowed: false, reason: "label_trigger_not_matched" };
    }
    return { allowed: true, ticketId: String(issue.number) };
  }

  if (event === "issue_comment" && action === "created") {
    const body = String(((payload?.comment as AnyRecord | undefined)?.body) ?? "");
    if (!body.includes(config.commandTrigger)) {
      return { allowed: false, reason: "command_not_found" };
    }
    return { allowed: true, ticketId: String(issue.number) };
  }

  return { allowed: false, reason: "unsupported_action" };
}

export function extractLinearTrigger(
  payload: AnyRecord,
  config: LinearAutoexecuteConfig
): TriggerResult {
  const type = String(payload?.type ?? "");
  const action = String(payload?.action ?? "");
  const normalizedEvent = `${type}.${action}`;
  if (!config.allowedEvents.has(normalizedEvent)) {
    return { allowed: false, reason: `event_not_allowed:${normalizedEvent}` };
  }

  const data = payload?.data as AnyRecord | undefined ?? {};
  const issueIdentifier = String(data?.identifier ?? (data?.issue as AnyRecord | undefined)?.identifier ?? "");
  const issueIdFallback = String(data?.id ?? data?.issueId ?? (data?.issue as AnyRecord | undefined)?.id ?? "");
  const ticketId = issueIdentifier || issueIdFallback;
  if (!ticketId) return { allowed: false, reason: "missing_ticket_identifier" };

  if (type === "Comment" && action === "create") {
    const body = String(data?.body ?? "");
    if (!body.includes(config.commandTrigger)) {
      return { allowed: false, reason: "command_not_found" };
    }
    return { allowed: true, ticketId };
  }

  if (config.requireCommand) {
    return { allowed: false, reason: "command_required" };
  }

  return { allowed: true, ticketId };
}
