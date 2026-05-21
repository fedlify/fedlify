import { describe, expect, it } from "vitest";
import { detectPhiWarning, detectRawClinicalData, ethicsAllowsRelease } from "@/lib/policy";

describe("policy", () => {
  it("blocks raw clinical dataset-looking uploads", () => {
    expect(detectRawClinicalData("patients.csv", "text/csv")).toContain("clinical data");
    expect(detectRawClinicalData("approval.pdf", "application/pdf")).toBeNull();
  });

  it("flags possible PHI in extracted text", () => {
    expect(detectPhiWarning("Patient MRN 1234 needs review")).toHaveLength(1);
  });

  it("allows releases only after ethics clearance", () => {
    expect(ethicsAllowsRelease("APPROVED")).toBe(true);
    expect(ethicsAllowsRelease("NOT_REQUIRED")).toBe(true);
    expect(ethicsAllowsRelease("PENDING")).toBe(false);
    expect(ethicsAllowsRelease("REJECTED")).toBe(false);
  });
});
