import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { PlatformConfig, ProjectConfig, RuntimeConfig } from "../shared/types.js";
import { resolveExecutionBackendName } from "./execution/index.js";
import { validateAgentSandboxWholeRunHosting } from "./agent-sandbox-platform.js";
import { describeProjectK8sContract } from "./k8s-project-contract.js";

export type PreflightSeverity = "pass" | "warn" | "fail";
export type PreflightProfile = "local" | "distributed" | "k8s";

export interface PreflightCheck {
  severity: PreflightSeverity;
  label: string;
  detail: string;
  fixHint?: string;
}

export interface PreflightResult {
  profile: PreflightProfile;
  checks: PreflightCheck[];
}

const exec = promisify(execFile);

async function run(cmd: string, args: string[], timeout = 5000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      timeout,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: any) {
    return {
      ok: false,
      stdout: String(error?.stdout ?? "").trim(),
      stderr: String(error?.stderr ?? error?.message ?? "").trim(),
    };
  }
}

function isTruthy(value: string | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isHostedWholeRunSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    String(env.SPRINTFOUNDRY_HOSTING_MODE ?? "").trim() === "k8s-agent-sandbox" &&
    String(env.SPRINTFOUNDRY_RUN_SANDBOX_MODE ?? "").trim() === "k8s-whole-run"
  );
}

export function resolvePreflightProfile(
  platform: PlatformConfig,
  project: ProjectConfig,
  env: NodeJS.ProcessEnv = process.env
): PreflightProfile {
  if (
    isTruthy(env.SPRINTFOUNDRY_K8S_MODE) ||
    platform.k8s?.agent_sandbox?.whole_run_hosting_enabled === true ||
    env.SPRINTFOUNDRY_RUN_SANDBOX_MODE === "k8s-whole-run"
  ) {
    return "k8s";
  }

  if (
    isTruthy(env.SPRINTFOUNDRY_DISTRIBUTED_MODE) ||
    env.SPRINTFOUNDRY_DATABASE_URL ||
    env.SPRINTFOUNDRY_REDIS_URL
  ) {
    return "distributed";
  }

  return "local";
}

function collectRuntimeRequirements(
  platform: PlatformConfig,
  project: ProjectConfig,
  options?: { includePlanner?: boolean; agentIds?: string[] }
) {
  const executionBackendName = resolveExecutionBackendName(platform, project);
  const byAgent = platform.defaults.runtime_per_agent ?? {};
  const fallbackRuntime: RuntimeConfig = { provider: "claude-code", mode: "local_process" };
  const agentRoleById = new Map(platform.agent_definitions.map((a) => [a.type, a.role] as const));

  const resolveRuntime = (agentId: string): RuntimeConfig =>
    project.runtime_overrides?.[agentId] ??
    byAgent[agentId] ??
    byAgent[agentRoleById.get(agentId) ?? ""] ??
    fallbackRuntime;

  const configuredAgents =
    options?.agentIds && options.agentIds.length > 0
      ? options.agentIds
      : project.agents && project.agents.length > 0
        ? project.agents
        : platform.agent_definitions.map((a) => a.type);

  let needsClaudeCli = false;
  let needsCodexCli = false;
  let needsAnthropicKey = false;
  let needsOpenaiKey = false;
  let needsDocker = executionBackendName === "docker";

  const applyRuntimeNeeds = (runtime: RuntimeConfig) => {
    if (runtime.provider === "claude-code") {
      if (runtime.mode === "local_process") needsClaudeCli = true;
      if (runtime.mode === "local_sdk") needsAnthropicKey = true;
    } else if (runtime.provider === "codex") {
      if (runtime.mode === "local_process") needsCodexCli = true;
      if (runtime.mode === "local_sdk") needsOpenaiKey = true;
    }
  };

  for (const agentId of configuredAgents) {
    applyRuntimeNeeds(resolveRuntime(agentId));
  }

  if (options?.includePlanner !== false) {
    applyRuntimeNeeds(
      project.planner_runtime_override ??
        platform.defaults.planner_runtime ?? {
          provider: "claude-code",
          mode: "local_process",
        }
    );
  }

  return {
    executionBackendName,
    needsClaudeCli,
    needsCodexCli,
    needsAnthropicKey,
    needsOpenaiKey,
    needsDocker,
  };
}

function add(
  checks: PreflightCheck[],
  severity: PreflightSeverity,
  label: string,
  detail: string,
  fixHint?: string
): void {
  checks.push({ severity, label, detail, ...(fixHint ? { fixHint } : {}) });
}

export async function runPreflight(
  platform: PlatformConfig,
  project: ProjectConfig,
  options?: { profile?: PreflightProfile; includePlanner?: boolean; agentIds?: string[] }
): Promise<PreflightResult> {
  const profile = options?.profile ?? resolvePreflightProfile(platform, project);
  const checks: PreflightCheck[] = [];

  const nodeMajor = Number.parseInt(process.version.slice(1).split(".")[0] ?? "0", 10);
  add(
    checks,
    nodeMajor >= 20 ? "pass" : "fail",
    "Node.js",
    `${process.version} (required: >=20)`,
    "Install Node.js 20 or newer."
  );

  const git = await run("git", ["--version"]);
  add(
    checks,
    git.ok ? "pass" : "fail",
    "Git",
    git.ok ? git.stdout : "not found in PATH",
    "Install Git and ensure it is available in PATH."
  );

  const runsRoot = path.join(process.env.SPRINTFOUNDRY_RUNS_ROOT || os.tmpdir(), "sprintfoundry-preflight-write-test");
  try {
    await fs.mkdir(runsRoot, { recursive: true });
    await fs.writeFile(path.join(runsRoot, ".preflight"), "ok", "utf-8");
    add(checks, "pass", "Runs root writable", runsRoot);
  } catch (error) {
    add(
      checks,
      "fail",
      "Runs root writable",
      error instanceof Error ? error.message : String(error),
      "Set SPRINTFOUNDRY_RUNS_ROOT to a writable directory."
    );
  }

  const repoCheck = await run("git", ["ls-remote", "--heads", project.repo.url, project.repo.default_branch], 10000);
  add(
    checks,
    repoCheck.ok ? "pass" : "warn",
    "Repo access",
    repoCheck.ok ? `${project.repo.url} (${project.repo.default_branch})` : `unable to reach ${project.repo.url}`,
    "Verify repo.url auth (token or SSH key) and that the default branch exists."
  );

  const requirements = collectRuntimeRequirements(platform, project, options);
  const anthropicKey = process.env.SPRINTFOUNDRY_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || project.api_keys.anthropic;
  const openaiKey = process.env.SPRINTFOUNDRY_OPENAI_KEY || process.env.OPENAI_API_KEY || project.api_keys.openai;

  if (requirements.needsClaudeCli) {
    const claude = await run("claude", ["--version"]);
    add(
      checks,
      claude.ok ? "pass" : "fail",
      "Claude CLI",
      claude.ok ? claude.stdout : "required by runtime but not found in PATH",
      "Install Claude Code CLI and ensure `claude --version` works."
    );
  }

  if (requirements.needsCodexCli) {
    const codex = await run("codex", ["--version"]);
    add(
      checks,
      codex.ok ? "pass" : "fail",
      "Codex CLI",
      codex.ok ? codex.stdout : "required by runtime but not found in PATH",
      "Install Codex CLI and ensure `codex --version` works."
    );
  }

  if (requirements.needsAnthropicKey) {
    add(
      checks,
      anthropicKey ? "pass" : "fail",
      "Anthropic key",
      anthropicKey ? "configured" : "missing but required for claude-code runtime",
      "Set SPRINTFOUNDRY_ANTHROPIC_KEY or ANTHROPIC_API_KEY."
    );
  }

  if (requirements.needsOpenaiKey) {
    add(
      checks,
      openaiKey ? "pass" : "fail",
      "OpenAI key",
      openaiKey ? "configured" : "missing but required for codex runtime",
      "Set SPRINTFOUNDRY_OPENAI_KEY or OPENAI_API_KEY."
    );
  }

  if (requirements.needsDocker || profile === "local") {
    const docker = await run("docker", ["--version"]);
    add(
      checks,
      requirements.needsDocker ? (docker.ok ? "pass" : "fail") : (docker.ok ? "pass" : "warn"),
      "Docker",
      docker.ok ? docker.stdout : requirements.needsDocker ? "required by docker execution backend but not installed" : "not installed (optional)",
      "Install Docker Desktop or Docker Engine if you use docker execution or local distributed infra."
    );
  }

  if (profile === "distributed") {
    const dbUrl = String(process.env.SPRINTFOUNDRY_DATABASE_URL ?? "").trim();
    const redisUrl = String(process.env.SPRINTFOUNDRY_REDIS_URL ?? "").trim();
    const sinkUrl = String(
      process.env.SPRINTFOUNDRY_EVENT_SINK_URL ?? project.integrations?.event_sink?.url ?? ""
    ).trim();
    add(
      checks,
      dbUrl ? "pass" : "fail",
      "Database URL",
      dbUrl || "SPRINTFOUNDRY_DATABASE_URL is not set",
      "Set SPRINTFOUNDRY_DATABASE_URL for distributed mode."
    );
    add(
      checks,
      redisUrl ? "pass" : "fail",
      "Redis URL",
      redisUrl || "SPRINTFOUNDRY_REDIS_URL is not set",
      "Set SPRINTFOUNDRY_REDIS_URL for distributed mode."
    );
    add(
      checks,
      sinkUrl ? "pass" : "fail",
      "Event sink URL",
      sinkUrl || "SPRINTFOUNDRY_EVENT_SINK_URL is not set",
      "Set SPRINTFOUNDRY_EVENT_SINK_URL or integrations.event_sink.url for distributed mode."
    );
    if (sinkUrl) {
      try {
        const response = await fetch(sinkUrl.replace(/\/events\/?$/, "/health"));
        add(
          checks,
          response.ok ? "pass" : "warn",
          "Event API health",
          response.ok ? "reachable" : `HTTP ${response.status}`,
          "Start the Event API or verify the event sink URL."
        );
      } catch (error) {
        add(
          checks,
          "warn",
          "Event API health",
          error instanceof Error ? error.message : String(error),
          "Start the Event API or verify network connectivity."
        );
      }
    }
  }

  if (profile === "k8s") {
    if (isHostedWholeRunSandbox()) {
      add(checks, "pass", "Kubernetes host checks", "skipped inside hosted whole-run sandbox");
      return { profile, checks };
    }

    const kubectl = await run("kubectl", ["version", "--client", "--output=yaml"]);
    add(
      checks,
      kubectl.ok ? "pass" : "fail",
      "kubectl",
      kubectl.ok ? "installed" : "not found in PATH",
      "Install kubectl and configure cluster access."
    );

    const context = await run("kubectl", ["config", "current-context"]);
    add(
      checks,
      context.ok && context.stdout ? "pass" : "fail",
      "Kube context",
      context.ok && context.stdout ? context.stdout : "no current context",
      "Run `kubectl config use-context <context>` before using k8s mode."
    );

    try {
      await validateAgentSandboxWholeRunHosting(platform);
      add(checks, "pass", "Agent Sandbox CRDs", "required CRDs are installed");
    } catch (error) {
      add(
        checks,
        "fail",
        "Agent Sandbox CRDs",
        error instanceof Error ? error.message : String(error),
        "Install the Agent Sandbox controller/CRDs in the cluster before whole-run hosting."
      );
    }

    const { namespace, secretName, configMapName } = describeProjectK8sContract(project);

    const namespaceCheck = await run("kubectl", ["get", "namespace", namespace, "-o", "name"]);
    add(
      checks,
      namespaceCheck.ok ? "pass" : "fail",
      "Project namespace",
      namespaceCheck.ok ? namespace : `missing namespace ${namespace}`,
      `Create the namespace ${namespace} before dispatching runs.`
    );

    const secretCheck = await run("kubectl", ["-n", namespace, "get", "secret", secretName, "-o", "name"]);
    add(
      checks,
      secretCheck.ok ? "pass" : "fail",
      "Project secret",
      secretCheck.ok ? secretName : `missing secret ${secretName}`,
      "Create the project runtime Secret or configure an ExternalSecret."
    );

    const configMapCheck = await run("kubectl", ["-n", namespace, "get", "configmap", configMapName, "-o", "name"]);
    add(
      checks,
      configMapCheck.ok ? "pass" : "fail",
      "Project configmap",
      configMapCheck.ok ? configMapName : `missing configmap ${configMapName}`,
      "Create the project config ConfigMap before dispatching runs."
    );

    const canCreateClaims = await run("kubectl", ["auth", "can-i", "create", "sandboxclaims.extensions.agents.x-k8s.io", "-n", namespace]);
    add(
      checks,
      canCreateClaims.ok && /yes/i.test(canCreateClaims.stdout) ? "pass" : "warn",
      "RBAC: sandboxclaims",
      canCreateClaims.stdout || canCreateClaims.stderr || "permission unknown",
      "Grant the dispatch identity permission to create SandboxClaims in the project namespace."
    );
  }

  return { profile, checks };
}

export function hasFailingChecks(result: PreflightResult): boolean {
  return result.checks.some((check) => check.severity === "fail");
}

export function summarizePreflight(result: PreflightResult): string[] {
  const lines = [`SprintFoundry ${result.profile} checks`];
  for (const check of result.checks) {
    const icon = check.severity === "pass" ? "[OK]" : check.severity === "warn" ? "[WARN]" : "[FAIL]";
    lines.push(`  ${icon} ${check.label.padEnd(20)} ${check.detail}`);
    if (check.fixHint) {
      lines.push(`         Fix: ${check.fixHint}`);
    }
  }
  return lines;
}
