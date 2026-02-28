// ============================================================
// SprintFoundry — GitHub SCM Plugin
// Bridges LifecycleManager to GitHub PR/CI/review APIs.
// ============================================================

import type {
  PluginModule,
  SCMPlugin,
  PRInfo,
  CIStatus,
  ReviewDecision,
  ReviewComment,
  MergeReadiness,
} from "../../shared/plugin-types.js";
import type { RepoConfig } from "../../shared/types.js";

type GitHubConfig = {
  token: string;
  owner: string;
  repo: string;
};

class GitHubSCMPlugin implements SCMPlugin {
  readonly name = "github";

  constructor(private config: GitHubConfig) {}

  async detectPR(branch: string, repo: RepoConfig): Promise<PRInfo | null> {
    const { owner, repo: name } = this.resolveRepo(repo.url);
    const head = `${owner}:${branch}`;
    const pulls = await this.request<any[]>(
      `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(head)}&per_page=1`
    );
    const pr = pulls[0];
    if (!pr) return null;
    return {
      number: pr.number,
      url: pr.html_url,
      branch: pr.head?.ref ?? branch,
      repo: `${owner}/${name}`,
    };
  }

  async getPRState(pr: PRInfo): Promise<"open" | "merged" | "closed"> {
    const data = await this.getPR(pr);
    if (data.merged_at) return "merged";
    if (data.state === "closed") return "closed";
    return "open";
  }

  async getCISummary(pr: PRInfo): Promise<CIStatus> {
    const data = await this.getPR(pr);
    const sha = data.head?.sha;
    if (!sha) return "none";
    const [owner, repo] = this.splitRepo(pr.repo);
    const status = await this.request<any>(`/repos/${owner}/${repo}/commits/${sha}/status`);
    const state = String(status.state ?? "").toLowerCase();
    if (state === "success") return "passing";
    if (state === "failure" || state === "error") return "failing";
    if (state === "pending") return "pending";
    return "none";
  }

  async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
    const [owner, repo] = this.splitRepo(pr.repo);
    const reviews = await this.request<any[]>(
      `/repos/${owner}/${repo}/pulls/${pr.number}/reviews?per_page=100`
    );
    for (let i = reviews.length - 1; i >= 0; i--) {
      const state = String(reviews[i]?.state ?? "").toUpperCase();
      if (state === "CHANGES_REQUESTED") return "changes_requested";
      if (state === "APPROVED") return "approved";
    }

    const prData = await this.getPR(pr);
    if ((prData.requested_reviewers ?? []).length > 0) return "pending";
    return "none";
  }

  async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
    const [owner, repo] = this.splitRepo(pr.repo);
    const comments = await this.request<any[]>(
      `/repos/${owner}/${repo}/pulls/${pr.number}/comments?per_page=100`
    );
    return comments.map((c) => ({
      id: c.id,
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      path: c.path ?? undefined,
      line: typeof c.line === "number" ? c.line : undefined,
      created_at: c.created_at ?? new Date().toISOString(),
    }));
  }

  async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
    const data = await this.getPR(pr);
    const ci = await this.getCISummary(pr);
    const review = await this.getReviewDecision(pr);
    const blockers: string[] = [];
    if (ci === "failing") blockers.push("CI is failing");
    if (ci === "pending") blockers.push("CI is pending");
    if (review === "changes_requested") blockers.push("Review requested changes");
    if (review === "pending") blockers.push("Review is pending");
    if (data.mergeable === false) blockers.push("GitHub reports PR is not mergeable");
    return {
      mergeable: blockers.length === 0,
      ci,
      review,
      blockers,
    };
  }

  async mergePR(pr: PRInfo, method: "merge" | "squash" | "rebase" = "squash"): Promise<void> {
    const [owner, repo] = this.splitRepo(pr.repo);
    await this.request(
      `/repos/${owner}/${repo}/pulls/${pr.number}/merge`,
      "PUT",
      { merge_method: method }
    );
  }

  private async getPR(pr: PRInfo): Promise<any> {
    const [owner, repo] = this.splitRepo(pr.repo);
    return this.request(`/repos/${owner}/${repo}/pulls/${pr.number}`);
  }

  private async request<T = unknown>(endpoint: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "SprintFoundry-SCM-Plugin",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`GitHub SCM API ${method} ${endpoint} failed: ${response.status} ${response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private resolveRepo(repoUrl: string): { owner: string; repo: string } {
    const explicit = {
      owner: this.config.owner?.trim(),
      repo: this.config.repo?.trim(),
    };
    if (explicit.owner && explicit.repo) return { owner: explicit.owner, repo: explicit.repo };

    const cleaned = repoUrl.replace(/^https?:\/\/[^@]+@/, "https://");
    const ssh = cleaned.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (ssh) return { owner: ssh[1], repo: ssh[2] };
    const https = cleaned.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (https) return { owner: https[1], repo: https[2] };
    throw new Error(`Unable to determine GitHub owner/repo from URL: ${repoUrl}`);
  }

  private splitRepo(repo: string): [string, string] {
    const [owner, name] = repo.split("/", 2);
    if (!owner || !name) throw new Error(`Invalid repo identifier: ${repo}`);
    return [owner, name];
  }
}

export const githubSCMModule: PluginModule<SCMPlugin> = {
  manifest: {
    name: "github",
    slot: "scm",
    version: "1.0.0",
    description: "GitHub SCM integration for PR state, CI, reviews, and merge operations",
  },
  create: (config) => {
    const token = String(config.token ?? "").trim();
    const owner = String(config.owner ?? "").trim();
    const repo = String(config.repo ?? "").trim();
    if (!token || !owner || !repo) {
      throw new Error("scm-github plugin requires token, owner, and repo");
    }
    return new GitHubSCMPlugin({ token, owner, repo });
  },
};

