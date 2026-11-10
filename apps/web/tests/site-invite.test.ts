import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  userId: { current: "actor" },
  actorRoles: { current: ["PRINCIPAL_INVESTIGATOR"] as string[] },
  siteStudyId: { current: "s1" },
  siteStatus: { current: "INVITED" },
  invitation: { current: null as null | Record<string, unknown> },
  userEmail: { current: "nurse@hospital.org" },
  created: vi.fn(),
  waiting: { current: null as null | { id: string } },
  existingMember: { current: null as null | { id: string } },
  invitationUpdate: vi.fn(),
  siteMemberUpsert: vi.fn(),
  studyMemberCreate: vi.fn(),
  orgMembershipUpsert: vi.fn(),
  emailArgs: vi.fn(),
  auditCalls: vi.fn()
}));

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: h.userId.current }) }));
vi.mock("@/lib/audit", () => ({ audit: async (input: unknown) => h.auditCalls(input) }));
vi.mock("@/lib/email", () => ({ sendInvitationEmail: async (input: unknown) => (h.emailArgs(input), true) }));
vi.mock("@/lib/runtime-config", () => ({ publicBaseUrl: () => "http://x" }));
vi.mock("@/lib/prisma", () => {
  const tx = {
    siteMember: { upsert: (...a: unknown[]) => h.siteMemberUpsert(...a) },
    studyMember: { createMany: (...a: unknown[]) => h.studyMemberCreate(...a) },
    orgMembership: { upsert: (...a: unknown[]) => h.orgMembershipUpsert(...a) },
    invitation: { update: (...a: unknown[]) => h.invitationUpdate(...a) }
  };
  return {
    prisma: {
      user: {
        findUnique: async (args: { where: { id?: string }; select?: { email?: boolean; name?: boolean } }) =>
          args.select?.email ? { email: h.userEmail.current } : args.select?.name ? { name: "Coordinator Kim" } : { platformRole: "USER" }
      },
      study: {
        findUnique: async () => ({
          id: "s1",
          orgId: "o1",
          title: "Sepsis study",
          createdBy: { name: "Dr Lead" },
          organization: { memberships: [] },
          members: h.actorRoles.current.map((role) => ({ role }))
        })
      },
      studySite: {
        findUnique: async () => ({ id: "ss1", studyId: h.siteStudyId.current, name: "General Hospital", participationStatus: h.siteStatus.current })
      },
      invitation: {
        create: async (args: { data: Record<string, unknown> }) => (h.created(args), { id: "i1", ...args.data }),
        findUnique: async () => h.invitation.current,
        findFirst: async () => h.waiting.current,
        update: (...a: unknown[]) => h.invitationUpdate(...a)
      },
      siteMember: { findFirst: async () => h.existingMember.current },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx)
    }
  };
});

import { POST as create } from "@/app/api/v1/studies/[studyId]/invitations/route";
import { POST as accept } from "@/app/api/v1/invitations/accept/route";

const invite = async (body: Record<string, unknown>) =>
  (await create(new NextRequest("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ studyId: "s1" }) })) as Response;
const acceptInvite = async () =>
  (await accept(new NextRequest("http://x", { method: "POST", body: JSON.stringify({ invitationId: "i1" }) }))) as Response;

const pendingSiteInvitation = () => ({
  id: "i1",
  studyId: "s1",
  orgId: "o1",
  email: "nurse@hospital.org",
  role: "AUDITOR",
  roles: [],
  studySiteId: "ss1",
  siteRoles: ["SITE_ADMIN", "SITE_PI"],
  status: "PENDING",
  expiresAt: new Date(Date.now() + 86_400_000),
  invitedById: "actor"
});

beforeEach(() => {
  vi.clearAllMocks();
  h.userId.current = "actor";
  h.actorRoles.current = ["PRINCIPAL_INVESTIGATOR"];
  h.siteStudyId.current = "s1";
  h.siteStatus.current = "INVITED";
  h.userEmail.current = "nurse@hospital.org";
  h.invitation.current = pendingSiteInvitation();
  h.waiting.current = null;
  h.existingMember.current = null;
});

describe("creating a site invitation", () => {
  it("defaults to the Site contact roles, attaches no study roles and sends the site email", async () => {
    const response = await invite({ email: "Nurse@Hospital.org", studySiteId: "ss1" });
    expect(response.status).toBe(201);
    const data = h.created.mock.calls[0][0].data;
    expect(data).toMatchObject({ email: "nurse@hospital.org", studySiteId: "ss1", siteRoles: ["SITE_ADMIN", "SITE_PI"], roles: [] });
    expect(h.emailArgs.mock.calls[0][0]).toMatchObject({ siteName: "General Hospital", studyTitle: "Sepsis study" });
    expect(h.auditCalls.mock.calls[0][0].action).toBe("invitation.site.create");
    expect((await response.json()).inviteUrl).toContain("/signin?invite=");
  });

  it("needs the manage sites permission", async () => {
    h.actorRoles.current = ["DATA_SCIENTIST"];
    expect((await invite({ email: "a@b.org", studySiteId: "ss1" })).status).toBe(403);
    expect(h.created).not.toHaveBeenCalled();
  });

  it("works for a coordinator, who can manage sites without being able to grant lead roles", async () => {
    h.actorRoles.current = ["STUDY_COORDINATOR"];
    expect((await invite({ email: "a@b.org", studySiteId: "ss1" })).status).toBe(201);
  });

  it("refuses a site from another study", async () => {
    h.siteStudyId.current = "other-study";
    expect((await invite({ email: "a@b.org", studySiteId: "ss1" })).status).toBe(404);
    expect(h.created).not.toHaveBeenCalled();
  });

  it("refuses a turned-off site", async () => {
    h.siteStatus.current = "DISABLED";
    expect((await invite({ email: "a@b.org", studySiteId: "ss1" })).status).toBe(409);
  });

  it("does not send the token hash back or show the placeholder role", async () => {
    const body = await (await invite({ email: "a@b.org", studySiteId: "ss1" })).json();
    expect(body.invitation.tokenHash).toBeUndefined();
    expect(body.invitation.role).toBeNull();
  });

  it("refuses a second invitation while one is waiting, and a person who already has access", async () => {
    h.waiting.current = { id: "i0" };
    expect((await invite({ email: "a@b.org", studySiteId: "ss1" })).status).toBe(409);
    h.waiting.current = null;
    h.existingMember.current = { id: "m1" };
    expect((await invite({ email: "a@b.org", studySiteId: "ss1" })).status).toBe(409);
    expect(h.created).not.toHaveBeenCalled();
  });

  it("names the person who sent it, not the study creator", async () => {
    await invite({ email: "a@b.org", studySiteId: "ss1" });
    expect(h.emailArgs.mock.calls[0][0].inviterName).toBe("Coordinator Kim");
  });

  it("ignores study roles sent along with a site invitation", async () => {
    await invite({ email: "a@b.org", studySiteId: "ss1", roles: ["PRINCIPAL_INVESTIGATOR"] });
    expect(h.created.mock.calls[0][0].data.roles).toEqual([]);
  });

  it("leaves the study-role path unchanged, including the grant rule", async () => {
    h.actorRoles.current = ["STUDY_COORDINATOR"];
    expect((await invite({ email: "a@b.org", roles: ["PRINCIPAL_INVESTIGATOR"] })).status).toBe(403);
    h.actorRoles.current = ["PRINCIPAL_INVESTIGATOR"];
    const ok = await invite({ email: "a@b.org", roles: ["DATA_SCIENTIST", "PIPELINE_DEVELOPER"] });
    expect(ok.status).toBe(201);
    const data = h.created.mock.calls.at(-1)?.[0].data;
    expect(data.roles).toEqual(["DATA_SCIENTIST", "PIPELINE_DEVELOPER"]);
    expect(data.studySiteId).toBeUndefined();
    expect(h.emailArgs.mock.calls.at(-1)?.[0].siteName).toBeUndefined();
  });
});

describe("accepting a site invitation", () => {
  beforeEach(() => {
    h.userId.current = "nurse";
  });

  it("creates SiteMember rows for that site only and returns the site id", async () => {
    const response = await acceptInvite();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ siteId: "ss1" });
    expect(h.siteMemberUpsert).toHaveBeenCalledTimes(2);
    expect(h.siteMemberUpsert.mock.calls.map((call) => call[0].create.role)).toEqual(["SITE_ADMIN", "SITE_PI"]);
    expect(h.siteMemberUpsert.mock.calls[0][0].create).toMatchObject({ studySiteId: "ss1", userId: "nurse" });
    expect(h.invitationUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACCEPTED" }) }));
  });

  it("never creates a study or organisation membership", async () => {
    await acceptInvite();
    expect(h.studyMemberCreate).not.toHaveBeenCalled();
    expect(h.orgMembershipUpsert).not.toHaveBeenCalled();
  });

  it("refuses someone signed in with a different email", async () => {
    h.userEmail.current = "someone-else@hospital.org";
    expect((await acceptInvite()).status).toBe(403);
    expect(h.siteMemberUpsert).not.toHaveBeenCalled();
  });

  it("refuses an expired invitation", async () => {
    h.invitation.current = { ...pendingSiteInvitation(), expiresAt: new Date(Date.now() - 1000) };
    expect((await acceptInvite()).status).toBe(410);
    expect(h.siteMemberUpsert).not.toHaveBeenCalled();
  });

  it("refuses an invitation to a site that has been turned off since", async () => {
    h.siteStatus.current = "DISABLED";
    expect((await acceptInvite()).status).toBe(409);
    expect(h.siteMemberUpsert).not.toHaveBeenCalled();
  });

  it("refuses an invitation that is no longer pending", async () => {
    h.invitation.current = { ...pendingSiteInvitation(), status: "ACCEPTED" };
    expect((await acceptInvite()).status).toBe(409);
  });

  it("still gives a study invitation the study and organisation membership", async () => {
    h.invitation.current = { ...pendingSiteInvitation(), studySiteId: null, siteRoles: [], roles: ["DATA_SCIENTIST"] };
    const response = await acceptInvite();
    expect(await response.json()).toEqual({ studyId: "s1" });
    expect(h.studyMemberCreate).toHaveBeenCalledTimes(1);
    expect(h.orgMembershipUpsert).toHaveBeenCalledTimes(1);
    expect(h.siteMemberUpsert).not.toHaveBeenCalled();
  });
});
