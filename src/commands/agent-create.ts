import { input, select, checkbox, confirm } from "@inquirer/prompts";
import { stringify as yamlStringify } from "yaml";
import * as fs from "fs/promises";
import * as path from "path";
import type { AgentRole } from "../shared/types.js";

// Maps AgentRole → default container image and model hint
const ROLE_META: Record<
  AgentRole,
  { image: string; model: string; runtime: string; defaultArtifacts: string[] }
> = {
  orchestrator: {
    image: "sprintfoundry/agent-orchestrator:latest",
    model: "claude-sonnet-4-5-20250929",
    runtime: "local_process",
    defaultArtifacts: ["artifacts/plan.json"],
  },
  product: {
    image: "sprintfoundry/agent-product:latest",
    model: "claude-sonnet-4-5-20250929",
    runtime: "local_process",
    defaultArtifacts: ["artifacts/product-spec.md", "artifacts/user-stories.md"],
  },
  architect: {
    image: "sprintfoundry/agent-architect:latest",
    model: "claude-sonnet-4-5-20250929",
    runtime: "local_process",
    defaultArtifacts: ["artifacts/architecture.md", "artifacts/api-contracts.yaml"],
  },
  developer: {
    image: "sprintfoundry/agent-developer:latest",
    model: "claude-sonnet-4-5-20250929",
    runtime: "local_process",
    defaultArtifacts: ["src/ (modified source code)", "artifacts/handoff/dev-to-qa.md"],
  },
  "code-review": {
    image: "sprintfoundry/agent-code-review:latest",
    model: "claude-sonnet-4-5-20250929",
    runtime: "local_process",
    defaultArtifacts: ["artifacts/code-review.md"],
  },
  qa: {
    image: "sprintfoundry/agent-qa:latest",
    model: "claude-sonnet-4-5-20250929",
    runtime: "local_process",
    defaultArtifacts: ["artifacts/qa-report.md", "artifacts/test-results/"],
  },
  security: {
    image: "sprintfoundry/agent-security:latest",
    model: "claude-sonnet-4-5-20250929",
    runtime: "local_process",
    defaultArtifacts: ["artifacts/security-report.md"],
  },
  "ui-ux": {
    image: "sprintfoundry/agent-ui-ux:latest",
    model: "claude-sonnet-4-5-20250929",
    runtime: "local_process",
    defaultArtifacts: ["artifacts/ui-specs/", "artifacts/wireframes/"],
  },
  devops: {
    image: "sprintfoundry/agent-devops:latest",
    model: "claude-sonnet-4-5-20250929",
    runtime: "local_process",
    defaultArtifacts: ["Dockerfile", ".github/workflows/", "artifacts/devops-report.md"],
  },
};

function deriveAgentName(type: string): string {
  return type
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") + " Agent";
}

function buildClaudeMd(answers: {
  type: string;
  name: string;
  role: AgentRole;
  description: string;
  capabilities: string[];
  output_artifacts: string[];
  required_inputs: string[];
}): string {
  const { type, name, role, description, capabilities, output_artifacts, required_inputs } =
    answers;

  const artifactList = output_artifacts
    .map((a) => `   - \`${a}\``)
    .join("\n");

  const inputList = required_inputs
    .map((i) => `   - \`${i}\``)
    .join("\n");

  const capabilityList = capabilities.map((c) => `- ${c}`).join("\n");

  return `# ${name}

## Role

${description}

You operate as part of the SprintFoundry multi-agent pipeline. Your assigned role is \`${role}\`.

## Before You Start

1. Read \`.agent-task.md\` for your specific task
2. Check these inputs if they exist:
${inputList || "   - `artifacts/` — outputs from previous agents"}
3. Check \`.agent-context/\` for previous step outputs
4. Understand the codebase before making changes

## What You Can Do

${capabilityList || "- Perform your assigned task"}

## Process

1. Read your task from \`.agent-task.md\`
2. Gather context from previous agent outputs in \`artifacts/\`
3. Perform your work
4. Write your outputs to the expected locations:
${artifactList || "   - `artifacts/output.md`"}
5. Write \`.agent-result.json\` to signal completion

## Rules

- Stay within your assigned scope — do not perform tasks belonging to other agents
- Write clear, concise artifacts that downstream agents can consume
- If blocked, set status to \`blocked\` in \`.agent-result.json\` with a clear reason
- If work from a previous agent needs fixing, set status to \`needs_rework\`

## Output Format

When finished, write \`.agent-result.json\`:

\`\`\`json
{
  "status": "complete | needs_rework | blocked | failed",
  "summary": "brief description of what you did",
  "artifacts_created": ["list of files you created"],
  "artifacts_modified": ["list of files you modified"],
  "issues": ["any problems or concerns"],
  "rework_reason": "if needs_rework, explain why",
  "rework_target": "if needs_rework, which agent should fix it (e.g. \\"developer\\")",
  "metadata": {}
}
\`\`\`
`;
}

function buildAgentYaml(answers: {
  type: string;
  name: string;
  role: AgentRole;
  description: string;
  capabilities: string[];
  output_artifacts: string[];
  required_inputs: string[];
  container_image: string;
  stack?: string;
}): string {
  const header = [
    "# SprintFoundry — Custom Agent Definition",
    "# Generated by: sprintfoundry agent create",
    `#`,
    `# Model & runtime inheritance:`,
    `#   This agent inherits from role '${answers.role}'.`,
    `#   Default model: ${ROLE_META[answers.role].model} (${ROLE_META[answers.role].runtime})`,
    `#`,
    `#   To override per-agent, add to your project.yaml:`,
    `#     model_overrides:`,
    `#       ${answers.type}:`,
    `#         provider: anthropic`,
    `#         model: claude-haiku-4-5-20251001`,
    `#     runtime_overrides:`,
    `#       ${answers.type}:`,
    `#         provider: claude-code`,
    `#         mode: local_process`,
    `#         model_reasoning_effort: low`,
    "",
  ].join("\n");

  const config: Record<string, unknown> = {
    type: answers.type,
    name: answers.name,
    role: answers.role,
    description: answers.description,
    container_image: answers.container_image,
    capabilities: answers.capabilities,
    output_artifacts: answers.output_artifacts,
    required_inputs: answers.required_inputs,
  };

  if (answers.stack) {
    config.stack = answers.stack;
  }

  const body = yamlStringify(config, {
    lineWidth: 120,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });

  return header + body;
}

function printNextSteps(
  type: string,
  role: AgentRole,
  agentYamlPath: string,
  claudeMdPath: string
): void {
  const meta = ROLE_META[role];
  console.log(`\n  Files written:\n`);
  console.log(`    ${agentYamlPath}`);
  console.log(`    ${claudeMdPath}`);

  console.log(`\n  Model & runtime (inherited from role '${role}'):`);
  console.log(`    Model:   ${meta.model}`);
  console.log(`    Runtime: ${meta.runtime} (claude-code)`);
  console.log(`\n  To override, add to your project.yaml:`);
  console.log(`    model_overrides:`);
  console.log(`      ${type}:`);
  console.log(`        provider: anthropic`);
  console.log(`        model: claude-haiku-4-5-20251001`);

  console.log(`\n  Next steps:\n`);
  console.log(`  1. Edit your CLAUDE.md to refine agent behavior:`);
  console.log(`       ${claudeMdPath}\n`);
  console.log(`  2. Add the agent to your project (config/<project>.yaml):`);
  console.log(`       agents:`);
  console.log(`         - ${type}\n`);
  console.log(`  3. Run it directly (bypassing SDLC):`);
  console.log(`       sprintfoundry run --source prompt --prompt "..." --agent ${type}\n`);
  console.log(`  4. Or let the orchestrator include it automatically:`);
  console.log(`       sprintfoundry run --source linear --ticket LIN-42\n`);
}

export async function runAgentCreate(configDir: string): Promise<void> {
  console.log("\n  Welcome to SprintFoundry agent setup.\n");

  // Phase 1 — Identity
  console.log("  Agent Identity\n");

  const type = await input({
    message: "Agent ID (kebab-case):",
    validate: (val) =>
      /^[a-z0-9][a-z0-9-]*$/.test(val) ||
      "Must be kebab-case (lowercase letters, numbers, hyphens)",
  });

  const name = await input({
    message: "Agent name:",
    default: deriveAgentName(type),
  });

  // Phase 2 — Role
  console.log("\n  Role & Inheritance\n");
  console.log(
    "  The role determines which model and runtime config this agent inherits by default.\n"
  );

  const role = (await select({
    message: "Closest matching role:",
    choices: [
      {
        name: "developer  — inherits developer model & runtime (writes code)",
        value: "developer",
      },
      {
        name: "qa         — inherits QA model & runtime (tests, validation)",
        value: "qa",
      },
      {
        name: "product    — inherits product model & runtime (specs, analysis)",
        value: "product",
      },
      {
        name: "architect  — inherits architect model & runtime (design, ADRs)",
        value: "architect",
      },
      {
        name: "security   — inherits security model & runtime (scanning, audit)",
        value: "security",
      },
      {
        name: "ui-ux      — inherits UI/UX model & runtime (design, wireframes)",
        value: "ui-ux",
      },
      {
        name: "devops     — inherits devops model & runtime (CI/CD, infra)",
        value: "devops",
      },
      {
        name: "code-review — inherits code-review model & runtime (review, critique)",
        value: "code-review",
      },
    ],
  })) as AgentRole;

  // Phase 3 — Behavior
  console.log("\n  Behavior\n");

  const description = await input({
    message: "Description (shown to orchestrator for planning):",
    validate: (val) => val.length > 0 || "Description is required",
  });

  const capabilitiesRaw = await input({
    message: "Capabilities (comma-separated, e.g. 'Summarize tickets, Extract action items'):",
  });
  const capabilities = capabilitiesRaw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  const defaultArtifacts = ROLE_META[role].defaultArtifacts.join(", ");
  const outputArtifactsRaw = await input({
    message: "Output artifacts (comma-separated file paths):",
    default: defaultArtifacts,
  });
  const output_artifacts = outputArtifactsRaw
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  const required_inputs = await checkbox({
    message: "Required inputs:",
    choices: [
      { name: "ticket_details", value: "ticket_details", checked: true },
      { name: "source_files", value: "source_files", checked: false },
      { name: "previous_step_output", value: "previous_step_output", checked: false },
      { name: "architecture_docs", value: "architecture_docs", checked: false },
    ],
  });

  // Phase 4 — Container Image
  console.log("\n  Container Image\n");

  const defaultImage = ROLE_META[role].image;
  const imageChoice = await select({
    message: "Container image:",
    choices: [
      {
        name: `Reuse role image (${defaultImage})`,
        value: "__role_default__",
      },
      {
        name: "Custom image path",
        value: "__custom__",
      },
    ],
  });

  let container_image = defaultImage;
  if (imageChoice === "__custom__") {
    container_image = await input({
      message: "Container image (e.g. myregistry/my-agent:latest):",
      validate: (val) => val.length > 0 || "Image path is required",
    });
  }

  // Phase 5 — Stack (optional)
  const wantStack = await confirm({
    message: "Is this agent stack-specific (e.g. only for Go or Python projects)?",
    default: false,
  });

  let stack: string | undefined;
  if (wantStack) {
    stack = await select({
      message: "Stack:",
      choices: [
        { name: "JavaScript / TypeScript", value: "js" },
        { name: "Go", value: "go" },
        { name: "Python", value: "python" },
        { name: "Rust", value: "rust" },
      ],
    });
  }

  // Build outputs
  const agentYaml = buildAgentYaml({
    type,
    name,
    role,
    description,
    capabilities,
    output_artifacts,
    required_inputs,
    container_image,
    stack,
  });

  const claudeMd = buildClaudeMd({
    type,
    name,
    role,
    description,
    capabilities,
    output_artifacts,
    required_inputs,
  });

  console.log("\n--- Generated agent config ---\n");
  console.log(agentYaml);
  console.log("------------------------------\n");

  const agentYamlPath = path.join(configDir, "agents", `${type}.yaml`);
  const claudeMdPath = path.join("src", "agents", type, "CLAUDE.md");

  const ok = await confirm({ message: `Save both files?`, default: true });
  if (!ok) {
    console.log("\n  Aborted. No files written.\n");
    return;
  }

  await fs.mkdir(path.dirname(agentYamlPath), { recursive: true });
  await fs.writeFile(agentYamlPath, agentYaml, "utf-8");

  await fs.mkdir(path.dirname(claudeMdPath), { recursive: true });
  await fs.writeFile(claudeMdPath, claudeMd, "utf-8");

  printNextSteps(type, role, agentYamlPath, claudeMdPath);
}
