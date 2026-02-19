import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const POC_FILE = path.join(__dirname, "codex-sdk-poc.ts");
const FINDINGS_FILE = path.join(__dirname, "CODEX_SDK_FINDINGS.md");
const PKG_FILE = path.join(ROOT, "package.json");

describe("codex sdk dependency", () => {
  let pkg: Record<string, unknown>;

  beforeAll(async () => {
    pkg = JSON.parse(await readFile(PKG_FILE, "utf8")) as Record<string, unknown>;
  });

  it("includes @openai/codex-sdk in dependencies", () => {
    const deps = pkg["dependencies"] as Record<string, string> | undefined;
    expect(deps).toBeDefined();
    expect(deps!["@openai/codex-sdk"]).toBeDefined();
  });
});

describe("codex sdk poc source", () => {
  let source = "";

  beforeAll(async () => {
    source = await readFile(POC_FILE, "utf8");
  });

  it("exists", () => {
    expect(existsSync(POC_FILE)).toBe(true);
  });

  it("uses startThread + run + resumeThread", () => {
    expect(source).toContain("startThread(");
    expect(source).toContain("run(");
    expect(source).toContain("resumeThread(");
  });

  it("checks OPENAI_API_KEY auth", () => {
    expect(source).toContain("OPENAI_API_KEY");
  });

  it("checks AGENTS.md and CODEX_HOME behavior", () => {
    expect(source).toContain("AGENTS.md");
    expect(source).toContain("CODEX_HOME");
  });

  it("captures structured output and usage metadata", () => {
    expect(source).toContain("outputSchema");
    expect(source).toContain("turn.usage");
  });
});

describe("codex findings documentation", () => {
  let findings = "";

  beforeAll(async () => {
    findings = await readFile(FINDINGS_FILE, "utf8");
  });

  it("exists", () => {
    expect(existsSync(FINDINGS_FILE)).toBe(true);
  });

  it("documents mapping and Claude differences", () => {
    expect(findings).toContain("CLI-to-SDK Mapping");
    expect(findings).toContain("Codex SDK vs Claude SDK");
  });

  it("documents cost metadata limitation", () => {
    expect(findings).toContain("not exposed");
  });
});

describe("preflight mode", () => {
  it(
    "runs without OPENAI_API_KEY and marks checks skipped",
    () => {
      const output = execSync(`npx tsx ${JSON.stringify(POC_FILE)}`, {
        cwd: ROOT,
        env: { ...process.env, OPENAI_API_KEY: undefined },
        encoding: "utf8",
        timeout: 45_000,
      });

      const parsed = JSON.parse(output) as {
        mode: string;
        checks: Array<{ status: string; name: string }>;
      };

      expect(parsed.mode).toBe("preflight");
      const authCheck = parsed.checks.find((check) => check.name === "OPENAI_API_KEY auth");
      expect(authCheck).toBeDefined();
      expect(parsed.checks.some((check) => check.status === "skipped")).toBe(true);
    },
    50_000
  );
});

describe("typecheck spike tsconfig", () => {
  it("passes tsc --noEmit", () => {
    let exitCode = 0;
    try {
      execSync(`npx tsc -p ${JSON.stringify(path.join(__dirname, "tsconfig.json"))} --noEmit`, {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 45_000,
      });
    } catch (error) {
      exitCode = (error as { status?: number }).status ?? 1;
    }
    expect(exitCode).toBe(0);
  });
});
