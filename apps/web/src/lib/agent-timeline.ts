/**
 * Changes timeline (design 2.6): one newest-first list built from
 *  1. AgentProposal rows (every status, accepted ones carry their commit),
 *  2. Gitea commits on the project branch (manual saves and unrecorded commits),
 *  3. pipeline_project.save audit events (to attribute manual commits to a Fedlify user),
 *  4. approved PipelineVersion rows (the "published" marker and rows).
 * Nothing is stored for the timeline itself. Diffs are computed on demand from Gitea.
 * No message text is ever written to audit metadata here.
 */

import { Prisma } from "@prisma/client";
import { AUDIT_ACTIONS, type TimelineEntryDto, type TimelineKind, type TimelinePageDto } from "@/lib/agent-thread-types";
import { readStoredFiles } from "@/lib/agent-proposal-store";
import { audit } from "@/lib/audit";
import { compareGiteaCommit, getGiteaBranch, listGiteaCommits, readGiteaFileAtRef, type GiteaCommitSummary } from "@/lib/gitea";
import { isSensitiveFilePath } from "@/lib/repo-checks";
import { prisma } from "@/lib/prisma";

export const TIMELINE_LIMITS = { defaultPage: 30, maxPage: 100, commitPageSize: 50, maxCommitPages: 20, diffMaxFiles: 50, diffMaxFileChars: 200_000 } as const;
export const TIMELINE_FILTERS = ["all", "agent", "manual", "published"] as const;
export type TimelineFilter = (typeof TIMELINE_FILTERS)[number];

const SAVE_ACTIONS = ["pipeline_project.save", "pipeline_project.agent_save"];
const TRAILER = /^Fedlify-Agent-Proposal:[ \t]*([A-Za-z0-9_-]{8,64})[ \t]*$/m;

/** The proposal id named by the `Fedlify-Agent-Proposal` trailer of a commit message, or null. */
export function parseProposalTrailer(message: string): string | null {
  const match = TRAILER.exec(message.replace(/\r\n/g, "\n"));
  return match ? match[1] : null;
}

// ---------- cursor ----------

export type TimelineCursor = { at: number; id: string };

export function encodeCursor(entry: Pick<TimelineEntryDto, "at" | "id">): string {
  return `${Date.parse(entry.at)}_${entry.id}`;
}

export function decodeCursor(value: string | null | undefined): TimelineCursor | null {
  if (!value) return null;
  const index = value.indexOf("_");
  if (index <= 0) return null;
  const at = Number(value.slice(0, index));
  const id = value.slice(index + 1);
  if (!Number.isFinite(at) || !id) return null;
  return { at, id };
}

/** True when the entry sorts strictly after the cursor in newest-first order. */
function isBeforeCursor(entry: Pick<TimelineEntryDto, "at" | "id">, cursor: TimelineCursor | null): boolean {
  if (!cursor) return true;
  const at = Date.parse(entry.at);
  return at < cursor.at || (at === cursor.at && entry.id < cursor.id);
}

function compareEntries(a: TimelineEntryDto, b: TimelineEntryDto): number {
  const diff = Date.parse(b.at) - Date.parse(a.at);
  if (diff !== 0) return diff;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// ---------- pure merge ----------

export type TimelineProposal = {
  id: string;
  title: string | null;
  status: string;
  files: Prisma.JsonValue | null;
  acceptedCommit: string | null;
  acceptedById: string | null;
  requestedById: string;
  rejectedById: string | null;
  rejectedAt: Date | null;
  decidedAt: Date | null;
  createdAt: Date;
  threadId: string | null;
  turnId: string | null;
};

export type TimelineVersion = { id: string; version: string; gitCommit: string | null; approvedAt: Date | null; publishedAt: Date | null; approvedById: string | null };

export type MergeInput = {
  proposals: TimelineProposal[];
  commits: GiteaCommitSummary[];
  versions: TimelineVersion[];
  /** commit sha to Fedlify user id, from save audit events. */
  saveActors: Map<string, string | null>;
  userNames: Map<string, string | null>;
  /** published markers for any commit, not only the versions in this page. */
  publishedByCommit?: Map<string, TimelineVersion>;
};

/** The instant a proposal row is shown at: decision time when decided, else its creation time. */
export function proposalAt(row: Pick<TimelineProposal, "decidedAt" | "rejectedAt" | "createdAt">): Date {
  return row.decidedAt ?? row.rejectedAt ?? row.createdAt;
}

function versionNumber(version: string): number {
  const digits = /\d+/.exec(version);
  return digits ? Number(digits[0]) : 0;
}

function firstLine(message: string, max = 120): string {
  return (message.split("\n")[0] ?? "").trim().slice(0, max);
}

export function mergeTimeline(input: MergeInput): TimelineEntryDto[] {
  const name = (id: string | null | undefined) => (id ? (input.userNames.get(id) ?? null) : null);
  const published = (commit: string | null) => {
    const version = commit ? (input.publishedByCommit?.get(commit) ?? input.versions.find((item) => item.gitCommit === commit)) : undefined;
    return version ? { version: versionNumber(version.version), approvedByName: name(version.approvedById) } : null;
  };

  const entries: TimelineEntryDto[] = [];
  const claimedCommits = new Set<string>();
  const proposalIds = new Set(input.proposals.map((row) => row.id));

  for (const row of input.proposals) {
    const files = readStoredFiles(row.files);
    const rejected = row.status === "REJECTED";
    const accepted = row.status === "ACCEPTED";
    if (accepted && row.acceptedCommit) claimedCommits.add(row.acceptedCommit);
    entries.push({
      id: `proposal:${row.id}`,
      kind: rejected ? "rejected" : "agent",
      at: proposalAt(row).toISOString(),
      commit: accepted ? row.acceptedCommit : null,
      title: row.title ?? "Proposed change",
      actor: rejected
        ? { id: row.rejectedById, name: name(row.rejectedById) }
        : accepted
          ? { id: row.acceptedById, name: name(row.acceptedById) }
          : { id: row.requestedById, name: name(row.requestedById) },
      threadId: row.threadId,
      proposalId: row.id,
      proposalStatus: row.status,
      turnId: row.turnId,
      added: files.length ? files.reduce((sum, file) => sum + file.added, 0) : null,
      removed: files.length ? files.reduce((sum, file) => sum + file.removed, 0) : null,
      published: accepted ? published(row.acceptedCommit) : null
    });
  }

  for (const commit of input.commits) {
    if (claimedCommits.has(commit.sha)) continue;
    const trailerId = parseProposalTrailer(commit.message);
    // Represented by its proposal row (which the caller loads for every trailer in the window).
    if (trailerId && proposalIds.has(trailerId)) continue;
    const savedBy = input.saveActors.get(commit.sha);
    const known = input.saveActors.has(commit.sha);
    const kind: TimelineKind = known ? "manual" : "external";
    entries.push({
      id: `commit:${commit.sha}`,
      kind,
      at: commit.at,
      commit: commit.sha,
      title: known ? "Manual save" : firstLine(commit.message) || "External commit",
      actor: known ? { id: savedBy ?? null, name: name(savedBy) } : { id: null, name: commit.authorName },
      threadId: null,
      proposalId: null,
      proposalStatus: null,
      turnId: null,
      added: commit.additions,
      removed: commit.deletions,
      published: published(commit.sha)
    });
  }

  for (const version of input.versions) {
    const at = version.approvedAt ?? version.publishedAt;
    if (!at) continue;
    const number = versionNumber(version.version);
    entries.push({
      id: `version:${version.id}`,
      kind: "published",
      at: at.toISOString(),
      commit: version.gitCommit,
      title: `v${number} published`,
      actor: { id: version.approvedById, name: name(version.approvedById) },
      threadId: null,
      proposalId: null,
      proposalStatus: null,
      turnId: null,
      added: null,
      removed: null,
      published: { version: number, approvedByName: name(version.approvedById) }
    });
  }

  return entries.sort(compareEntries);
}

// ---------- Gitea window (cached by head sha: commits are immutable) ----------

const PAGE_CACHE_MAX = 64;
const pageCache = new Map<string, GiteaCommitSummary[]>();

async function cachedCommitPage(owner: string, repo: string, head: string, page: number): Promise<GiteaCommitSummary[]> {
  const key = `${owner}/${repo}@${head}#${page}`;
  const hit = pageCache.get(key);
  if (hit) {
    pageCache.delete(key);
    pageCache.set(key, hit);
    return hit;
  }
  const commits = await listGiteaCommits({ owner, repo, branch: head, page, limit: TIMELINE_LIMITS.commitPageSize });
  pageCache.set(key, commits);
  while (pageCache.size > PAGE_CACHE_MAX) pageCache.delete(pageCache.keys().next().value as string);
  return commits;
}

export function clearTimelineCache() {
  pageCache.clear();
}

/** Newest-first commits until `need` of them are at or before `cutoffMs`, or the history (or the page budget) ends. */
export async function fetchCommitWindow(input: { owner: string; repo: string; branch: string; cutoffMs: number | null; need: number }): Promise<{ commits: GiteaCommitSummary[]; complete: boolean; floorMs: number | null }> {
  const branch = await getGiteaBranch({ owner: input.owner, repo: input.repo, branchName: input.branch });
  const head = branch.commit?.id ?? branch.commit?.sha;
  if (!head) return { commits: [], complete: true, floorMs: null };
  const commits: GiteaCommitSummary[] = [];
  let eligible = 0;
  let complete = false;
  for (let page = 1; page <= TIMELINE_LIMITS.maxCommitPages; page += 1) {
    const batch = await cachedCommitPage(input.owner, input.repo, head, page);
    commits.push(...batch);
    eligible += batch.filter((commit) => input.cutoffMs === null || Date.parse(commit.at) <= input.cutoffMs).length;
    if (batch.length < TIMELINE_LIMITS.commitPageSize) {
      complete = true;
      break;
    }
    if (eligible >= input.need) break;
  }
  const last = commits[commits.length - 1];
  return { commits, complete, floorMs: complete || !last ? null : Date.parse(last.at) };
}

// ---------- reconciler ----------

export type ReconcileContext = { projectId: string; studyId: string; orgId: string | null; actorUserId: string | null };

/**
 * A commit carrying a `Fedlify-Agent-Proposal` trailer whose proposal is ACCEPTED but has no acceptedCommit (the
 * accept route committed and then failed to record it) gets its acceptedCommit filled in. Only proposals of this
 * project are touched, and a commit that a Fedlify save audit already claims as a manual save is never linked,
 * so a manual commit message cannot hijack a proposal. Returns the proposals it changed. Audits carry ids only.
 */
export async function reconcileAgentCommits(ctx: ReconcileContext, commits: GiteaCommitSummary[], proposals: Map<string, TimelineProposal>, manualShas: Set<string>): Promise<string[]> {
  const fixed: string[] = [];
  for (const commit of commits) {
    const id = parseProposalTrailer(commit.message);
    if (!id || manualShas.has(commit.sha)) continue;
    const row = proposals.get(id);
    if (!row || row.status !== "ACCEPTED" || row.acceptedCommit) continue;
    const result = await prisma.agentProposal.updateMany({ where: { id, projectId: ctx.projectId, status: "ACCEPTED", acceptedCommit: null }, data: { acceptedCommit: commit.sha } });
    if (result.count === 0) continue;
    row.acceptedCommit = commit.sha;
    fixed.push(id);
    try {
      await audit({
        actorUserId: ctx.actorUserId,
        orgId: ctx.orgId,
        studyId: ctx.studyId,
        action: AUDIT_ACTIONS.commitReconciled,
        targetType: "PipelineProject",
        targetId: ctx.projectId,
        metadata: { proposalId: id, commitSha: commit.sha }
      });
    } catch (error) {
      console.error("timeline: reconcile audit failed", error instanceof Error ? error.message : "unknown error");
    }
  }
  return fixed;
}

// ---------- loader ----------

export type TimelineProject = { id: string; studyId: string; giteaOwner: string | null; giteaRepo: string | null; defaultBranch: string; study: { orgId: string | null } };

const PROPOSAL_SELECT = {
  id: true,
  title: true,
  status: true,
  files: true,
  acceptedCommit: true,
  acceptedById: true,
  requestedById: true,
  rejectedById: true,
  rejectedAt: true,
  decidedAt: true,
  createdAt: true,
  threadId: true,
  turnId: true
} as const;

/** Proposal rows at or before the cursor, per "shown at" bucket, so each bucket's own ordering is exact. */
async function loadProposals(projectId: string, before: Date | null, take: number): Promise<TimelineProposal[]> {
  const base: Prisma.AgentProposalWhereInput = { projectId, files: { not: Prisma.DbNull } };
  const lte = (field: "decidedAt" | "rejectedAt" | "createdAt") => (before ? { [field]: { lte: before } } : {});
  const [decided, rejectedOnly, pending] = await Promise.all([
    prisma.agentProposal.findMany({ where: { AND: [base, { decidedAt: { not: null } }, lte("decidedAt")] }, orderBy: { decidedAt: "desc" }, take, select: PROPOSAL_SELECT }),
    prisma.agentProposal.findMany({ where: { AND: [base, { decidedAt: null, rejectedAt: { not: null } }, lte("rejectedAt")] }, orderBy: { rejectedAt: "desc" }, take, select: PROPOSAL_SELECT }),
    prisma.agentProposal.findMany({ where: { AND: [base, { decidedAt: null, rejectedAt: null }, lte("createdAt")] }, orderBy: { createdAt: "desc" }, take, select: PROPOSAL_SELECT })
  ]);
  return [...decided, ...rejectedOnly, ...pending] as TimelineProposal[];
}

export async function loadTimeline(input: { project: TimelineProject; actorUserId: string | null; limit?: number; cursor?: string | null; kind?: TimelineFilter }): Promise<TimelinePageDto> {
  const { project } = input;
  const limit = Math.min(TIMELINE_LIMITS.maxPage, Math.max(1, Math.floor(input.limit ?? TIMELINE_LIMITS.defaultPage)));
  const kind = input.kind ?? "all";
  const cursor = decodeCursor(input.cursor);
  const before = cursor ? new Date(cursor.at) : null;

  const wantProposals = kind !== "manual" && kind !== "published";
  const wantCommits = kind !== "published";
  const wantVersions = kind === "all" || kind === "published";

  // 1. commits
  let commits: GiteaCommitSummary[] = [];
  let floorMs: number | null = null;
  if (wantCommits && project.giteaOwner && project.giteaRepo) {
    const window = await fetchCommitWindow({ owner: project.giteaOwner, repo: project.giteaRepo, branch: project.defaultBranch, cutoffMs: cursor?.at ?? null, need: limit + 1 + 20 });
    commits = window.commits;
    floorMs = window.floorMs;
  }

  // 2. proposals, plus any proposal named by a trailer in the commit window
  const proposals = new Map<string, TimelineProposal>();
  if (wantProposals || commits.length) {
    if (wantProposals) for (const row of await loadProposals(project.id, before, limit + 1)) proposals.set(row.id, row);
    const trailerIds = [...new Set(commits.map((commit) => parseProposalTrailer(commit.message)).filter((id): id is string => id !== null && !proposals.has(id)))];
    if (trailerIds.length) {
      const extra = (await prisma.agentProposal.findMany({
        where: { projectId: project.id, id: { in: trailerIds }, files: { not: Prisma.DbNull } },
        select: PROPOSAL_SELECT
      })) as TimelineProposal[];
      for (const row of extra) proposals.set(row.id, row);
    }
  }

  // 3. save audit events attribute manual commits
  const saveActors = new Map<string, string | null>();
  if (commits.length) {
    const oldest = commits[commits.length - 1];
    const events = await prisma.auditEvent.findMany({
      where: { action: { in: SAVE_ACTIONS }, targetType: "PipelineProject", targetId: project.id, createdAt: { gte: new Date(Date.parse(oldest.at) - 60_000) } },
      orderBy: { createdAt: "desc" },
      take: 2000,
      select: { action: true, actorUserId: true, metadata: true }
    });
    for (const event of events) {
      if (event.action !== "pipeline_project.save") continue;
      const sha = (event.metadata as { commitSha?: unknown } | null)?.commitSha;
      if (typeof sha === "string" && !saveActors.has(sha)) saveActors.set(sha, event.actorUserId);
    }
  }
  const manualShas = new Set(saveActors.keys());

  // 4. reconcile accepted proposals whose commit was never recorded
  if (commits.length && proposals.size) {
    await reconcileAgentCommits({ projectId: project.id, studyId: project.studyId, orgId: project.study.orgId, actorUserId: input.actorUserId }, commits, proposals, manualShas);
  }

  // 5. versions
  const versions: TimelineVersion[] = wantVersions
    ? await prisma.pipelineVersion.findMany({
        where: { projectId: project.id, approvalStatus: "APPROVED", approvedAt: before ? { lte: before } : { not: null } },
        orderBy: { approvedAt: "desc" },
        take: limit + 1,
        select: { id: true, version: true, gitCommit: true, approvedAt: true, publishedAt: true, approvedById: true }
      })
    : [];

  // 6. merge. Published markers for shown commits come from one extra lookup.
  const shas = [...new Set([...commits.map((commit) => commit.sha), ...[...proposals.values()].map((row) => row.acceptedCommit).filter((sha): sha is string => Boolean(sha))])];
  const markerRows = shas.length
    ? await prisma.pipelineVersion.findMany({
        where: { projectId: project.id, approvalStatus: "APPROVED", gitCommit: { in: shas } },
        select: { id: true, version: true, gitCommit: true, approvedAt: true, publishedAt: true, approvedById: true }
      })
    : [];
  const publishedByCommit = new Map<string, TimelineVersion>();
  for (const row of markerRows) if (row.gitCommit) publishedByCommit.set(row.gitCommit, row);

  const userIds = new Set<string>();
  for (const row of proposals.values()) for (const id of [row.acceptedById, row.requestedById, row.rejectedById]) if (id) userIds.add(id);
  for (const id of saveActors.values()) if (id) userIds.add(id);
  for (const row of [...versions, ...markerRows]) if (row.approvedById) userIds.add(row.approvedById);
  const userNames = new Map<string, string | null>();
  if (userIds.size) for (const user of await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } })) userNames.set(user.id, user.name);

  let merged = mergeTimeline({ proposals: [...proposals.values()], commits, versions, saveActors, userNames, publishedByCommit }).filter((entry) => isBeforeCursor(entry, cursor));
  // Older commits that were not fetched may still exist; do not show other sources past the fetched floor.
  if (floorMs !== null) merged = merged.filter((entry) => Date.parse(entry.at) >= floorMs);
  merged = merged.filter((entry) => {
    if (kind === "all") return true;
    if (kind === "agent") return entry.kind === "agent" || entry.kind === "rejected";
    if (kind === "manual") return entry.kind === "manual" || entry.kind === "external";
    return entry.kind === kind;
  });

  const page = merged.slice(0, limit);
  const more = merged.length > limit || (floorMs !== null && page.length > 0);
  return { entries: page, nextCursor: more && page.length ? encodeCursor(page[page.length - 1]) : null };
}

// ---------- diff of one commit, on demand ----------

export type CommitDiffFile = { path: string; status: "added" | "modified" | "deleted" | "renamed"; previousPath: string | null; before: string | null; after: string | null; truncated: boolean };
export type CommitDiff = { sha: string; parent: string | null; files: CommitDiffFile[]; omitted: number };

export const COMMIT_SHA = /^[0-9a-f]{7,64}$/;

const clip = (text: string | null) => (text !== null && text.length > TIMELINE_LIMITS.diffMaxFileChars ? { text: text.slice(0, TIMELINE_LIMITS.diffMaxFileChars), truncated: true } : { text, truncated: false });

/** Parent-versus-commit file contents for a read-only diff view. Null when Gitea does not know the commit. */
export async function loadCommitDiff(input: { owner: string; repo: string; commit: string }): Promise<CommitDiff | null> {
  const change = await compareGiteaCommit(input);
  if (!change) return null;
  const shown = change.files.slice(0, TIMELINE_LIMITS.diffMaxFiles);
  const files = await Promise.all(
    shown.map(async (file): Promise<CommitDiffFile> => {
      const oldPath = file.previousPath ?? file.path;
      const [before, after] = await Promise.all([
        file.status === "added" || !change.parent ? Promise.resolve(null) : readGiteaFileAtRef({ owner: input.owner, repo: input.repo, ref: change.parent, path: oldPath }),
        file.status === "deleted" ? Promise.resolve(null) : readGiteaFileAtRef({ owner: input.owner, repo: input.repo, ref: change.sha, path: file.path })
      ]);
      // Files that look like secrets are listed but their contents are never returned.
      const hidden = isSensitiveFilePath(file.path) || isSensitiveFilePath(oldPath);
      const b = clip(hidden ? null : before);
      const a = clip(hidden ? null : after);
      return { path: file.path, status: file.status, previousPath: file.previousPath, before: b.text, after: a.text, truncated: b.truncated || a.truncated };
    })
  );
  return { sha: change.sha, parent: change.parent, files, omitted: change.files.length - shown.length };
}
