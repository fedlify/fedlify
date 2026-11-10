import { describe, expect, it } from "vitest";
import { describeStudyRoles, isSiteContact, PLAIN_ROLES, plainRoleFor, toSiteRoles, toStudyRoles } from "@/lib/plain-roles";

describe("plain roles", () => {
  it("offers the five plain roles with a label and a one-line description", () => {
    expect(PLAIN_ROLES.map((role) => role.label)).toEqual(["Study lead", "Researcher", "Approver", "Site contact", "Observer"]);
    for (const role of PLAIN_ROLES) expect(role.description.length).toBeGreaterThan(10);
  });

  it("maps each plain role onto the agreed detailed roles", () => {
    expect(toStudyRoles("STUDY_LEAD")).toEqual(["PRINCIPAL_INVESTIGATOR"]);
    expect(toStudyRoles("RESEARCHER")).toEqual(["DATA_SCIENTIST", "PIPELINE_DEVELOPER"]);
    expect(toStudyRoles("APPROVER")).toEqual(["RELEASE_APPROVER", "CLINICAL_LEAD"]);
    expect(toStudyRoles("OBSERVER")).toEqual(["AUDITOR"]);
    expect(toStudyRoles("SITE_CONTACT")).toEqual([]);
    expect(toSiteRoles("SITE_CONTACT")).toEqual(["SITE_ADMIN", "SITE_PI"]);
  });

  it("returns copies so callers cannot change the table", () => {
    toStudyRoles("RESEARCHER").push("AUDITOR");
    expect(toStudyRoles("RESEARCHER")).toEqual(["DATA_SCIENTIST", "PIPELINE_DEVELOPER"]);
  });

  it("recognises a plain role only on an exact match, in any order", () => {
    expect(plainRoleFor(["PIPELINE_DEVELOPER", "DATA_SCIENTIST"])?.key).toBe("RESEARCHER");
    expect(plainRoleFor(["PRINCIPAL_INVESTIGATOR"])?.key).toBe("STUDY_LEAD");
    expect(plainRoleFor(["DATA_SCIENTIST"])).toBeNull();
    expect(plainRoleFor(["PRINCIPAL_INVESTIGATOR", "DATA_SCIENTIST"])).toBeNull();
    expect(plainRoleFor([])).toBeNull();
  });

  it("names the closest plain role when the match is not exact, and keeps the detail", () => {
    expect(describeStudyRoles(["DATA_SCIENTIST"])).toEqual({ label: "Researcher", detail: "Data scientist" });
    expect(describeStudyRoles(["PRINCIPAL_INVESTIGATOR", "DATA_SCIENTIST"]).label).toBe("Study lead");
    expect(describeStudyRoles(["PIPELINE_DEVELOPER", "DATA_SCIENTIST"])).toEqual({ label: "Researcher", detail: null });
  });

  it("shows Custom with the detailed labels when nothing matches", () => {
    expect(describeStudyRoles(["AUDITOR"])).toEqual({ label: "Observer", detail: null });
    expect(describeStudyRoles(["DATA_SCIENTIST", "ETHICS_REVIEWER"])).toEqual({ label: "Custom", detail: "Data scientist, Ethics reviewer" });
  });

  it("recognises the site contact from site roles", () => {
    expect(isSiteContact(["SITE_PI", "SITE_ADMIN"])).toBe(true);
    expect(isSiteContact(["SITE_ADMIN"])).toBe(false);
  });
});
