import { describe, expect, it } from "vitest";
import { currentStep, describeStuckPod, detectStuckPods, readablePublishSummary, type PodLike } from "@/lib/workflow-health";

const now = Date.parse("2026-11-03T12:10:00Z");
function pod(name: string, phase: string, created: string, waiting?: { reason: string; message?: string }): PodLike {
  return {
    metadata: { name, creationTimestamp: created, annotations: { "workflows.argoproj.io/node-name": `wf.${name}` } },
    status: { phase, startTime: created, containerStatuses: [{ name: "main", image: "alpine/k8s:1", state: waiting ? { waiting } : {} }] }
  };
}

describe("detectStuckPods", () => {
  it("flags image pull errors older than the threshold", () => {
    const stuck = detectStuckPods([pod("build", "Pending", "2026-11-03T12:00:00Z", { reason: "ImagePullBackOff", message: "Back-off pulling" })], now);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ step: "build", reason: "ImagePullBackOff", image: "alpine/k8s:1" });
    expect(describeStuckPod(stuck[0]!)).toContain('step "build" could not pull its image');
    expect(describeStuckPod(stuck[0]!)).not.toContain("alpine/k8s");
  });
  it("ignores young pods, normal waits and non-pending pods", () => {
    expect(detectStuckPods([pod("a", "Pending", "2026-11-03T12:08:00Z", { reason: "ErrImagePull" })], now)).toHaveLength(0);
    expect(detectStuckPods([pod("e", "Pending", "2026-11-03T12:00:00Z", { reason: "ErrImagePull" })], now)).toHaveLength(0); // transient, not fatal
    expect(detectStuckPods([pod("b", "Pending", "2026-11-03T12:00:00Z", { reason: "ContainerCreating" })], now)).toHaveLength(0);
    expect(detectStuckPods([pod("c", "Running", "2026-11-03T12:00:00Z", { reason: "ErrImagePull" })], now)).toHaveLength(0);
  });
  it("describes config errors differently", () => {
    const [stuck] = detectStuckPods([pod("d", "Pending", "2026-11-03T12:00:00Z", { reason: "CreateContainerConfigError" })], now);
    expect(describeStuckPod(stuck!)).toContain("could not start");
  });
});

describe("currentStep", () => {
  it("prefers the newest running pod, then pending, else null", () => {
    expect(currentStep([pod("a", "Succeeded", "2026-11-03T12:00:00Z"), pod("b", "Running", "2026-11-03T12:01:00Z"), pod("c", "Pending", "2026-11-03T12:02:00Z")])).toEqual({ step: "b", state: "running" });
    expect(currentStep([pod("c", "Pending", "2026-11-03T12:02:00Z")])).toEqual({ step: "c", state: "pending" });
    expect(currentStep([pod("a", "Succeeded", "2026-11-03T12:00:00Z")])).toBeNull();
  });
});

describe("readablePublishSummary", () => {
  const failures = JSON.stringify([
    { displayName: "wf", templateName: "publish", message: "child failed", podName: "wf" },
    { displayName: "clone-validate", templateName: "clone-validate", message: "main: Error (exit code 1)", podName: "wf-clone" }
  ]);

  it("names the failed step from Argo's failure list, quoted or not", () => {
    const expected = 'Publish failed in step "clone-validate": main: Error (exit code 1)';
    expect(readablePublishSummary(`Publish Failed: ${failures}`)).toBe(expected);
    expect(readablePublishSummary(`Publish Failed: ${JSON.stringify(failures)}`)).toBe(expected);
  });

  it("keeps plain or truncated text unchanged", () => {
    expect(readablePublishSummary("Aggregator live.")).toBe("Aggregator live.");
    expect(readablePublishSummary('Publish Failed: "[{\\"a')).toBe('Publish Failed: "[{\\"a');
  });
});

