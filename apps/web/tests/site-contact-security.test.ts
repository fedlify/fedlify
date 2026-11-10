import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  userId: { current: "contact" },
  studyActions: { current: {} as Record<string, boolean> },
  siteActions: { current: {} as Record<string, boolean> },
  remainingAdmins: { current: 0 },
  userByEmail: { current: null as null | { id: string } },
  deleted: vi.fn(),
  upserted: vi.fn(),
  invitation: { current: null as null | Record<string, unknown> },
  invitationUpdate: vi.fn(),
  releaseArgs: vi.fn(),
  pipelineArgs: vi.fn(),
  memberArgs: vi.fn()
}));

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: h.userId.current }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/site-presence", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/site-presence")>()), markStaleSitesOffline: async () => undefined }));
vi.mock("@/lib/study-runtime", () => ({
  adapterSystemInfo: async () => ({ clients: [] }),
  nvflareClientName: () => "site-1"
}));
vi.mock("@/lib/rbac", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac")>();
  const forbid = () => {
    const error = new Error("no");
    error.name = "ForbiddenError";
    throw error;
  };
  return {
    ...actual,
    assertSiteAccess: async (_u: string, _s: string, action: string) => (h.siteActions.current[action] ? undefined : forbid()),
    assertStudyAccess: async (_u: string, _s: string, action: string) => (h.studyActions.current[action] ? undefined : forbid()),
    canAccessSite: async (_u: string, _s: string, action: string) => Boolean(h.siteActions.current[action]),
    canAccessStudy: async (_u: string, _s: string, action: string) => Boolean(h.studyActions.current[action])
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    studySite: {
      findUnique: async () => ({
        id: "ss1",
        studyId: "s1",
        siteId: "site-1",
        code: "hosp",
        study: { orgId: "o1" },
        site: { nvflareClientName: "site-1", heartbeats: [] },
        joinPackages: []
      })
    },
    user: { findUnique: async () => h.userByEmail.current },
    siteMember: {
      findMany: async (args: unknown) => (h.memberArgs(args), []),
      count: async () => h.remainingAdmins.current,
      deleteMany: async () => (h.deleted(), { count: 1 }),
      upsert: async () => (h.upserted(), { id: "m1", role: "SITE_ADMIN" })
    },
    invitation: {
      findMany: async () => [],
      findUnique: async () => h.invitation.current,
      update: async (args: unknown) => (h.invitationUpdate(args), {})
    },
    kitRelease: { findMany: async (args: unknown) => (h.releaseArgs(args), []) },
    pipelineVersion: { findMany: async (args: unknown) => (h.pipelineArgs(args), []), findUnique: async () => null },
    nvflareDeployment: {
      findFirst: async () => ({
        id: "d1",
        status: "ACTIVE",
        pipelineVersionId: null,
        updatedAt: new Date(),
        serverAddress: "secret.example",
        adminStartupKitStorageKey: "keys/admin",
        provisionedSites: ["other-hospital"],
        adapterUrl: "http://adapter",
        hostname: "h"
      })
    },
    auditEvent: { findMany: async () => [] }
  }
}));

import { GET as getSite } from "@/app/api/v1/sites/[siteId]/route";
import { DELETE as removeMember, POST as addMember } from "@/app/api/v1/sites/[siteId]/members/route";
import { DELETE as revoke } from "@/app/api/v1/studies/[studyId]/invitations/[invitationId]/route";

const ctx = { params: Promise.resolve({ siteId: "ss1" }) };
const call = <A extends unknown[]>(fn: (...a: A) => Promise<Response | void> | Response | void, ...a: A) => Promise.resolve(fn(...a)) as Promise<Response>;
const req = (method: string, body?: unknown) => new NextRequest("http://x", { method, body: body ? JSON.stringify(body) : undefined });

beforeEach(() => {
  vi.clearAllMocks();
  h.userId.current = "contact";
  h.studyActions.current = {};
  h.siteActions.current = { read: true, assignMembers: true };
  h.remainingAdmins.current = 0;
  h.userByEmail.current = null;
  h.invitation.current = null;
});

describe("GET /sites/[siteId] for a site contact", () => {
  it("returns only the minimal deployment row and no study server secrets", async () => {
    const body = await (await call(getSite, req("GET"), ctx)).json();
    expect(body.activeDeployment).toEqual({ id: "d1", status: "ACTIVE", pipelineVersionId: null, updatedAt: expect.anything() });
    expect(JSON.stringify(body)).not.toContain("secret.example");
    expect(JSON.stringify(body)).not.toContain("keys/admin");
    expect(JSON.stringify(body)).not.toContain("other-hospital");
  });

  it("selects artifacts for this site only, without storage keys, and slim pipeline versions", async () => {
    await call(getSite, req("GET"), ctx);
    const release = h.releaseArgs.mock.calls[0][0];
    expect(release.include).toBeUndefined();
    expect(release.select.artifacts.where.OR).toEqual([{ siteId: null }, { siteId: "site-1" }]);
    expect(release.select.artifacts.select.storageKey).toBeUndefined();
    expect(h.pipelineArgs.mock.calls[0][0].include).toBeUndefined();
  });

  it("lists everyone on the site for a site administrator, only themselves for anyone else", async () => {
    await call(getSite, req("GET"), ctx);
    expect(h.memberArgs.mock.calls[0][0].where).toEqual({ studySiteId: "ss1" });
    h.siteActions.current = { read: true };
    await call(getSite, req("GET"), ctx);
    expect(h.memberArgs.mock.calls[1][0].where).toEqual({ studySiteId: "ss1", userId: "contact" });
  });

  it("keeps the full rows for the study team", async () => {
    h.studyActions.current = { read: true, manageSites: true };
    const body = await (await call(getSite, req("GET"), ctx)).json();
    expect(body.activeDeployment.serverAddress).toBe("secret.example");
    expect(h.releaseArgs.mock.calls[0][0].include).toEqual({ artifacts: true });
  });
});

describe("adding and removing site members", () => {
  it("adding a person directly is for the study team, not site staff", async () => {
    expect((await call(addMember, req("POST", { email: "a@b.org", role: "SITE_ADMIN" }), ctx)).status).toBe(403);
    expect(h.upserted).not.toHaveBeenCalled();
  });

  it("gives the same answer whether or not the address has an account", async () => {
    h.studyActions.current = { manageSites: true };
    const unknown = await call(addMember, req("POST", { email: "a@b.org", role: "SITE_ADMIN" }), ctx);
    h.userByEmail.current = { id: "u9" };
    const known = await call(addMember, req("POST", { email: "a@b.org", role: "SITE_ADMIN" }), ctx);
    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
  });

  it("stops site staff from removing the last site administrator", async () => {
    const response = await call(removeMember, req("DELETE", { userId: "contact" }), ctx);
    expect(response.status).toBe(409);
    expect(h.deleted).not.toHaveBeenCalled();
  });

  it("allows it when another administrator remains, or for the study team", async () => {
    h.remainingAdmins.current = 1;
    expect((await call(removeMember, req("DELETE", { userId: "contact" }), ctx)).status).toBe(200);
    h.remainingAdmins.current = 0;
    h.studyActions.current = { manageSites: true };
    expect((await call(removeMember, req("DELETE", { userId: "contact" }), ctx)).status).toBe(200);
  });
});

describe("cancelling an invitation", () => {
  const revokeCtx = { params: Promise.resolve({ studyId: "s1", invitationId: "i1" }) };
  const pending = (extra: Record<string, unknown> = {}) => ({ id: "i1", studyId: "s1", orgId: "o1", email: "a@b.org", studySiteId: "ss1", status: "PENDING", ...extra });

  it("needs manage sites for a site invitation and marks it revoked", async () => {
    h.invitation.current = pending();
    expect((await call(revoke, req("DELETE"), revokeCtx)).status).toBe(403);
    h.studyActions.current = { manageSites: true };
    expect((await call(revoke, req("DELETE"), revokeCtx)).status).toBe(200);
    expect(h.invitationUpdate).toHaveBeenCalledWith({ where: { id: "i1" }, data: { status: "REVOKED" } });
  });

  it("cannot reach an invitation of another study", async () => {
    h.studyActions.current = { manageSites: true, invite: true };
    h.invitation.current = pending({ studyId: "other" });
    expect((await call(revoke, req("DELETE"), revokeCtx)).status).toBe(404);
  });

  it("refuses one that is no longer waiting", async () => {
    h.studyActions.current = { manageSites: true };
    h.invitation.current = pending({ status: "ACCEPTED" });
    expect((await call(revoke, req("DELETE"), revokeCtx)).status).toBe(409);
  });
});
