import { describe, expect, it } from "vitest";
import { imageMismatchSites } from "@/lib/run-image-check";

const a = "harbor.fedlify.com/x/y@sha256:" + "a".repeat(64);
const b = "harbor.fedlify.com/other/y@sha256:" + "b".repeat(64);

describe("imageMismatchSites", () => {
  it("lists sites whose recorded image differs from the run's image", () => {
    expect(imageMismatchSites(a, [{ site: "ha", imageDigest: b }, { site: "hb", imageDigest: a }])).toEqual(["ha"]);
  });
  it("compares by digest, not repository path", () => {
    expect(imageMismatchSites(a, [{ site: "ha", imageDigest: "elsewhere/z@sha256:" + "a".repeat(64) }])).toEqual([]);
  });
  it("says nothing when either side is unknown", () => {
    expect(imageMismatchSites(null, [{ site: "ha", imageDigest: b }])).toEqual([]);
    expect(imageMismatchSites(a, null)).toEqual([]);
    expect(imageMismatchSites(a, [{ site: "ha", imageDigest: null }])).toEqual([]);
  });
});
