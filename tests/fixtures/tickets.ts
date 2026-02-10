import type { TicketDetails } from "../../src/shared/types.js";

export function makeTicket(overrides?: Partial<TicketDetails>): TicketDetails {
  return {
    id: overrides?.id ?? "TEST-123",
    source: overrides?.source ?? "github",
    title: overrides?.title ?? "Add CSV export to reports page",
    description:
      overrides?.description ??
      "Users need to export report data as CSV files.\n\nAcceptance Criteria:\n- [ ] Export button on reports page\n- [ ] CSV includes all visible columns\n- [ ] Large exports are streamed",
    labels: overrides?.labels ?? ["feature", "frontend"],
    priority: overrides?.priority ?? "p1",
    acceptance_criteria: overrides?.acceptance_criteria ?? [
      "Export button on reports page",
      "CSV includes all visible columns",
      "Large exports are streamed",
    ],
    linked_tickets: overrides?.linked_tickets ?? [],
    comments: overrides?.comments ?? [],
    author: overrides?.author ?? "test-user",
    assignee: overrides?.assignee,
    raw: overrides?.raw ?? {},
  };
}
