import { describe, expect, it } from "vitest";
import { platformCan, roleCan, siteRoleCan } from "@/lib/rbac";

describe("rbac", () => {
  it("allows study owners to approve releases", () => {
    expect(roleCan("STUDY_OWNER", "approveRelease")).toBe(true);
    expect(roleCan("PRINCIPAL_INVESTIGATOR", "submitJob")).toBe(true);
  });

  it("does not allow data scientists to approve releases", () => {
    expect(roleCan("DATA_SCIENTIST", "approveRelease")).toBe(false);
    expect(roleCan("PIPELINE_DEVELOPER", "approvePipeline")).toBe(false);
  });

  it("keeps auditors read-only", () => {
    expect(roleCan("AUDITOR", "audit")).toBe(true);
    expect(roleCan("AUDITOR", "runAgent")).toBe(false);
    expect(roleCan("AUDITOR", "viewLogs")).toBe(true);
  });

  it("allows platform admins all study actions", () => {
    expect(platformCan("PLATFORM_ADMIN", "approveRelease")).toBe(true);
    expect(platformCan("PLATFORM_ADMIN", "manage")).toBe(true);
  });

  it("separates site startup-kit and pipeline-bundle permissions", () => {
    expect(siteRoleCan("SITE_ENGINEER", "downloadJoinKit")).toBe(true);
    expect(siteRoleCan("SITE_ENGINEER", "downloadPipelineBundle")).toBe(false);
    expect(siteRoleCan("SITE_REVIEWER", "downloadPipelineBundle")).toBe(true);
    expect(siteRoleCan("SITE_DATA_STEWARD", "downloadJoinKit")).toBe(false);
    expect(siteRoleCan("SITE_DATA_STEWARD", "acceptSitePolicy")).toBe(true);
  });

  it("allows study pipeline developers to inspect pipeline bundles without granting release approval", () => {
    expect(roleCan("PIPELINE_DEVELOPER", "downloadPipelineBundle")).toBe(true);
    expect(roleCan("PIPELINE_DEVELOPER", "approveRelease")).toBe(false);
    expect(roleCan("DATA_SCIENTIST", "downloadPipelineBundle")).toBe(true);
  });
});
