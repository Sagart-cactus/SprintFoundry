import { spawn } from "child_process";
import * as fs from "fs/promises";

interface ProcessOutputFiles {
  stdoutPath?: string;
  stderrPath?: string;
}

export async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
    parseTokensFromStdout?: boolean;
    outputFiles?: ProcessOutputFiles;
  }
): Promise<{ tokensUsed: number; runtimeId: string; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const safeArgs = args.map(a => a.length > 80 ? a.slice(0, 80) + "..." : a);
    console.log(`[process] Spawning: ${command} ${safeArgs.join(" ")}`);
    console.log(`[process] CWD: ${options.cwd}, timeout: ${Math.round(options.timeoutMs / 1000)}s`);

    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Close stdin immediately — CLI tools like `claude` and `codex`
    // may hang waiting for input if stdin remains open.
    proc.stdin?.end();

    console.log(`[process] PID: ${proc.pid}`);

    let stdout = "";
    let stderr = "";
    let settled = false;

    const persistOutputs = async () => {
      const writes: Promise<unknown>[] = [];
      if (options.outputFiles?.stdoutPath) {
        writes.push(fs.writeFile(options.outputFiles.stdoutPath, stdout, "utf-8"));
      }
      if (options.outputFiles?.stderrPath) {
        writes.push(fs.writeFile(options.outputFiles.stderrPath, stderr, "utf-8"));
      }
      if (writes.length > 0) {
        await Promise.allSettled(writes);
      }
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      console.log(`[process] ${command} FAILED: ${error.message}`);
      void persistOutputs().finally(() => reject(error));
    };

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      console.log(`[process] ${command} completed successfully (stdout: ${stdout.length} chars, stderr: ${stderr.length} chars)`);
      void persistOutputs().finally(() => {
        const tokensUsed = options.parseTokensFromStdout
          ? parseTokenUsage(stdout)
          : 0;
        resolve({
          tokensUsed,
          runtimeId: `local-${command}-${proc.pid}`,
          stdout,
          stderr,
        });
      });
    };

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      settleReject(new Error(`Process ${command} timed out`));
    }, options.timeoutMs);

    proc.on("close", (code) => {
      if (code !== 0) {
        settleReject(new Error(`Process ${command} exited with code ${code}. ${stderr.trim()}`));
        return;
      }
      settleResolve();
    });

    proc.on("error", (err) => {
      settleReject(err);
    });
  });
}

export function parseTokenUsage(output: string): number {
  const trimmed = output.trim();
  if (!trimmed) return 0;

  // First try a single JSON payload.
  const fromSingleJson = parseUsageFromJson(trimmed);
  if (fromSingleJson !== null) return fromSingleJson;

  // Fallback: parse JSONL streams (Codex emits one JSON object per line).
  let totalFromJsonl = 0;
  let foundJsonlUsage = false;
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || (!line.startsWith("{") && !line.startsWith("["))) continue;
    const value = parseUsageFromJson(line);
    if (value !== null) {
      totalFromJsonl += value;
      foundJsonlUsage = true;
    }
  }
  if (foundJsonlUsage) return totalFromJsonl;

  // Final fallback for plain-text output.
  const match = trimmed.match(/tokens?[:\s]+(\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
}

function parseUsageFromJson(jsonText: string): number | null {
  try {
    const parsed = JSON.parse(jsonText);
    return extractUsage(parsed);
  } catch {
    return null;
  }
}

function extractUsage(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  // Claude: { usage: { total_tokens } } or { usage: { input_tokens, output_tokens } }
  const usage = record["usage"];
  if (usage && typeof usage === "object") {
    const usageObj = usage as Record<string, unknown>;

    const totalTokens = numberOrNull(usageObj["total_tokens"]);
    if (totalTokens !== null) return totalTokens;

    const inputTokens = numberOrNull(usageObj["input_tokens"]) ?? 0;
    const outputTokens = numberOrNull(usageObj["output_tokens"]) ?? 0;
    if (inputTokens > 0 || outputTokens > 0) {
      return inputTokens + outputTokens;
    }
  }

  // Legacy fallback: { tokens_used: N }
  const tokensUsed = numberOrNull(record["tokens_used"]);
  if (tokensUsed !== null) return tokensUsed;

  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
