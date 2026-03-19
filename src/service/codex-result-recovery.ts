import * as fs from "fs/promises";
import * as path from "path";

type PatchOperation =
  | {
      kind: "add";
      filePath: string;
      content: string;
    }
  | {
      kind: "delete";
      filePath: string;
    }
  | {
      kind: "update";
      filePath: string;
      moveTo?: string;
      hunks: string[][];
    };

export async function recoverAgentResultFromCodexOutput(
  workspacePath: string
): Promise<boolean> {
  const stdoutLogs = await findCodexStdoutLogs(workspacePath);
  for (const stdoutLog of stdoutLogs) {
    const content = await safeReadFile(stdoutLog);
    if (!content) continue;

    const finalMessage = extractLatestAgentMessage(content);
    if (!finalMessage) continue;

    const patchText = extractPatchBlock(finalMessage);
    if (!patchText) continue;

    try {
      const operations = parseSprintFoundryPatch(patchText);
      await applySprintFoundryPatch(workspacePath, operations);
      return true;
    } catch (error) {
      console.warn(
        `[agent-runner] Failed to recover workspace changes from ${path.basename(stdoutLog)}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return false;
}

async function findCodexStdoutLogs(workspacePath: string): Promise<string[]> {
  const entries = await fs.readdir(workspacePath, { withFileTypes: true });
  const stdoutFiles = entries
    .filter((entry) => {
      if (!entry.isFile()) return false;
      return (
        entry.name === ".codex-runtime.stdout.log" ||
        /^\.codex-runtime\.step-\d+\.attempt-\d+\.stdout\.log$/.test(entry.name)
      );
    })
    .map((entry) => path.join(workspacePath, entry.name));

  const withStats = await Promise.all(
    stdoutFiles.map(async (filePath) => ({
      filePath,
      stat: await fs.stat(filePath),
    }))
  );

  return withStats
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .map((entry) => entry.filePath);
}

async function safeReadFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

function extractLatestAgentMessage(stdoutContent: string): string | undefined {
  let latestMessage: string | undefined;
  for (const rawLine of stdoutContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const message = pickAgentMessageText(parsed);
      if (message) latestMessage = message;
    } catch {
      continue;
    }
  }
  return latestMessage;
}

function pickAgentMessageText(event: Record<string, unknown>): string | undefined {
  if (event["type"] === "agent_message") {
    return pickString(event, ["text", "message"])
      ?? (isRecord(event["item"]) ? pickString(event["item"], ["text", "message"]) : undefined);
  }

  if (
    (event["type"] === "item.completed" || event["type"] === "item.started")
    && isRecord(event["item"])
    && event["item"]["type"] === "agent_message"
  ) {
    return pickString(event["item"], ["text", "message"]);
  }

  return undefined;
}

function extractPatchBlock(message: string): string | undefined {
  const match = message.match(/\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/);
  return match?.[0];
}

function parseSprintFoundryPatch(patchText: string): PatchOperation[] {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") {
    throw new Error("Patch is missing the expected begin marker");
  }

  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line === "*** End Patch") {
      return operations;
    }

    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length).trim();
      index += 1;
      const fileLines: string[] = [];
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const addLine = lines[index];
        if (!addLine.startsWith("+")) {
          throw new Error(`Invalid add-file line: ${addLine}`);
        }
        fileLines.push(addLine.slice(1));
        index += 1;
      }
      operations.push({
        kind: "add",
        filePath,
        content: fileLines.join("\n") + "\n",
      });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      operations.push({
        kind: "delete",
        filePath: line.slice("*** Delete File: ".length).trim(),
      });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length).trim();
      index += 1;

      let moveTo: string | undefined;
      if (index < lines.length && lines[index].startsWith("*** Move to: ")) {
        moveTo = lines[index].slice("*** Move to: ".length).trim();
        index += 1;
      }

      const hunks: string[][] = [];
      let currentHunk: string[] = [];
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const patchLine = lines[index];
        if (patchLine.startsWith("@@")) {
          if (currentHunk.length > 0) {
            hunks.push(currentHunk);
            currentHunk = [];
          }
          index += 1;
          continue;
        }
        if (patchLine === "*** End of File") {
          index += 1;
          continue;
        }
        if (!/^[ +\-]/.test(patchLine)) {
          throw new Error(`Invalid update line: ${patchLine}`);
        }
        currentHunk.push(patchLine);
        index += 1;
      }
      if (currentHunk.length > 0) {
        hunks.push(currentHunk);
      }
      operations.push({
        kind: "update",
        filePath,
        moveTo,
        hunks,
      });
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    throw new Error(`Unsupported patch line: ${line}`);
  }

  throw new Error("Patch is missing the expected end marker");
}

async function applySprintFoundryPatch(
  workspacePath: string,
  operations: PatchOperation[]
): Promise<void> {
  for (const operation of operations) {
    if (operation.kind === "add") {
      const targetPath = resolveWorkspacePath(workspacePath, operation.filePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, operation.content, "utf-8");
      continue;
    }

    if (operation.kind === "delete") {
      const targetPath = resolveWorkspacePath(workspacePath, operation.filePath);
      await fs.rm(targetPath, { force: true });
      continue;
    }

    const sourcePath = resolveWorkspacePath(workspacePath, operation.filePath);
    const originalContent = await fs.readFile(sourcePath, "utf-8");
    const originalHasTrailingNewline = originalContent.endsWith("\n");
    const originalLines = splitFileLines(originalContent);

    let cursor = 0;
    const nextLines: string[] = [];
    for (const hunk of operation.hunks) {
      const sourceHunkLines = hunk
        .filter((line) => line.startsWith(" ") || line.startsWith("-"))
        .map((line) => line.slice(1));
      const startIndex = sourceHunkLines.length === 0
        ? cursor
        : findMatchingHunkStart(originalLines, sourceHunkLines, cursor);
      if (startIndex < 0) {
        throw new Error(`Could not match update hunk for ${operation.filePath}`);
      }

      nextLines.push(...originalLines.slice(cursor, startIndex));
      let sourceIndex = startIndex;
      for (const line of hunk) {
        const marker = line[0];
        const text = line.slice(1);
        if (marker === " ") {
          if (originalLines[sourceIndex] !== text) {
            throw new Error(`Context mismatch while updating ${operation.filePath}`);
          }
          nextLines.push(text);
          sourceIndex += 1;
          continue;
        }
        if (marker === "-") {
          if (originalLines[sourceIndex] !== text) {
            throw new Error(`Delete mismatch while updating ${operation.filePath}`);
          }
          sourceIndex += 1;
          continue;
        }
        if (marker === "+") {
          nextLines.push(text);
        }
      }

      cursor = sourceIndex;
    }

    nextLines.push(...originalLines.slice(cursor));
    const targetPath = resolveWorkspacePath(
      workspacePath,
      operation.moveTo ?? operation.filePath
    );
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(
      targetPath,
      joinFileLines(nextLines, originalHasTrailingNewline),
      "utf-8"
    );
    if (targetPath !== sourcePath) {
      await fs.rm(sourcePath, { force: true });
    }
  }
}

function findMatchingHunkStart(
  originalLines: string[],
  sourceHunkLines: string[],
  minIndex: number
): number {
  if (sourceHunkLines.length === 0) return minIndex;
  for (let start = minIndex; start <= originalLines.length - sourceHunkLines.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < sourceHunkLines.length; offset += 1) {
      if (originalLines[start + offset] !== sourceHunkLines[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

function splitFileLines(content: string): string[] {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function joinFileLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return "";
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

function resolveWorkspacePath(workspacePath: string, relativePath: string): string {
  const resolved = path.resolve(workspacePath, relativePath);
  const normalizedWorkspace = ensureTrailingSeparator(path.resolve(workspacePath));
  const normalizedResolved = path.resolve(resolved);
  if (!normalizedResolved.startsWith(normalizedWorkspace)) {
    throw new Error(`Refusing to write outside workspace: ${relativePath}`);
  }
  return normalizedResolved;
}

function ensureTrailingSeparator(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function pickString(
  value: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
