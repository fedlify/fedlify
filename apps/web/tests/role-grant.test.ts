import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  platformRole: { current: "USER" },
  orgAdmin: { current: false },
  actorRoles: { current: [] as string[] },
  targetRoles: { current: [] as string[] },
  otherLeads: { current: 1 },
  deleteMany: vi.fn(),
  createMany: vi.fn(),
  invitationCreate: vi.fn(),
  txOptions: vi.fn()
}));

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "actor" }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/email", () => ({ sendInvitationEmail: async () => true }));
vi.mock("@/lib/runtime-config", () => ({ publicBaseUrl: () => "http://x" }));
vi.mock("@/lib/prisma", () => {
  const tx = {
    studyMember: { count: async () => h.otherLeads.current, deleteMany: (...a: unknown[]) => h.deleteMany(...a), createMany: (...a: unknown[]) => h.createMany(...a) }
  };
  return {
    prisma: {
      user: { findUnique: async () => ({ platformRole: h.platformRole.current }) },
      study: {
        findUnique: async () => ({
          id: "s1",
          orgId: "o1",
          title: "Study",
          createdBy: { name: "Ana" },
          organization: { memberships: h.orgAdmin.current ? [{ role: "ORG_ADMIN" }] : [] },
          members: h.actorRoles.current.map((role) => ({ role }))
        })
      },
      studyMember: {
        findMany: async () => h.targetRoles.current.map((role) => ({ role })),
        count: async () => h.otherLeads.current
      },
      invitation: { create: async (args: unknown) => (h.invitationCreate(args), { id: "i1" }) },
      $transaction: async (fn: (t: typeof tx) => unknown, opts?: unknown) => (h.txOptions(opts), fn(tx))
    }
  };
});

import { PATCH } from "@/app/api/v1/studies/[studyId]/members/[userId]/roles/route";
import { POST as invite } from "@/app/api/v1/studies/[studyId]/invitations/route";
import { grantableRoles, ungrantableRoles } from "@/lib/rbac";

const none = { platformAdmin: false, orgAdmin: false };
const patch = async (roles: string[]) =>
  (await PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ roles }) }) as never, { params: Promise.resolve({ studyId: "s1", userId: "target" }) })) as Response;
const post = async (roles: string[]) =>
  (await invite(new NextRequest("http://x", { method: "POST", body: JSON.stringify({ email: "a@b.org", roles }) }) as never, { params: Promise.resolve({ studyId: "s1" }) })) as Response;

beforeEach(() => {
  vi.clearAllMocks();
  h.platformRole.current = "USER";
  h.orgAdmin.current = false;
  h.actorRoles.current = ["STUDY_COORDINATOR"];
  h.targetRoles.current = ["DATA_SCIENTIST"];
  h.otherLeads.current = 1;
});

describe("grantableRoles", () => {
  it("a coordinator cannot grant the lead roles but can grant roles inside their own permissions", () => {
    const actor = { ...none, roles: ["STUDY_COORDINATOR" as const] };
    const grantable = grantableRoles(actor);
    expect(grantable).not.toContain("PRINCIPAL_INVESTIGATOR");
    expect(grantable).not.toContain("STUDY_OWNER");
    expect(grantable).toContain("DATA_SCIENTIST");
    expect(grantable).toContain("STUDY_COORDINATOR");
    expect(ungrantableRoles(actor, ["DATA_SCIENTIST", "PRINCIPAL_INVESTIGATOR", "AUDITOR"])).toEqual(["PRINCIPAL_INVESTIGATOR", "AUDITOR"]);
  });

  it("a principal investigator can grant every role", () => {
    expect(ungrantableRoles({ ...none, roles: ["PRINCIPAL_INVESTIGATOR"] }, ["PRINCIPAL_INVESTIGATOR", "STUDY_OWNER", "AUDITOR", "RELEASE_APPROVER"])).toEqual([]);
  });

  it("platform admins can grant everything, and someone with no study role nothing", () => {
    expect(ungrantableRoles({ platformAdmin: true, orgAdmin: false, roles: [] }, ["PRINCIPAL_INVESTIGATOR"])).toEqual([]);
    expect(grantableRoles({ ...none, roles: [] })).toEqual([]);
  });

  it("an org admin without a study role still cannot hand out release or run rights they do not hold", () => {
    const actor = { platformAdmin: false, orgAdmin: true, roles: [] as never[] };
    expect(ungrantableRoles(actor, ["PRINCIPAL_INVESTIGATOR", "RELEASE_APPROVER"])).toEqual(["PRINCIPAL_INVESTIGATOR", "RELEASE_APPROVER"]);
    expect(ungrantableRoles(actor, ["DATA_SCIENTIST", "ETHICS_REVIEWER"])).toEqual([]);
  });
});

describe("PATCH member roles", () => {
  it("refuses a coordinator making someone a principal investigator, naming the role", async () => {
    const response = await patch(["DATA_SCIENTIST", "PRINCIPAL_INVESTIGATOR"]);
    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toContain("Principal Investigator");
    expect(h.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses a coordinator removing a role they could not grant", async () => {
    h.targetRoles.current = ["PRINCIPAL_INVESTIGATOR", "DATA_SCIENTIST"];
    const response = await patch(["DATA_SCIENTIST"]);
    expect(response.status).toBe(403);
  });

  it("lets a coordinator change a member to a role within their own permissions", async () => {
    const response = await patch(["DATA_SCIENTIST", "PIPELINE_DEVELOPER"]);
    expect(response.status).toBe(200);
    expect(h.createMany).toHaveBeenCalled();
  });

  it("lets a principal investigator grant anything", async () => {
    h.actorRoles.current = ["PRINCIPAL_INVESTIGATOR"];
    expect((await patch(["PRINCIPAL_INVESTIGATOR"])).status).toBe(200);
  });

  it("refuses to remove the last study lead", async () => {
    h.actorRoles.current = ["PRINCIPAL_INVESTIGATOR"];
    h.targetRoles.current = ["PRINCIPAL_INVESTIGATOR"];
    h.otherLeads.current = 0;
    const response = await patch(["DATA_SCIENTIST"]);
    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toBe("A study must keep at least one study lead.");
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.txOptions).toHaveBeenCalledWith({ isolationLevel: "Serializable" });
  });

  it("allows removing a lead when another one remains", async () => {
    h.actorRoles.current = ["PRINCIPAL_INVESTIGATOR"];
    h.targetRoles.current = ["PRINCIPAL_INVESTIGATOR"];
    expect((await patch(["DATA_SCIENTIST"])).status).toBe(200);
  });
});

describe("POST invitations", () => {
  it("refuses a coordinator inviting a principal investigator", async () => {
    const response = await post(["PRINCIPAL_INVESTIGATOR"]);
    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toContain("Principal Investigator");
    expect(h.invitationCreate).not.toHaveBeenCalled();
  });

  it("lets a coordinator invite a data scientist", async () => {
    expect((await post(["DATA_SCIENTIST"])).status).toBe(201);
  });

  it("lets a principal investigator invite any role", async () => {
    h.actorRoles.current = ["PRINCIPAL_INVESTIGATOR"];
    expect((await post(["PRINCIPAL_INVESTIGATOR", "AUDITOR"])).status).toBe(201);
  });
});
