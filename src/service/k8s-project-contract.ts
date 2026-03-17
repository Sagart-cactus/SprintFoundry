import type { ProjectConfig } from "../shared/types.js";

export const K8S_NAMESPACE_ENV = "SPRINTFOUNDRY_K8S_NAMESPACE";
export const K8S_PROJECT_SECRET_ENV = "SPRINTFOUNDRY_K8S_PROJECT_SECRET_NAME";
export const K8S_PROJECT_CONFIGMAP_ENV = "SPRINTFOUNDRY_K8S_PROJECT_CONFIGMAP_NAME";

function readOverride(value: string | undefined): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : undefined;
}

export function defaultProjectNamespace(projectId: string): string {
  return String(projectId ?? "").trim();
}

export function defaultProjectSecretName(projectId: string): string {
  return `sprintfoundry-project-${String(projectId ?? "").trim()}-secrets`;
}

export function defaultProjectConfigMapName(projectId: string): string {
  return `sprintfoundry-project-${String(projectId ?? "").trim()}-config`;
}

export function resolveProjectNamespace(projectId: string, env: NodeJS.ProcessEnv = process.env): string {
  return readOverride(env[K8S_NAMESPACE_ENV]) ?? defaultProjectNamespace(projectId);
}

export function resolveProjectSecretName(projectId: string, env: NodeJS.ProcessEnv = process.env): string {
  return readOverride(env[K8S_PROJECT_SECRET_ENV]) ?? defaultProjectSecretName(projectId);
}

export function resolveProjectConfigMapName(projectId: string, env: NodeJS.ProcessEnv = process.env): string {
  return readOverride(env[K8S_PROJECT_CONFIGMAP_ENV]) ?? defaultProjectConfigMapName(projectId);
}

export function describeProjectK8sContract(
  projectOrId: Pick<ProjectConfig, "project_id"> | string,
  env: NodeJS.ProcessEnv = process.env
): { namespace: string; secretName: string; configMapName: string } {
  const projectId =
    typeof projectOrId === "string"
      ? projectOrId
      : projectOrId.project_id;
  return {
    namespace: resolveProjectNamespace(projectId, env),
    secretName: resolveProjectSecretName(projectId, env),
    configMapName: resolveProjectConfigMapName(projectId, env),
  };
}
