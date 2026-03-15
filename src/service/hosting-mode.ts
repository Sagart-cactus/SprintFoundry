import type { ExecutionBackendName, HostingMode } from "../shared/types.js";

export const RUN_SANDBOX_MODE_ENV = "SPRINTFOUNDRY_RUN_SANDBOX_MODE";
export const HOSTING_MODE_ENV = "SPRINTFOUNDRY_HOSTING_MODE";
export const WHOLE_RUN_SANDBOX_MODE = "k8s-whole-run";

export function normalizeHostingMode(value: unknown): HostingMode | null {
  const normalized = String(value ?? "").trim();
  if (
    normalized === "local" ||
    normalized === "docker" ||
    normalized === "k8s-job-whole-run" ||
    normalized === "k8s-agent-sandbox"
  ) {
    return normalized;
  }
  return null;
}

export function resolveHostingMode(options: {
  explicitHostingMode?: unknown;
  executionBackend?: ExecutionBackendName | string | null | undefined;
  env?: NodeJS.ProcessEnv;
} = {}): HostingMode {
  const explicit = normalizeHostingMode(options.explicitHostingMode);
  if (explicit) return explicit;

  const env = options.env ?? process.env;
  const envHostingMode = normalizeHostingMode(env[HOSTING_MODE_ENV]);
  if (envHostingMode) return envHostingMode;
  if (String(env[RUN_SANDBOX_MODE_ENV] ?? "").trim() === WHOLE_RUN_SANDBOX_MODE) {
    return "k8s-job-whole-run";
  }

  const backend = String(options.executionBackend ?? "").trim();
  if (backend === "agent-sandbox") return "k8s-agent-sandbox";
  if (backend === "docker") return "docker";
  return "local";
}
