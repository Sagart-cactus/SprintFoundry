/**
 * spike/codex-sdk-poc.ts
 *
 * Proof-of-concept for @openai/codex-sdk thread APIs.
 *
 * Run with:  npx tsx spike/codex-sdk-poc.ts
 * Typecheck: npx tsc -p spike/tsconfig.json --noEmit
 */

import { Codex, type ThreadOptions, type Usage } from "@openai/codex-sdk";
import { execFile } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_MODEL = process.env["OPENAI_MODEL"] ?? "gpt-5";
const AGENTS_MARKER = "AGENTS_RULE_ACTIVE";
const MEMORY_MARKER = "THREAD_MARKER_ONE";
const SKILL_MARKER = "SKILL_MARKER_ACTIVE";

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "skipped";
  details: string;
}

interface TurnSummary {
  threadId: string | null;
  usage: Usage | null;
  structured: Record<string, unknown> | null;
  responseText: string;
}

interface PocReport {
  sdkVersion: string;
  mode: "live" | "preflight";
  model: string;
  workspacePath: string;
  checks: CheckResult[];
  tokens: {
    firstRun: Usage | null;
    secondRun: Usage | null;
    resumedRun: Usage | null;
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
  thread: {
    initialThreadId: string | null;
    resumedThreadId: string | null;
    persistedThreadIdMatch: boolean;
  };
  outputs: {
    firstRun: Record<string, unknown> | null;
    secondRun: Record<string, unknown> | null;
    resumedRun: Record<string, unknown> | null;
  };
  mappingNotes: string[];
}

function getSdkVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(PROJECT_ROOT, "node_modules", "@openai", "codex-sdk", "package.json"), "utf8")
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function createSchema<T extends Record<string, unknown>>(schema: T): T {
  return schema;
}

function parseStructuredResponse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function usageOrZero(usage: Usage | null): Usage {
  return usage ?? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
}

function summarizeCheck(name: string, pass: boolean, details: string): CheckResult {
  return { name, status: pass ? "pass" : "fail", details };
}

function skippedCheck(name: string, details: string): CheckResult {
  return { name, status: "skipped", details };
}

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "poc@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Codex SDK PoC"], { cwd: dir });
}

async function buildWorkspace(): Promise<{ workspacePath: string; outsideFilePath: string }> {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sdk-poc-workspace-"));
  await initGitRepo(workspacePath);

  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sdk-poc-outside-"));
  const outsideFilePath = path.join(outsideDir, "outside-secret.txt");

  await fs.writeFile(path.join(workspacePath, "workspace-sentinel.txt"), "WORKSPACE_SENTINEL_OK\n", "utf8");
  await fs.writeFile(outsideFilePath, "OUTSIDE_SECRET_SHOULD_NOT_BE_READ\n", "utf8");
  await fs.writeFile(
    path.join(workspacePath, "AGENTS.md"),
    [
      "# Workspace AGENTS",
      "",
      "For JSON responses in this workspace:",
      `- Set \`agents_instruction_marker\` to \`${AGENTS_MARKER}\`.`,
      "- Keep strict JSON with no extra text.",
    ].join("\n"),
    "utf8"
  );

  return { workspacePath, outsideFilePath };
}

async function buildCodexHomeWithSkill(): Promise<string> {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sdk-poc-home-"));
  const skillDir = path.join(codexHome, "skills", "skill-marker");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "# skill-marker",
      "",
      "When asked for \`skill_marker\`, set it to exactly \`SKILL_MARKER_ACTIVE\`.",
      "Do not invent a different marker.",
    ].join("\n"),
    "utf8"
  );
  return codexHome;
}

async function runStructuredTurn(
  codex: Codex,
  threadOptions: ThreadOptions,
  prompt: string,
  schema: Record<string, unknown>,
  existingThreadId?: string
): Promise<TurnSummary> {
  const thread = existingThreadId
    ? codex.resumeThread(existingThreadId, threadOptions)
    : codex.startThread(threadOptions);
  const turn = await thread.run(prompt, { outputSchema: schema });
  return {
    threadId: thread.id,
    usage: turn.usage,
    structured: parseStructuredResponse(turn.finalResponse),
    responseText: turn.finalResponse,
  };
}

async function runSkillBehaviorCheck(
  apiKey: string,
  threadOptions: ThreadOptions,
  workspacePath: string,
  codexHomeDir: string
): Promise<{ withCodexHome: string | null; withoutCodexHome: string | null }> {
  const schema = createSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      skill_marker: { type: "string" },
    },
    required: ["skill_marker"],
  });

  const prompt = [
    "Return strict JSON matching the schema.",
    `Set skill_marker to ${SKILL_MARKER} only if a loaded skill requires it.`,
    "If no such skill is present, set skill_marker to SKILL_NOT_LOADED.",
  ].join("\n");

  const codexWithout = new Codex({
    env: {
      ...process.env,
      OPENAI_API_KEY: apiKey,
    } as Record<string, string>,
  });

  const codexWith = new Codex({
    env: {
      ...process.env,
      OPENAI_API_KEY: apiKey,
      CODEX_HOME: codexHomeDir,
    } as Record<string, string>,
  });

  const without = await runStructuredTurn(codexWithout, { ...threadOptions, workingDirectory: workspacePath }, prompt, schema);
  const withHome = await runStructuredTurn(codexWith, { ...threadOptions, workingDirectory: workspacePath }, prompt, schema);

  const withoutMarker = typeof without.structured?.["skill_marker"] === "string"
    ? (without.structured["skill_marker"] as string)
    : null;
  const withMarker = typeof withHome.structured?.["skill_marker"] === "string"
    ? (withHome.structured["skill_marker"] as string)
    : null;

  return { withCodexHome: withMarker, withoutCodexHome: withoutMarker };
}

async function runLivePoc(apiKey: string): Promise<PocReport> {
  const { workspacePath, outsideFilePath } = await buildWorkspace();
  const codexHomeDir = await buildCodexHomeWithSkill();

  const threadOptions: ThreadOptions = {
    model: DEFAULT_MODEL,
    sandboxMode: "workspace-write",
    workingDirectory: workspacePath,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
  };

  const codex = new Codex({
    env: {
      ...process.env,
      OPENAI_API_KEY: apiKey,
      CODEX_HOME: codexHomeDir,
    } as Record<string, string>,
  });

  const firstSchema = createSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      agents_instruction_marker: { type: "string" },
      cwd: { type: "string" },
      workspace_sentinel: { type: "string" },
      outside_workspace_secret: {
        oneOf: [{ type: "string" }, { type: "null" }],
      },
      thread_memory_marker: { type: "string" },
    },
    required: [
      "agents_instruction_marker",
      "cwd",
      "workspace_sentinel",
      "outside_workspace_secret",
      "thread_memory_marker",
    ],
  });

  const firstPrompt = [
    "Read AGENTS.md in the working directory and follow its rules.",
    "Return strict JSON matching the schema.",
    `Set thread_memory_marker to exactly ${MEMORY_MARKER}.`,
    "Read workspace-sentinel.txt and set workspace_sentinel to its full content trimmed.",
    `Do not read ${outsideFilePath}. If unavailable, set outside_workspace_secret to null.`,
    "Set cwd to the current working directory used by Codex.",
  ].join("\n");

  const secondSchema = createSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      remembered_marker: { type: "string" },
      continuity_ok: { type: "boolean" },
    },
    required: ["remembered_marker", "continuity_ok"],
  });

  const secondPrompt = [
    "Return strict JSON matching the schema.",
    "Without reading files, remember the previous turn's thread_memory_marker.",
    `Set remembered_marker to ${MEMORY_MARKER} and continuity_ok to true only if memory persisted.`,
  ].join("\n");

  const resumedSchema = createSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      resumed_thread_memory_marker: { type: "string" },
      resumed_ok: { type: "boolean" },
    },
    required: ["resumed_thread_memory_marker", "resumed_ok"],
  });

  const resumedPrompt = [
    "Return strict JSON matching the schema.",
    "You are running after resumeThread(threadId).",
    `Set resumed_thread_memory_marker to ${MEMORY_MARKER} if thread context persisted across resume.`,
    "Set resumed_ok accordingly.",
  ].join("\n");

  const firstRun = await runStructuredTurn(codex, threadOptions, firstPrompt, firstSchema);
  const firstThreadId = firstRun.threadId;
  if (!firstThreadId) {
    throw new Error("Codex SDK did not return a thread ID after first run().");
  }

  const sameThread = codex.resumeThread(firstThreadId, threadOptions);
  const secondTurn = await sameThread.run(secondPrompt, { outputSchema: secondSchema });
  const secondRun: TurnSummary = {
    threadId: sameThread.id,
    usage: secondTurn.usage,
    structured: parseStructuredResponse(secondTurn.finalResponse),
    responseText: secondTurn.finalResponse,
  };

  const resumedRun = await runStructuredTurn(
    codex,
    threadOptions,
    resumedPrompt,
    resumedSchema,
    firstThreadId
  );

  const skillResult = await runSkillBehaviorCheck(apiKey, threadOptions, workspacePath, codexHomeDir);

  const firstUsage = usageOrZero(firstRun.usage);
  const secondUsage = usageOrZero(secondRun.usage);
  const resumedUsage = usageOrZero(resumedRun.usage);

  const checks: CheckResult[] = [
    summarizeCheck(
      "OPENAI_API_KEY auth",
      true,
      "Live run completed with OPENAI_API_KEY passed through Codex env"
    ),
    summarizeCheck(
      "workspace path control",
      String(firstRun.structured?.["cwd"] ?? "") === workspacePath &&
        String(firstRun.structured?.["workspace_sentinel"] ?? "") === "WORKSPACE_SENTINEL_OK",
      `cwd=${String(firstRun.structured?.["cwd"] ?? "(missing)")}`
    ),
    summarizeCheck(
      "AGENTS.md instruction pickup",
      String(firstRun.structured?.["agents_instruction_marker"] ?? "") === AGENTS_MARKER,
      `agents_instruction_marker=${String(firstRun.structured?.["agents_instruction_marker"] ?? "(missing)")}`
    ),
    summarizeCheck(
      "thread persistence via run()",
      String(secondRun.structured?.["remembered_marker"] ?? "") === MEMORY_MARKER &&
        Boolean(secondRun.structured?.["continuity_ok"]),
      `remembered_marker=${String(secondRun.structured?.["remembered_marker"] ?? "(missing)")}`
    ),
    summarizeCheck(
      "thread persistence via resumeThread(threadId)",
      String(resumedRun.structured?.["resumed_thread_memory_marker"] ?? "") === MEMORY_MARKER &&
        Boolean(resumedRun.structured?.["resumed_ok"]),
      `resumed_marker=${String(resumedRun.structured?.["resumed_thread_memory_marker"] ?? "(missing)")}`
    ),
    summarizeCheck(
      "CODEX_HOME skills behavior",
      skillResult.withCodexHome === SKILL_MARKER,
      `with_CODEX_HOME=${skillResult.withCodexHome ?? "(missing)"}, without_CODEX_HOME=${skillResult.withoutCodexHome ?? "(missing)"}`
    ),
    summarizeCheck(
      "structured output capture",
      Boolean(firstRun.structured) && Boolean(secondRun.structured) && Boolean(resumedRun.structured),
      "Parsed JSON from all turn.finalResponse values"
    ),
  ];

  return {
    sdkVersion: getSdkVersion(),
    mode: "live",
    model: DEFAULT_MODEL,
    workspacePath,
    checks,
    tokens: {
      firstRun: firstRun.usage,
      secondRun: secondRun.usage,
      resumedRun: resumedRun.usage,
      total: {
        input_tokens: firstUsage.input_tokens + secondUsage.input_tokens + resumedUsage.input_tokens,
        cached_input_tokens:
          firstUsage.cached_input_tokens + secondUsage.cached_input_tokens + resumedUsage.cached_input_tokens,
        output_tokens: firstUsage.output_tokens + secondUsage.output_tokens + resumedUsage.output_tokens,
      },
    },
    cost: {
      value_usd: null,
      source: "@openai/codex-sdk Usage exposes token counts but no cost field in Turn/ThreadEvent APIs",
    },
    thread: {
      initialThreadId: firstThreadId,
      resumedThreadId: resumedRun.threadId,
      persistedThreadIdMatch: firstThreadId === resumedRun.threadId,
    },
    outputs: {
      firstRun: firstRun.structured,
      secondRun: secondRun.structured,
      resumedRun: resumedRun.structured,
    },
    mappingNotes: [
      "Codex SDK startThread(options) maps to CLI session start with --cd/--model/--sandbox.",
      "Thread.run(input, { outputSchema }) replaces `codex exec <prompt> --json` parsing.",
      "resumeThread(threadId) maps to `codex exec resume <threadId>`.",
      "Usage tokens are directly exposed at turn.completed / turn.usage.",
      "Cost is not exposed by @openai/codex-sdk v0.104.0, unlike Claude SDK total_cost_usd.",
    ],
  };
}

function buildPreflightReport(): PocReport {
  const missingApiKey = !process.env["OPENAI_API_KEY"];

  return {
    sdkVersion: getSdkVersion(),
    mode: "preflight",
    model: DEFAULT_MODEL,
    workspacePath: "(not created)",
    checks: [
      missingApiKey
        ? skippedCheck("OPENAI_API_KEY auth", "Set OPENAI_API_KEY to execute live Codex SDK runs")
        : summarizeCheck("OPENAI_API_KEY auth", true, "OPENAI_API_KEY present"),
      skippedCheck("workspace path control", "Skipped in preflight mode (no API key)"),
      skippedCheck("AGENTS.md instruction pickup", "Skipped in preflight mode (no API key)"),
      skippedCheck("thread persistence via run()", "Skipped in preflight mode (no API key)"),
      skippedCheck("thread persistence via resumeThread(threadId)", "Skipped in preflight mode (no API key)"),
      skippedCheck("CODEX_HOME skills behavior", "Skipped in preflight mode (no API key)"),
      skippedCheck("structured output capture", "Skipped in preflight mode (no API key)"),
    ],
    tokens: {
      firstRun: null,
      secondRun: null,
      resumedRun: null,
      total: {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
      },
    },
    cost: {
      value_usd: null,
      source: "No live run; Codex SDK does not expose cost in type surface",
    },
    thread: {
      initialThreadId: null,
      resumedThreadId: null,
      persistedThreadIdMatch: false,
    },
    outputs: {
      firstRun: null,
      secondRun: null,
      resumedRun: null,
    },
    mappingNotes: [
      "Codex SDK APIs required by this spike: startThread(), run(), resumeThread().",
      "OPENAI_API_KEY check is preflight-gated to avoid auth failures in CI.",
      "Live run required to verify AGENTS.md and skills behavior.",
    ],
  };
}

async function main(): Promise<void> {
  const apiKey = process.env["OPENAI_API_KEY"];
  const report = apiKey ? await runLivePoc(apiKey) : buildPreflightReport();

  console.log(JSON.stringify(report, null, 2));

  const outputPath = path.join(PROJECT_ROOT, "spike", "codex-sdk-poc-output.json");
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
}

main().catch((error) => {
  const failure = {
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
  };
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
