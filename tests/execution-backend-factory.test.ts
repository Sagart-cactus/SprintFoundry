import { describe, expect, it } from "vitest";
import {
  createExecutionBackend,
  DockerExecutionBackend,
  KubernetesPodExecutionBackend,
  LocalExecutionBackend,
  resolveExecutionBackendName,
} from "../src/service/execution/index.js";
import { makePlatformConfig, makeProjectConfig } from "./fixtures/configs.js";

describe("execution backend factory", () => {
  it("defaults to local when no backend is configured", () => {
    const platform = makePlatformConfig();
    const project = makeProjectConfig();

    expect(resolveExecutionBackendName(platform, project, {} as NodeJS.ProcessEnv)).toBe("local");
    expect(createExecutionBackend(platform, project, {} as NodeJS.ProcessEnv)).toBeInstanceOf(LocalExecutionBackend);
  });

  it("prefers project override over env and platform config", () => {
    const platform = makePlatformConfig({ execution_backend: "local" });
    const project = makeProjectConfig({ execution_backend_override: "docker" });
    const env = { SPRINTFOUNDRY_EXECUTION_BACKEND: "k8s-pod" } as NodeJS.ProcessEnv;

    expect(resolveExecutionBackendName(platform, project, env)).toBe("docker");
  });

  it("prefers environment override over platform config", () => {
    const platform = makePlatformConfig({ execution_backend: "local" });
    const project = makeProjectConfig();
    const env = { SPRINTFOUNDRY_EXECUTION_BACKEND: "k8s-pod" } as NodeJS.ProcessEnv;

    expect(resolveExecutionBackendName(platform, project, env)).toBe("k8s-pod");
  });

  it("does not couple dispatch k8s mode to execution backend selection", () => {
    const platform = makePlatformConfig();
    const project = makeProjectConfig();
    const env = { SPRINTFOUNDRY_K8S_MODE: "true" } as NodeJS.ProcessEnv;

    expect(resolveExecutionBackendName(platform, project, env)).toBe("local");
  });

  it("constructs the docker backend when configured", () => {
    const platform = makePlatformConfig();
    const project = makeProjectConfig({ execution_backend_override: "docker" });

    expect(createExecutionBackend(platform, project, {} as NodeJS.ProcessEnv)).toBeInstanceOf(
      DockerExecutionBackend
    );
  });

  it("constructs the k8s pod backend when configured", () => {
    const platform = makePlatformConfig();
    const project = makeProjectConfig({ execution_backend_override: "k8s-pod" });

    expect(createExecutionBackend(platform, project, {} as NodeJS.ProcessEnv)).toBeInstanceOf(
      KubernetesPodExecutionBackend
    );
  });
});
