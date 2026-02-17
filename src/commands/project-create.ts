import { input, select, checkbox, confirm } from "@inquirer/prompts";
import { stringify as yamlStringify } from "yaml";
import * as fs from "fs/promises";
import * as path from "path";

interface ProjectAnswers {
  projectId: string;
  name: string;
  stack: string;
  agents: string[];
  repoUrl: string;
  defaultBranch: string;
  ticketSource: string;
  ticketConfig: Record<string, string>;
  apiProviders: string[];
  branchPrefix: string;
  includeTicketId: boolean;
  namingStyle: string;
}

function deriveProjectName(id: string): string {
  return id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function getAgentChoices(stack: string): { name: string; value: string; checked: boolean }[] {
  const allAgents = [
    { name: "Product Agent", value: "product" },
    { name: "Architecture Agent", value: "architect" },
    { name: "Developer Agent (JS/TS)", value: "developer" },
    { name: "Go Developer Agent", value: "go-developer" },
    { name: "Code Review Agent", value: "code-review" },
    { name: "QA Agent (JS/TS)", value: "qa" },
    { name: "Go QA Agent", value: "go-qa" },
    { name: "Security Agent", value: "security" },
    { name: "UI/UX Agent", value: "ui-ux" },
    { name: "DevOps Agent", value: "devops" },
  ];

  const jsDefaults = ["product", "architect", "developer", "code-review", "qa", "security"];
  const goDefaults = ["product", "architect", "go-developer", "code-review", "go-qa", "security"];
  const pythonDefaults = ["product", "architect", "developer", "code-review", "qa", "security"];
  const defaults =
    stack === "go" ? goDefaults : stack === "python" ? pythonDefaults : jsDefaults;

  return allAgents.map((a) => ({ ...a, checked: defaults.includes(a.value) }));
}

function parseRepoOwnerAndName(url: string): { owner: string; repo: string } | null {
  // SSH: git@github.com:org/repo.git
  const sshMatch = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  // HTTPS: https://github.com/org/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  return null;
}

async function askTicketConfig(
  source: string,
  repoUrl: string
): Promise<Record<string, string>> {
  const parsed = parseRepoOwnerAndName(repoUrl);

  switch (source) {
    case "github":
      return {
        token: "${GITHUB_TOKEN}",
        owner: await input({
          message: "GitHub org/owner:",
          default: parsed?.owner,
        }),
        repo: await input({
          message: "GitHub repo name:",
          default: parsed?.repo,
        }),
      };
    case "linear":
      return {
        api_key: "${LINEAR_API_KEY}",
        team_id: await input({ message: "Linear team ID:" }),
      };
    case "jira":
      return {
        host: await input({
          message: "Jira host (e.g. https://myorg.atlassian.net):",
        }),
        email: await input({ message: "Jira email:" }),
        api_token: "${JIRA_API_TOKEN}",
        project_key: await input({ message: "Jira project key:" }),
      };
    case "prompt":
    default:
      return {};
  }
}

async function gatherAnswers(): Promise<ProjectAnswers> {
  // Phase 1: Project Identity
  console.log("  Project Identity\n");

  const projectId = await input({
    message: "Project ID (kebab-case):",
    validate: (val) =>
      /^[a-z0-9][a-z0-9-]*$/.test(val) || "Must be kebab-case (lowercase letters, numbers, hyphens)",
  });

  const name = await input({
    message: "Project name:",
    default: deriveProjectName(projectId),
  });

  // Phase 2: Technology Stack
  console.log("\n  Technology Stack\n");

  const stack = await select({
    message: "Technology stack:",
    choices: [
      { name: "JavaScript / TypeScript", value: "js" },
      { name: "Go", value: "go" },
      { name: "Python (coming soon)", value: "python", disabled: true },
      { name: "Rust (coming soon)", value: "rust", disabled: true },
      { name: "Other (coming soon)", value: "other", disabled: true },
    ],
  });

  const agents = await checkbox({
    message: "Select agents for this project:",
    choices: getAgentChoices(stack),
  });

  // Phase 3: Repository
  console.log("\n  Repository\n");

  const repoUrl = await input({
    message: "Repository URL (SSH or HTTPS):",
    validate: (val) =>
      val.length > 0 || "Repository URL is required",
  });

  const defaultBranch = await input({
    message: "Default branch:",
    default: "main",
  });

  // Phase 4: Ticket Source
  console.log("\n  Ticket Source\n");

  const ticketSource = await select({
    message: "Where do tickets come from?",
    choices: [
      { name: "GitHub Issues", value: "github" },
      { name: "Linear", value: "linear" },
      { name: "Jira", value: "jira" },
      { name: "Prompt only (no ticket system)", value: "prompt" },
    ],
  });

  const ticketConfig = await askTicketConfig(ticketSource, repoUrl);

  // Phase 5: API Keys
  console.log("\n  API Keys\n");

  console.log("  If you're logged in to Claude Code or Codex, SprintFoundry will use that session automatically.");
  console.log("  Otherwise, set the SPRINTFOUNDRY_ANTHROPIC_KEY env var.\n");

  const apiProviders = await checkbox({
    message: "Additional API providers:",
    choices: [
      { name: "OpenAI", value: "openai", checked: false },
      { name: "Google", value: "google", checked: false },
    ],
  });

  // Phase 6: Branch Strategy
  console.log("\n  Branch Strategy\n");

  const branchPrefix = await select({
    message: "Branch prefix:",
    choices: [
      { name: "feat/", value: "feat/" },
      { name: "fix/", value: "fix/" },
      { name: "chore/", value: "chore/" },
      { name: "Custom", value: "__custom__" },
    ],
  });

  let finalPrefix = branchPrefix;
  if (branchPrefix === "__custom__") {
    finalPrefix = await input({
      message: "Custom branch prefix:",
      validate: (val) => val.length > 0 || "Prefix is required",
    });
  }

  const includeTicketId = await confirm({
    message: "Include ticket ID in branch name?",
    default: true,
  });

  const namingStyle = await select({
    message: "Branch naming style:",
    choices: [
      { name: "kebab-case (feat/lin-123-add-feature)", value: "kebab-case" },
      { name: "snake_case (feat/lin_123_add_feature)", value: "snake_case" },
    ],
  });

  return {
    projectId,
    name,
    stack,
    agents,
    repoUrl,
    defaultBranch,
    ticketSource,
    ticketConfig,
    apiProviders,
    branchPrefix: finalPrefix,
    includeTicketId,
    namingStyle,
  };
}

function buildProjectConfig(answers: ProjectAnswers): Record<string, unknown> {
  const config: Record<string, unknown> = {
    project_id: answers.projectId,
    name: answers.name,
    stack: answers.stack,
    agents: answers.agents,
    repo: {
      url: answers.repoUrl,
      default_branch: answers.defaultBranch,
    },
    api_keys: {
      anthropic: "${SPRINTFOUNDRY_ANTHROPIC_KEY}",
      ...(answers.apiProviders.includes("openai") && {
        openai: "${SPRINTFOUNDRY_OPENAI_KEY}",
      }),
      ...(answers.apiProviders.includes("google") && {
        google: "${SPRINTFOUNDRY_GOOGLE_KEY}",
      }),
    },
    branch_strategy: {
      prefix: answers.branchPrefix,
      include_ticket_id: answers.includeTicketId,
      naming: answers.namingStyle,
    },
  };

  if (answers.ticketSource !== "prompt") {
    config.integrations = {
      ticket_source: {
        type: answers.ticketSource,
        config: answers.ticketConfig,
      },
    };
  } else {
    config.integrations = {
      ticket_source: {
        type: "prompt",
        config: {},
      },
    };
  }

  config.rules = [];

  return config;
}

function renderYaml(config: Record<string, unknown>): string {
  const header = [
    "# SprintFoundry — Project Configuration",
    "# Generated by: sprintfoundry project create",
    "",
  ].join("\n");

  const body = yamlStringify(config, {
    lineWidth: 120,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });

  return header + body;
}

function printNextSteps(projectId: string, filePath: string): void {
  console.log(`\n  Configuration saved to ${filePath}\n`);
  console.log("  Next steps:\n");
  console.log("  1. Set required environment variables:");
  console.log("     export SPRINTFOUNDRY_ANTHROPIC_KEY=sk-ant-...");
  console.log("");
  console.log("  2. Validate the config:");
  console.log(`     sprintfoundry validate --project ${projectId}`);
  console.log("");
  console.log("  3. Run on a ticket:");
  console.log(`     sprintfoundry run --source github --ticket 42 --project ${projectId}`);
  console.log("");
}

export async function runProjectCreate(configDir: string): Promise<void> {
  console.log("\n  Welcome to SprintFoundry project setup.\n");

  const answers = await gatherAnswers();
  const config = buildProjectConfig(answers);
  const yaml = renderYaml(config);

  console.log("\n--- Generated config ---\n");
  console.log(yaml);
  console.log("------------------------\n");

  const filePath = path.join(configDir, `${answers.projectId}.yaml`);

  const ok = await confirm({ message: `Save to ${filePath}?`, default: true });
  if (!ok) {
    console.log("\n  Aborted. No file was written.\n");
    return;
  }

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(filePath, yaml, "utf-8");
  printNextSteps(answers.projectId, filePath);
}
