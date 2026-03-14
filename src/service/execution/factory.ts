import type { ExecutionBackendName, PlatformConfig, ProjectConfig } from "../../shared/types.js";
import { AgentSandboxExecutionBackend } from "./agent-sandbox-backend.js";
import type { ExecutionBackend } from "./backend.js";
import { DockerExecutionBackend } from "./docker-backend.js";
import { LocalExecutionBackend } from "./local-backend.js";

const EXECUTION_BACKEND_ENV = "SPRINTFOUNDRY_EXECUTION_BACKEND";
const AGENT_SANDBOX_ENV = "SPRINTFOUNDRY_AGENT_SANDBOX";
const RUN_SANDBOX_MODE_ENV = "SPRINTFOUNDRY_RUN_SANDBOX_MODE";
const WHOLE_RUN_SANDBOX_MODE = "k8s-whole-run";

export function resolveExecutionBackendName(
  platformConfig: PlatformConfig,
  projectConfig: ProjectConfig,
  env: NodeJS.ProcessEnv = process.env
): ExecutionBackendName {
  if (env[RUN_SANDBOX_MODE_ENV] === WHOLE_RUN_SANDBOX_MODE) {
    return "local";
  }

  const projectOverride = projectConfig.execution_backend_override;
  if (projectOverride) {
    return assertSupportedExecutionBackendName(projectOverride, "project execution_backend_override");
  }

  const envOverride = normalizeConfiguredExecutionBackendName(env[EXECUTION_BACKEND_ENV]);
  if (envOverride) {
    return assertSupportedExecutionBackendName(envOverride, `env ${EXECUTION_BACKEND_ENV}`);
  }

  if (platformConfig.execution_backend) {
    return assertSupportedExecutionBackendName(platformConfig.execution_backend, "platform execution_backend");
  }

  return "local";
}

export function createExecutionBackend(
  platformConfig: PlatformConfig,
  projectConfig: ProjectConfig,
  env: NodeJS.ProcessEnv = process.env
): ExecutionBackend {
  const backendName = resolveExecutionBackendName(platformConfig, projectConfig, env);

  switch (backendName) {
    case "local":
      return new LocalExecutionBackend();
    case "docker":
      return new DockerExecutionBackend(platformConfig, projectConfig);
    case "agent-sandbox":
      if (!isTruthy(env[AGENT_SANDBOX_ENV]) && !platformConfig.k8s?.agent_sandbox?.enabled) {
        throw new Error(
          "Execution backend 'agent-sandbox' is disabled. Set SPRINTFOUNDRY_AGENT_SANDBOX=true or enable k8s.agent_sandbox.enabled."
        );
      }
      return new AgentSandboxExecutionBackend(platformConfig, projectConfig);
  }
}

function normalizeConfiguredExecutionBackendName(
  value: string | undefined
): ExecutionBackendName | "k8s-pod" | null {
  const normalized = String(value ?? "").trim();
  if (
    normalized === "local" ||
    normalized === "docker" ||
    normalized === "agent-sandbox"
  ) {
    return normalized;
  }
  if (normalized === "k8s-pod") {
    return normalized;
  }
  return null;
}

function assertSupportedExecutionBackendName(
  value: ExecutionBackendName | "k8s-pod",
  source: string
): ExecutionBackendName {
  if (value === "k8s-pod") {
    throw new Error(
      `${source} uses deprecated execution backend 'k8s-pod'. ` +
      `Use agent-sandbox whole-run hosting with local step execution instead.`
    );
  }
  return value;
}

function isTruthy(value: string | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
