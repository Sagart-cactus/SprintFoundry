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
    // TODO: implement per-source status updates
    console.log(
      `[ticket] Updating ${ticket.source}/${ticket.id} → ${status}${prUrl ? ` (PR: ${prUrl})` : ""}`
    );
  }

  private async fetchLinear(ticketId: string): Promise<TicketDetails> {
    const config = this.integrations.ticket_source.config;
    const apiKey = config.api_key;
    if (!apiKey) throw new Error("Linear API key not configured");

    const query = `
      query {
        issue(id: "${ticketId}") {
          id identifier title description
          priority priorityLabel
          labels { nodes { name } }
          comments { nodes { body } }
          creator { name }
          assignee { name }
        }
      }
    `;

    const resp = await fetch("https://api.linear.app/graphql", {
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
    const issue = data.data?.issue;
    if (!issue) throw new Error(`Linear issue not found: ${ticketId}`);

    return {
      id: issue.identifier ?? ticketId,
      source: "linear",
      title: issue.title,
      description: issue.description ?? "",
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
      throw new Error("GitHub integration not fully configured (need token, owner, repo)");
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
      throw new Error("Jira integration not fully configured (need host, email, api_token)");
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
}
