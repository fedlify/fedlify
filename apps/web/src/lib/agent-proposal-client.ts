/** Browser-side calls for workspace assistant proposals. Every commit still needs an explicit human click. */

/** Shown wherever a person reviews a proposal. The server-side scan is advisory, never a security boundary. */
export const SCAN_NOTICE = "Automatic checks are a heuristic, not a security review. They can miss obfuscated code, so read the whole diff before you accept.";

export type ProposalStatus = "PROPOSED" | "ACCEPTED" | "REJECTED" | "STALE";

export type ProposalFileSummary = {
  path: string;
  action: "create" | "update" | "delete";
  added: number;
  removed: number;
  /** Present on detail responses: the complete proposed content, null for a delete. */
  content?: string | null;
};

export type ProposalSummary = {
  id: string;
  title: string;
  rationale: string;
  prompt: string;
  status: ProposalStatus;
  baseCommit: string | null;
  acceptedCommit: string | null;
  /** Files that were actually committed. Null means all of them (or not accepted yet). */
  acceptedPaths?: string[] | null;
  createdAt: string;
  files: ProposalFileSummary[];
};

export type ProposalFailure = { ok: false; status: number; code: string; message: string; details: string[]; stale: boolean };
export type ProposalResult<T> = ({ ok: true } & T) | ProposalFailure;

function base(studyId: string, projectId: string) {
  return `/api/v1/studies/${studyId}/pipeline-projects/${projectId}/agent/proposals`;
}

async function call<T>(url: string, init?: RequestInit, signal?: AbortSignal): Promise<ProposalResult<T>> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      ...init,
      signal,
      headers: { "content-type": "application/json", ...init?.headers }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof body?.error?.code === "string" ? body.error.code : "error";
      return {
        ok: false,
        status: response.status,
        code,
        message: typeof body?.error?.message === "string" ? body.error.message : `Request failed (${response.status}).`,
        details: Array.isArray(body?.error?.details) ? body.error.details.filter((item: unknown): item is string => typeof item === "string") : [],
        stale: code === "proposal_stale"
      };
    }
    return { ok: true, ...(body as T) };
  } catch {
    return { ok: false, status: 0, code: "network", message: signal?.aborted ? "Cancelled." : "The request could not be completed.", details: [], stale: false };
  }
}

export const listProposals = (studyId: string, projectId: string) => call<{ proposals: ProposalSummary[] }>(base(studyId, projectId));
export const getProposal = (studyId: string, projectId: string, id: string) => call<{ proposal: ProposalSummary }>(`${base(studyId, projectId)}/${id}`);
export const createProposal = (
  studyId: string,
  projectId: string,
  body: { message: string; history: Array<{ role: "user" | "assistant"; content: string }>; filePath?: string; selection?: string },
  signal?: AbortSignal
) => call<{ proposal: ProposalSummary }>(base(studyId, projectId), { method: "POST", body: JSON.stringify(body) }, signal);
export const acceptProposal = (studyId: string, projectId: string, id: string, paths?: string[]) =>
  call<{ commitSha: string; changed: number }>(`${base(studyId, projectId)}/${id}/accept`, { method: "POST", body: JSON.stringify(paths ? { paths } : {}) });
export const rejectProposal = (studyId: string, projectId: string, id: string) =>
  call<{ proposal: { id: string; status: ProposalStatus } }>(`${base(studyId, projectId)}/${id}/reject`, { method: "POST", body: "{}" });

/** A PROPOSED proposal written against a commit that is no longer the saved head reads as STALE right away. */
export function effectiveStatus(proposal: Pick<ProposalSummary, "status" | "baseCommit">, head: string | null): ProposalStatus {
  if (proposal.status === "PROPOSED" && head && proposal.baseCommit && proposal.baseCommit !== head) return "STALE";
  return proposal.status;
}

/** Files that landed in the commit (all files when the proposal was accepted whole). */
export function appliedPaths(proposal: Pick<ProposalSummary, "files" | "status" | "acceptedPaths">): Set<string> {
  if (proposal.status !== "ACCEPTED") return new Set();
  const accepted = proposal.acceptedPaths;
  return new Set(Array.isArray(accepted) ? accepted : proposal.files.map((file) => file.path));
}
