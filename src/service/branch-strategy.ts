import type { BranchStrategy, TicketDetails } from "../shared/types.js";

export function sanitizeBranchSegment(value: string, separator: "-" | "_"): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(/^[-_]+|[-_]+$/g, "");
  return sanitized || "work";
}

export function buildBranchName(ticket: TicketDetails, branchStrategy: BranchStrategy): string {
  const { prefix, include_ticket_id, naming } = branchStrategy;
  const separator = naming === "snake_case" ? "_" : "-";
  const parts: string[] = [];

  if (include_ticket_id) {
    parts.push(sanitizeBranchSegment(ticket.id, separator));
  }

  parts.push(sanitizeBranchSegment(ticket.title, separator).slice(0, 50));

  return prefix + parts.join(separator);
}

export function extractTicketIdFromBranch(branch: string): string | null {
  const match = branch.match(/([a-z][a-z0-9]*-\d+)/i);
  if (!match) return null;
  return match[1].toUpperCase();
}
