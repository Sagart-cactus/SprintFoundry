// ============================================================
// SprintFoundry — Workspace Manager
// Creates and cleans up workspace directories per run
// ============================================================

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type { ProjectConfig } from "../shared/types.js";

export class WorkspaceManager {
  private baseDir: string;

  constructor(private projectConfig: ProjectConfig) {
    this.baseDir = path.join(os.tmpdir(), "sprintfoundry", projectConfig.project_id);
  }

  async create(runId: string): Promise<string> {
    const workspacePath = path.join(this.baseDir, runId);
    await fs.mkdir(workspacePath, { recursive: true });
    return workspacePath;
  }

  async cleanup(runId: string): Promise<void> {
    const workspacePath = path.join(this.baseDir, runId);
    await fs.rm(workspacePath, { recursive: true, force: true });
  }

  async list(): Promise<string[]> {
    try {
      return await fs.readdir(this.baseDir);
    } catch {
      return [];
    }
  }

  getPath(runId: string): string {
    return path.join(this.baseDir, runId);
  }
}
