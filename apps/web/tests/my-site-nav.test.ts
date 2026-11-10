import { describe, expect, it } from "vitest";
import { isMySitePath, sidebarMode } from "@/lib/study-workspace";

describe("sidebarMode", () => {
  it("falls back to the study sidebar when nothing is known", () => {
    expect(sidebarMode(null)).toBe("study");
    expect(sidebarMode({})).toBe("study");
  });
  it("gives a site-only person just My site", () => {
    expect(sidebarMode({ landing: "/my-site", sites: [{}] })).toBe("site-only");
  });
  it("adds My site for a person with both", () => {
    expect(sidebarMode({ landing: "/dashboard", sites: [{}] })).toBe("both");
  });
  it("keeps the study sidebar when there are no sites", () => {
    expect(sidebarMode({ landing: "/dashboard", sites: [] })).toBe("study");
  });
});

describe("isMySitePath", () => {
  it("matches the My site page and site pages only", () => {
    expect(isMySitePath("/my-site")).toBe(true);
    expect(isMySitePath("/sites/abc")).toBe(true);
    expect(isMySitePath("/studies/abc")).toBe(false);
  });
});
