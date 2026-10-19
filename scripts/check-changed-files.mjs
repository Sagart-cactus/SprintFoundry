import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const maxCodeLines = 1_200;
const codeExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const debtMarker = /\b(TODO|FIXME|XXX|HACK)\b/;
const issueReference = /\b(?:TODO|FIXME|XXX|HACK)\s*(?:\((?:#[0-9]+|[A-Z][A-Z0-9]+-[0-9]+)\)|#[0-9]+)\b/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function resolveBase() {
  const configuredBase = process.env.READINESS_BASE_SHA;
  if (configuredBase && !/^0+$/.test(configuredBase)) return configuredBase;

  try {
    return git(["rev-parse", "--verify", "origin/main"]);
  } catch {
    return git(["rev-parse", "--verify", "HEAD^"]);
  }
}

const base = resolveBase();
const range = `${base}...HEAD`;
const changedFiles = git(["diff", "--name-only", "--diff-filter=ACMR", range]).split("\n").filter(Boolean);
const failures = [];

for (const file of changedFiles) {
  if (!codeExtensions.has(extname(file))) continue;

  const lines = readFileSync(file, "utf8").split(/\r?\n/).length - 1;
  if (lines > maxCodeLines) {
    failures.push(`${file} has ${lines} lines; keep changed source files at or below ${maxCodeLines}.`);
  }
}

const diff = git(["diff", "--unified=0", range, "--"]);
for (const line of diff.split("\n")) {
  if (!line.startsWith("+") || line.startsWith("+++")) continue;
  const addedLine = line.slice(1);
  if (debtMarker.test(addedLine) && !issueReference.test(addedLine)) {
    failures.push(`New debt marker needs a ticket reference: ${addedLine.trim()}`);
  }
}

if (failures.length > 0) {
  console.error("Changed-file checks failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`Changed-file checks passed for ${changedFiles.length} files (base ${base.slice(0, 8)}).`);
}
