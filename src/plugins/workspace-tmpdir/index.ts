// ============================================================
// SprintFoundry — Workspace Tmpdir Plugin
// Adapter that wraps existing WorkspaceManager + GitManager
// behind the WorkspacePlugin interface.
// ============================================================

import type {
  WorkspacePlugin,
  WorkspaceInfo,
  PluginModule,
} from "../../shared/plugin-types.js";
import type {
  AgentType,
  BranchStrategy,
  RepoConfig,
  TaskRun,
  TicketDetails,
} from "../../shared/types.js";
import { WorkspaceManager } from "../../service/workspace-manager.js";
import { GitManager } from "../../service/git-manager.js";

class TmpdirWorkspacePlugin implements WorkspacePlugin {
  readonly name = "tmpdir";
  private manager: WorkspaceManager;
  private gitManager: GitManager | null = null;

  constructor(private projectConfig: { project_id: string }) {
    // We use a lightweight subset — WorkspaceManager only needs project_id
    this.manager = new WorkspaceManager(projectConfig as any);
  }

  async create(
    runId: string,
    repoConfig: RepoConfig,
    branchStrategy: BranchStrategy,
    ticket: TicketDetails
  ): Promise<WorkspaceInfo> {
    const path = await this.manager.create(runId);
    this.gitManager = new GitManager(repoConfig, branchStrategy);
    const branch = await this.gitManager.cloneAndBranch(path, ticket);
    return { path, branch };
  }

  async destroy(runId: string): Promise<void> {
    await this.manager.cleanup(runId);
  }

  async commitStepChanges(
    workspacePath: string,
    runId: string,
    stepNumber: number,
    agent: AgentType,
  ): Promise<boolean> {
    if (!this.gitManager) {
      throw new Error("Workspace not initialized — call create() first");
    }
    return this.gitManager.commitStepCheckpoint(workspacePath, runId, stepNumber, agent);
  }

  async createPullRequest(
    workspacePath: string,
    run: TaskRun,
  ): Promise<string> {
    if (!this.gitManager) {
      throw new Error("Workspace not initialized — call create() first");
    }
    return this.gitManager.createPullRequest(workspacePath, run);
  }

  getPath(runId: string): string {
    return this.manager.getPath(runId);
  }

  async list(): Promise<string[]> {
    return this.manager.list();
  }
}

export const tmpdirWorkspaceModule: PluginModule<WorkspacePlugin> = {
  manifest: {
    name: "tmpdir",
    slot: "workspace",
    version: "1.0.0",
    description: "Temp-directory workspace with full git clone (default behavior)",
  },
  create: (config) => {
    const projectId = (config.project_id as string) ?? "default";
    return new TmpdirWorkspacePlugin({ project_id: projectId });
  },
};
