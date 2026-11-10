import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  platformRole: "USER" as string,
  members: [] as Array<{ role: string }>,
  orgAdmin: false,
  userQueries: 0,
  studyQueries: 0
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: async () => {
        h.userQueries += 1;
        return { platformRole: h.platformRole };
      }
    },
    study: {
      findUnique: async () => {
        h.studyQueries += 1;
        return { orgId: "o1", members: h.members, organization: { memberships: h.orgAdmin ? [{ role: "ORG_ADMIN" }] : [] } };
      }
    }
  }
}));

import { canAccessStudy, canAccessStudyActions } from "@/lib/rbac";

beforeEach(() => {
  h.platformRole = "USER";
  h.members = [];
  h.orgAdmin = false;
  h.userQueries = 0;
  h.studyQueries = 0;
});

describe("canAccessStudyActions", () => {
  it("answers several actions with one lookup of the user and the study", async () => {
    h.members = [{ role: "PRINCIPAL_INVESTIGATOR" }];
    const can = await canAccessStudyActions("u1", "s1", ["manage", "submitJob", "approveRelease"] as const);
    expect(can).toEqual({ manage: true, submitJob: true, approveRelease: true });
    expect(h.userQueries).toBe(1);
    expect(h.studyQueries).toBe(1);
  });

  it("gives a person with no study role nothing, and a platform admin everything without asking the study", async () => {
    expect(await canAccessStudyActions("u1", "s1", ["read", "manage"] as const)).toEqual({ read: false, manage: false });
    h.platformRole = "PLATFORM_ADMIN";
    h.studyQueries = 0;
    expect(await canAccessStudyActions("u1", "s1", ["read", "manage"] as const)).toEqual({ read: true, manage: true });
    expect(h.studyQueries).toBe(0);
  });

  it("keeps the org admin rule: no release, publish or run rights without a study role", async () => {
    h.orgAdmin = true;
    const can = await canAccessStudyActions("u1", "s1", ["manage", "approvePipeline", "submitJob"] as const);
    expect(can).toEqual({ manage: true, approvePipeline: false, submitJob: false });
    expect(await canAccessStudy("u1", "s1", "manage")).toBe(true);
    expect(await canAccessStudy("u1", "s1", "submitJob")).toBe(false);
  });
});
