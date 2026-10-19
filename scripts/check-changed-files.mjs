import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const maxCodeLines = 1_200;
const codeExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
// Only markers inside comments count; prose and string literals mentioning them do not.
const debtMarker = /(?:\/\/|\/\*|^\s*\*)\s*(?:TODO|FIXME|XXX|HACK)\b/;
const issueReference = /\b(?:TODO|FIXME|XXX|HACK)\s*(?:\((?:#[0-9]+|[A-Z][A-Z0-9]+-[0-9]+)\)|#[0-9]+)/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function resolveBase() {
  const configuredBase = process.env.READINESS_BASE_SHA;
  if (configuredBase && !/^0+$/.test(configuredBase)) return configuredBase;

  try {
    return git(["merge-base", "origin/main", "HEAD"]);
  } catch {
    return git(["rev-parse", "--verify", "HEAD^"]);
  }
}

function countLines(text) {
  return text === "" ? 0 : text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
}

function baseLineCount(base, file) {
  try {
    return countLines(git(["show", `${base}:${file}`]) + "\n");
  } catch {
    return 0;
  }
}

const base = resolveBase();
const range = `${base}...HEAD`;
const changedCodeFiles = git(["diff", "--name-only", "--diff-filter=ACMR", range])
  .split("\n")
  .filter((file) => file && codeExtensions.has(extname(file)));
const failures = [];
const warnings = [];

for (const file of changedCodeFiles) {
  const lines = countLines(readFileSync(file, "utf8"));
  if (lines <= maxCodeLines) continue;

  const before = baseLineCount(base, file);
  if (before <= maxCodeLines) {
    failures.push(`${file} grew to ${lines} lines; keep source files at or below ${maxCodeLines}.`);
  } else {
    warnings.push(`${file} was already ${before} lines and is now ${lines}; consider splitting it.`);
  }
}

if (changedCodeFiles.length > 0) {
  let currentFile = "";
  const diff = git(["diff", "--unified=0", range, "--", ...changedCodeFiles]);
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      currentFile = line.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }
    if (!line.startsWith("+")) continue;
    const addedLine = line.slice(1);
    if (debtMarker.test(addedLine) && !issueReference.test(addedLine)) {
      failures.push(
        `${currentFile}: new debt marker needs an issue reference, e.g. TODO(#123): ${addedLine.trim()}`,
      );
    }
  }
}

warnings.forEach((warning) => console.warn(`warning: ${warning}`));
if (failures.length > 0) {
  console.error("Changed-file checks failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(
    `Changed-file checks passed for ${changedCodeFiles.length} code files (base ${base.slice(0, 8)}).`,
  );
}
