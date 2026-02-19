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
 *
 * Stub mode: when ANTHROPIC_API_KEY is absent the PoC runs in stub mode,
 * yielding synthetic messages with realistic timing.  No real SDK calls are
 * made, so the file is fully runnable without credentials.
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
const EXPECTED_PLUGIN_NAME = "code-review";

// Budget intentionally tiny to observe enforcement behaviour.
const MAX_BUDGET_USD = 0.05;

// Multi-run latency benchmark parameters
const WARM_RUNS = 3; // number of warm runs after the initial cold run

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
  pluginAssertionPassed: boolean | null;
  error: string | null;
}

interface LatencyStats {
  samples: number[];
  min_ms: number;
  mean_ms: number;
  max_ms: number;
  p95_ms: number;
  /** true when numbers come from stubQueryGen rather than real query() calls */
  isSimulated: boolean;
}

// ---- Helpers ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeLatencyStats(samples: number[], isSimulated: boolean): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  // p95 index (0-based): ceil(n * 0.95) - 1, clamped to last element
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
    isSimulated,
  };
}

// ---- Stub query generator ----
// Simulates the SDK's async message stream without a real API call.
// Yields a synthetic system/init then a synthetic result/success message.
// initDelayMs approximates SDK startup time (process fork + Node bootstrap).
async function* stubQueryGen(
  initDelayMs: number
): AsyncGenerator<SDKMessage> {
  await sleep(initDelayMs);

  // Synthetic system/init — mirrors the real SDKSystemMessage shape
  const stubInit = {
    type: "system" as const,
    subtype: "init" as const,
    model: MODEL ?? "claude-sonnet-4-6",
    permissionMode: "bypassPermissions",
    claude_code_version: "2.1.47",
    // Stub includes the expected plugin so the assertion exercises the pass path.
    // In a real run this list comes from the spawned claude process.
    plugins: [{ name: EXPECTED_PLUGIN_NAME, path: PLUGIN_DIR }],
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    skills: [],
    session_id: `stub-${Date.now()}`,
    timestamp: new Date().toISOString(),
    uuid: `stub-uuid-${Date.now()}`,
  };
  yield stubInit as unknown as SDKMessage;

  await sleep(50);

  // Synthetic result/success
  const stubResult = {
    type: "result" as const,
    subtype: "success" as const,
    is_error: false,
    num_turns: 1,
    duration_ms: initDelayMs + 50,
    duration_api_ms: initDelayMs,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    session_id: `stub-${Date.now()}`,
    result: JSON.stringify({
      status: "complete",
      summary: "SDK PoC stub run",
      artifacts_created: [],
      artifacts_modified: [],
      issues: [],
      metadata: {},
    }),
  };
  yield stubResult as unknown as SDKMessage;
}

// ---- Latency benchmark ----
// Measures first-message latency (time from query() call to system/init)
// using the stub generator.  No real API key required.
// Cold run simulates JIT + page-cache cold; warm runs reflect steady-state.

// Measure time from query() call to the first system/init message using a
// real SDK invocation.  system/init is emitted before any model inference, so
// this captures process-fork + Node bootstrap cost with ~$0 budget impact.
// We abort (break) as soon as the first message arrives.
async function measureFirstMessageLatencyReal(): Promise<number> {
  const start = Date.now();
  for await (const msg of query({
    prompt: "exit",
    options: {
      maxBudgetUsd: 0.001,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      cwd: os.tmpdir(),
    },
  })) {
    if (msg.type === "system") {
      return Date.now() - start;
    }
  }
  return Date.now() - start;
}

// Stub fallback used when ANTHROPIC_API_KEY is absent.
async function measureFirstMessageLatencyStub(isColdRun: boolean): Promise<number> {
  const baseDelay = isColdRun ? 350 : 280;
  const jitter = Math.floor(Math.random() * 60) - 30; // ±30ms
  const start = Date.now();
  for await (const _msg of stubQueryGen(baseDelay + jitter)) {
    return Date.now() - start;
  }
  return -1;
}

async function runLatencyBenchmark(): Promise<LatencyStats> {
  const totalRuns = 1 + WARM_RUNS;
  const usingReal = Boolean(API_KEY);
  const modeLabel = usingReal
    ? "empirical — real query() calls, breaks after system/init"
    : "SIMULATED — stub generator, no real API calls";

  console.log(`\n[poc] === Latency Benchmark (${modeLabel}) ===`);
  console.log(
    `[poc] Methodology: 1 cold run + ${WARM_RUNS} warm runs (n=${totalRuns})`
  );
  console.log(
    `[poc] Metric: time from query() call to first system/init message`
  );
  if (!usingReal) {
    console.log(
      `[poc] NOTE: Set ANTHROPIC_API_KEY for empirical measurements.`
    );
  }

  const latencies: number[] = [];

  process.stdout.write(`[poc] Run 1 (cold): `);
  const cold = usingReal
    ? await measureFirstMessageLatencyReal()
    : await measureFirstMessageLatencyStub(true);
  latencies.push(cold);
  console.log(`${cold}ms`);

  for (let i = 0; i < WARM_RUNS; i++) {
    process.stdout.write(`[poc] Run ${i + 2} (warm): `);
    const w = usingReal
      ? await measureFirstMessageLatencyReal()
      : await measureFirstMessageLatencyStub(false);
    latencies.push(w);
    console.log(`${w}ms`);
  }

  const stats = computeLatencyStats(latencies, !usingReal);
  console.log(`\n[poc] First-message latency stats (n=${stats.samples.length})${!usingReal ? " [SIMULATED]" : ""}:`);
  console.log(`[poc]   min:  ${stats.min_ms}ms`);
  console.log(`[poc]   mean: ${stats.mean_ms}ms`);
  console.log(`[poc]   max:  ${stats.max_ms}ms`);
  console.log(`[poc]   p95:  ${stats.p95_ms}ms`);

  return stats;
}

// ---- Plugin load assertion helper ----
// Checks the plugins list from system/init and logs pass/fail.
// Returns true if the expected plugin is active, false otherwise.
function assertPluginLoaded(
  plugins: { name: string; path: string }[]
): boolean {
  // Require both path AND name to match to avoid false positives from a
  // different plugin that happens to share the same name at a different path.
  const found = plugins.some(
    (p) => p.path === PLUGIN_DIR && p.name === EXPECTED_PLUGIN_NAME
  );
  if (found) {
    console.log(
      `[poc] ASSERTION PASS: plugin '${EXPECTED_PLUGIN_NAME}' loaded`
    );
  } else {
    console.error(
      `[poc] ASSERTION FAIL: plugin '${EXPECTED_PLUGIN_NAME}' NOT found in loaded plugins`
    );
    console.error(`[poc] Expected plugin at: ${PLUGIN_DIR}`);
    console.error(`[poc] Loaded plugins:`, JSON.stringify(plugins));
    console.error(
      `[poc] Possible causes: plugin.json missing, path incorrect, plugin directory invalid,`
    );
    console.error(
      `[poc]   or SDK version mismatch.  The SDK does NOT throw on plugin load failure.`
    );
  }
  return found;
}

// ---- Stub PoC run ----
// Exercises the full message-processing path without a real API call.
// Used when ANTHROPIC_API_KEY is absent.
async function runPocStub(): Promise<PocRunResult> {
  console.log(`\n[poc] Running in STUB mode (no API key)\n`);

  const observed: ObservedMessage[] = [];
  let firstMessageTime: number | null = null;
  let resultMessage: SDKResultMessage | null = null;
  let pluginsLoaded: { name: string; path: string }[] = [];
  let toolsAvailable: string[] = [];
  let pluginAssertionPassed: boolean | null = null;

  const spawnStart = Date.now();
  console.log(`[poc] stubQueryGen() called at t=0ms`);

  // Realistic warm-run delay for the full stub run
  const initDelay = 280 + Math.floor(Math.random() * 60) - 30;

  for await (const message of stubQueryGen(initDelay)) {
    const now = Date.now();

    if (firstMessageTime === null) {
      firstMessageTime = now;
      const latency = now - spawnStart;
      console.log(
        `[poc] First message received: ${latency}ms after stubQueryGen() call`
      );
    }

    const entry: ObservedMessage = {
      type: message.type,
      timestamp_ms: now - spawnStart,
    };
    if (
      "subtype" in message &&
      typeof (message as { subtype?: unknown }).subtype === "string"
    ) {
      entry.subtype = (message as { subtype: string }).subtype;
    }
    observed.push(entry);

    logMessage(message, entry);

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

        // Plugin load assertion
        pluginAssertionPassed = assertPluginLoaded(sys.plugins);
      }
    }

    if (message.type === "result") {
      resultMessage = message as SDKResultMessage;
      logResult(resultMessage);
    }
  }

  return {
    firstMessageLatency_ms:
      firstMessageTime !== null ? firstMessageTime - spawnStart : -1,
    totalDuration_ms: Date.now() - spawnStart,
    messages: observed,
    resultMessage,
    pluginsLoaded,
    toolsAvailable,
    pluginAssertionPassed,
    error: null,
  };
}

// ---- Main PoC (real SDK) ----

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
  let pluginAssertionPassed: boolean | null = null;

  // ---- Latency measurement ----
  // Equivalent to the timestamp before spawn("claude", args) in the current approach.
  const spawnStart = Date.now();
  console.log(`[poc] query() called at t=0ms`);

  try {
    // (2) permissionMode  (3) maxBudgetUsd  (4) plugins  (5) cwd
    // NOTE: allowedTools is redundant when permissionMode is 'bypassPermissions'
    // because all permission prompts are already bypassed. Only set allowedTools
    // when using permissionMode 'default' or 'dontAsk'.
    const queryGen = query({
      prompt: "Read task details in .agent-task.md and follow CLAUDE.md.",
      options: {
        // (1) systemPrompt from developer CLAUDE.md
        systemPrompt,

        // (2) permissionMode – equivalent to --dangerously-skip-permissions
        // allowedTools is intentionally omitted: redundant with bypassPermissions
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,

        // (3) maxBudgetUsd – small value to observe budget enforcement
        maxBudgetUsd: MAX_BUDGET_USD,

        // (4) plugins – equivalent to --plugin-dir
        plugins: [{ type: "local", path: PLUGIN_DIR }],

        // (5) cwd – workspace directory
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

          // Plugin load assertion: verify the expected plugin is active.
          // The SDK does NOT throw on plugin load failure — must check explicitly.
          pluginAssertionPassed = assertPluginLoaded(sys.plugins);
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
    pluginAssertionPassed,
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

function printSummary(result: PocRunResult, latencyStats: LatencyStats): void {
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
    `Plugin assertion:       ${result.pluginAssertionPassed === null ? "not run" : result.pluginAssertionPassed ? "PASS" : "FAIL"}`
  );
  console.log(
    `Tools available:        ${result.toolsAvailable.join(", ") || "(all)"}`
  );

  const latencyLabel = latencyStats.isSimulated
    ? `Latency Benchmark — ${latencyStats.samples.length} runs [SIMULATED — set ANTHROPIC_API_KEY for empirical data]`
    : `Latency Benchmark — ${latencyStats.samples.length} runs [empirical]`;
  console.log(`\n--- ${latencyLabel} ---`);
  console.log(`min:  ${latencyStats.min_ms}ms`);
  console.log(`mean: ${latencyStats.mean_ms}ms`);
  console.log(`max:  ${latencyStats.max_ms}ms`);
  console.log(`p95:  ${latencyStats.p95_ms}ms`);

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

  // Step 1: Always run the multi-run latency benchmark (stub — no API key needed)
  const latencyStats = await runLatencyBenchmark();

  // Step 2: Full PoC run — stub mode if no API key, real SDK if key is set
  let result: PocRunResult;
  if (!API_KEY) {
    console.log(
      "\n[poc] ANTHROPIC_API_KEY not set — running stub PoC (no real API calls)"
    );
    try {
      result = await runPocStub();
    } catch (err) {
      console.error("[poc] Stub run error:", err);
      process.exit(1);
    }
  } else {
    try {
      result = await runPoc();
    } catch (err) {
      console.error("[poc] Fatal error:", err);
      process.exit(1);
    }
  }

  printSummary(result, latencyStats);
}

main();
