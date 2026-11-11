import { describe, expect, it } from "vitest";
import { landingFor } from "@/lib/landing";

const defaultStudy = { study: { defaultStudy: true, createdById: "u1", _count: { studySites: 0, pipelineProjects: 0 } } };
const base = { userId: "u1", platformRole: "USER", siteCount: 1, studyMembers: [], orgMemberships: [] as { role: string; status?: string; organization: { slug: string } }[] };

describe("landingFor", () => {
  it("sends a new person with no study and no site to the dashboard, which opens Study management", () => {
    const fresh = { ...base, siteCount: 0, orgMemberships: [{ role: "ORG_ADMIN", organization: { slug: "personal-u1" } }] };
    expect(landingFor(fresh)).toBe("/dashboard");
  });

  it("sends a site-only person to My site", () => {
    expect(landingFor(base)).toBe("/my-site");
  });

  it("ignores their own untouched default study and personal organisation", () => {
    expect(landingFor({ ...base, studyMembers: [defaultStudy, defaultStudy], orgMemberships: [{ role: "ORG_ADMIN", organization: { slug: "personal-u1" } }] })).toBe("/my-site");
  });

  it("keeps the dashboard once the default study has been used", () => {
    const used = { study: { defaultStudy: true, createdById: "u1", _count: { studySites: 1, pipelineProjects: 0 } } };
    expect(landingFor({ ...base, studyMembers: [used] })).toBe("/dashboard");
  });

  it("keeps the dashboard for anyone on someone else's study", () => {
    expect(landingFor({ ...base, studyMembers: [{ study: { defaultStudy: false, createdById: "boss" } }] })).toBe("/dashboard");
  });

  it("keeps the dashboard for people with no site, platform staff and shared-organisation admins", () => {
    expect(landingFor({ ...base, siteCount: 0 })).toBe("/dashboard");
    expect(landingFor({ ...base, platformRole: "PLATFORM_ADMIN" })).toBe("/dashboard");
    expect(landingFor({ ...base, orgMemberships: [{ role: "ORG_ADMIN", organization: { slug: "hospital" } }] })).toBe("/dashboard");
    expect(landingFor({ ...base, orgMemberships: [{ role: "MEMBER", organization: { slug: "hospital" } }] })).toBe("/my-site");
  });
});

describe("landing with a waiting site invitation", () => {
  const untouched = { study: { defaultStudy: true, createdById: "u1", _count: { studySites: 0, pipelineProjects: 0 } } };
  const base = { userId: "u1", siteCount: 0, studyMembers: [untouched], orgMemberships: [] };
  it("sends a new person with an invitation waiting to My site", () => {
    expect(landingFor({ ...base, pendingSiteInvite: true })).toBe("/my-site");
    expect(landingFor(base)).toBe("/dashboard");
  });
  it("leaves a person who is working on a real study on the dashboard", () => {
    const real = { study: { defaultStudy: false, createdById: "u1", _count: { studySites: 1, pipelineProjects: 0 } } };
    expect(landingFor({ ...base, studyMembers: [real], pendingSiteInvite: true })).toBe("/dashboard");
    const working = { study: { defaultStudy: true, createdById: "u1", _count: { studySites: 0, pipelineProjects: 2 } } };
    expect(landingFor({ ...base, studyMembers: [working], pendingSiteInvite: true })).toBe("/dashboard");
  });
});
