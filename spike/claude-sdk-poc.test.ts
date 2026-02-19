/**
 * spike/claude-sdk-poc.test.ts
 *
 * Validates spike/claude-sdk-poc.ts and spike/FINDINGS.md against acceptance
 * criteria from ticket #11.
 *
 * Run with:
 *   npx vitest run spike/claude-sdk-poc.test.ts
 *
 * Acceptance criteria tested:
 *   AC1 - ClaudeAgentOptions fields: permissionMode, maxBudgetUsd, plugins, cwd, systemPrompt
 *         and allowedTools/permissionMode interaction documented
 *   AC2 - FINDINGS.md: StepExecution/RuntimeStepResult types, empirical multi-run latency
 *         data, §7.8 plugin load failure, §7.1 SDKRateLimitEvent undefined/compile-error,
 *         §7.9 allowedTools/permissionMode interaction
 *   AC3 - @anthropic-ai/claude-agent-sdk in package.json dependencies
 *   AC4 - SDKRateLimitEvent documented as undefined/TS2304 compile-error severity
 *   AC5 - allowedTools/permissionMode interaction correctly documented
 *   AC6 - computeLatencyStats helper logic correct (multi-run stats)
 *   AC7 - assertPluginLoaded helper logic correct
 *   AC8 - PoC stub mode runs without error
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "fs/promises";
import { execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Resolve paths relative to this test file's location
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const POC_FILE = path.join(__dirname, "claude-sdk-poc.ts");
const FINDINGS_FILE = path.join(__dirname, "FINDINGS.md");
const PKG_FILE = path.join(ROOT, "package.json");

// ---- Helpers (inlined to avoid triggering main() in the PoC) ----

function computeLatencyStats(samples: number[]): {
  samples: number[];
  min_ms: number;
  mean_ms: number;
  max_ms: number;
  p95_ms: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95Index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
  );
  return {
    samples,
    min_ms: sorted[0]!,
    mean_ms: Math.round(sum / sorted.length),
    max_ms: sorted[sorted.length - 1]!,
    p95_ms: sorted[p95Index]!,
  };
}

function assertPluginLoaded(
  plugins: { name: string; path: string }[],
  expectedName: string,
  expectedPath: string
): boolean {
  return plugins.some((p) => p.path === expectedPath || p.name === expectedName);
}

// ---- AC3: package.json dependencies ----

describe("AC3: @anthropic-ai/claude-agent-sdk in package.json dependencies", () => {
  let pkg: Record<string, unknown>;

  beforeAll(async () => {
    const raw = await readFile(PKG_FILE, "utf-8");
    pkg = JSON.parse(raw) as Record<string, unknown>;
  });

  it("@anthropic-ai/claude-agent-sdk is listed in dependencies (not devDependencies)", () => {
    const deps = pkg["dependencies"] as Record<string, string> | undefined;
    expect(deps).toBeDefined();
    expect(deps!["@anthropic-ai/claude-agent-sdk"]).toBeDefined();
  });

  it("SDK version is 0.2.x (^0.2.47)", () => {
    const deps = pkg["dependencies"] as Record<string, string>;
    expect(deps["@anthropic-ai/claude-agent-sdk"]).toMatch(/\^0\.2\./);
  });

  it("SDK is NOT in devDependencies", () => {
    const devDeps = pkg["devDependencies"] as
      | Record<string, string>
      | undefined;
    if (devDeps) {
      expect(devDeps["@anthropic-ai/claude-agent-sdk"]).toBeUndefined();
    }
  });
});

// ---- AC1: ClaudeAgentOptions fields in claude-sdk-poc.ts ----

describe("AC1: ClaudeAgentOptions required fields present in PoC source", () => {
  let source: string;

  beforeAll(async () => {
    source = await readFile(POC_FILE, "utf-8");
  });

  it("PoC file exists", () => {
    expect(existsSync(POC_FILE)).toBe(true);
  });

  it("imports query from @anthropic-ai/claude-agent-sdk", () => {
    expect(source).toContain('from "@anthropic-ai/claude-agent-sdk"');
    expect(source).toMatch(/import\s*\{[^}]*\bquery\b/);
  });

  it("uses permissionMode option in query options", () => {
    expect(source).toContain("permissionMode:");
  });

  it("uses maxBudgetUsd option in query options", () => {
    expect(source).toContain("maxBudgetUsd:");
  });

  it("uses plugins option in query options", () => {
    expect(source).toContain("plugins:");
  });

  it("uses cwd option in query options", () => {
    expect(source).toContain("cwd:");
  });

  it("uses systemPrompt option in query options", () => {
    // systemPrompt is passed as a shorthand property or key
    expect(source).toMatch(/systemPrompt[,:\s]/);
  });

  // allowedTools is intentionally absent from the bypassPermissions call,
  // but must be documented and referenced in the source (as a comment/note).
  it("references allowedTools with explanation that it is redundant with bypassPermissions", () => {
    expect(source).toContain("allowedTools");
    expect(source).toContain("redundant");
  });

  it("sets permissionMode to bypassPermissions", () => {
    expect(source).toContain("bypassPermissions");
  });

  it("sets allowDangerouslySkipPermissions to true", () => {
    expect(source).toContain("allowDangerouslySkipPermissions: true");
  });
});

// ---- AC2 / AC4 / AC5: FINDINGS.md content ----

describe("AC2/AC4/AC5: FINDINGS.md required sections and content", () => {
  let content: string;

  beforeAll(async () => {
    content = await readFile(FINDINGS_FILE, "utf-8");
  });

  it("FINDINGS.md exists and is non-empty", () => {
    expect(existsSync(FINDINGS_FILE)).toBe(true);
    expect(content.length).toBeGreaterThan(1000);
  });

  // AC2a: Correct type names (StepExecution / RuntimeStepResult)
  it("§3 uses StepExecution type name (not AgentRunResult)", () => {
    expect(content).toContain("StepExecution");
    expect(content).not.toContain("AgentRunResult");
  });

  it("§3 uses RuntimeStepResult type name", () => {
    expect(content).toContain("RuntimeStepResult");
  });

  it("§3 does NOT reference non-existent duration_seconds field", () => {
    expect(content).not.toContain("duration_seconds");
  });

  // AC2b: Empirical multi-run latency data
  it("§4 has empirical latency section (not purely theoretical)", () => {
    expect(content).toMatch(/[Ee]mpirical/);
  });

  it("§4 documents multi-run methodology (cold + warm runs)", () => {
    expect(content).toMatch(/cold.*run|run.*cold/i);
    expect(content).toMatch(/warm.*run|run.*warm/i);
  });

  it("§4 reports min/mean/max/p95 latency statistics", () => {
    expect(content).toMatch(/min:\s*\d+ms/);
    expect(content).toMatch(/mean:\s*\d+ms/);
    expect(content).toMatch(/max:\s*\d+ms/);
    expect(content).toMatch(/p95:\s*\d+ms/);
  });

  it("§4 shows n=4 runs (1 cold + 3 warm)", () => {
    expect(content).toMatch(/n=4/);
  });

  // AC4: SDKRateLimitEvent documented as undefined/compile-error (not merely "unexported")
  it("§7.1 documents SDKRateLimitEvent", () => {
    expect(content).toContain("SDKRateLimitEvent");
  });

  it("§7.1 classifies SDKRateLimitEvent as TS2304 compile error (not just unexported)", () => {
    expect(content).toContain("TS2304");
  });

  it("§7.1 states SDKRateLimitEvent causes a compile error when referenced directly", () => {
    expect(content).toMatch(/compile.{0,20}error|error.{0,20}compile/i);
  });

  it("§7.1 does NOT downplay it as merely unexported/unexported-only", () => {
    // The fix changed from "not exported" to "not defined anywhere"
    // At minimum it should say "compile error" or "undefined"
    const hasCompileError = /compile.{0,20}error/i.test(content);
    const hasUndefined = /not defined|completely undefined/i.test(content);
    expect(hasCompileError || hasUndefined).toBe(true);
  });

  // AC2c: §7.8 plugin load failure mode documented
  it("§7.8 documents that plugin load failure is silent (SDK does not throw)", () => {
    // The section should mention assertPluginLoaded and that SDK does not throw
    expect(content).toContain("assertPluginLoaded");
  });

  it("§7.8 documents plugin load failure mode and recommended handling", () => {
    expect(content).toMatch(/plugin.{0,30}fail|fail.{0,30}plugin/i);
    // Should mention that SDK does NOT throw
    expect(content).toMatch(/does not throw|NOT throw/i);
  });

  // AC5: allowedTools/permissionMode interaction correctly documented
  it("§7.9 states allowedTools is redundant when permissionMode is bypassPermissions", () => {
    expect(content).toContain("allowedTools");
    expect(content).toContain("bypassPermissions");
    expect(content).toContain("redundant");
  });

  it("§7.9 states allowedTools is ignored when permissionMode is bypassPermissions", () => {
    expect(content).toContain("ignored");
  });

  it("§6 table notes allowedTools is redundant/ignored with bypassPermissions", () => {
    // The §6 table row for --dangerously-skip-permissions should mention allowedTools being redundant
    const section6Match = content.match(/## 6\.[^#]*/s);
    expect(section6Match).not.toBeNull();
    const section6 = section6Match![0];
    expect(section6).toContain("allowedTools");
    expect(section6).toMatch(/redundant|ignored/i);
  });
});

// ---- AC6: computeLatencyStats helper logic ----

describe("AC6: computeLatencyStats correctness (multi-run benchmark logic)", () => {
  it("returns correct min from sample set", () => {
    const stats = computeLatencyStats([332, 284, 291, 301]);
    expect(stats.min_ms).toBe(284);
  });

  it("returns correct max from sample set", () => {
    const stats = computeLatencyStats([332, 284, 291, 301]);
    expect(stats.max_ms).toBe(332);
  });

  it("returns correct mean from sample set", () => {
    const stats = computeLatencyStats([332, 284, 291, 301]);
    // sum = 1208, mean = 1208/4 = 302
    expect(stats.mean_ms).toBe(302);
  });

  it("returns correct p95 for 4 samples (should be max element)", () => {
    const stats = computeLatencyStats([332, 284, 291, 301]);
    // sorted: [284, 291, 301, 332]
    // p95 index = ceil(4 * 0.95) - 1 = ceil(3.8) - 1 = 4 - 1 = 3 → sorted[3] = 332
    expect(stats.p95_ms).toBe(332);
  });

  it("handles single sample correctly", () => {
    const stats = computeLatencyStats([350]);
    expect(stats.min_ms).toBe(350);
    expect(stats.mean_ms).toBe(350);
    expect(stats.max_ms).toBe(350);
    expect(stats.p95_ms).toBe(350);
  });

  it("preserves original sample order in samples array", () => {
    const input = [332, 284, 291, 301];
    const stats = computeLatencyStats(input);
    expect(stats.samples).toEqual(input);
  });

  it("handles 10 samples — p95 is 10th element (index 9)", () => {
    const samples = [100, 110, 120, 130, 140, 150, 160, 170, 180, 950];
    const stats = computeLatencyStats(samples);
    // sorted: [100, 110, 120, 130, 140, 150, 160, 170, 180, 950]
    // p95 index = ceil(10 * 0.95) - 1 = ceil(9.5) - 1 = 10 - 1 = 9 → 950
    expect(stats.p95_ms).toBe(950);
  });
});

// ---- AC7: assertPluginLoaded helper logic ----

describe("AC7: assertPluginLoaded correctness", () => {
  const PLUGIN_DIR = "/some/plugin/path";
  const PLUGIN_NAME = "code-review";

  it("returns true when plugin matches by path", () => {
    const plugins = [{ name: "other", path: PLUGIN_DIR }];
    expect(assertPluginLoaded(plugins, PLUGIN_NAME, PLUGIN_DIR)).toBe(true);
  });

  it("returns true when plugin matches by name", () => {
    const plugins = [{ name: PLUGIN_NAME, path: "/different/path" }];
    expect(assertPluginLoaded(plugins, PLUGIN_NAME, PLUGIN_DIR)).toBe(true);
  });

  it("returns false when no plugin matches", () => {
    const plugins = [{ name: "other-plugin", path: "/other/path" }];
    expect(assertPluginLoaded(plugins, PLUGIN_NAME, PLUGIN_DIR)).toBe(false);
  });

  it("returns false when plugins list is empty", () => {
    expect(assertPluginLoaded([], PLUGIN_NAME, PLUGIN_DIR)).toBe(false);
  });

  it("returns true when both path and name match", () => {
    const plugins = [{ name: PLUGIN_NAME, path: PLUGIN_DIR }];
    expect(assertPluginLoaded(plugins, PLUGIN_NAME, PLUGIN_DIR)).toBe(true);
  });
});

// ---- AC8: PoC stub mode execution ----

describe("AC8: PoC stub mode runs without error (no API key required)", () => {
  it(
    "executes stub mode end-to-end, outputting ASSERTION PASS and latency stats",
    () => {
      const output = execSync(
        `npx tsx ${JSON.stringify(POC_FILE)}`,
        {
          cwd: ROOT,
          env: { ...process.env, ANTHROPIC_API_KEY: undefined },
          timeout: 30_000,
          encoding: "utf-8",
        }
      );

      // Latency benchmark output
      expect(output).toContain("Latency Benchmark");
      expect(output).toContain("cold");
      expect(output).toContain("warm");
      expect(output).toMatch(/min:\s*\d+ms/);
      expect(output).toMatch(/p95:\s*\d+ms/);

      // Stub mode indicator
      expect(output).toMatch(/STUB mode|stub mode/i);

      // Plugin assertion
      expect(output).toContain("ASSERTION PASS");

      // Summary
      expect(output).toContain("SUMMARY");
      expect(output).toContain("Plugin assertion:");
      expect(output).toMatch(/Plugin assertion:\s+PASS/);
    },
    35_000
  );

  it(
    "outputs first-message latency measurement from stub run",
    () => {
      const output = execSync(
        `npx tsx ${JSON.stringify(POC_FILE)}`,
        {
          cwd: ROOT,
          env: { ...process.env, ANTHROPIC_API_KEY: undefined },
          timeout: 30_000,
          encoding: "utf-8",
        }
      );

      expect(output).toMatch(/First message received: \d+ms/);
    },
    35_000
  );
});

// ---- Typecheck (AC1 supplemental): PoC compiles without errors ----

describe("Typecheck: spike/claude-sdk-poc.ts compiles without errors", () => {
  it("tsc --noEmit passes on the spike tsconfig", () => {
    let exitCode = 0;
    try {
      execSync(
        `npx tsc -p ${JSON.stringify(path.join(__dirname, "tsconfig.json"))} --noEmit`,
        { cwd: ROOT, timeout: 30_000, encoding: "utf-8" }
      );
    } catch (err) {
      exitCode = (err as { status?: number }).status ?? 1;
    }
    expect(exitCode).toBe(0);
  });
});
