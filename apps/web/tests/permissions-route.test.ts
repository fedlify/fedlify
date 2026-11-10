import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  studyRoles: { current: [] as string[] },
  siteRoles: { current: [] as string[] },
  siteExists: { current: true }
}));

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: async () => ({ platformRole: "USER" }) },
    study: {
      findUnique: async () => ({
        orgId: "o1",
        members: h.studyRoles.current.map((role) => ({ role })),
        organization: { memberships: [] }
      })
    },
    studySite: {
      findUnique: async () => (h.siteExists.current ? { id: "ss1", studyId: "s1", members: h.siteRoles.current.map((role) => ({ role })) } : null)
    }
  }
}));

import { GET as studyPermissions } from "@/app/api/v1/studies/[studyId]/permissions/route";
import { GET as sitePermissions } from "@/app/api/v1/sites/[siteId]/permissions/route";
import { SITE_ACTIONS, STUDY_ACTIONS } from "@/lib/rbac";

const studyCan = async () => (await ((await studyPermissions({} as never, { params: Promise.resolve({ studyId: "s1" }) })) as Response).json()) as { can: Record<string, boolean> };
const siteCan = async () => (await ((await sitePermissions({} as never, { params: Promise.resolve({ siteId: "ss1" }) })) as Response).json()) as { can: Record<string, boolean>; backHref: string | null };

beforeEach(() => {
  h.studyRoles.current = [];
  h.siteRoles.current = [];
  h.siteExists.current = true;
});

describe("study permissions route", () => {
  it("returns every study action, all false without access", async () => {
    const { can } = await studyCan();
    expect(Object.keys(can).sort()).toEqual([...STUDY_ACTIONS].sort());
    expect(Object.values(can).every((value) => value === false)).toBe(true);
  });

  it("reflects the person's study roles", async () => {
    h.studyRoles.current = ["DATA_SCIENTIST"];
    const { can } = await studyCan();
    expect(can.runAgent).toBe(true);
    expect(can.approvePipeline).toBe(false);
    expect(can.manageSites).toBe(false);
  });
});

describe("site permissions route", () => {
  it("returns every site action", async () => {
    h.siteRoles.current = ["SITE_ADMIN", "SITE_PI"];
    const { can } = await siteCan();
    expect(Object.keys(can).sort()).toEqual([...SITE_ACTIONS].sort());
  });

  it("gives a site-only contact the install and sign-off actions and sends them back to My site", async () => {
    h.siteRoles.current = ["SITE_ADMIN", "SITE_PI"];
    const { can, backHref } = await siteCan();
    expect(can.downloadJoinKit).toBe(true);
    expect(can.acceptSitePolicy).toBe(true);
    expect(can.manageProfile).toBe(true);
    expect(backHref).toBe("/my-site");
  });

  it("sends a study lead back to the study's Sites page", async () => {
    h.studyRoles.current = ["PRINCIPAL_INVESTIGATOR"];
    const { can, backHref } = await siteCan();
    expect(can.rotateSiteToken).toBe(true);
    expect(backHref).toBe("/studies/s1?section=sites");
  });

  it("answers no access with all false and no back link", async () => {
    const { can, backHref } = await siteCan();
    expect(Object.values(can).every((value) => value === false)).toBe(true);
    expect(backHref).toBeNull();
    h.siteExists.current = false;
    expect((await siteCan()).backHref).toBeNull();
  });

  it("limits a PI-only site person to sign-off, not installing", async () => {
    h.siteRoles.current = ["SITE_PI"];
    const { can } = await siteCan();
    expect(can.acceptSitePolicy).toBe(true);
    expect(can.downloadJoinKit).toBe(false);
  });
});
