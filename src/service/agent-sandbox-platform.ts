import { createRequire } from "module";
import type { PlatformConfig } from "../shared/types.js";

const require = createRequire(import.meta.url);

export const AGENT_SANDBOX_WHOLE_RUN_HOSTING_ENV = "SPRINTFOUNDRY_AGENT_SANDBOX_WHOLE_RUN_HOSTING";
export const DEFAULT_AGENT_SANDBOX_API_GROUP = "extensions.agents.x-k8s.io";
export const DEFAULT_AGENT_SANDBOX_CORE_API_GROUP = "agents.x-k8s.io";
export const DEFAULT_AGENT_SANDBOX_API_VERSION = "v1alpha1";
export const DEFAULT_AGENT_SANDBOX_CLAIM_PLURAL = "sandboxclaims";
export const DEFAULT_AGENT_SANDBOX_TEMPLATE_NAME = "default";

interface AgentSandboxCrdValidator {
  readCustomResourceDefinition(name: string): Promise<unknown>;
}

function isTruthy(value: string | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function isAgentSandboxWholeRunHostingEnabled(
  platformConfig: PlatformConfig,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (Object.prototype.hasOwnProperty.call(env, AGENT_SANDBOX_WHOLE_RUN_HOSTING_ENV)) {
    return isTruthy(env[AGENT_SANDBOX_WHOLE_RUN_HOSTING_ENV]);
  }
  return platformConfig.k8s?.agent_sandbox?.whole_run_hosting_enabled === true;
}

export function normalizeAgentSandboxPlatformConfig(platformConfig: PlatformConfig): void {
  platformConfig.k8s = platformConfig.k8s ?? {};
  const current = platformConfig.k8s.agent_sandbox ?? {};
  platformConfig.k8s.agent_sandbox = {
    enabled: current.enabled ?? false,
    whole_run_hosting_enabled: current.whole_run_hosting_enabled ?? false,
    template_name: current.template_name?.trim() || DEFAULT_AGENT_SANDBOX_TEMPLATE_NAME,
    warm_pool_name: current.warm_pool_name ?? "",
    api_group: current.api_group?.trim() || DEFAULT_AGENT_SANDBOX_API_GROUP,
    api_version: current.api_version?.trim() || DEFAULT_AGENT_SANDBOX_API_VERSION,
    claim_plural: current.claim_plural?.trim() || DEFAULT_AGENT_SANDBOX_CLAIM_PLURAL,
  };
}

export async function validateAgentSandboxWholeRunHosting(
  platformConfig: PlatformConfig,
  env: NodeJS.ProcessEnv = process.env,
  client?: AgentSandboxCrdValidator
): Promise<void> {
  normalizeAgentSandboxPlatformConfig(platformConfig);
  if (!isAgentSandboxWholeRunHostingEnabled(platformConfig, env)) {
    return;
  }

  const agentSandbox = platformConfig.k8s?.agent_sandbox;
  if (!agentSandbox?.enabled) {
    throw new Error(
      `SandboxClaim whole-run hosting is enabled, but k8s.agent_sandbox.enabled is false. ` +
      `Enable k8s.agent_sandbox.enabled or unset ${AGENT_SANDBOX_WHOLE_RUN_HOSTING_ENV}.`
    );
  }

  const apiGroup = agentSandbox.api_group ?? DEFAULT_AGENT_SANDBOX_API_GROUP;
  const validator = client ?? createAgentSandboxCrdValidator();
  const requiredCrds = [
    `sandboxclaims.${apiGroup}`,
    `sandboxtemplates.${apiGroup}`,
    `sandboxes.${DEFAULT_AGENT_SANDBOX_CORE_API_GROUP}`,
  ];
  const missingCrds: string[] = [];

  for (const crdName of requiredCrds) {
    try {
      await validator.readCustomResourceDefinition(crdName);
    } catch {
      missingCrds.push(crdName);
    }
  }

  if (missingCrds.length > 0) {
    throw new Error(
      `SandboxClaim whole-run hosting requires Agent Sandbox CRDs, but these were not found: ${missingCrds.join(", ")}. ` +
      `Install the Agent Sandbox controller/CRDs or disable ${AGENT_SANDBOX_WHOLE_RUN_HOSTING_ENV}.`
    );
  }
}

function createAgentSandboxCrdValidator(): AgentSandboxCrdValidator {
  let k8sModule: any;
  try {
    k8sModule = require("@kubernetes/client-node");
  } catch (error) {
    throw new Error(
      `SandboxClaim whole-run hosting validation requires @kubernetes/client-node: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const kc = new k8sModule.KubeConfig();
  kc.loadFromDefault();
  const api = kc.makeApiClient(k8sModule.ApiextensionsV1Api);

  return {
    readCustomResourceDefinition: async (name: string) => {
      await api.readCustomResourceDefinition({ name });
    },
  };
}
