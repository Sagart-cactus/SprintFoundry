/**
 * spike/claude-sdk-poc.ts
 *
 * Proof-of-concept for @anthropic-ai/claude-agent-sdk integration.
 *
 * Run with:   tsx spike/claude-sdk-poc.ts
 * Typecheck:  npx tsc -p spike/tsconfig.json --noEmit
 *
 * Exercises the SDK's query() API and compares it against the current
 * child_process.spawn approach in:
 *   src/service/runtime/claude-code-runtime.ts  (runLocal / buildCliArgs)
 *   src/service/agent-runner.ts                 (buildClaudeCliArgs)
 *
 * Coverage matrix vs buildClaudeCliArgs():
 *   CLI flag                           SDK option
 *   -p <prompt>                     →  prompt parameter
 *   --output-format json            →  not needed (SDK yields typed messages)
 *   --dangerously-skip-permissions  →  permissionMode:'bypassPermissions' + allowDangerouslySkipPermissions:true
 *   --max-budget-usd N              →  maxBudgetUsd: N
 *   --plugin-dir <path>             →  plugins:[{ type:'local', path }]
 *   ANTHROPIC_MODEL env var         →  model option (or env passthrough)
 *   cwd                             →  cwd option
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKResultMessage,
  SDKResultError,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

// ---- Path resolution ----

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEVELOPER_CLAUDE_MD = path.join(
  PROJECT_ROOT,
  "src",
  "agents",
  "developer",
  "CLAUDE.md"
);
// Use code-review plugin for plugin-loading verification
const PLUGIN_DIR = path.join(PROJECT_ROOT, "plugins", "code-review");

// Budget intentionally tiny to observe enforcement behaviour.
const MAX_BUDGET_USD = 0.05;

// ---- Auth ----
// The SDK passes env to the spawned claude process.  In production the
// SprintFoundry runtime supplies ANTHROPIC_API_KEY via process.env or
// via RuntimeStepContext.apiKey (see process-utils.ts runProcess).
//
// IMPORTANT: When running this PoC standalone, set ANTHROPIC_API_KEY in
// your shell.  When integrated into AgentRunner, pass it via the `env`
// option (see runPoc below).
const API_KEY = process.env["ANTHROPIC_API_KEY"];
const MODEL = process.env["ANTHROPIC_MODEL"];

// ---- Types ----

interface ObservedMessage {
  type: string;
  subtype?: string;
  timestamp_ms: number;
}

interface PocRunResult {
  firstMessageLatency_ms: number;
  totalDuration_ms: number;
  messages: ObservedMessage[];
  resultMessage: SDKResultMessage | null;
  pluginsLoaded: { name: string; path: string }[];
  toolsAvailable: string[];
  error: string | null;
}

// ---- Main PoC ----

async function runPoc(): Promise<PocRunResult> {
  if (!API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Set it in your environment before running this PoC.\n" +
      "In SprintFoundry production, pass it via the `env` option in the SDK query() call."
    );
  }

  // (1) Read developer system prompt from CLAUDE.md
  const systemPrompt = await fs.readFile(DEVELOPER_CLAUDE_MD, "utf-8");

  // (6) Create a temporary workspace directory
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "sprintfoundry-sdk-poc-")
  );

  // Write a minimal task so the agent terminates quickly with minimal token use
  await fs.mkdir(path.join(workspaceDir, "artifacts", "handoff"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(workspaceDir, ".agent-task.md"),
    [
      "# Task for developer Agent",
      "",
      "## Task Description",
      'Write `.agent-result.json` with `{"status":"complete","summary":"SDK PoC minimal task","artifacts_created":[],"artifacts_modified":[],"issues":[],"metadata":{}}`. Do nothing else.',
      "",
      "## Required Output",
      "Write `.agent-result.json` as instructed above.",
    ].join("\n"),
    "utf-8"
  );

  const observed: ObservedMessage[] = [];
  let firstMessageTime: number | null = null;
  let resultMessage: SDKResultMessage | null = null;
  let pluginsLoaded: { name: string; path: string }[] = [];
  let toolsAvailable: string[] = [];

  // ---- Latency measurement ----
  // Equivalent to the timestamp before spawn("claude", args) in the current approach.
  const spawnStart = Date.now();
  console.log(`[poc] query() called at t=0ms`);

  try {
    // (2) allowedTools  (3) permissionMode  (4) maxBudgetUsd  (5) plugins  (6) cwd
    const queryGen = query({
      prompt: "Read task details in .agent-task.md and follow CLAUDE.md.",
      options: {
        // (1) systemPrompt from developer CLAUDE.md
        systemPrompt,

        // (2) allowedTools – auto-approve these; use tools to restrict the set
        allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],

        // (3) permissionMode – equivalent to --dangerously-skip-permissions
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,

        // (4) maxBudgetUsd – small value to observe budget enforcement
        maxBudgetUsd: MAX_BUDGET_USD,

        // (5) plugins – equivalent to --plugin-dir
        plugins: [{ type: "local", path: PLUGIN_DIR }],

        // (6) cwd – workspace directory
        cwd: workspaceDir,

        // Env passthrough: equivalent to the env object in runProcess()
        // process-utils.ts passes ANTHROPIC_API_KEY and ANTHROPIC_MODEL this way.
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: API_KEY,
          ...(MODEL ? { ANTHROPIC_MODEL: MODEL } : {}),
        },

        // Model from env var (explicit model option takes precedence over env)
        ...(MODEL ? { model: MODEL } : {}),

        // Avoid persisting a session to disk for this ephemeral spike run
        persistSession: false,
      },
    });

    for await (const message of queryGen) {
      const now = Date.now();

      // Measure latency to first SDKMessage – analogous to the "first byte" from
      // the spawned process in the child_process approach.
      if (firstMessageTime === null) {
        firstMessageTime = now;
        const latency = now - spawnStart;
        console.log(
          `[poc] First message received: ${latency}ms after query() call`
        );
      }

      const entry: ObservedMessage = {
        type: message.type,
        timestamp_ms: now - spawnStart,
      };
      if ("subtype" in message && typeof (message as { subtype?: unknown }).subtype === "string") {
        entry.subtype = (message as { subtype: string }).subtype;
      }
      observed.push(entry);

      logMessage(message, entry);

      // Capture init info (plugin verification, tool set confirmation)
      if (message.type === "system") {
        const sys = message as SDKSystemMessage;
        if (sys.subtype === "init") {
          pluginsLoaded = sys.plugins;
          toolsAvailable = sys.tools;
          console.log(
            `[poc] Init: model=${sys.model}, permissionMode=${sys.permissionMode}`
          );
          console.log(`[poc] CC version: ${sys.claude_code_version}`);
          console.log(
            `[poc] Plugins loaded (${sys.plugins.length}):`,
            JSON.stringify(sys.plugins)
          );
          console.log(`[poc] Tools available: ${sys.tools.join(", ")}`);
          console.log(`[poc] Skills: ${sys.skills.join(", ") || "(none)"}`);
        }
      }

      // Capture the final result message
      if (message.type === "result") {
        resultMessage = message as SDKResultMessage;
        logResult(resultMessage);
      }
    }
  } finally {
    await fs.rm(workspaceDir, { recursive: true }).catch(() => {});
  }

  return {
    firstMessageLatency_ms:
      firstMessageTime !== null ? firstMessageTime - spawnStart : -1,
    totalDuration_ms: Date.now() - spawnStart,
    messages: observed,
    resultMessage,
    pluginsLoaded,
    toolsAvailable,
    error: null,
  };
}

function logMessage(message: SDKMessage, entry: ObservedMessage): void {
  const label = entry.subtype
    ? `${entry.type}/${entry.subtype}`
    : entry.type;
  console.log(`[poc] +${entry.timestamp_ms}ms  ${label}`);
}

function logResult(r: SDKResultMessage): void {
  console.log(`\n[poc] === RESULT (${r.subtype}) ===`);
  console.log(`[poc] is_error:        ${r.is_error}`);
  console.log(`[poc] num_turns:       ${r.num_turns}`);
  console.log(`[poc] duration_ms:     ${r.duration_ms}`);
  console.log(`[poc] duration_api_ms: ${r.duration_api_ms}`);
  console.log(`[poc] total_cost_usd:  $${r.total_cost_usd.toFixed(6)}`);
  console.log(`[poc] usage:`, {
    input_tokens: r.usage.input_tokens,
    output_tokens: r.usage.output_tokens,
    cache_creation_input_tokens: r.usage.cache_creation_input_tokens,
    cache_read_input_tokens: r.usage.cache_read_input_tokens,
  });
  if (r.subtype === "error_max_budget_usd") {
    console.log(`[poc] *** Budget limit enforcement triggered ***`);
  }
  if (r.is_error) {
    const err = r as SDKResultError;
    console.log(`[poc] Errors:`, err.errors);
    console.log(`[poc] Permission denials:`, err.permission_denials);
  }
}

function printSummary(result: PocRunResult): void {
  console.log("\n=== SUMMARY ===");
  console.log(`First-message latency: ${result.firstMessageLatency_ms}ms`);
  console.log(`Total wall-clock time:  ${result.totalDuration_ms}ms`);
  console.log(`Message count:          ${result.messages.length}`);

  const uniqueTypes = [
    ...new Set(
      result.messages.map(
        (m) => m.type + (m.subtype ? `/${m.subtype}` : "")
      )
    ),
  ];
  console.log(`Message types seen:     ${uniqueTypes.join(", ")}`);
  console.log(
    `Plugins loaded:         ${result.pluginsLoaded.map((p) => p.name).join(", ") || "(none)"}`
  );
  console.log(
    `Tools restricted to:    ${result.toolsAvailable.join(", ") || "(all)"}`
  );

  if (result.resultMessage) {
    const r = result.resultMessage;
    const totalTokens = r.usage.input_tokens + r.usage.output_tokens;
    console.log(`\n--- Token / Cost Comparison ---`);
    console.log(
      `SDK exact input_tokens:    ${r.usage.input_tokens}`
    );
    console.log(
      `SDK exact output_tokens:   ${r.usage.output_tokens}`
    );
    console.log(
      `SDK derived total tokens:  ${totalTokens}`
    );
    console.log(
      `SDK total_cost_usd:        $${r.total_cost_usd.toFixed(6)}`
    );
    console.log(
      `\nCurrent approach (parseTokenUsage) would parse these from stdout JSON.`
    );
    console.log(
      `SDK provides structured fields directly — no regex or JSON.parse needed.`
    );
  }

  console.log("\n--- CLI Flag Coverage (buildClaudeCliArgs → SDK options) ---");
  console.log(
    '  -p <prompt>                     → prompt parameter in query()'
  );
  console.log(
    '  --output-format json            → NOT NEEDED (SDK yields typed SDKMessage)'
  );
  console.log(
    '  --dangerously-skip-permissions  → permissionMode:"bypassPermissions" + allowDangerouslySkipPermissions:true'
  );
  console.log(
    '  --max-budget-usd N              → maxBudgetUsd: N'
  );
  console.log(
    '  --plugin-dir <path>             → plugins:[{ type:"local", path }]'
  );
  console.log(
    '  ANTHROPIC_MODEL env             → model option (or env passthrough)'
  );
  console.log(
    '  cwd: config.workspacePath       → cwd option'
  );
}

async function main(): Promise<void> {
  console.log("=== SprintFoundry — Claude Agent SDK PoC ===\n");
  console.log(`SDK version:       @anthropic-ai/claude-agent-sdk@0.2.47`);
  console.log(`Developer CLAUDE.md: ${DEVELOPER_CLAUDE_MD}`);
  console.log(`Plugin dir:          ${PLUGIN_DIR}`);
  console.log(`Max budget:          $${MAX_BUDGET_USD}\n`);

  let result: PocRunResult;
  try {
    result = await runPoc();
  } catch (err) {
    console.error("[poc] Fatal error:", err);
    process.exit(1);
  }

  printSummary(result);
}

main();
