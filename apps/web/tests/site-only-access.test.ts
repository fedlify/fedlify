import { beforeEach, describe, expect, it, vi } from "vitest";

// A person with site memberships (two sites in one study) and no study membership.
const h = vi.hoisted(() => ({ off: { current: false }, memberships: { current: [] as { studySiteId: string; studyId: string; role: string }[] } }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: async () => ({ platformRole: "USER" }) },
    study: { findUnique: async () => ({ orgId: "o1", members: [], organization: { memberships: [] } }) },
    studySite: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const rows = h.memberships.current.filter((m) => m.studySiteId === where.id);
        const known = ["ss1", "ss2", "ss3"].includes(where.id);
        return known ? { id: where.id, studyId: where.id === "ss3" ? "other" : "s1", participationStatus: where.id === "ss2" && h.off.current ? "DISABLED" : "ACTIVE", members: rows.map((m) => ({ role: m.role })) } : null;
      }
    },
    siteMember: {
      findMany: async ({ where }: { where: { studySite: { studyId: string } } }) =>
        h.memberships.current.filter((m) => m.studyId === where.studySite.studyId).map((m) => ({ role: m.role }))
    }
  }
}));

import { canAccessAnyStudySite, canAccessSite, canAccessStudy } from "@/lib/rbac";

beforeEach(() => {
  h.off.current = false;
  h.memberships.current = [
    { studySiteId: "ss1", studyId: "s1", role: "SITE_PI" },
    { studySiteId: "ss2", studyId: "s1", role: "SITE_ADMIN" }
  ];
});

describe("a turned-off site", () => {
  it("gives its own members nothing, and the study-wide lookup skips it", async () => {
    h.off.current = true;
    expect(await canAccessSite("u", "ss2", "read")).toBe(false);
    h.off.current = false;
    expect(await canAccessSite("u", "ss2", "read")).toBe(true);
  });
});

describe("site-only access", () => {
  it("lets a site contact use their site but not another site or the study", async () => {
    expect(await canAccessSite("u", "ss2", "read")).toBe(true);
    expect(await canAccessSite("u", "ss2", "downloadJoinKit")).toBe(true);
    expect(await canAccessSite("u", "ss1", "acceptSitePolicy")).toBe(true);
    expect(await canAccessSite("u", "ss1", "downloadJoinKit")).toBe(false);
    expect(await canAccessSite("u", "ss3", "read")).toBe(false);
    expect(await canAccessStudy("u", "s1", "read")).toBe(false);
  });

  it("canAccessAnyStudySite looks at every site membership, not just the first", async () => {
    // The first membership is PI-only (cannot download the kit); the second site's admin role can.
    expect(await canAccessAnyStudySite("u", "s1", "downloadJoinKit")).toBe(true);
    expect(await canAccessAnyStudySite("u", "s1", "rotateSiteToken")).toBe(true);
    expect(await canAccessAnyStudySite("u", "other", "read")).toBe(false);
  });

  it("gives nothing to a person with no site membership", async () => {
    h.memberships.current = [];
    expect(await canAccessAnyStudySite("u", "s1", "read")).toBe(false);
    expect(await canAccessSite("u", "ss1", "read")).toBe(false);
  });
});
