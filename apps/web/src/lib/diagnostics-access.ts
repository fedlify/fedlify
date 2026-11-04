/**
 * Access rule for diagnostics: they contain log tails, run events and per-site state, so they need the same
 * `viewLogs` permission as the run-status and job-log routes. A role with runAgent but without viewLogs
 * (for example DATA_SCIENTIST) never gets them, whatever the client asks for.
 */

import { diagnosticsRelevant } from "@/lib/diagnostics";
import { loadProjectDiagnostics } from "@/lib/diagnostics-loader";
import { canAccessStudy } from "@/lib/rbac";

export async function loadDiagnosticsForMessage(args: {
  userId: string;
  studyId: string;
  projectId: string;
  message: string;
  flagged?: boolean;
}) {
  if (!diagnosticsRelevant(args.message, args.flagged ?? false)) return null;
  if (!(await canAccessStudy(args.userId, args.studyId, "viewLogs"))) return null;
  return loadProjectDiagnostics(args.studyId, args.projectId).catch(() => null);
}
