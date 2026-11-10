import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ user: { current: null as unknown }, sites: { current: [] as unknown[] } }));
vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: async () => h.user.current },
    siteMember: { findMany: async () => h.sites.current }
  }
}));

import { GET } from "@/app/api/v1/me/route";

const site = (role: string) => ({ studySiteId: "ss1", role, studySite: { name: "General Hospital", study: { title: "Sepsis study" } } });
const call = async () => (await GET()) as Response;

beforeEach(() => {
  h.user.current = {
    id: "u1",
    platformRole: "USER",
    orgMemberships: [{ role: "ORG_ADMIN", organization: { slug: "personal-u1" } }],
    studyMembers: [{ role: "PRINCIPAL_INVESTIGATOR", study: { defaultStudy: true, createdById: "u1", _count: { studySites: 0, pipelineProjects: 0 } } }]
  };
  h.sites.current = [site("SITE_ADMIN"), site("SITE_PI")];
});

describe("GET /api/v1/me", () => {
  it("lists the person's sites (roles merged) and lands them on My site", async () => {
    const body = await (await call()).json();
    expect(body.sites).toEqual([{ studySiteId: "ss1", name: "General Hospital", studyTitle: "Sepsis study", roles: ["SITE_ADMIN", "SITE_PI"] }]);
    expect(body.landing).toBe("/my-site");
  });

  it("uses the usual landing without site memberships", async () => {
    h.sites.current = [];
    const body = await (await call()).json();
    expect(body.sites).toEqual([]);
    expect(body.landing).toBe("/dashboard");
  });

  it("uses the usual landing when the person also works on a real study", async () => {
    (h.user.current as { studyMembers: unknown[] }).studyMembers.push({ role: "DATA_SCIENTIST", study: { defaultStudy: false, createdById: "boss" } });
    expect((await (await call()).json()).landing).toBe("/dashboard");
  });
});

describe("GET /api/v1/me secrets", () => {
  it("asks the database to leave the password hash out", async () => {
    const source = (await import("node:fs")).readFileSync(new URL("../src/app/api/v1/me/route.ts", import.meta.url), "utf8");
    expect(source).toMatch(/omit:\s*\{\s*passwordHash:\s*true\s*\}/);
  });
});
