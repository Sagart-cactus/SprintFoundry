import { describe, expect, it } from "vitest";
import {
  defaultProjectConfigMapName,
  defaultProjectNamespace,
  defaultProjectRuntimeSecretName,
  defaultProjectSecretName,
  describeProjectK8sContract,
} from "../src/service/k8s-project-contract.js";

describe("k8s project contract", () => {
  it("uses project id as the default namespace", () => {
    expect(defaultProjectNamespace("demo-project")).toBe("demo-project");
  });

  it("derives default secret and configmap names from the project id", () => {
    expect(defaultProjectSecretName("demo-project")).toBe("sprintfoundry-project-demo-project-secrets");
    expect(defaultProjectConfigMapName("demo-project")).toBe("sprintfoundry-project-demo-project-config");
    expect(defaultProjectRuntimeSecretName("demo-project")).toBe("sprintfoundry-project-demo-project-runtime-secrets");
  });

  it("honors environment overrides", () => {
    const contract = describeProjectK8sContract("demo-project", {
      SPRINTFOUNDRY_K8S_NAMESPACE: "custom-ns",
      SPRINTFOUNDRY_K8S_PROJECT_SECRET_NAME: "custom-secret",
      SPRINTFOUNDRY_K8S_PROJECT_CONFIGMAP_NAME: "custom-config",
    } as NodeJS.ProcessEnv);

    expect(contract).toEqual({
      namespace: "custom-ns",
      secretName: "custom-secret",
      configMapName: "custom-config",
      runtimeSecretName: "sprintfoundry-project-demo-project-runtime-secrets",
    });
  });
});
