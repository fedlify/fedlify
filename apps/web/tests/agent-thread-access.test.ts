import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudyRole } from "@prisma/client";

const canAccessStudy = vi.fn();
vi.mock("@/lib/rbac", async (orig) => ({ ...(await orig<typeof import("@/lib/rbac")>()), canAccessStudy: (...a: unknown[]) => canAccessStudy(...a) }));

import { roleCan } from "@/lib/rbac";
import { assertCanUseAgentThreads, resolveThreadAccess } from "@/lib/agent-thread-access";

const ROLES: StudyRole[] = [
  "PRINCIPAL_INVESTIGATOR",
  "STUDY_OWNER",
  "STUDY_COORDINATOR",
  "CLINICAL_LEAD",
  "ETHICS_REVIEWER",
  "DATA_SCIENTIST",
  "PIPELINE_DEVELOPER",
  "PRIVACY_SECURITY_OFFICER",
  "RELEASE_APPROVER",
  "SITE_ADMIN",
  "AUDITOR"
];

function asRole(role: StudyRole | null) {
  canAccessStudy.mockImplementation(async (_u: string, _s: string, action: Parameters<typeof roleCan>[1]) => (role ? roleCan(role, action) : false));
}

const thread = { studyId: "s1", createdById: "author" };

describe("agent thread access", () => {
  beforeEach(() => canAccessStudy.mockReset());

  it("gives the author of a thread full access when they hold read + runAgent", async () => {
    for (const role of ROLES.filter((r) => roleCan(r, "runAgent"))) {
      asRole(role);
      const access = await resolveThreadAccess("author", thread);
      expect(access, role).toMatchObject({ level: "author", canWrite: true, canDecidePlan: true, canReadContent: true, readOnly: false });
    }
  });

  it("lets the PI and study owner read another user's thread, read-only", async () => {
    for (const role of ["PRINCIPAL_INVESTIGATOR", "STUDY_OWNER"] as const) {
      asRole(role);
      const access = await resolveThreadAccess("someone-else", thread);
      expect(access).toMatchObject({ level: "manager", canReadContent: true, canWrite: false, canDecidePlan: false, readOnly: true, canArchive: true });
    }
  });

  it("gives other runAgent roles no access to someone else's thread", async () => {
    for (const role of ["STUDY_COORDINATOR", "DATA_SCIENTIST", "PIPELINE_DEVELOPER"] as const) {
      asRole(role);
      expect(await resolveThreadAccess("someone-else", thread), role).toBeNull();
    }
  });

  it("gives audit-only roles metadata only, never content", async () => {
    for (const role of ["AUDITOR", "CLINICAL_LEAD", "ETHICS_REVIEWER", "PRIVACY_SECURITY_OFFICER", "RELEASE_APPROVER"] as const) {
      asRole(role);
      const access = await resolveThreadAccess("someone-else", thread);
      expect(access, role).toMatchObject({ level: "auditor", canReadContent: false, canWrite: false, canArchive: false, readOnly: true });
    }
  });

  it("treats an author who lost runAgent as an auditor or nobody, not as author", async () => {
    asRole("AUDITOR");
    expect((await resolveThreadAccess("author", thread))?.level).toBe("auditor");
    asRole("SITE_ADMIN");
    expect(await resolveThreadAccess("author", thread)).toBeNull();
  });

  it("refuses outsiders", async () => {
    asRole(null);
    expect(await resolveThreadAccess("author", thread)).toBeNull();
    await expect(assertCanUseAgentThreads("x", "s1")).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("requires read + runAgent to create threads", async () => {
    asRole("DATA_SCIENTIST");
    await expect(assertCanUseAgentThreads("x", "s1")).resolves.toBeUndefined();
    asRole("AUDITOR");
    await expect(assertCanUseAgentThreads("x", "s1")).rejects.toMatchObject({ name: "ForbiddenError" });
    asRole("SITE_ADMIN");
    await expect(assertCanUseAgentThreads("x", "s1")).rejects.toMatchObject({ name: "ForbiddenError" });
  });
});
