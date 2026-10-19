import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const builtIndex = resolve(process.cwd(), "dist/index.html");

describe("production website build", () => {
  it("contains the landing page and a bundled JavaScript entrypoint", () => {
    expect(existsSync(builtIndex)).toBe(true);

    const html = readFileSync(builtIndex, "utf8");
    expect(html).toContain("SprintFoundry — AI Agents That Ship Your Code");
    expect(html).toMatch(/assets\/[^"]+\.js/);
  });
});
