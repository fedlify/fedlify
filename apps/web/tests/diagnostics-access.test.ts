import { beforeEach, describe, expect, it, vi } from "vitest";

const canAccessStudy = vi.fn();
const loadProjectDiagnostics = vi.fn();
vi.mock("@/lib/rbac", async (orig) => ({ ...(await orig<typeof import("@/lib/rbac")>()), canAccessStudy: (...a: unknown[]) => canAccessStudy(...a) }));
vi.mock("@/lib/diagnostics-loader", () => ({ loadProjectDiagnostics: (...a: unknown[]) => loadProjectDiagnostics(...a) }));

import { roleCan } from "@/lib/rbac";
import { loadDiagnosticsForMessage } from "@/lib/diagnostics-access";

const args = { userId: "u", studyId: "s", projectId: "p", message: "Why did the run fail?", flagged: true };

describe("diagnostics access", () => {
  beforeEach(() => {
    canAccessStudy.mockReset();
    loadProjectDiagnostics.mockReset().mockResolvedValue({ publish: null });
  });
  it("denies a role without viewLogs even when the client flags diagnostics", async () => {
    canAccessStudy.mockResolvedValue(false);
    expect(await loadDiagnosticsForMessage(args)).toBeNull();
    expect(canAccessStudy).toHaveBeenCalledWith("u", "s", "viewLogs");
    expect(loadProjectDiagnostics).not.toHaveBeenCalled();
  });
  it("allows a role with viewLogs", async () => {
    canAccessStudy.mockResolvedValue(true);
    expect(await loadDiagnosticsForMessage(args)).toEqual({ publish: null });
  });
  it("does not even check access for an unrelated message", async () => {
    expect(await loadDiagnosticsForMessage({ ...args, message: "Explain client.py", flagged: false })).toBeNull();
    expect(canAccessStudy).not.toHaveBeenCalled();
  });
  it("maps roles as expected", () => {
    expect(roleCan("DATA_SCIENTIST", "runAgent")).toBe(true);
    expect(roleCan("DATA_SCIENTIST", "viewLogs")).toBe(false);
    expect(roleCan("PIPELINE_DEVELOPER", "viewLogs")).toBe(true);
  });
});
