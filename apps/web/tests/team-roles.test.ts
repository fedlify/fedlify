import { describe, expect, it } from "vitest";
import { buildInviteBody, canGrantFullAccess, groupMembers, invitationSummary, roleDisabledReason, siteContactRows, CANNOT_GRANT_MESSAGE } from "@/lib/team-roles";

describe("team-roles", () => {
  it("groups roles per person and sorts by name", () => {
    const rows = groupMembers([
      { role: "DATA_SCIENTIST", user: { id: "u2", name: "Zed", email: "z@x.ca" } },
      { role: "DATA_SCIENTIST", user: { id: "u1", name: "Amy", email: "a@x.ca" } },
      { role: "PIPELINE_DEVELOPER", user: { id: "u1", name: "Amy", email: "a@x.ca" } }
    ]);
    expect(rows.map((row) => row.name)).toEqual(["Amy", "Zed"]);
    expect(rows[0].roles).toEqual(["DATA_SCIENTIST", "PIPELINE_DEVELOPER"]);
  });

  it("lists site contacts per site", () => {
    const rows = siteContactRows([
      { id: "s1", name: "Hospital A", members: [{ role: "SITE_ADMIN", user: { id: "u1", name: "Amy" } }, { role: "SITE_PI", user: { id: "u1", name: "Amy" } }] },
      { id: "s2", name: "Hospital B", members: [] }
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ siteName: "Hospital A", siteRoles: ["SITE_ADMIN", "SITE_PI"] });
  });

  it("describes invitations in plain words", () => {
    expect(invitationSummary({ studySiteId: "s1", siteName: "Hospital A", siteRoles: ["SITE_ADMIN", "SITE_PI"], roles: [] }).label).toBe("Site contact for Hospital A");
    expect(invitationSummary({ roles: ["AUDITOR"] }).label).toBe("Observer");
    expect(invitationSummary({ roles: ["ETHICS_REVIEWER"] })).toMatchObject({ label: "Custom", detail: "Ethics reviewer" });
  });

  it("disables roles the person cannot give", () => {
    const coordinator = { invite: true, manageSites: true, read: true, approveRelease: false };
    expect(roleDisabledReason("STUDY_LEAD", coordinator, { siteCount: 1 })).toBe(CANNOT_GRANT_MESSAGE);
    expect(roleDisabledReason("RESEARCHER", coordinator, { siteCount: 1 })).toBeNull();
    expect(roleDisabledReason("SITE_CONTACT", coordinator, { siteCount: 0 })).toBe("Add a site first.");
    expect(roleDisabledReason("SITE_CONTACT", { invite: true }, { siteCount: 2 })).toMatch(/permission/);
    expect(canGrantFullAccess({ a: true, b: true })).toBe(true);
    expect(canGrantFullAccess({})).toBe(false);
  });

  it("builds invitation bodies", () => {
    expect(buildInviteBody({ email: " a@x.ca ", choice: "RESEARCHER" })).toEqual({ body: { email: "a@x.ca", roles: ["DATA_SCIENTIST", "PIPELINE_DEVELOPER"] } });
    expect(buildInviteBody({ email: "a@x.ca", choice: "SITE_CONTACT", studySiteId: "s1" })).toEqual({ body: { email: "a@x.ca", studySiteId: "s1", siteRoles: ["SITE_ADMIN", "SITE_PI"] } });
    expect(buildInviteBody({ email: "a@x.ca", choice: "SITE_CONTACT" })).toHaveProperty("error");
    expect(buildInviteBody({ email: "a@x.ca", choice: "ADVANCED", advancedRoles: [] })).toHaveProperty("error");
    expect(buildInviteBody({ email: "", choice: "OBSERVER" })).toHaveProperty("error");
  });
});
