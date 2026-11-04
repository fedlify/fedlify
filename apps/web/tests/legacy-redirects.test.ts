import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS config module
import nextConfig from "../next.config.mjs";
import { LEGACY_SECTION_REDIRECTS } from "@/lib/study-workspace";

describe("legacy study section redirects", () => {
  it("redirects pipeline, run and audit sections without deleting them", async () => {
    const rules = (await nextConfig.redirects()) as Array<{ source: string; has: Array<{ key: string; value: string }>; destination: string }>;
    for (const section of Object.keys(LEGACY_SECTION_REDIRECTS)) {
      const rule = rules.find((r) => r.has.some((h) => h.key === "section" && new RegExp(`^${h.value}$`).test(section)));
      expect(rule, section).toBeTruthy();
      expect(rule!.source).toBe("/studies/:studyId");
      expect(rule!.destination.replace(":studyId", "s1")).toBe(LEGACY_SECTION_REDIRECTS[section]("s1"));
    }
    expect(rules.some((r) => r.has.some((h) => new RegExp(`^${h.value}$`).test("sites")))).toBe(false);
  });
});
