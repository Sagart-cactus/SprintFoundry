/**
 * Unit tests: Session Metadata
 * Parse/serialize RunSessionMetadata, update merge, field validation.
 */

import { describe, it, expect } from "vitest";
import type { RunSessionMetadata, RunStatus } from "../../src/shared/types.js";
import { makeTaskRun, makeCompletedRun, makeFailedRun } from "../helpers/session-factory.js";
import { makePlan } from "../fixtures/plans.js";

/** Simulate the persist logic to create metadata from a TaskRun. */
function extractMetadata(
  run: ReturnType<typeof makeTaskRun>,
  extra?: { workspace_path?: string; branch?: string }
): RunSessionMetadata {
  const currentStep = run.steps.length > 0
    ? Math.max(...run.steps.filter((s) => s.status === "running").map((s) => s.step_number), 0)
    : 0;
  const totalSteps = run.validated_plan?.steps.length ?? run.plan?.steps.length ?? 0;

  return {
    run_id: run.run_id,
    project_id: run.project_id,
    ticket_id: run.ticket?.id ?? "unknown",
    ticket_source: run.ticket?.source ?? "prompt",
    ticket_title: run.ticket?.title ?? "Unknown",
    status: run.status,
    current_step: currentStep,
    total_steps: totalSteps,
    plan_classification: run.plan?.classification ?? null,
    workspace_path: extra?.workspace_path ?? null,
    branch: extra?.branch ?? null,
    pr_url: run.pr_url,
    total_tokens: run.total_tokens_used,
    total_cost_usd: run.total_cost_usd,
    created_at: run.created_at instanceof Date ? run.created_at.toISOString() : String(run.created_at),
    updated_at: new Date().toISOString(),
    completed_at: run.completed_at instanceof Date ? run.completed_at.toISOString() : null,
    error: run.error,
  };
}

describe("Metadata — serialize from TaskRun", () => {
  it("extracts all required fields from an executing run", () => {
    const run = makeTaskRun({ status: "executing" });
    const meta = extractMetadata(run, { workspace_path: "/tmp/ws", branch: "feat/test" });

    expect(meta.run_id).toBe(run.run_id);
    expect(meta.project_id).toBe("test-project");
    expect(meta.ticket_id).toBe("TEST-123");
    expect(meta.ticket_source).toBe("github");
    expect(meta.status).toBe("executing");
    expect(meta.workspace_path).toBe("/tmp/ws");
    expect(meta.branch).toBe("feat/test");
    expect(meta.pr_url).toBeNull();
    expect(meta.total_tokens).toBe(run.total_tokens_used);
    expect(meta.total_cost_usd).toBe(run.total_cost_usd);
    expect(meta.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format
    expect(meta.error).toBeNull();
  });

  it("includes PR URL for completed runs", () => {
    const run = makeCompletedRun();
    const meta = extractMetadata(run);
    expect(meta.status).toBe("completed");
    expect(meta.pr_url).toBe("https://github.com/test/repo/pull/42");
    expect(meta.completed_at).not.toBeNull();
  });

  it("includes error for failed runs", () => {
    const run = makeFailedRun();
    const meta = extractMetadata(run);
    expect(meta.status).toBe("failed");
    expect(meta.error).toContain("failed");
  });

  it("computes current_step from running steps", () => {
    const run = makeTaskRun({
      steps: [
        { step_number: 1, agent: "developer", status: "completed", container_id: null, tokens_used: 0, cost_usd: 0, started_at: null, completed_at: null, result: null, rework_count: 0 },
        { step_number: 2, agent: "qa", status: "running", container_id: null, tokens_used: 0, cost_usd: 0, started_at: null, completed_at: null, result: null, rework_count: 0 },
      ],
    });
    const meta = extractMetadata(run);
    expect(meta.current_step).toBe(2);
  });

  it("computes current_step as 0 when no steps running", () => {
    const run = makeTaskRun({
      steps: [
        { step_number: 1, agent: "developer", status: "completed", container_id: null, tokens_used: 0, cost_usd: 0, started_at: null, completed_at: null, result: null, rework_count: 0 },
      ],
    });
    const meta = extractMetadata(run);
    expect(meta.current_step).toBe(0);
  });
});

describe("Metadata — JSON roundtrip", () => {
  it("survives JSON serialize/deserialize roundtrip", () => {
    const run = makeCompletedRun();
    const meta = extractMetadata(run);
    const json = JSON.stringify(meta, null, 2);
    const parsed = JSON.parse(json) as RunSessionMetadata;

    expect(parsed.run_id).toBe(meta.run_id);
    expect(parsed.project_id).toBe(meta.project_id);
    expect(parsed.status).toBe(meta.status);
    expect(parsed.total_tokens).toBe(meta.total_tokens);
    expect(parsed.total_cost_usd).toBe(meta.total_cost_usd);
    expect(parsed.pr_url).toBe(meta.pr_url);
    expect(parsed.created_at).toBe(meta.created_at);
    expect(parsed.completed_at).toBe(meta.completed_at);
  });

  it("null fields remain null after roundtrip", () => {
    const run = makeTaskRun({ pr_url: null, completed_at: null, error: null });
    const meta = extractMetadata(run);
    const parsed = JSON.parse(JSON.stringify(meta)) as RunSessionMetadata;

    expect(parsed.pr_url).toBeNull();
    expect(parsed.completed_at).toBeNull();
    expect(parsed.error).toBeNull();
    expect(parsed.workspace_path).toBeNull();
    expect(parsed.branch).toBeNull();
  });
});

describe("Metadata — update merge", () => {
  it("status update preserves other fields", () => {
    const run = makeTaskRun({ status: "executing" });
    const meta = extractMetadata(run, { workspace_path: "/tmp/ws" });

    // Simulate status update
    const updated: RunSessionMetadata = {
      ...meta,
      status: "completed" as RunStatus,
      updated_at: new Date().toISOString(),
    };

    expect(updated.run_id).toBe(meta.run_id);
    expect(updated.workspace_path).toBe("/tmp/ws");
    expect(updated.ticket_id).toBe(meta.ticket_id);
    expect(updated.status).toBe("completed");
  });

  it("partial update merges only specified fields", () => {
    const meta = extractMetadata(makeTaskRun());

    // Simulate adding PR URL and updating status
    const update: Partial<RunSessionMetadata> = {
      pr_url: "https://github.com/test/repo/pull/99",
      status: "completed",
    };

    const merged: RunSessionMetadata = { ...meta, ...update };
    expect(merged.pr_url).toBe("https://github.com/test/repo/pull/99");
    expect(merged.status).toBe("completed");
    expect(merged.project_id).toBe(meta.project_id); // preserved
  });
});

describe("Metadata — plan classification extraction", () => {
  it("extracts classification from plan", () => {
    const run = makeTaskRun();
    const meta = extractMetadata(run);
    expect(meta.plan_classification).toBe("new_feature");
  });

  it("returns null when no plan exists", () => {
    const run = makeTaskRun({ plan: null, validated_plan: null });
    const meta = extractMetadata(run);
    expect(meta.plan_classification).toBeNull();
  });

  it("handles different classifications", () => {
    const run = makeTaskRun({ plan: makePlan({ classification: "bug_fix" }) });
    const meta = extractMetadata(run);
    expect(meta.plan_classification).toBe("bug_fix");
  });
});
