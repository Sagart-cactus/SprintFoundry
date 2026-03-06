import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  extractGitHubTrigger,
  extractLinearTrigger,
  normalizeGitHubAutoexecuteConfig,
  normalizeLinearAutoexecuteConfig,
  verifyGitHubSignature,
  verifyLinearSignature,
  type GitHubAutoexecuteConfig,
  type LinearAutoexecuteConfig,
} from "../src/service/webhook-handler.js";

function githubSignature(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function linearSignature(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

const githubConfig: GitHubAutoexecuteConfig = {
  enabled: true,
  webhookSecret: "test-secret",
  allowedEvents: new Set(["issues.opened", "issues.labeled", "issue_comment.created"]),
  labelTrigger: "sf:auto-run",
  commandTrigger: "/sf-run",
  requireCommand: false,
  dedupeWindowMinutes: 30,
};

const linearConfig: LinearAutoexecuteConfig = {
  enabled: true,
  webhookSecret: "linear-secret",
  allowedEvents: new Set(["Issue.create", "Comment.create"]),
  commandTrigger: "/sf-run",
  requireCommand: false,
  dedupeWindowMinutes: 30,
  maxTimestampAgeSeconds: 120,
};

describe("webhook-handler signatures", () => {
  it("verifies valid github signature", () => {
    const body = JSON.stringify({ action: "opened" });
    expect(verifyGitHubSignature(body, githubSignature(body, "test-secret"), "test-secret")).toBe(true);
  });

  it("rejects invalid github signature", () => {
    const body = JSON.stringify({ action: "opened" });
    expect(verifyGitHubSignature(body, "sha256=bad", "test-secret")).toBe(false);
  });

  it("rejects missing github signature", () => {
    const body = JSON.stringify({ action: "opened" });
    expect(verifyGitHubSignature(body, "", "test-secret")).toBe(false);
  });

  it("verifies valid linear signature", () => {
    const body = JSON.stringify({ action: "create", type: "Issue" });
    expect(verifyLinearSignature(body, linearSignature(body, "linear-secret"), "linear-secret")).toBe(true);
  });

  it("rejects invalid linear signature", () => {
    const body = JSON.stringify({ action: "create", type: "Issue" });
    expect(verifyLinearSignature(body, "bad", "linear-secret")).toBe(false);
  });

  it("rejects missing linear signature", () => {
    const body = JSON.stringify({ action: "create", type: "Issue" });
    expect(verifyLinearSignature(body, "", "linear-secret")).toBe(false);
  });
});

describe("webhook-handler github trigger extraction", () => {
  it("allows issue opened", () => {
    const result = extractGitHubTrigger(
      {
        issue: { number: 42, updated_at: "2026-03-01T10:00:00Z" },
      },
      "issues",
      "opened",
      githubConfig
    );
    expect(result).toEqual({ allowed: true, ticketId: "42" });
  });

  it("allows issue labeled when label matches trigger", () => {
    const result = extractGitHubTrigger(
      {
        issue: { number: 43, updated_at: "2026-03-01T10:01:00Z" },
        label: { name: "sf:auto-run" },
      },
      "issues",
      "labeled",
      githubConfig
    );
    expect(result).toEqual({ allowed: true, ticketId: "43" });
  });

  it("allows issue comment create when command is present", () => {
    const result = extractGitHubTrigger(
      {
        issue: { number: 44, updated_at: "2026-03-01T10:02:00Z" },
        comment: { body: "please run /sf-run now" },
      },
      "issue_comment",
      "created",
      githubConfig
    );
    expect(result).toEqual({ allowed: true, ticketId: "44" });
  });
});

describe("webhook-handler linear trigger extraction", () => {
  it("allows linear issue create", () => {
    const result = extractLinearTrigger(
      {
        type: "Issue",
        action: "create",
        data: { identifier: "SPR-123", teamId: "spr" },
      },
      linearConfig
    );
    expect(result).toEqual({ allowed: true, ticketId: "SPR-123" });
  });

  it("allows linear comment create when command is present", () => {
    const result = extractLinearTrigger(
      {
        type: "Comment",
        action: "create",
        data: { identifier: "SPR-124", body: "please /sf-run this" },
      },
      linearConfig
    );
    expect(result).toEqual({ allowed: true, ticketId: "SPR-124" });
  });
});

describe("webhook-handler config normalization", () => {
  it("normalizes github autoexecute config with defaults", () => {
    const cfg = normalizeGitHubAutoexecuteConfig({
      autoexecute: { enabled: true, github: { webhook_secret: "abc" } },
    } as Record<string, unknown>);
    expect(cfg.enabled).toBe(true);
    expect(cfg.webhookSecret).toBe("abc");
    expect(cfg.allowedEvents.has("issues.opened")).toBe(true);
    expect(cfg.commandTrigger).toBe("/sf-run");
    expect(cfg.labelTrigger).toBe("sf:auto-run");
  });

  it("normalizes linear autoexecute config with defaults", () => {
    const cfg = normalizeLinearAutoexecuteConfig({
      autoexecute: { enabled: true, linear: { webhook_secret: "xyz" } },
    } as Record<string, unknown>);
    expect(cfg.enabled).toBe(true);
    expect(cfg.webhookSecret).toBe("xyz");
    expect(cfg.allowedEvents.has("Issue.create")).toBe(true);
    expect(cfg.commandTrigger).toBe("/sf-run");
    expect(cfg.maxTimestampAgeSeconds).toBe(120);
  });
});
