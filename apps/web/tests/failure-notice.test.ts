import { describe, expect, it } from "vitest";
import { failureNoticeText } from "@/lib/failure-notice";

describe("failureNoticeText", () => {
  it("removes repeated lines and uses the final line as the headline", () => {
    expect(failureNoticeText(["Warning: a", "Warning: a", " ", "Run ended: b"])).toEqual({ headline: "Run ended: b", details: ["Warning: a", "Run ended: b"] });
  });
  it("has no headline when nothing was recorded", () => {
    expect(failureNoticeText([])).toEqual({ headline: null, details: [] });
  });
});
