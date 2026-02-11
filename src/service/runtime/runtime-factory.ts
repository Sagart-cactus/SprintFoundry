import type { AgentRuntime } from "./types.js";
import type { RuntimeConfig } from "../../shared/types.js";
import { ClaudeCodeRuntime } from "./claude-code-runtime.js";
import { CodexRuntime } from "./codex-runtime.js";

export class RuntimeFactory {
  create(runtime: RuntimeConfig): AgentRuntime {
    switch (runtime.provider) {
      case "claude-code":
        return new ClaudeCodeRuntime();
      case "codex":
        return new CodexRuntime();
      default:
        throw new Error(`Unsupported runtime provider: ${(runtime as RuntimeConfig).provider}`);
    }
  }
}
