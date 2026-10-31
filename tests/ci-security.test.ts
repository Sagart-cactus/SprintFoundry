import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts/check-secret-scan.mjs");
const dirs: string[] = [];

function finding(overrides: Record<string, unknown> = {}) {
  return {
    DetectorName: "Postgres",
    Verified: false,
    Raw: "postgres://sf:sf@postgres:5432",
    SourceMetadata: { Data: { Git: { file: "docker-compose.distributed.yml" } } },
    ...overrides,
  };
}

async function scan(lines: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "sf-secret-scan-"));
  dirs.push(dir);
  const file = join(dir, "results.jsonl");
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  return () => execFileSync(process.execPath, [script, file], { encoding: "utf8", stdio: "pipe" });
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("secret scan policy", () => {
  it("accepts only the reviewed local/demo database findings", async () => {
    const run = await scan([
      finding(),
      finding({
        Raw: "postgres://user:pass@host:5432",
        SourceMetadata: { Data: { Git: { file: ".env.example" } } },
      }),
    ]);
    expect(run()).toContain("2 reviewed demo findings, 0 blocking findings");
  });

  it.each([
    ...["scripts/check-secret-scan.mjs", "tests/ci-security.test.ts"].flatMap((file) =>
      [
        "postgres://sf:sf@postgres:5432",
        "postgres://user:pass@host:5432",
        "postgres://sf:not-the-demo-password@postgres:5432",
        "postgres://sf:sf@production:5432",
      ].map((raw) => [file, raw]),
    ),
  ])("accepts the reviewed policy fixture in %s", async (file, raw) => {
    const fixture = finding({
      Raw: raw,
      SourceMetadata: { Data: { Git: { file } } },
    });
    expect((await scan([fixture]))()).toContain("1 reviewed demo findings, 0 blocking findings");
    expect(await scan([{ ...fixture, Verified: true }])).toThrow();
  });

  it.each([
    ["verified local credentials", { Verified: true }],
    ["different credentials", { Raw: "postgres://sf:not-the-demo-password@postgres:5432" }],
    ["different host", { Raw: "postgres://sf:sf@production:5432" }],
    ["another detector", { DetectorName: "AWS" }],
    ["another file", { SourceMetadata: { Data: { Git: { file: "src/config.ts" } } } }],
    [
      "unknown policy fixture",
      {
        Raw: ["postgres", "://", "sf:not-an-allowed-fixture@postgres:5432"].join(""),
        SourceMetadata: { Data: { Git: { file: "tests/ci-security.test.ts" } } },
      },
    ],
  ])("blocks %s without logging credentials", async (_label, overrides) => {
    const run = await scan([finding(), finding(overrides)]);
    expect(run).toThrow();
    try {
      run();
    } catch (error) {
      const output = error as { stdout: string; stderr: string };
      expect(output.stdout).toContain("1 blocking findings");
      expect(output.stdout + output.stderr).not.toContain("postgres://");
    }
  });

  it("accepts a completed scan with no findings", async () => {
    expect((await scan([]))()).toContain("0 blocking findings");
  });

  it.each([null, {}, { DetectorName: "Postgres", Verified: false }])(
    "fails closed on unexpected results",
    async (result) => {
      expect(await scan([result])).toThrow();
    },
  );

  it("fails closed on malformed JSON without leaking its contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sf-secret-scan-"));
    dirs.push(dir);
    const file = join(dir, "results.jsonl");
    await writeFile(file, '{"Raw":"private-test-value" invalid');
    try {
      execFileSync(process.execPath, [script, file], { encoding: "utf8", stdio: "pipe" });
      expect.fail("malformed scanner output must fail");
    } catch (error) {
      const output = error as { stdout: string; stderr: string };
      expect(output.stderr).toContain("Secret scan validation failed");
      expect(output.stdout + output.stderr).not.toContain("private-test-value");
    }
  });
});

describe("workspace dependency updates", () => {
  it("uses one pnpm lockfile and one Dependabot npm workspace root", async () => {
    const config = parse(await readFile(join(root, ".github/dependabot.yml"), "utf8"));
    const npm = config.updates.filter(
      (update: Record<string, unknown>) => update["package-ecosystem"] === "npm",
    );
    expect(npm).toHaveLength(1);
    expect(npm[0].directory).toBe("/");
    expect(npm[0].directories).toBeUndefined();
    const lock = parse(await readFile(join(root, "pnpm-lock.yaml"), "utf8"));
    for (const workspace of [".", "website", "monitor/v4", "monitor/v5"]) {
      await expect(access(join(root, workspace, "package-lock.json"))).rejects.toThrow();
      const pkg = JSON.parse(await readFile(join(root, workspace, "package.json"), "utf8"));
      for (const section of ["dependencies", "devDependencies"]) {
        for (const [name, specifier] of Object.entries(pkg[section] ?? {})) {
          expect(lock.importers[workspace][section][name].specifier).toBe(specifier);
        }
      }
    }
  });
});
