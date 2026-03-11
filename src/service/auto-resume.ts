import type { RunSessionMetadata } from "../shared/types.js";

export type AutoResumeAction = "fresh" | "restart" | "resume";

export function resolveAutoResumeAction(
  runId: string | undefined,
  session: Pick<RunSessionMetadata, "workspace_path" | "status"> | null
): AutoResumeAction {
  if (!runId) {
    return "fresh";
  }
  if (!session) {
    return "fresh";
  }
  if (session.status !== "executing") {
    return "fresh";
  }
  return session.workspace_path ? "resume" : "restart";
}
