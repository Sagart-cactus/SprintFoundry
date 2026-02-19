import * as fs from "fs/promises";
import * as path from "path";
import type { AgentType, RuntimeConfig } from "../shared/types.js";

export interface RuntimeSessionRecord {
  run_id: string;
  agent: AgentType;
  step_number: number;
  step_attempt: number;
  runtime_provider: RuntimeConfig["provider"];
  runtime_mode: RuntimeConfig["mode"];
  session_id: string;
  resume_reason?: string;
  updated_at: string;
}

interface RuntimeSessionStoreFile {
  version: 1;
  sessions: RuntimeSessionRecord[];
}

const STORE_DIR = ".sprintfoundry";
const STORE_NAME = "sessions.json";

export class RuntimeSessionStore {
  private getStorePath(workspacePath: string): string {
    return path.join(workspacePath, STORE_DIR, STORE_NAME);
  }

  async record(workspacePath: string, record: RuntimeSessionRecord): Promise<void> {
    const storePath = this.getStorePath(workspacePath);
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const current = await this.read(workspacePath);

    const next = current.sessions.filter(
      (s) =>
        !(
          s.run_id === record.run_id &&
          s.agent === record.agent &&
          s.step_number === record.step_number &&
          s.step_attempt === record.step_attempt
        )
    );
    next.push(record);

    await fs.writeFile(
      storePath,
      JSON.stringify({ version: 1, sessions: next }, null, 2),
      "utf-8"
    );
  }

  async findLatestByAgent(
    workspacePath: string,
    runId: string,
    agent: AgentType
  ): Promise<RuntimeSessionRecord | null> {
    const current = await this.read(workspacePath);
    const matching = current.sessions
      .filter((s) => s.run_id === runId && s.agent === agent)
      .sort((a, b) => {
        if (a.updated_at !== b.updated_at) {
          return b.updated_at.localeCompare(a.updated_at);
        }
        if (a.step_number !== b.step_number) {
          return b.step_number - a.step_number;
        }
        return b.step_attempt - a.step_attempt;
      });
    return matching[0] ?? null;
  }

  private async read(workspacePath: string): Promise<RuntimeSessionStoreFile> {
    const storePath = this.getStorePath(workspacePath);
    try {
      const raw = await fs.readFile(storePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<RuntimeSessionStoreFile>;
      if (parsed.version === 1 && Array.isArray(parsed.sessions)) {
        return {
          version: 1,
          sessions: parsed.sessions,
        };
      }
      return { version: 1, sessions: [] };
    } catch {
      return { version: 1, sessions: [] };
    }
  }
}
