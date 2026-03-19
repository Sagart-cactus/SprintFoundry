import { buildBranchName } from "./branch-strategy.js";
import type {
  BranchStrategy,
  ProjectConfig,
  TicketDetails,
  TicketWorkflowConfig,
  TicketWorkflowStage,
  WorkflowStageContext,
} from "../shared/types.js";

export interface NormalizedTicketWorkflowConfig {
  provider: "linear_sdlc";
  linearStates: {
    todo: string[];
    review: string[];
    done: string[];
  };
  agents: Record<TicketWorkflowStage, string>;
  mergeMethod: "merge" | "squash" | "rebase";
}

const DEFAULT_LINEAR_STATES = {
  todo: ["todo"],
  review: ["review"],
  done: ["done"],
};

const DEFAULT_AGENTS: Record<TicketWorkflowStage, string> = {
  developer: "developer",
  qa: "qa",
  merge: "merge-bot",
};

function normalizeStateNames(values: string[] | undefined, fallback: string[]): string[] {
  const normalized = (values ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : fallback;
}

export function normalizeTicketWorkflowConfig(
  config: TicketWorkflowConfig | undefined
): NormalizedTicketWorkflowConfig | null {
  if (!config?.enabled) return null;

  return {
    provider: config.provider ?? "linear_sdlc",
    linearStates: {
      todo: normalizeStateNames(config.linear_states?.todo, DEFAULT_LINEAR_STATES.todo),
      review: normalizeStateNames(config.linear_states?.review, DEFAULT_LINEAR_STATES.review),
      done: normalizeStateNames(config.linear_states?.done, DEFAULT_LINEAR_STATES.done),
    },
    agents: {
      developer: config.agents?.developer?.trim() || DEFAULT_AGENTS.developer,
      qa: config.agents?.qa?.trim() || DEFAULT_AGENTS.qa,
      merge: config.agents?.merge?.trim() || DEFAULT_AGENTS.merge,
    },
    mergeMethod: config.merge_method ?? "squash",
  };
}

export function getTicketWorkflowConfig(
  projectConfig: ProjectConfig
): NormalizedTicketWorkflowConfig | null {
  return normalizeTicketWorkflowConfig(projectConfig.ticket_workflow);
}

export function resolveWorkflowStageForLinearTicket(
  ticket: TicketDetails,
  workflowConfig: NormalizedTicketWorkflowConfig
): TicketWorkflowStage | null {
  const state = String(ticket.state ?? "").trim().toLowerCase();
  if (!state) return null;
  if (workflowConfig.linearStates.todo.includes(state)) return "developer";
  if (workflowConfig.linearStates.review.includes(state)) return "qa";
  if (workflowConfig.linearStates.done.includes(state)) return null;
  return null;
}

export function resolveWorkflowBranchName(
  ticket: TicketDetails,
  branchStrategy: BranchStrategy,
  context?: WorkflowStageContext
): string {
  return context?.branch?.trim() || buildBranchName(ticket, branchStrategy);
}

export function resolveWorkflowStateTarget(
  workflowConfig: NormalizedTicketWorkflowConfig,
  stage: TicketWorkflowStage
): string | null {
  if (stage === "developer" || stage === "qa") {
    return workflowConfig.linearStates.review[0] ?? null;
  }
  if (stage === "merge") {
    return workflowConfig.linearStates.done[0] ?? null;
  }
  return null;
}

export function buildWorkflowStageTask(
  ticket: TicketDetails,
  context: WorkflowStageContext,
  branch: string
): string {
  if (context.stage === "developer") {
    return [
      `Implement the Linear ticket on branch '${branch}'.`,
      `When you finish, leave the branch in a review-ready state and write a concise handoff summary.`,
      ``,
      `Ticket: ${ticket.id} — ${ticket.title}`,
      ticket.description,
    ].join("\n");
  }

  if (context.stage === "qa") {
    return [
      `Validate the existing implementation on branch '${branch}'.`,
      `Run the relevant test suite, add or adjust tests if coverage is missing, and prepare the branch for PR creation.`,
      ``,
      `Ticket: ${ticket.id} — ${ticket.title}`,
      ticket.description,
    ].join("\n");
  }

  return [
    `Resolve any remaining merge blockers for branch '${branch}'${context.pr_url ? ` and PR '${context.pr_url}'` : ""}.`,
    `Bring the branch up to date with the default branch, resolve conflicts if present, run a basic smoke test, and leave it ready to merge.`,
    ``,
    `Ticket: ${ticket.id} — ${ticket.title}`,
    ticket.description,
  ].join("\n");
}
