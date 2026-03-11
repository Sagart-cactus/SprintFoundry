import { describe, expect, it } from "vitest";
import { resolveAutoResumeAction } from "../src/service/auto-resume.js";

describe("resolveAutoResumeAction", () => {
  it("returns fresh when no run id is available", () => {
    expect(resolveAutoResumeAction(undefined, null)).toBe("fresh");
  });

  it("returns fresh when no session exists", () => {
    expect(resolveAutoResumeAction("run-1", null)).toBe("fresh");
  });

  it("returns restart when the session exists but has no workspace path yet", () => {
    expect(resolveAutoResumeAction("run-1", { workspace_path: null })).toBe("restart");
  });

  it("returns resume when the session has a workspace path", () => {
    expect(resolveAutoResumeAction("run-1", { workspace_path: "/workspace/run-1" })).toBe("resume");
  });
});
