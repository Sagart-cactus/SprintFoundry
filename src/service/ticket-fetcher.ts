// ============================================================
// SprintFoundry — Ticket Fetcher
// Fetches ticket details from Linear, GitHub, or Jira
// ============================================================

import type {
  TicketDetails,
  TaskSource,
  IntegrationConfig,
} from "../shared/types.js";

export class TicketFetcher {
  constructor(private integrations: IntegrationConfig) {}

  async fetch(ticketId: string, source: TaskSource): Promise<TicketDetails> {
    switch (source) {
      case "linear":
        return this.fetchLinear(ticketId);
      case "github":
        return this.fetchGitHub(ticketId);
      case "jira":
        return this.fetchJira(ticketId);
      default:
        throw new Error(`Unsupported ticket source: ${source}`);
    }
  }

  async updateStatus(
    ticket: TicketDetails,
    status: string,
    prUrl?: string
  ): Promise<void> {
    switch (ticket.source) {
      case "linear":
        await this.updateLinearStatus(ticket, status, prUrl);
        return;
      default:
        console.log(
          `[ticket] Updating ${ticket.source}/${ticket.id} → ${status}${prUrl ? ` (PR: ${prUrl})` : ""}`
        );
    }
  }

  private async fetchLinear(ticketId: string): Promise<TicketDetails> {
    const config = this.integrations.ticket_source.config;
    const apiKey = config.api_key;
    if (!apiKey) {
      throw new Error(
        "Linear API key not configured. Set LINEAR_API_KEY or add integrations.ticket_source.config.api_key in your project config."
      );
    }

    const query = `
      query {
        issue(id: "${ticketId}") {
          id identifier title description url
          state { id name type }
          priority priorityLabel
          team { id key states { nodes { id name type } } }
          labels { nodes { name } }
          comments { nodes { body } }
          creator { name }
          assignee { name }
        }
      }
    `;

    const data = await this.linearRequest(query);
    const issue = data.data?.issue;
    if (!issue) throw new Error(`Linear issue not found: ${ticketId}`);

    return {
      id: issue.identifier ?? ticketId,
      identifier: issue.identifier ?? ticketId,
      source: "linear",
      title: issue.title,
      description: issue.description ?? "",
      url: issue.url ?? undefined,
      state: issue.state?.name ?? undefined,
      state_id: issue.state?.id ?? undefined,
      state_type: issue.state?.type ?? undefined,
      team_id: issue.team?.id ?? undefined,
      team_key: issue.team?.key ?? undefined,
      labels: issue.labels?.nodes?.map((l: any) => l.name) ?? [],
      priority: this.mapLinearPriority(issue.priority),
      acceptance_criteria: this.extractAcceptanceCriteria(issue.description ?? ""),
      linked_tickets: [],
      comments: issue.comments?.nodes?.map((c: any) => c.body) ?? [],
      author: issue.creator?.name ?? "unknown",
      assignee: issue.assignee?.name,
      raw: issue,
    };
  }

  private async fetchGitHub(ticketId: string): Promise<TicketDetails> {
    const config = this.integrations.ticket_source.config;
    const token = config.token;
    const owner = config.owner;
    const repo = config.repo;
    if (!token || !owner || !repo) {
      throw new Error(
        "GitHub integration not fully configured (need token, owner, repo). Ensure integrations.ticket_source.config includes token, owner, and repo in your project config."
      );
    }

    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${ticketId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    if (!resp.ok) {
      throw new Error(`GitHub API error: ${resp.status} ${resp.statusText}`);
    }

    const issue = (await resp.json()) as any;

    // Fetch comments
    const commentsResp = await fetch(issue.comments_url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    const comments = commentsResp.ok ? ((await commentsResp.json()) as any[]) : [];

    return {
      id: `#${issue.number}`,
      source: "github",
      title: issue.title,
      description: issue.body ?? "",
      labels: issue.labels?.map((l: any) => l.name) ?? [],
      priority: this.inferGitHubPriority(issue.labels),
      acceptance_criteria: this.extractAcceptanceCriteria(issue.body ?? ""),
      linked_tickets: [],
      comments: comments.map((c: any) => c.body),
      author: issue.user?.login ?? "unknown",
      assignee: issue.assignee?.login,
      raw: issue,
    };
  }

  private async fetchJira(ticketId: string): Promise<TicketDetails> {
    const config = this.integrations.ticket_source.config;
    const host = config.host;
    const email = config.email;
    const apiToken = config.api_token;
    if (!host || !email || !apiToken) {
      throw new Error(
        "Jira integration not fully configured (need host, email, api_token). Ensure integrations.ticket_source.config includes host, email, and api_token in your project config."
      );
    }

    const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

    const resp = await fetch(`${host}/rest/api/3/issue/${ticketId}`, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      throw new Error(`Jira API error: ${resp.status} ${resp.statusText}`);
    }

    const issue = (await resp.json()) as any;
    const fields = issue.fields;

    return {
      id: issue.key,
      source: "jira",
      title: fields.summary,
      description: this.extractJiraDescription(fields.description),
      labels: fields.labels ?? [],
      priority: this.mapJiraPriority(fields.priority?.name),
      acceptance_criteria: this.extractAcceptanceCriteria(
        this.extractJiraDescription(fields.description)
      ),
      linked_tickets: fields.issuelinks?.map((l: any) =>
        l.outwardIssue?.key ?? l.inwardIssue?.key
      ).filter(Boolean) ?? [],
      comments: fields.comment?.comments?.map((c: any) =>
        this.extractJiraDescription(c.body)
      ) ?? [],
      author: fields.creator?.displayName ?? "unknown",
      assignee: fields.assignee?.displayName,
      raw: issue,
    };
  }

  // ---- Helpers ----

  private mapLinearPriority(priority: number): TicketDetails["priority"] {
    // Linear: 0=no priority, 1=urgent, 2=high, 3=medium, 4=low
    if (priority <= 1) return "p0";
    if (priority === 2) return "p1";
    if (priority === 3) return "p2";
    return "p3";
  }

  private inferGitHubPriority(
    labels: { name: string }[]
  ): TicketDetails["priority"] {
    const names = labels.map((l) => l.name.toLowerCase());
    if (names.some((n) => n.includes("critical") || n.includes("p0"))) return "p0";
    if (names.some((n) => n.includes("high") || n.includes("p1"))) return "p1";
    if (names.some((n) => n.includes("low") || n.includes("p3"))) return "p3";
    return "p2";
  }

  private mapJiraPriority(name?: string): TicketDetails["priority"] {
    const lower = (name ?? "").toLowerCase();
    if (lower.includes("highest") || lower.includes("critical")) return "p0";
    if (lower.includes("high")) return "p1";
    if (lower.includes("low") || lower.includes("lowest")) return "p3";
    return "p2";
  }

  private extractAcceptanceCriteria(description: string): string[] {
    const criteria: string[] = [];
    // Look for common AC patterns: "- [ ] ...", "AC:", "Acceptance Criteria:", numbered lists after AC header
    const lines = description.split("\n");
    let inAC = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (/acceptance\s*criteria/i.test(trimmed)) {
        inAC = true;
        continue;
      }
      if (inAC) {
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || /^\d+\./.test(trimmed)) {
          criteria.push(trimmed.replace(/^[-*\d.[\]\s]+/, "").trim());
        } else if (trimmed === "" && criteria.length > 0) {
          break; // End of AC section
        }
      }
      // Also capture checkbox items anywhere
      if (/^-\s*\[[ x]\]\s*/.test(trimmed)) {
        const item = trimmed.replace(/^-\s*\[[ x]\]\s*/, "").trim();
        if (!criteria.includes(item)) criteria.push(item);
      }
    }

    return criteria;
  }

  private extractJiraDescription(adf: any): string {
    // Jira uses Atlassian Document Format — extract plain text
    if (typeof adf === "string") return adf;
    if (!adf?.content) return "";

    const extract = (node: any): string => {
      if (node.type === "text") return node.text ?? "";
      if (node.content) return node.content.map(extract).join("");
      return "";
    };

    return adf.content.map(extract).join("\n");
  }

  private async updateLinearStatus(
    ticket: TicketDetails,
    status: string,
    prUrl?: string
  ): Promise<void> {
    const issueId = String(ticket.raw?.id ?? "").trim();
    if (!issueId) {
      throw new Error(`Linear ticket ${ticket.id} is missing raw.id needed for state updates`);
    }

    const stateId = this.resolveLinearStateId(ticket, status);
    if (!stateId) {
      throw new Error(`Unable to map Linear status '${status}' for ticket ${ticket.id}`);
    }

    const mutation = `
      mutation {
        issueUpdate(id: "${issueId}", input: { stateId: "${stateId}" }) {
          success
        }
      }
    `;
    await this.linearRequest(mutation);

    if (!prUrl) return;

    const commentMutation = `
      mutation {
        commentCreate(input: { issueId: "${issueId}", body: "SprintFoundry PR: ${this.escapeGraphqlString(prUrl)}" }) {
          success
        }
      }
    `;
    await this.linearRequest(commentMutation);
  }

  private resolveLinearStateId(ticket: TicketDetails, status: string): string | null {
    const rawTeamStates = (ticket.raw?.team as any)?.states?.nodes;
    const states = Array.isArray(rawTeamStates) ? rawTeamStates : [];
    const normalizedStatus = status.trim().toLowerCase();

    const directMatch = states.find((state: any) => String(state?.name ?? "").trim().toLowerCase() === normalizedStatus);
    if (directMatch?.id) return String(directMatch.id);

    const aliasMatchers: Record<string, (state: any) => boolean> = {
      in_review: (state) => {
        const name = String(state?.name ?? "").toLowerCase();
        return name.includes("review");
      },
      done: (state) => {
        const name = String(state?.name ?? "").toLowerCase();
        const type = String(state?.type ?? "").toLowerCase();
        return name.includes("done") || type === "completed";
      },
      todo: (state) => {
        const name = String(state?.name ?? "").toLowerCase();
        const type = String(state?.type ?? "").toLowerCase();
        return name.includes("todo") || type === "unstarted";
      },
    };

    const matcher = aliasMatchers[normalizedStatus];
    if (!matcher) return null;
    const aliasMatch = states.find((state: any) => matcher(state));
    return aliasMatch?.id ? String(aliasMatch.id) : null;
  }

  private async linearRequest(query: string): Promise<any> {
    const config = this.integrations.ticket_source.config;
    const apiKey = config.api_key;
    const apiUrl = config.api_url || "https://api.linear.app/graphql";

    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    if (!resp.ok) {
      throw new Error(`Linear API error: ${resp.status} ${resp.statusText}`);
    }

    const data = (await resp.json()) as any;
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      throw new Error(`Linear GraphQL error: ${String(data.errors[0]?.message ?? "unknown error")}`);
    }
    return data;
  }

  private escapeGraphqlString(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
}
