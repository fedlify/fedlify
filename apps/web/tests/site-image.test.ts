import { describe, expect, it } from "vitest";
import { checkSiteImages, describeImageMismatch, imageSha256, siteImageFixSteps, siteImageState, updateNeedsNewKit } from "@/lib/site-image";
import { kitState } from "@/lib/site-overview";
import { sanitizeHeartbeatMetadata } from "@/lib/site-presence";

const A = "a".repeat(64);
const B = "b".repeat(64);
const ref = (path: string, hex: string) => `harbor.example/${path}@sha256:${hex}`;

describe("site image comparison", () => {
  it("compares sha256 only: the repository path is not part of identity", () => {
    expect(imageSha256(ref("proj-one/study", A.toUpperCase()))).toBe(A);
    expect(siteImageState(ref("legacy/study", A), ref("fedlify-s-x/study", A))).toBe("CURRENT");
    expect(siteImageState(ref("same/study", A), ref("same/study", B))).toBe("OUTDATED");
  });
  it("treats a missing or unparseable reported digest as a mismatch, and no desired digest as unknown", () => {
    expect(siteImageState(null, ref("p/s", A))).toBe("NOT_REPORTED");
    expect(siteImageState("harbor.example/p/s:latest", ref("p/s", A))).toBe("NOT_REPORTED");
    expect(siteImageState(ref("p/s", A), null)).toBe("UNKNOWN");
  });
  it("needs a new kit only when the registry location changed, never for a code-only publish", () => {
    expect(updateNeedsNewKit(ref("fedlify-s-x/study", A), ref("fedlify-s-x/study", B))).toBe(false);
    expect(updateNeedsNewKit(ref("fedlify-studies/study", A), ref("fedlify-s-x/study", B))).toBe(true);
    expect(updateNeedsNewKit("other.example/p/study@sha256:" + A, ref("p/study", B))).toBe(true);
    expect(updateNeedsNewKit(null, ref("p/study", B))).toBe(false);
  });
  it("kit state follows the same rule", () => {
    expect(kitState({ imageDigest: ref("p/study", A) }, ref("p/study", B))).toBe("RELEASED");
    expect(kitState({ imageDigest: ref("old/study", A) }, ref("p/study", B))).toBe("OUTDATED");
    expect(kitState(null, ref("p/study", B))).toBe("NOT_RELEASED");
  });
  it("checks every site, names it, and gives different fix steps for update and new kit", () => {
    const sites = [
      { code: "A", clientName: "site-A", heartbeatMetadata: { imageDigest: ref("p/study", B) } },
      { code: "B", clientName: "site-B", heartbeatMetadata: { imageDigest: ref("p/study", A) } },
      { code: "C", clientName: "site-C", heartbeatMetadata: {} },
      { code: "D", clientName: "site-D", heartbeatMetadata: { imageDigest: ref("legacy/study", A) } }
    ];
    const checks = checkSiteImages(sites, ref("p/study", B));
    expect(checks.map((c) => c.state)).toEqual(["CURRENT", "OUTDATED", "NOT_REPORTED", "OUTDATED"]);
    expect(checks[1].needsNewKit).toBe(false);
    expect(checks[3].needsNewKit).toBe(true);
    const message = describeImageMismatch(checks, ref("p/study", B));
    expect(message).toContain("site-B");
    expect(message).toContain("site-C");
    expect(message).not.toContain("site-A");
    expect(siteImageFixSteps(checks[1]).join(" ")).toMatch(/fedlify-runner.sh update/);
    expect(siteImageFixSteps(checks[1]).join(" ")).toMatch(/No new kit is needed/);
    expect(siteImageFixSteps(checks[3]).join(" ")).toMatch(/new site kit/);
  });
  it("keeps a full-length image reference in heartbeat metadata, so its digest is never cut", () => {
    const long = `harbor.fedlify.com/fedlify-s-${"x".repeat(40)}/${"y".repeat(40)}@sha256:${A}`;
    expect(long.length).toBeGreaterThan(150);
    const clean = sanitizeHeartbeatMetadata({ imageDigest: long + "", container: "c".repeat(500) }) as Record<string, string>;
    expect(imageSha256(clean.imageDigest)).toBe(A);
    expect(clean.container.length).toBe(200);
  });
});
