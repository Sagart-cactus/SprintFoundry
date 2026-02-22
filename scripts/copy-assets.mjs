#!/usr/bin/env node
/**
 * Post-build asset copy: copies src/agents/ and src/agents-codex/ into dist/
 * so the compiled package contains the agent CLAUDE.md / AGENTS.md files.
 *
 * TypeScript's tsc only emits .ts → .js; non-TS assets must be copied manually.
 * agent-runner resolves agentDir relative to dist/service/, so CLAUDE.md files
 * must live at dist/agents/<agent>/CLAUDE.md for global npm installs to work.
 */

import { cpSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const copies = [
  { src: "src/agents", dest: "dist/agents" },
  { src: "src/agents-codex", dest: "dist/agents-codex" },
];

for (const { src, dest } of copies) {
  const srcPath = join(root, src);
  const destPath = join(root, dest);
  if (!existsSync(srcPath)) {
    console.log(`  skip ${src} (not found)`);
    continue;
  }
  cpSync(srcPath, destPath, {
    recursive: true,
    filter: (p) => !p.endsWith(".ts"),
  });
  console.log(`  copied ${src} → ${dest}`);
}

console.log("copy-assets: done");
