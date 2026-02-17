import { describe, it, expect } from "vitest";
import { PlanValidator } from "../src/service/plan-validator.js";
import { makePlatformConfig, makeProjectConfig, defaultAgentDefinitions, defaultPlatformRules } from "./fixtures/configs.js";
import { makePlan, makeStep } from "./fixtures/plans.js";
import { makeTicket } from "./fixtures/tickets.js";

function createValidator(
  platformOverrides?: Parameters<typeof makePlatformConfig>[0],
  projectOverrides?: Parameters<typeof makeProjectConfig>[0]
) {
  return new PlanValidator(
    makePlatformConfig(platformOverrides),
    makeProjectConfig(projectOverrides)
  );
}

describe("PlanValidator", () => {
  it("passes a valid plan through unchanged", () => {
    // Use only rules that won't inject extra steps for this plan+ticket combo.
    const validator = createValidator({
      rules: [
        {
          id: "always-qa-after-code",
          description: "QA after code",
          condition: { type: "always" },
          action: { type: "require_role", role: "qa" },
          enforced: true,
        },
      ],
    });
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "qa", task: "Test code", depends_on: [1] }),
      ],
    });
    const ticket = makeTicket({ labels: [] });

    const result = validator.validate(plan, ticket);

    // Plan already has dev and qa, and no other rules trigger
    expect(result.steps.length).toBe(2);
    expect(result.steps[0].agent).toBe("developer");
    expect(result.steps[1].agent).toBe("qa");
  });

  it("injects QA role when missing (always-qa-after-code rule)", () => {
    const validator = createValidator();
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
      ],
    });
    const ticket = makeTicket({ labels: [] });

    const result = validator.validate(plan, ticket);

    // QA should be injected because of the "always" rule
    const qaStep = result.steps.find(
      (s) => s.agent === "qa" || s.agent === "go-qa"
    );
    expect(qaStep).toBeDefined();
    expect(qaStep!.task).toContain("[AUTO-INJECTED BY RULE]");
  });

  it("does NOT double-inject QA when already in plan", () => {
    const validator = createValidator();
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "qa", task: "Test code", depends_on: [1] }),
      ],
    });
    const ticket = makeTicket({ labels: [] });

    const result = validator.validate(plan, ticket);

    const qaSteps = result.steps.filter(
      (s) => s.agent === "qa" || s.agent === "go-qa"
    );
    expect(qaSteps.length).toBe(1);
  });

  it("injects security agent on label_contains 'security'", () => {
    const validator = createValidator();
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "qa", task: "Test code", depends_on: [1] }),
      ],
    });
    const ticket = makeTicket({ labels: ["security", "feature"] });

    const result = validator.validate(plan, ticket);

    const securityStep = result.steps.find((s) => s.agent === "security");
    expect(securityStep).toBeDefined();
  });

  it("injects human gate for P0 tickets after QA", () => {
    const validator = createValidator();
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "qa", task: "Test code", depends_on: [1] }),
      ],
    });
    const ticket = makeTicket({ priority: "p0" });

    const result = validator.validate(plan, ticket);

    const gate = result.human_gates.find((g) => g.after_step === 2);
    expect(gate).toBeDefined();
    expect(gate!.required).toBe(true);
  });

  it("throws on broken dependency reference", () => {
    const validator = createValidator();
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "qa", task: "Test code", depends_on: [99] }),
      ],
    });
    const ticket = makeTicket({ labels: [] });

    expect(() => validator.validate(plan, ticket)).toThrow(
      /depends on non-existent step 99/
    );
  });

  it("throws on duplicate step numbers", () => {
    const validator = createValidator();
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 1, agent: "qa", task: "Test code" }),
      ],
    });
    const ticket = makeTicket({ labels: [] });

    expect(() => validator.validate(plan, ticket)).toThrow(
      /duplicate step number 1/
    );
  });

  it("respects project catalog filtering (findAgentByRole)", () => {
    // Project only allows go-developer and go-qa
    const validator = createValidator(undefined, {
      agents: ["go-developer", "go-qa"],
    });
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "go-developer", task: "Write code" }),
      ],
    });
    const ticket = makeTicket({ labels: [] });

    const result = validator.validate(plan, ticket);

    // Should inject go-qa (not js qa) since catalog restricts to go agents
    const qaStep = result.steps.find((s) => s.agent === "go-qa");
    expect(qaStep).toBeDefined();
  });

  it("inserts steps in correct role order", () => {
    const validator = createValidator();
    // Plan has only developer step, missing qa
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
      ],
    });
    const ticket = makeTicket({ labels: [] });

    const result = validator.validate(plan, ticket);

    // QA should be inserted after developer (by role order)
    const devIndex = result.steps.findIndex((s) => s.agent === "developer");
    const qaIndex = result.steps.findIndex(
      (s) => s.agent === "qa" || s.agent === "go-qa"
    );
    expect(qaIndex).toBeGreaterThan(devIndex);
  });

  it("file_path_matches injects security when matching context path", () => {
    const validator = createValidator({
      rules: [
        {
          id: "security-on-files",
          description: "Security on auth files",
          condition: { type: "file_path_matches", pattern: "src/auth/**" },
          action: { type: "require_agent", agent: "security" },
          enforced: true,
        },
      ],
    });
    const plan = makePlan({
      steps: [
        makeStep({
          step_number: 1,
          agent: "developer",
          task: "Write code",
          context_inputs: [{ type: "file", path: "src/auth/session.ts" }],
        }),
        makeStep({ step_number: 2, agent: "qa", task: "Test code", depends_on: [1] }),
      ],
    });
    const ticket = makeTicket({ labels: [] });

    const result = validator.validate(plan, ticket);

    // Security should be injected because file path actually matches
    const securityStep = result.steps.find((s) => s.agent === "security");
    expect(securityStep).toBeDefined();
  });

  it("file_path_matches does NOT inject when no context path matches", () => {
    const validator = createValidator({
      rules: [
        {
          id: "security-on-files",
          description: "Security on auth files",
          condition: { type: "file_path_matches", pattern: "src/auth/**" },
          action: { type: "require_agent", agent: "security" },
          enforced: true,
        },
      ],
    });
    const plan = makePlan({
      steps: [
        makeStep({
          step_number: 1,
          agent: "developer",
          task: "Write code",
          context_inputs: [{ type: "file", path: "src/reports/export.ts" }],
        }),
        makeStep({ step_number: 2, agent: "qa", task: "Test code", depends_on: [1] }),
      ],
    });

    const result = validator.validate(plan, makeTicket({ labels: [] }));
    const securityStep = result.steps.find((s) => s.agent === "security");
    expect(securityStep).toBeUndefined();
  });

  it("classification_is condition matches correctly", () => {
    const validator = createValidator({
      rules: [
        {
          id: "product-on-new-feature",
          description: "Product agent for new features",
          condition: { type: "classification_is", values: ["new_feature"] },
          action: { type: "require_role", role: "product" },
          enforced: true,
        },
      ],
    });
    const plan = makePlan({
      classification: "new_feature",
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
      ],
    });
    const ticket = makeTicket();

    const result = validator.validate(plan, ticket);

    const productStep = result.steps.find((s) => s.agent === "product");
    expect(productStep).toBeDefined();
  });

  // ---- Code Review Agent Tests ----

  it("injects code-review agent for P0 tickets", () => {
    const validator = createValidator();
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "qa", task: "Test code", depends_on: [1] }),
      ],
    });
    const ticket = makeTicket({ priority: "p0" });

    const result = validator.validate(plan, ticket);

    const codeReviewStep = result.steps.find((s) => s.agent === "code-review");
    expect(codeReviewStep).toBeDefined();
    expect(codeReviewStep!.task).toContain("[AUTO-INJECTED BY RULE]");
  });

  it("code-review step has correct role ordering via dependencies", () => {
    const validator = createValidator();
    // Plan without qa so code-review is inserted by P0 rule and qa by always-qa rule
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
      ],
    });
    const ticket = makeTicket({ priority: "p0" });

    const result = validator.validate(plan, ticket);

    // Both code-review and qa should be injected
    const crStep = result.steps.find((s) => s.agent === "code-review");
    const qaStep = result.steps.find((s) => s.agent === "qa" || s.agent === "go-qa");
    expect(crStep).toBeDefined();
    expect(qaStep).toBeDefined();

    // Code-review should depend on the developer step
    expect(crStep!.depends_on).toContain(1);
    // Both should come after developer by step number
    expect(crStep!.step_number).toBeGreaterThan(1);
    expect(qaStep!.step_number).toBeGreaterThan(1);
  });

  it("does not inject code-review for non-P0 when rule is enforced only for P0", () => {
    const validator = createValidator();
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "qa", task: "Test code", depends_on: [1] }),
      ],
    });
    const ticket = makeTicket({ priority: "p2" });

    const result = validator.validate(plan, ticket);

    const codeReviewStep = result.steps.find((s) => s.agent === "code-review");
    expect(codeReviewStep).toBeUndefined();
  });

  it("does not double-inject code-review when already in plan", () => {
    const validator = createValidator();
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "code-review", task: "Review code", depends_on: [1] }),
        makeStep({ step_number: 3, agent: "qa", task: "Test code", depends_on: [2] }),
      ],
    });
    const ticket = makeTicket({ priority: "p0" });

    const result = validator.validate(plan, ticket);

    const codeReviewSteps = result.steps.filter((s) => s.agent === "code-review");
    expect(codeReviewSteps.length).toBe(1);
  });

  it("code-review step depends on developer step", () => {
    const validator = createValidator();
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
      ],
    });
    const ticket = makeTicket({ priority: "p0" });

    const result = validator.validate(plan, ticket);

    const codeReviewStep = result.steps.find((s) => s.agent === "code-review");
    expect(codeReviewStep).toBeDefined();
    expect(codeReviewStep!.depends_on).toContain(1);
  });

  it("classification_is condition does NOT match wrong classification", () => {
    const validator = createValidator({
      rules: [
        {
          id: "product-on-new-feature",
          description: "Product agent for new features",
          condition: { type: "classification_is", values: ["new_feature"] },
          action: { type: "require_role", role: "product" },
          enforced: true,
        },
      ],
    });
    const plan = makePlan({
      classification: "bug_fix",
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Fix bug" }),
      ],
    });
    const ticket = makeTicket();

    const result = validator.validate(plan, ticket);

    const productStep = result.steps.find((s) => s.agent === "product");
    expect(productStep).toBeUndefined();
  });
});
