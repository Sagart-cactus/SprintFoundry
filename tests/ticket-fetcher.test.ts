import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TicketFetcher } from "../src/service/ticket-fetcher.js";
import type { IntegrationConfig } from "../src/shared/types.js";

function makeIntegration(
  overrides?: Partial<IntegrationConfig>
): IntegrationConfig {
  return {
    ticket_source: overrides?.ticket_source ?? {
      type: "github",
      config: {
        token: "ghp_test",
        owner: "test-org",
        repo: "test-repo",
      },
    },
    notifications: overrides?.notifications,
  };
}

function mockFetchResponse(data: any, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(data),
  };
}

describe("TicketFetcher", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -- Linear --

  it("fetchLinear sends GraphQL query and maps response", async () => {
    const fetcher = new TicketFetcher(
      makeIntegration({
        ticket_source: {
          type: "linear",
          config: { api_key: "lin_test_key" },
        },
      })
    );

    (globalThis.fetch as any).mockResolvedValueOnce(
      mockFetchResponse({
        data: {
          issue: {
            id: "abc-123",
            identifier: "LIN-42",
            title: "Fix login bug",
            description: "Login fails on mobile",
            priority: 2,
            priorityLabel: "High",
            labels: { nodes: [{ name: "bug" }] },
            comments: { nodes: [{ body: "Urgent fix needed" }] },
            creator: { name: "Alice" },
            assignee: { name: "Bob" },
          },
        },
      })
    );

    const ticket = await fetcher.fetch("abc-123", "linear");

    expect(ticket.id).toBe("LIN-42");
    expect(ticket.source).toBe("linear");
    expect(ticket.title).toBe("Fix login bug");
    expect(ticket.labels).toContain("bug");
    expect(ticket.priority).toBe("p1"); // priority 2 → p1
    expect(ticket.author).toBe("Alice");
    expect(ticket.comments).toContain("Urgent fix needed");
  });

  it("fetchLinear throws on missing API key", async () => {
    const fetcher = new TicketFetcher(
      makeIntegration({
        ticket_source: { type: "linear", config: {} },
      })
    );

    await expect(fetcher.fetch("abc-123", "linear")).rejects.toThrow(
      /API key not configured/
    );
  });

  it("fetchLinear throws on 401 response", async () => {
    const fetcher = new TicketFetcher(
      makeIntegration({
        ticket_source: {
          type: "linear",
          config: { api_key: "bad_key" },
        },
      })
    );

    (globalThis.fetch as any).mockResolvedValueOnce(
      mockFetchResponse({}, false, 401)
    );

    await expect(fetcher.fetch("abc-123", "linear")).rejects.toThrow(
      /Linear API error: 401/
    );
  });

  // -- GitHub --

  it("fetchGitHub fetches issue + comments", async () => {
    const fetcher = new TicketFetcher(makeIntegration());

    // First call: issue
    (globalThis.fetch as any)
      .mockResolvedValueOnce(
        mockFetchResponse({
          number: 42,
          title: "Add dark mode",
          body: "Users want dark mode\n\n- [ ] Toggle switch\n- [ ] Persist preference",
          labels: [{ name: "feature" }, { name: "p1" }],
          comments_url: "https://api.github.com/repos/test-org/test-repo/issues/42/comments",
          user: { login: "alice" },
          assignee: { login: "bob" },
        })
      )
      // Second call: comments
      .mockResolvedValueOnce(
        mockFetchResponse([
          { body: "Please prioritize this" },
        ])
      );

    const ticket = await fetcher.fetch("42", "github");

    expect(ticket.id).toBe("#42");
    expect(ticket.source).toBe("github");
    expect(ticket.title).toBe("Add dark mode");
    expect(ticket.labels).toContain("feature");
    expect(ticket.comments).toContain("Please prioritize this");
    expect(ticket.author).toBe("alice");
  });

  it("fetchGitHub infers priority from labels", async () => {
    const fetcher = new TicketFetcher(makeIntegration());

    (globalThis.fetch as any)
      .mockResolvedValueOnce(
        mockFetchResponse({
          number: 1,
          title: "Critical bug",
          body: "",
          labels: [{ name: "critical" }],
          comments_url: "https://api.github.com/repos/test-org/test-repo/issues/1/comments",
          user: { login: "dev" },
        })
      )
      .mockResolvedValueOnce(mockFetchResponse([]));

    const ticket = await fetcher.fetch("1", "github");

    expect(ticket.priority).toBe("p0"); // "critical" → p0
  });

  // -- Jira --

  it("fetchJira fetches issue with Basic auth", async () => {
    const fetcher = new TicketFetcher(
      makeIntegration({
        ticket_source: {
          type: "jira",
          config: {
            host: "https://test.atlassian.net",
            email: "user@test.com",
            api_token: "jira_token",
          },
        },
      })
    );

    (globalThis.fetch as any).mockResolvedValueOnce(
      mockFetchResponse({
        key: "PROJ-100",
        fields: {
          summary: "Jira ticket title",
          description: "Plain text description",
          labels: ["backend"],
          priority: { name: "High" },
          creator: { displayName: "Creator" },
          assignee: { displayName: "Assignee" },
          issuelinks: [],
          comment: { comments: [] },
        },
      })
    );

    const ticket = await fetcher.fetch("PROJ-100", "jira");

    expect(ticket.id).toBe("PROJ-100");
    expect(ticket.source).toBe("jira");
    expect(ticket.title).toBe("Jira ticket title");
    expect(ticket.priority).toBe("p1"); // "High" → p1

    // Verify Basic auth header
    const callArgs = (globalThis.fetch as any).mock.calls[0];
    expect(callArgs[1].headers.Authorization).toMatch(/^Basic /);
  });

  it("fetchJira extracts ADF description to plain text", async () => {
    const fetcher = new TicketFetcher(
      makeIntegration({
        ticket_source: {
          type: "jira",
          config: {
            host: "https://test.atlassian.net",
            email: "user@test.com",
            api_token: "jira_token",
          },
        },
      })
    );

    (globalThis.fetch as any).mockResolvedValueOnce(
      mockFetchResponse({
        key: "PROJ-101",
        fields: {
          summary: "ADF test",
          description: {
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }],
              },
            ],
          },
          labels: [],
          priority: { name: "Medium" },
          creator: { displayName: "Dev" },
          issuelinks: [],
          comment: { comments: [] },
        },
      })
    );

    const ticket = await fetcher.fetch("PROJ-101", "jira");

    expect(ticket.description).toBe("Hello world");
  });

  // -- Priority Mapping --

  it("mapLinearPriority maps 0-4 to p0-p3", () => {
    const fetcher = new TicketFetcher(makeIntegration());

    expect((fetcher as any).mapLinearPriority(0)).toBe("p0");
    expect((fetcher as any).mapLinearPriority(1)).toBe("p0");
    expect((fetcher as any).mapLinearPriority(2)).toBe("p1");
    expect((fetcher as any).mapLinearPriority(3)).toBe("p2");
    expect((fetcher as any).mapLinearPriority(4)).toBe("p3");
  });

  it("inferGitHubPriority handles various label names", () => {
    const fetcher = new TicketFetcher(makeIntegration());

    expect((fetcher as any).inferGitHubPriority([{ name: "critical" }])).toBe("p0");
    expect((fetcher as any).inferGitHubPriority([{ name: "P0" }])).toBe("p0");
    expect((fetcher as any).inferGitHubPriority([{ name: "high-priority" }])).toBe("p1");
    expect((fetcher as any).inferGitHubPriority([{ name: "p1" }])).toBe("p1");
    expect((fetcher as any).inferGitHubPriority([{ name: "low" }])).toBe("p3");
    expect((fetcher as any).inferGitHubPriority([{ name: "feature" }])).toBe("p2"); // default
  });

  it("mapJiraPriority handles Jira priority names", () => {
    const fetcher = new TicketFetcher(makeIntegration());

    expect((fetcher as any).mapJiraPriority("Highest")).toBe("p0");
    expect((fetcher as any).mapJiraPriority("Critical")).toBe("p0");
    expect((fetcher as any).mapJiraPriority("High")).toBe("p1");
    expect((fetcher as any).mapJiraPriority("Medium")).toBe("p2");
    expect((fetcher as any).mapJiraPriority("Low")).toBe("p3");
    expect((fetcher as any).mapJiraPriority("Lowest")).toBe("p3");
    expect((fetcher as any).mapJiraPriority(undefined)).toBe("p2");
  });

  // -- Acceptance Criteria Parsing --

  it("extractAcceptanceCriteria parses markdown checkboxes", () => {
    const fetcher = new TicketFetcher(makeIntegration());

    const desc = "Some text\n- [ ] First item\n- [x] Second item\n- [ ] Third item";
    const criteria = (fetcher as any).extractAcceptanceCriteria(desc);

    expect(criteria).toContain("First item");
    expect(criteria).toContain("Second item");
    expect(criteria).toContain("Third item");
  });

  it('extractAcceptanceCriteria parses "Acceptance Criteria:" section', () => {
    const fetcher = new TicketFetcher(makeIntegration());

    const desc =
      "Feature desc.\n\nAcceptance Criteria:\n- Must support CSV\n- Must support PDF\n\nNotes: foo";
    const criteria = (fetcher as any).extractAcceptanceCriteria(desc);

    expect(criteria).toContain("Must support CSV");
    expect(criteria).toContain("Must support PDF");
  });

  // -- Unsupported source --

  it("fetch() throws on unsupported source", async () => {
    const fetcher = new TicketFetcher(makeIntegration());

    await expect(
      fetcher.fetch("123", "unsupported" as any)
    ).rejects.toThrow(/Unsupported ticket source/);
  });
});
