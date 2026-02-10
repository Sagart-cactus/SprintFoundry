import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { loadYaml, loadConfig } from "../src/service/config-loader.js";

describe("Config Loading", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-test-"));
  });

  // --- loadYaml ---

  it("loadYaml parses valid YAML", async () => {
    const yamlContent = `
name: test
version: 1
nested:
  key: value
list:
  - a
  - b
`;
    const filePath = path.join(tmpDir, "test.yaml");
    await fs.writeFile(filePath, yamlContent, "utf-8");

    const result = await loadYaml<any>(filePath);

    expect(result.name).toBe("test");
    expect(result.version).toBe(1);
    expect(result.nested.key).toBe("value");
    expect(result.list).toEqual(["a", "b"]);
  });

  it("loadYaml interpolates ${ENV_VAR} from process.env", async () => {
    process.env.TEST_CONFIG_VAR = "my-secret-key";

    const yamlContent = `
api_key: \${TEST_CONFIG_VAR}
other: static
`;
    const filePath = path.join(tmpDir, "env.yaml");
    await fs.writeFile(filePath, yamlContent, "utf-8");

    const result = await loadYaml<any>(filePath);

    expect(result.api_key).toBe("my-secret-key");
    expect(result.other).toBe("static");

    delete process.env.TEST_CONFIG_VAR;
  });

  it("loadYaml replaces missing env vars with empty string", async () => {
    delete process.env.NONEXISTENT_VAR_FOR_TEST;

    // Use a template where the env var is part of a larger string so YAML
    // doesn't parse the standalone empty string as null.
    const yamlContent = `
api_key: "prefix-\${NONEXISTENT_VAR_FOR_TEST}-suffix"
`;
    const filePath = path.join(tmpDir, "missing.yaml");
    await fs.writeFile(filePath, yamlContent, "utf-8");

    const result = await loadYaml<any>(filePath);

    // The ${NONEXISTENT_VAR_FOR_TEST} is replaced with empty string
    expect(result.api_key).toBe("prefix--suffix");
  });

  // --- loadConfig ---

  it("loadConfig loads platform.yaml + project.yaml", async () => {
    const platformYaml = `
defaults:
  model_per_agent:
    developer:
      provider: anthropic
      model: claude-sonnet-4-5-20250929
  budgets:
    per_agent_tokens: 500000
    per_task_total_tokens: 3000000
    per_task_max_cost_usd: 25
  timeouts:
    agent_timeout_minutes: 30
    task_timeout_minutes: 180
    human_gate_timeout_hours: 48
  max_rework_cycles: 3
rules: []
agent_definitions: []
`;

    const projectYaml = `
project_id: test-project
name: Test Project
repo:
  url: https://github.com/test/repo.git
  default_branch: main
api_keys:
  anthropic: sk-test
rules: []
integrations:
  ticket_source:
    type: github
    config:
      token: ghp_test
branch_strategy:
  prefix: "feat/"
  include_ticket_id: true
  naming: kebab-case
`;

    await fs.writeFile(path.join(tmpDir, "platform.yaml"), platformYaml, "utf-8");
    await fs.writeFile(path.join(tmpDir, "project.yaml"), projectYaml, "utf-8");

    const { platform, project } = await loadConfig(tmpDir);

    expect(platform.defaults.max_rework_cycles).toBe(3);
    expect(project.project_id).toBe("test-project");
    expect(project.name).toBe("Test Project");
  });

  it("loadConfig with --project tries name.yaml then project-name.yaml", async () => {
    const platformYaml = `
defaults:
  model_per_agent: {}
  budgets:
    per_agent_tokens: 100
    per_task_total_tokens: 100
    per_task_max_cost_usd: 1
  timeouts:
    agent_timeout_minutes: 1
    task_timeout_minutes: 1
    human_gate_timeout_hours: 1
  max_rework_cycles: 1
rules: []
agent_definitions: []
`;

    const projectYaml = `
project_id: myapp
name: My App
repo:
  url: https://github.com/test/myapp.git
  default_branch: main
api_keys: {}
rules: []
integrations:
  ticket_source:
    type: github
    config: {}
branch_strategy:
  prefix: "feat/"
  include_ticket_id: false
  naming: kebab-case
`;

    await fs.writeFile(path.join(tmpDir, "platform.yaml"), platformYaml, "utf-8");
    // Write as project-myapp.yaml (second candidate)
    await fs.writeFile(path.join(tmpDir, "project-myapp.yaml"), projectYaml, "utf-8");

    const { project } = await loadConfig(tmpDir, "myapp");

    expect(project.project_id).toBe("myapp");
    expect(project.name).toBe("My App");
  });

  it("loadConfig throws when project config not found", async () => {
    const platformYaml = `
defaults:
  model_per_agent: {}
  budgets:
    per_agent_tokens: 100
    per_task_total_tokens: 100
    per_task_max_cost_usd: 1
  timeouts:
    agent_timeout_minutes: 1
    task_timeout_minutes: 1
    human_gate_timeout_hours: 1
  max_rework_cycles: 1
rules: []
agent_definitions: []
`;
    await fs.writeFile(path.join(tmpDir, "platform.yaml"), platformYaml, "utf-8");

    await expect(loadConfig(tmpDir, "nonexistent")).rejects.toThrow(
      /Could not find project config/
    );
  });

  it("loadConfig throws when no project.yaml exists (no --project)", async () => {
    const platformYaml = `
defaults:
  model_per_agent: {}
  budgets:
    per_agent_tokens: 100
    per_task_total_tokens: 100
    per_task_max_cost_usd: 1
  timeouts:
    agent_timeout_minutes: 1
    task_timeout_minutes: 1
    human_gate_timeout_hours: 1
  max_rework_cycles: 1
rules: []
agent_definitions: []
`;
    await fs.writeFile(path.join(tmpDir, "platform.yaml"), platformYaml, "utf-8");

    await expect(loadConfig(tmpDir)).rejects.toThrow(/project\.yaml not found/);
  });
});
