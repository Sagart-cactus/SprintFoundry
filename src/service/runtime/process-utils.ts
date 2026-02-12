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
  try {
    const parsed = JSON.parse(output);
    return parsed?.usage?.total_tokens ?? parsed?.tokens_used ?? 0;
  } catch {
    const match = output.match(/tokens?[:\s]+(\d+)/i);
    return match ? parseInt(match[1], 10) : 0;
  }
}
