import { describe, it, expect } from "vitest";
import { RuntimeFactory } from "../src/service/runtime/runtime-factory.js";

describe("RuntimeFactory", () => {
  it("creates claude runtime", () => {
    const runtime = new RuntimeFactory().create({
      provider: "claude-code",
      mode: "local_process",
    });
    expect(runtime).toBeDefined();
  });

  it("creates codex runtime", () => {
    const runtime = new RuntimeFactory().create({
      provider: "codex",
      mode: "local_process",
    });
    expect(runtime).toBeDefined();
  });
});
