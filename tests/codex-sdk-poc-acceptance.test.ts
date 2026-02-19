import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const POC_FILE = path.join(ROOT, "spike", "codex-sdk-poc.ts");

interface PocOutput {
  mode: string;
  checks: Array<{ name: string; status: "pass" | "fail" | "skipped"; details: string }>;
  tokens: {
    total: {
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
    };
  };
  cost: {
    value_usd: number | null;
    source: string;
  };
  mappingNotes: string[];
}

function runPreflight(): PocOutput {
  const raw = execSync(`OPENAI_API_KEY= npx tsx ${JSON.stringify(POC_FILE)}`, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  const jsonStart = raw.indexOf("{");
  const payload = jsonStart >= 0 ? raw.slice(jsonStart) : raw;
  return JSON.parse(payload) as PocOutput;
}

describe("codex sdk poc acceptance preflight", () => {
  it("emits all required acceptance checks with skipped status in preflight mode", () => {
    const report = runPreflight();
    expect(report.mode).toBe("preflight");

    const requiredChecks = [
      "OPENAI_API_KEY auth",
      "workspace path control",
      "AGENTS.md instruction pickup",
      "thread persistence via run()",
      "thread persistence via resumeThread(threadId)",
      "CODEX_HOME skills behavior",
      "structured output capture",
    ];

    for (const checkName of requiredChecks) {
      const check = report.checks.find((entry) => entry.name === checkName);
      expect(check, `Missing check: ${checkName}`).toBeDefined();
      expect(check?.status).toBe("skipped");
    }
  });

  it("captures output and cost instrumentation fields in report payload", () => {
    const report = runPreflight();

    expect(report.tokens.total.input_tokens).toBe(0);
    expect(report.tokens.total.cached_input_tokens).toBe(0);
    expect(report.tokens.total.output_tokens).toBe(0);

    expect(report.cost.value_usd).toBeNull();
    expect(report.cost.source.length).toBeGreaterThan(0);

    expect(report.mappingNotes.some((note) => note.includes("resumeThread"))).toBe(true);
  });
});
