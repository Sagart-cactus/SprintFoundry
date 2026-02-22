import path from "path";
import { realpathSync } from "fs";
import type { GuardrailConfig } from "../../shared/types.js";

export type GuardrailToolCall = {
  kind: "command" | "file";
  command?: string;
  path?: string;
  tool_name?: string;
};

export type GuardrailDecision = {
  allowed: boolean;
  reason?: string;
  rule?: string;
  details?: Record<string, unknown>;
};

export function evaluateGuardrail(
  guardrails: GuardrailConfig | undefined,
  toolCall: GuardrailToolCall,
  workspacePath: string
): GuardrailDecision {
  if (!guardrails) return { allowed: true };

  if (toolCall.kind === "command" && toolCall.command) {
    const decision = matchCommandGuards(toolCall.command, guardrails.deny_commands);
    if (!decision.allowed) return decision;
    return { allowed: true };
  }

  if (toolCall.kind === "file" && toolCall.path) {
    return matchPathGuards(toolCall.path, guardrails, workspacePath);
  }

  return { allowed: true };
}

// Resolve symlinks for path comparison. Falls back to path.resolve if the
// path doesn't exist yet (e.g., a file being created for the first time).
function realpath(p: string): string {
  // Walk up until we find an existing ancestor, then append the rest
  const parts = p.split(path.sep);
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join(path.sep) || path.sep;
    try {
      const real = realpathSync(candidate);
      const remainder = parts.slice(i).join(path.sep);
      return remainder ? path.join(real, remainder) : real;
    } catch {
      // path does not exist, try shorter prefix
    }
  }
  return p;
}

function matchCommandGuards(command: string, denyPatterns?: string[]): GuardrailDecision {
  if (!denyPatterns || denyPatterns.length === 0) return { allowed: true };
  for (const pattern of denyPatterns) {
    if (!pattern) continue;
    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(command)) {
        return {
          allowed: false,
          reason: "command_denied",
          rule: pattern,
          details: { command },
        };
      }
    } catch {
      // Ignore invalid regex patterns.
      continue;
    }
  }
  return { allowed: true };
}

function matchPathGuards(
  rawPath: string,
  guardrails: GuardrailConfig,
  workspacePath: string
): GuardrailDecision {
  const resolved = realpath(path.resolve(workspacePath, rawPath));
  const workspaceRoot = realpath(path.resolve(workspacePath));
  const isInsideWorkspace = resolved === workspaceRoot || resolved.startsWith(workspaceRoot + path.sep);
  const relPath = path.relative(workspaceRoot, resolved).replace(/\\/g, "/");

  if (!isInsideWorkspace) {
    return {
      allowed: false,
      reason: "path_outside_workspace",
      details: { path: rawPath, resolved },
    };
  }

  if (guardrails.allow_paths && guardrails.allow_paths.length > 0) {
    const allowed = guardrails.allow_paths.some((pattern) =>
      globLikePatternToRegex(pattern).test(relPath)
    );
    if (!allowed) {
      return {
        allowed: false,
        reason: "path_not_allowed",
        details: { path: rawPath, resolved, rel_path: relPath },
      };
    }
  }

  if (guardrails.deny_paths && guardrails.deny_paths.length > 0) {
    for (const pattern of guardrails.deny_paths) {
      if (!pattern) continue;
      if (globLikePatternToRegex(pattern).test(relPath)) {
        return {
          allowed: false,
          reason: "path_denied",
          rule: pattern,
          details: { path: rawPath, resolved, rel_path: relPath },
        };
      }
    }
  }

  return { allowed: true };
}

function globLikePatternToRegex(pattern: string): RegExp {
  const doubleStarPlaceholder = "__SF_DOUBLE_STAR__";
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, doubleStarPlaceholder)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(new RegExp(doubleStarPlaceholder, "g"), ".*");
  return new RegExp(`^${escaped}$`);
}
