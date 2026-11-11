import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(resolve(__dirname, "..", relative), "utf8");

describe("phase 0 link fixes", () => {
  it("study summary cards and shortcuts do not push legacy pipeline or run sections", () => {
    const source = read("src/app/(app)/studies/[studyId]/page.tsx");
    expect(source).not.toMatch(/sectionUrl\("(pipeline|run)"\)/);
    expect(source).not.toContain("sectionUrl(card.section)");
  });
});
