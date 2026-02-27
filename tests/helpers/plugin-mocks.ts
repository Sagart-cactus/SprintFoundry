/**
 * Test helper: mock implementations of all 4 plugin interfaces.
 * Each mock records calls for assertion and returns configurable defaults.
 */

import { vi } from "vitest";
import type {
  WorkspacePlugin,
  WorkspaceInfo,
  TrackerPlugin,
  SCMPlugin,
  PRInfo,
  CIStatus,
  ReviewDecision,
  ReviewComment,
  MergeReadiness,
  NotifierPlugin,
  PluginModule,
} from "../../src/shared/plugin-types.js";
import type {
  TaskRun,
  TicketDetails,
  RepoConfig,
  BranchStrategy,
  EventPriority,
  TaskSource,
} from "../../src/shared/types.js";
import { makeTicket } from "../fixtures/tickets.js";

// ---- Workspace Plugin Mock ----

export interface MockWorkspacePluginOptions {
  name?: string;
  basePath?: string;
  supportsSubWorktrees?: boolean;
}

export function createMockWorkspacePlugin(opts: MockWorkspacePluginOptions = {}): WorkspacePlugin {
  const basePath = opts.basePath ?? "/tmp/mock-workspace";
  return {
    name: opts.name ?? "mock-workspace",
    supportsSubWorktrees: opts.supportsSubWorktrees ?? false,
    create: vi.fn(async (runId: string): Promise<WorkspaceInfo> => ({
      path: `${basePath}/${runId}`,
      branch: `feat/${runId}`,
    })),
    destroy: vi.fn(async () => {}),
    commitStepChanges: vi.fn(async () => true),
    createPullRequest: vi.fn(async () => "https://github.com/test/repo/pull/99"),
    getPath: vi.fn((runId: string) => `${basePath}/${runId}`),
    list: vi.fn(async () => []),
    createSubWorktree: opts.supportsSubWorktrees
      ? vi.fn(async (parentPath: string, step: number) => `${parentPath}/.worktrees/step-${step}`)
      : undefined,
    mergeSubWorktree: opts.supportsSubWorktrees
      ? vi.fn(async () => {})
      : undefined,
    removeSubWorktree: opts.supportsSubWorktrees
      ? vi.fn(async () => {})
      : undefined,
  };
}

export const mockWorkspaceModule: PluginModule<WorkspacePlugin> = {
  manifest: { name: "mock-workspace", slot: "workspace", version: "1.0.0" },
  create: () => createMockWorkspacePlugin(),
};

// ---- Tracker Plugin Mock ----

export interface MockTrackerPluginOptions {
  name?: string;
  tickets?: Map<string, TicketDetails>;
}

export function createMockTrackerPlugin(opts: MockTrackerPluginOptions = {}): TrackerPlugin {
  const tickets = opts.tickets ?? new Map([["TEST-123", makeTicket()]]);
  return {
    name: opts.name ?? "mock-tracker",
    fetch: vi.fn(async (ticketId: string) => {
      const ticket = tickets.get(ticketId);
      if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
      return ticket;
    }),
    updateStatus: vi.fn(async () => {}),
  };
}

export const mockTrackerModule: PluginModule<TrackerPlugin> = {
  manifest: { name: "mock-tracker", slot: "tracker", version: "1.0.0" },
  create: () => createMockTrackerPlugin(),
};

// ---- SCM Plugin Mock ----

export interface MockSCMPluginOptions {
  name?: string;
  defaultPR?: PRInfo | null;
  defaultCIStatus?: CIStatus;
  defaultReviewDecision?: ReviewDecision;
  defaultMergeability?: MergeReadiness;
}

export function createMockSCMPlugin(opts: MockSCMPluginOptions = {}): SCMPlugin {
  const defaultPR: PRInfo | null = "defaultPR" in opts
    ? (opts.defaultPR as PRInfo | null)
    : {
      number: 42,
      url: "https://github.com/test/repo/pull/42",
      branch: "feat/test",
      repo: "test/repo",
    };
  return {
    name: opts.name ?? "mock-scm",
    detectPR: vi.fn(async () => defaultPR),
    getPRState: vi.fn(async () => "open" as const),
    getCISummary: vi.fn(async () => opts.defaultCIStatus ?? "passing"),
    getReviewDecision: vi.fn(async () => opts.defaultReviewDecision ?? "approved"),
    getPendingComments: vi.fn(async (): Promise<ReviewComment[]> => []),
    getMergeability: vi.fn(async (): Promise<MergeReadiness> => opts.defaultMergeability ?? {
      mergeable: true,
      ci: "passing",
      review: "approved",
      blockers: [],
    }),
    mergePR: vi.fn(async () => {}),
  };
}

export const mockSCMModule: PluginModule<SCMPlugin> = {
  manifest: { name: "mock-scm", slot: "scm", version: "1.0.0" },
  create: () => createMockSCMPlugin(),
};

// ---- Notifier Plugin Mock ----

export interface MockNotifierPluginOptions {
  name?: string;
  shouldFail?: boolean;
}

export function createMockNotifierPlugin(opts: MockNotifierPluginOptions = {}): NotifierPlugin {
  return {
    name: opts.name ?? "mock-notifier",
    notify: opts.shouldFail
      ? vi.fn(async () => { throw new Error("Notification delivery failed"); })
      : vi.fn(async () => {}),
  };
}

export const mockNotifierModule: PluginModule<NotifierPlugin> = {
  manifest: { name: "mock-notifier", slot: "notifier", version: "1.0.0" },
  create: () => createMockNotifierPlugin(),
};

/** Create a notifier that records all messages for assertion. */
export function createRecordingNotifier(name = "recorder"): NotifierPlugin & { messages: Array<{ message: string; priority?: EventPriority }> } {
  const messages: Array<{ message: string; priority?: EventPriority }> = [];
  return {
    name,
    messages,
    notify: vi.fn(async (message: string, priority?: EventPriority) => {
      messages.push({ message, priority });
    }),
  };
}
