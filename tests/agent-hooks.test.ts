import { describe, it, expect } from "vitest";
import * as path from "path";
import { evaluateGuardrail } from "../src/service/runtime/agent-hooks.js";

const workspace = path.join("/tmp", "agent-hooks-test");

describe("guardrail evaluation", () => {
  it("blocks commands that match deny regex", () => {
    const decision = evaluateGuardrail(
      { deny_commands: ["rm\\s+-rf"], deny_paths: [], allow_paths: [] },
      { kind: "command", command: "rm -rf /" },
      workspace
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("command_denied");
  });

  it("blocks paths outside workspace", () => {
    const decision = evaluateGuardrail(
      { deny_paths: [], allow_paths: [] },
      { kind: "file", path: "../secrets.txt" },
      workspace
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("path_outside_workspace");
  });

  it("enforces allow_paths when configured", () => {
    const decision = evaluateGuardrail(
      { allow_paths: ["src/**"] },
      { kind: "file", path: "tests/sample.txt" },
      workspace
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("path_not_allowed");
  });

  it("blocks deny_paths even when allow_paths matches", () => {
    const decision = evaluateGuardrail(
      { allow_paths: ["src/**"], deny_paths: ["src/private/**"] },
      { kind: "file", path: "src/private/secret.txt" },
      workspace
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("path_denied");
  });
});
