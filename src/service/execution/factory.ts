import type { ExecutionBackendName, PlatformConfig, ProjectConfig } from "../../shared/types.js";
import type { ExecutionBackend } from "./backend.js";
import { DockerExecutionBackend } from "./docker-backend.js";
import { KubernetesPodExecutionBackend } from "./k8s-pod-backend.js";
import { LocalExecutionBackend } from "./local-backend.js";

const EXECUTION_BACKEND_ENV = "SPRINTFOUNDRY_EXECUTION_BACKEND";

export function resolveExecutionBackendName(
  platformConfig: PlatformConfig,
  projectConfig: ProjectConfig,
  env: NodeJS.ProcessEnv = process.env
): ExecutionBackendName {
  if (projectConfig.execution_backend_override) {
    return projectConfig.execution_backend_override;
  }

  const envOverride = normalizeExecutionBackendName(env[EXECUTION_BACKEND_ENV]);
  if (envOverride) {
    return envOverride;
  }

  if (platformConfig.execution_backend) {
    return platformConfig.execution_backend;
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
    case "k8s-pod":
      return new KubernetesPodExecutionBackend(platformConfig, projectConfig);
    case "agent-sandbox":
      throw new Error("Execution backend 'agent-sandbox' is configured but not implemented yet. Complete issue #015 first.");
  }
}

function normalizeExecutionBackendName(value: string | undefined): ExecutionBackendName | null {
  const normalized = String(value ?? "").trim();
  if (
    normalized === "local" ||
    normalized === "docker" ||
    normalized === "k8s-pod" ||
    normalized === "agent-sandbox"
  ) {
    return normalized;
  }
  return null;
}
