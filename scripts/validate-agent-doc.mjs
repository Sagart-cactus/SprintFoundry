import { readFileSync } from "node:fs";

const agentDoc = readFileSync("AGENTS.md", "utf8");
const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const websitePackage = JSON.parse(readFileSync("website/package.json", "utf8"));
const match = agentDoc.match(/## CI-Verified Commands\n(?:(?!\n## )[\s\S])*?```bash\s*([\s\S]*?)```/);

if (!match) {
  throw new Error("AGENTS.md must define a fenced bash block under CI-Verified Commands.");
}

const commands = match[1]
  .split("\n")
  .map((command) => command.trim())
  .filter(Boolean);

for (const command of commands) {
  const websiteCommand = command.match(/^pnpm --filter @sprintfoundry\/website (.+)$/);
  const rootCommand = command.match(/^pnpm ([a-zA-Z0-9:_-]+)$/);
  const packageScript = websiteCommand
    ? websitePackage.scripts?.[websiteCommand[1]]
    : rootCommand
      ? rootPackage.scripts?.[rootCommand[1]]
      : undefined;

  if (!packageScript) {
    throw new Error(`AGENTS.md command has no matching package script: ${command}`);
  }
  if (!workflow.includes(command)) {
    throw new Error(`CI does not run the documented command: ${command}`);
  }
}

console.log(`Validated ${commands.length} AGENTS.md commands against package scripts and CI.`);
