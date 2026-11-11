import { describe, expect, it } from "vitest";
import { studyNameHints } from "@/lib/studies";

const study = (id: string, title: string, org: string, status = "ACTIVE") => ({ id, title, status, organization: { name: org } });

describe("study selector second line", () => {
  it("leaves a unique title alone and tells same titles apart by workspace, then status", () => {
    const hints = studyNameHints([
      study("a1", "Default Study", "Test PI's Workspace"),
      study("b2", "Default Study", "site-b.test's Workspace", "DRAFT"),
      study("c3", "Sepsis study", "Test PI's Workspace")
    ]);
    expect(hints.get("a1")).toBe("Test PI's Workspace");
    expect(hints.get("b2")).toBe("site-b.test's Workspace");
    expect(hints.get("c3")).toBeNull();

    const sameOrg = studyNameHints([study("x1", "Pilot", "Lab"), study("y2", "pilot", "Lab", "DRAFT")]);
    expect(sameOrg.get("x1")).toBe("Lab · Active");
    expect(sameOrg.get("y2")).toBe("Lab · Draft");

    const identical = studyNameHints([study("aaaaaa111111", "Pilot", "Lab"), study("bbbbbb222222", "Pilot", "Lab")]);
    expect(identical.get("aaaaaa111111")).toBe("Lab · Active · 111111");
  });
});
