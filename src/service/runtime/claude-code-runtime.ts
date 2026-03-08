import * as path from "path";
import * as fs from "fs/promises";
import { spawn } from "child_process";
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentRuntime,
  RuntimeActivityEvent,
  RuntimeStepContext,
  RuntimeStepResult,
} from "./types.js";
import { evaluateGuardrail, type GuardrailToolCall } from "./agent-hooks.js";
import { runProcess, parseTokenUsage } from "./process-utils.js";
import type { RuntimeMetadataEnvelope } from "../../shared/types.js";
import type { RuntimeLogChunk } from "../event-sink-client.js";

const LOG_CHUNK_FLUSH_INTERVAL_MS = 5_000;
const LOG_CHUNK_MAX_BYTES = 4_096;

interface ActivityDispatcher {
  hasConsumer: boolean;
  emit(event: RuntimeActivityEvent): Promise<void>;
  flushFinal(): Promise<void>;
}

export class ClaudeCodeRuntime implements AgentRuntime {
  async runStep(config: RuntimeStepContext): Promise<RuntimeStepResult> {
    const activityDispatcher = this.createActivityDispatcher(config);
    await fs.mkdir(config.workspacePath, { recursive: true });
    try {
      if (config.runtime.mode === "local_sdk") return this.runSdk(config, activityDispatcher);
      return this.runLocal(config, activityDispatcher);
    } finally {
      await activityDispatcher.flushFinal();
    }
  }

  private async runLocal(
    config: RuntimeStepContext,
    activityDispatcher: ActivityDispatcher
  ): Promise<RuntimeStepResult> {
    // When there is an activity listener, use streaming so the monitor gets per-turn events.
    if (activityDispatcher.hasConsumer) return this.runLocalStreaming(config, activityDispatcher);

    const args = this.buildCliArgs(config, "json");
    const paths = this.buildLogPaths(config);
    await this.writeDebugFiles(paths, {
      timestamp: new Date().toISOString(),
      step_number: config.stepNumber,
      step_attempt: config.stepAttempt,
      runtime_mode: config.runtime.mode,
      runtime_provider: config.runtime.provider,
      runtime_command: "claude",
      model: config.modelConfig.model,
      api_key_present: Boolean(config.apiKey),
    });
    const result = await runProcess("claude", args, {
      cwd: config.workspacePath,
      env: {
        ...process.env,
        CLAUDECODE: undefined, // unset to allow nested claude invocations
        ...(config.apiKey ? { ANTHROPIC_API_KEY: config.apiKey } : {}),
        ANTHROPIC_MODEL: config.modelConfig.model,
        // Inject OTel telemetry env vars when enabled so Claude Code CLI
        // forwards its own metrics (token usage, cost, session duration)
        // to the shared OTLP collector.
        ...(process.env.SPRINTFOUNDRY_OTEL_ENABLED === "1" ? {
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318",
          OTEL_EXPORTER_OTLP_PROTOCOL: process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf",
          OTEL_METRICS_EXPORTER: "otlp",
          OTEL_LOGS_EXPORTER: "otlp",
        } : {}),
        ...(config.runtime.env ?? {}),
      },
      timeoutMs: config.timeoutMinutes * 60 * 1000,
      parseTokensFromStdout: true,
      outputFiles: {
        stdoutPath: paths.stepStdoutPath,
        stderrPath: paths.stepStderrPath,
      },
    });
    await this.copyLatestLogs(paths.stepStdoutPath, paths.stepStderrPath, paths.latestStdoutPath, paths.latestStderrPath);
    const runtimeId = this.extractSessionIdFromOutput(result.stdout) ?? result.runtimeId;
    const runtimeMetadata = this.buildRuntimeMetadata(config, runtimeId, {
      resume: this.buildResumeMetadata(config),
      provider_metadata: {
        output_parsing: "jsonl",
        session_id_source: "stdout_json_line",
      },
    });
    return {
      tokens_used: result.tokensUsed,
      runtime_id: runtimeId,
      resume_used: runtimeMetadata.resume?.used,
      resume_failed: runtimeMetadata.resume?.failed,
      resume_fallback: runtimeMetadata.resume?.fallback_to_fresh,
      runtime_metadata: runtimeMetadata,
    };
  }

  private async runLocalStreaming(
    config: RuntimeStepContext,
    activityDispatcher: ActivityDispatcher
  ): Promise<RuntimeStepResult> {
    const paths = this.buildLogPaths(config);
    const args = this.buildCliArgs(config, "stream-json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDECODE: undefined, // unset to allow nested claude invocations
      ...(config.apiKey ? { ANTHROPIC_API_KEY: config.apiKey } : {}),
      ANTHROPIC_MODEL: config.modelConfig.model,
      // Inject OTel telemetry env vars when enabled so Claude Code CLI
      // forwards its own metrics (token usage, cost, session duration)
      // to the shared OTLP collector.
      ...(process.env.SPRINTFOUNDRY_OTEL_ENABLED === "1" ? {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318",
        OTEL_EXPORTER_OTLP_PROTOCOL: process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_LOGS_EXPORTER: "otlp",
      } : {}),
      ...(config.runtime.env ?? {}),
    };

    await this.writeDebugFiles(paths, {
      timestamp: new Date().toISOString(),
      step_number: config.stepNumber,
      step_attempt: config.stepAttempt,
      runtime_mode: config.runtime.mode,
      runtime_provider: config.runtime.provider,
      runtime_command: "claude",
      output_format: "stream-json",
      model: config.modelConfig.model,
      api_key_present: Boolean(config.apiKey),
    });

    return new Promise((resolve, reject) => {
      const proc = spawn("claude", args, {
        cwd: config.workspacePath,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      proc.stdin?.end(); // signal EOF immediately so interactive prompts don't hang

      const stdoutLines: string[] = [];
      let stderrData = "";
      let lineBuffer = "";
      let runtimeId: string | null = null;
      let tokensUsed = 0;
      let costUsd: number | undefined;
      let timedOut = false;

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        // Force-kill after 5 s grace period if the process ignores SIGTERM
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* already exited */ }
        }, 5000);
      }, config.timeoutMinutes * 60 * 1000);

      proc.stdout?.on("data", (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          stdoutLines.push(trimmed);

          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }

          // Extract session ID from any message that carries it
          if (typeof msg.session_id === "string" && msg.session_id) {
            runtimeId = msg.session_id;
          }

          // Extract token usage and cost from the final result line
          if (msg.type === "result") {
            const usage = msg.usage as Record<string, number> | undefined;
            if (usage) {
              tokensUsed = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
            }
            if (typeof msg.total_cost_usd === "number") costUsd = msg.total_cost_usd;
          }

          // Emit per-turn activity events (tool calls, file edits, commands, thinking)
          const activities = this.extractActivityEventsFromSdkMessage(msg);
          for (const activityEvent of activities) {
            void this.safeEmitActivity(activityDispatcher, activityEvent);
          }
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrData += chunk.toString();
      });

      const finish = async (code: number | null) => {
        clearTimeout(timeoutHandle);
        // Parse any remaining buffered content — the final `result` line may lack a trailing newline
        const remaining = lineBuffer.trim();
        if (remaining) {
          stdoutLines.push(remaining);
          try {
            const msg = JSON.parse(remaining) as Record<string, unknown>;
            if (typeof msg.session_id === "string" && msg.session_id) runtimeId = msg.session_id;
            if (msg.type === "result") {
              const usage = msg.usage as Record<string, number> | undefined;
              if (usage) tokensUsed = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
              if (typeof msg.total_cost_usd === "number") costUsd = msg.total_cost_usd;
            }
          } catch { /* not JSON */ }
        }
        const stdout = stdoutLines.join("\n");
        await Promise.all([
          fs.writeFile(paths.stepStdoutPath, stdout, "utf-8"),
          fs.writeFile(paths.stepStderrPath, stderrData, "utf-8"),
        ]);
        await this.copyLatestLogs(paths.stepStdoutPath, paths.stepStderrPath, paths.latestStdoutPath, paths.latestStderrPath);

        if (timedOut) return reject(new Error("Process claude timed out"));
        if (code !== 0) return reject(new Error(`Process claude exited with code 1. ${stderrData.slice(0, 300)}`));

        const finalRuntimeId = runtimeId ?? `claude-stream-${Date.now()}`;
        const runtimeMetadata = this.buildRuntimeMetadata(config, finalRuntimeId, {
          resume: this.buildResumeMetadata(config),
          provider_metadata: {
            output_parsing: "stream-jsonl",
            session_id_source: "stdout_stream",
          },
        });
        resolve({
          tokens_used: tokensUsed,
          cost_usd: costUsd,
          runtime_id: finalRuntimeId,
          resume_used: runtimeMetadata.resume?.used,
          resume_failed: runtimeMetadata.resume?.failed,
          resume_fallback: runtimeMetadata.resume?.fallback_to_fresh,
          runtime_metadata: runtimeMetadata,
        });
      };

      proc.on("close", (code: number | null) => { finish(code).catch(reject); });
      proc.on("error", async (err: Error) => {
        clearTimeout(timeoutHandle);
        await Promise.all([
          fs.writeFile(paths.stepStdoutPath, stdoutLines.join("\n"), "utf-8").catch(() => {}),
          fs.writeFile(paths.stepStderrPath, stderrData, "utf-8").catch(() => {}),
        ]);
        reject(err);
      });
    });
  }

  private buildCliArgs(config: RuntimeStepContext, outputFormat: string): string[] {
    const flags = config.cliFlags ?? {};
    const taskPrompt = this.readTaskPrompt();
    const args: string[] = config.resumeSessionId
      ? ["--resume", config.resumeSessionId, "-p", taskPrompt]
      : ["-p", taskPrompt];
    // outputFormat arg takes precedence — streaming path must not be overridden by platform config
    args.push("--output-format", outputFormat);
    if (outputFormat === "stream-json") {
      args.push("--verbose");
    }
    if (flags.skip_permissions !== false) {
      args.push("--dangerously-skip-permissions");
    }
    const budgetUsd = flags.max_budget_usd;
    if (budgetUsd !== undefined && budgetUsd > 0) {
      args.push("--max-budget-usd", String(budgetUsd));
    }
    if (config.plugins && config.plugins.length > 0) {
      for (const pluginPath of config.plugins) {
        args.push("--plugin-dir", pluginPath);
      }
    }
    return args;
  }

  private readTaskPrompt(): string {
    return `Read task details in .agent-task.md and follow CLAUDE.md.`;
  }

  private async runSdk(
    config: RuntimeStepContext,
    activityDispatcher: ActivityDispatcher
  ): Promise<RuntimeStepResult> {
    const paths = this.buildLogPaths(config);
    const prompts = await this.readPrompts(config.workspacePath);
    const flags = config.cliFlags ?? {};
    const env = {
      ...process.env,
      CLAUDECODE: undefined, // unset to allow nested claude invocations
      ...(config.apiKey ? { ANTHROPIC_API_KEY: config.apiKey } : {}),
      ANTHROPIC_MODEL: config.modelConfig.model,
      ...(config.runtime.env ?? {}),
    };
    await this.writeDebugFiles(paths, {
      timestamp: new Date().toISOString(),
      step_number: config.stepNumber,
      step_attempt: config.stepAttempt,
      runtime_mode: config.runtime.mode,
      runtime_provider: config.runtime.provider,
      runtime_command: "claude-sdk",
      model: config.modelConfig.model,
      api_key_present: Boolean(config.apiKey),
    });
    const timeoutMs = config.timeoutMinutes * 60 * 1000;
    const timeoutAbortController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutAbortController.abort();
    }, timeoutMs);

    let runtimeId = `local-claude-sdk-${Date.now()}`;
    let stdout = "";
    let stderr = "";
    let finalResultMessage: SDKResultMessage | null = null;

    try {
      const queryOptions: Record<string, unknown> = {
        cwd: config.workspacePath,
        model: config.modelConfig.model,
        env,
        systemPrompt: prompts.systemPrompt,
        maxBudgetUsd:
          flags.max_budget_usd !== undefined && flags.max_budget_usd > 0
            ? flags.max_budget_usd
            : undefined,
        permissionMode: flags.skip_permissions !== false ? "bypassPermissions" : undefined,
        allowDangerouslySkipPermissions: flags.skip_permissions !== false ? true : undefined,
        plugins: config.plugins?.map((pluginPath) => ({ type: "local" as const, path: pluginPath })),
        abortController: timeoutAbortController,
        stderr: (data: string) => {
          stderr += data;
        },
      };
      if (config.resumeSessionId) {
        queryOptions.resume = config.resumeSessionId;
      }
      for await (const message of query({
        prompt: prompts.taskPrompt,
        options: queryOptions as any,
      })) {
        const guardrailViolation = this.findGuardrailViolation(message, config);
        if (guardrailViolation) {
          await this.emitGuardrailBlock(activityDispatcher, guardrailViolation);
          throw new Error(`Guardrail blocked: ${guardrailViolation.reason ?? "blocked"}`);
        }
        stdout += `${JSON.stringify(message)}\n`;
        const activities = this.extractActivityEventsFromSdkMessage(message);
        for (const activityEvent of activities) {
          await this.safeEmitActivity(activityDispatcher, activityEvent);
        }
        if ("session_id" in message && typeof message.session_id === "string") {
          runtimeId = message.session_id;
        }
        if (message.type === "result") {
          finalResultMessage = message;
        }
      }
    } catch (error) {
      if (!timeoutAbortController.signal.aborted) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
      await Promise.all([
        fs.writeFile(paths.stepStdoutPath, stdout, "utf-8"),
        fs.writeFile(paths.stepStderrPath, stderr, "utf-8"),
      ]);
      await this.copyLatestLogs(paths.stepStdoutPath, paths.stepStderrPath, paths.latestStdoutPath, paths.latestStderrPath);
    }

    if (timeoutAbortController.signal.aborted && !finalResultMessage) {
      throw new Error("Process claude timed out");
    }
    if (!finalResultMessage) {
      throw new Error("Claude SDK did not return a result message");
    }
    if (finalResultMessage.subtype !== "success") {
      const details = finalResultMessage.errors.join("; ");
      throw new Error(`Process claude exited with code 1. ${details}`);
    }

    const usage = this.normalizeUsage(finalResultMessage.usage);
    const tokensUsed = this.tokensFromUsage(usage);
    const runtimeMetadata = this.buildRuntimeMetadata(config, runtimeId, {
      usage,
      billing: {
        cost_usd: finalResultMessage.total_cost_usd,
        cost_source: "runtime_reported",
      },
      resume: this.buildResumeMetadata(config),
      provider_metadata: {
        output_parsing: "sdk_stream",
        session_id_source: "sdk_message",
      },
    });
    return {
      tokens_used: tokensUsed,
      runtime_id: runtimeId,
      cost_usd: finalResultMessage.total_cost_usd,
      usage,
      resume_used: runtimeMetadata.resume?.used,
      resume_failed: runtimeMetadata.resume?.failed,
      resume_fallback: runtimeMetadata.resume?.fallback_to_fresh,
      runtime_metadata: runtimeMetadata,
    };
  }

  private findGuardrailViolation(
    message: unknown,
    config: RuntimeStepContext
  ): (GuardrailToolCall & { reason?: string; rule?: string }) | null {
    if (!config.guardrails) return null;
    const toolCalls = this.extractClaudeToolCalls(message);
    for (const toolCall of toolCalls) {
      const decision = evaluateGuardrail(config.guardrails, toolCall, config.workspacePath);
      if (!decision.allowed) {
        return { ...toolCall, reason: decision.reason, rule: decision.rule };
      }
    }
    return null;
  }

  private extractClaudeToolCalls(message: unknown): GuardrailToolCall[] {
    if (!message || typeof message !== "object") return [];
    const raw = message as Record<string, unknown>;
    const content =
      (this.isRecord(raw["message"]) && Array.isArray((raw["message"] as any).content)
        ? (raw["message"] as any).content
        : Array.isArray(raw["content"])
          ? raw["content"]
          : []) as Array<Record<string, unknown>>;

    const toolCalls: GuardrailToolCall[] = [];
    for (const block of content) {
      if (!block || block.type !== "tool_use") continue;
      const toolName = typeof block.name === "string" ? block.name : "";
      const input = this.isRecord(block.input) ? block.input : {};
      const command = this.pickString(input, ["command", "cmd"]);
      const filePath = this.pickString(input, ["file_path", "path", "target_path"]);

      if (command) {
        toolCalls.push({
          kind: "command",
          command,
          tool_name: toolName,
        });
        continue;
      }

      if (filePath) {
        toolCalls.push({
          kind: "file",
          path: filePath,
          tool_name: toolName,
        });
      }
    }

    const topToolName = this.pickString(raw, ["tool_name", "name"]);
    const topCommand = this.pickString(raw, ["command", "cmd"]);
    const topFilePath = this.pickString(raw, ["path", "file_path", "target_path"]);
    if (topCommand) {
      toolCalls.push({
        kind: "command",
        command: topCommand,
        tool_name: topToolName,
      });
    } else if (topFilePath) {
      toolCalls.push({
        kind: "file",
        path: topFilePath,
        tool_name: topToolName,
      });
    }

    return toolCalls;
  }

  private async emitGuardrailBlock(
    activityDispatcher: ActivityDispatcher,
    toolCall: GuardrailToolCall & { reason?: string; rule?: string }
  ): Promise<void> {
    await this.safeEmitActivity(activityDispatcher, {
      type: "agent_guardrail_block",
      data: {
        tool_name: toolCall.tool_name ?? "",
        command: toolCall.command ?? "",
        path: toolCall.path ?? "",
        reason: toolCall.reason ?? "blocked",
        rule: toolCall.rule ?? "",
      },
    });
  }

  private async readPrompts(workspacePath: string): Promise<{ systemPrompt: string; taskPrompt: string }> {
    const [systemPrompt, taskPrompt] = await Promise.all([
      fs.readFile(path.join(workspacePath, "CLAUDE.md"), "utf-8"),
      fs.readFile(path.join(workspacePath, ".agent-task.md"), "utf-8"),
    ]);
    return { systemPrompt, taskPrompt };
  }

  private normalizeUsage(usage: Record<string, unknown>): Record<string, number> {
    const normalized: Record<string, number> = {};
    for (const [key, value] of Object.entries(usage)) {
      const num = this.toNumber(value);
      if (num !== null) {
        normalized[key] = num;
      }
    }
    return normalized;
  }

  private tokensFromUsage(usage: Record<string, number>): number {
    const total = usage.total_tokens;
    if (typeof total === "number" && Number.isFinite(total)) {
      return total;
    }
    const input = usage.input_tokens ?? usage.inputTokens ?? 0;
    const output = usage.output_tokens ?? usage.outputTokens ?? 0;
    return input + output;
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  private extractSessionIdFromOutput(stdout: string): string | null {
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    for (const line of trimmed.split(/\r?\n/)) {
      const candidate = this.extractSessionIdFromJson(line.trim());
      if (candidate) return candidate;
    }
    return this.extractSessionIdFromJson(trimmed);
  }

  private extractSessionIdFromJson(jsonText: string): string | null {
    if (!jsonText || (!jsonText.startsWith("{") && !jsonText.startsWith("["))) return null;
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const sessionId = parsed["session_id"];
      if (typeof sessionId === "string" && sessionId.trim()) return sessionId;
      return null;
    } catch {
      return null;
    }
  }

  private async safeEmitActivity(
    activityDispatcher: ActivityDispatcher,
    event: RuntimeActivityEvent
  ): Promise<void> {
    try {
      await activityDispatcher.emit(event);
    } catch (error) {
      console.warn(
        `[claude-runtime] Failed to emit activity event ${event.type}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private createActivityDispatcher(config: RuntimeStepContext): ActivityDispatcher {
    const callback = config.onActivity;
    const sinkClient = config.sinkClient;
    const hasConsumer = Boolean(callback || sinkClient);
    if (!hasConsumer) {
      return {
        hasConsumer: false,
        emit: async () => undefined,
        flushFinal: async () => undefined,
      };
    }

    let buffer = "";
    let bufferBytes = 0;
    let sequence = 0;
    let timer: NodeJS.Timeout | undefined;
    let flushChain: Promise<void> = Promise.resolve();

    const clearTimer = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = undefined;
    };

    const startTimerIfNeeded = () => {
      if (!sinkClient || timer || bufferBytes <= 0) return;
      timer = setTimeout(() => {
        void queueFlush(false);
      }, LOG_CHUNK_FLUSH_INTERVAL_MS);
    };

    const queueFlush = (isFinal: boolean): Promise<void> => {
      flushChain = flushChain.then(async () => {
        if (!sinkClient || bufferBytes <= 0) {
          clearTimer();
          return;
        }
        const chunk = buffer;
        const byteLength = bufferBytes;
        buffer = "";
        bufferBytes = 0;
        clearTimer();
        const payload: RuntimeLogChunk = {
          run_id: config.runId,
          step_number: config.stepNumber,
          step_attempt: config.stepAttempt,
          agent: config.agent,
          runtime_provider: config.runtime.provider,
          sequence,
          chunk,
          byte_length: byteLength,
          stream: "activity",
          is_final: isFinal,
          timestamp: new Date().toISOString(),
        };
        sequence += 1;
        try {
          await sinkClient.postLog(payload);
        } catch (error) {
          console.warn(
            `[claude-runtime] Failed to post activity log chunk step=${config.stepNumber} attempt=${config.stepAttempt}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        } finally {
          startTimerIfNeeded();
        }
      });
      return flushChain;
    };

    return {
      hasConsumer: true,
      emit: async (event: RuntimeActivityEvent) => {
        if (callback) {
          try {
            await callback(event);
          } catch (error) {
            console.warn(
              `[claude-runtime] Activity callback failed for ${event.type}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
        if (!sinkClient) return;
        const line = `${JSON.stringify({
          type: event.type,
          data: event.data,
          timestamp: new Date().toISOString(),
        })}\n`;
        buffer += line;
        bufferBytes += Buffer.byteLength(line, "utf-8");
        if (bufferBytes >= LOG_CHUNK_MAX_BYTES) {
          await queueFlush(false);
          return;
        }
        startTimerIfNeeded();
      },
      flushFinal: async () => {
        clearTimer();
        await queueFlush(true);
      },
    };
  }

  private extractActivityEventsFromSdkMessage(message: unknown): RuntimeActivityEvent[] {
    if (!message || typeof message !== "object") return [];
    const raw = message as Record<string, unknown>;
    const events: RuntimeActivityEvent[] = [];
    const topType = this.pickString(raw, ["type", "subtype"]).toLowerCase();

    if (topType.includes("thinking") || topType.includes("reasoning")) {
      const thought =
        this.pickString(raw, ["thinking", "reasoning", "text", "message"]) ||
        this.textFromContent(raw["content"]) ||
        "";
      events.push({
        type: "agent_thinking",
        data: {
          kind: topType || "thinking",
          text: this.truncate(thought, 300),
        },
      });
    }

    if (this.isRecord(raw["content"])) {
      this.extractEventsFromContentArray([raw["content"]], events);
    } else if (Array.isArray(raw["content"])) {
      this.extractEventsFromContentArray(raw["content"], events);
    }

    const toolName = this.pickString(raw, ["tool_name", "name"]);
    if (toolName) {
      const command = this.pickString(raw, ["command", "cmd"]);
      const filePath = this.pickString(raw, ["path", "file_path", "target_path"]);
      if (command) {
        events.push({
          type: "agent_command_run",
          data: {
            tool_name: toolName,
            command: this.truncate(command, 240),
          },
        });
      } else if (filePath) {
        events.push({
          type: "agent_file_edit",
          data: {
            tool_name: toolName,
            path: filePath,
          },
        });
      } else {
        events.push({
          type: "agent_tool_call",
          data: {
            tool_name: toolName,
          },
        });
      }
    }

    return events;
  }

  private extractEventsFromContentArray(
    contentItems: unknown[],
    out: RuntimeActivityEvent[]
  ): void {
    for (const item of contentItems) {
      if (!this.isRecord(item)) continue;
      const contentType = this.pickString(item, ["type"]).toLowerCase();
      if (!contentType) continue;

      if (contentType.includes("thinking") || contentType.includes("reasoning")) {
        const text =
          this.pickString(item, ["thinking", "text", "reasoning"]) ||
          this.textFromContent(item["content"]) ||
          "";
        out.push({
          type: "agent_thinking",
          data: {
            kind: contentType,
            text: this.truncate(text, 300),
          },
        });
        continue;
      }

      const toolName = this.pickString(item, ["name", "tool_name"]);
      if (contentType === "tool_use" || contentType === "server_tool_use" || toolName) {
        const command =
          this.pickString(item, ["command", "cmd"]) ||
          (this.isRecord(item["input"]) ? this.pickString(item["input"] as Record<string, unknown>, ["command", "cmd"]) : "");
        const filePath =
          this.pickString(item, ["path", "file_path"]) ||
          (this.isRecord(item["input"]) ? this.pickString(item["input"] as Record<string, unknown>, ["path", "file_path", "target_path"]) : "");

        if (command) {
          out.push({
            type: "agent_command_run",
            data: {
              tool_name: toolName || contentType,
              command: this.truncate(command, 240),
            },
          });
        } else if (filePath) {
          out.push({
            type: "agent_file_edit",
            data: {
              tool_name: toolName || contentType,
              path: filePath,
            },
          });
        } else {
          out.push({
            type: "agent_tool_call",
            data: {
              tool_name: toolName || contentType,
            },
          });
        }
      }
    }
  }

  private pickString(value: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    return "";
  }

  private textFromContent(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((item) => (this.isRecord(item) ? this.pickString(item, ["text", "message"]) : ""))
        .filter(Boolean)
        .join("\n");
    }
    if (this.isRecord(value)) return this.pickString(value, ["text", "message"]);
    return "";
  }

  private truncate(value: string, maxLen: number): string {
    if (!value) return "";
    if (value.length <= maxLen) return value;
    return `${value.slice(0, maxLen)}...`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  private buildLogPaths(config: RuntimeStepContext) {
    const stepPrefix = `.claude-runtime.step-${config.stepNumber}.attempt-${config.stepAttempt}`;
    return {
      stepDebugPath: path.join(config.workspacePath, `${stepPrefix}.debug.json`),
      stepStdoutPath: path.join(config.workspacePath, `${stepPrefix}.stdout.log`),
      stepStderrPath: path.join(config.workspacePath, `${stepPrefix}.stderr.log`),
      latestDebugPath: path.join(config.workspacePath, ".claude-runtime.debug.json"),
      latestStdoutPath: path.join(config.workspacePath, ".claude-runtime.stdout.log"),
      latestStderrPath: path.join(config.workspacePath, ".claude-runtime.stderr.log"),
    };
  }

  private async writeDebugFiles(
    paths: { stepDebugPath: string; latestDebugPath: string },
    payload: Record<string, unknown>
  ): Promise<void> {
    const content = JSON.stringify(payload, null, 2);
    await Promise.all([
      fs.writeFile(paths.stepDebugPath, content, "utf-8"),
      fs.writeFile(paths.latestDebugPath, content, "utf-8"),
    ]);
  }

  private async copyLatestLogs(
    stepStdoutPath: string,
    stepStderrPath: string,
    latestStdoutPath: string,
    latestStderrPath: string
  ): Promise<void> {
    const stdout = await fs.readFile(stepStdoutPath, "utf-8").catch(() => "");
    const stderr = await fs.readFile(stepStderrPath, "utf-8").catch(() => "");
    await Promise.all([
      fs.writeFile(latestStdoutPath, stdout, "utf-8"),
      fs.writeFile(latestStderrPath, stderr, "utf-8"),
    ]);
  }

  private buildRuntimeMetadata(
    config: RuntimeStepContext,
    runtimeId: string,
    extras?: Omit<RuntimeMetadataEnvelope, "schema_version" | "runtime">
  ): RuntimeMetadataEnvelope {
    return {
      schema_version: 1,
      runtime: {
        provider: config.runtime.provider,
        mode: config.runtime.mode,
        runtime_id: runtimeId,
        step_attempt: config.stepAttempt,
      },
      ...extras,
    };
  }

  private buildResumeMetadata(config: RuntimeStepContext): RuntimeMetadataEnvelope["resume"] | undefined {
    if (!config.resumeSessionId) return undefined;
    return {
      requested: true,
      used: true,
      failed: false,
      fallback_to_fresh: false,
      source_session_id: config.resumeSessionId,
      reason: config.resumeReason,
    };
  }
}
