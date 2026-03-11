import type { RunSessionMetadata } from "../shared/types.js";

export type AutoResumeAction = "fresh" | "restart" | "resume";

export function resolveAutoResumeAction(
  runId: string | undefined,
  session: Pick<RunSessionMetadata, "workspace_path"> | null
): AutoResumeAction {
  if (!runId) {
    return "fresh";
  }
  if (!session) {
    return "fresh";
  }
  return session.workspace_path ? "resume" : "restart";
}
