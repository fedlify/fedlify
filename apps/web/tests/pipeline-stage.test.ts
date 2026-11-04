import { describe, expect, it } from "vitest";
import { computeStages, type StageInput } from "@/lib/pipeline-stage";

const base: StageInput = {
  hasProject: true,
  unsavedFiles: 0,
  sourceCommit: "abcdef1234",
  versions: [],
  aggregator: null,
  sites: [],
  jobs: [],
  busy: { saving: false, publishing: false, starting: false },
  activeStage: "code"
};
const live = { id: "v1", version: "v1", gitCommit: "abcdef1234", publish: { status: "PASSED" } };
const agg = { status: "ACTIVE", pipelineVersionId: "v1", imageDigest: "d1" };
const site = (over = {}) => ({ kitReleased: true, kitImageDigest: "d1", connected: true, ...over });

describe("pipeline rail stages", () => {
  it("asks for a project first", () => {
    const { current, stages } = computeStages({ ...base, hasProject: false });
    expect(current).toBe("code");
    expect(stages[0].action?.key).toBe("new_project");
  });

  it("makes Save the action while edits are unsaved", () => {
    const { current, stages } = computeStages({ ...base, unsavedFiles: 2 });
    expect(current).toBe("code");
    expect(stages[0]).toMatchObject({ status: "2 unsaved", action: { key: "save" } });
  });

  it("offers Publish for a saved, unpublished commit and blocks it during a run", () => {
    const first = computeStages(base);
    expect(first.current).toBe("publish");
    expect(first.stages[1].action?.label).toBe("Publish abcdef12");
    const running = computeStages({ ...base, versions: [live], aggregator: agg, sites: [site()], jobs: [{ id: "j", status: "RUNNING", result: null }], sourceCommit: "zzzzzzzz" });
    expect(running.stages[1].action?.disabledReason).toMatch(/run is in progress/);
  });

  it("flags a newer saved commit and a failed publish", () => {
    const newer = computeStages({ ...base, sourceCommit: "ffffffff", versions: [live], aggregator: agg });
    expect(newer.stages[1]).toMatchObject({ tone: "warn", status: "v1 live" });
    const failed = computeStages({ ...base, versions: [{ id: "v2", version: "v2", gitCommit: "abcdef1234", publish: { status: "FAILED" } }] });
    expect(failed.stages[1]).toMatchObject({ tone: "error", action: { key: "publish" } });
  });

  it("moves to Sites for a missing kit, then Run once a site is connected", () => {
    const kit = computeStages({ ...base, versions: [live], aggregator: agg, sites: [site({ kitReleased: false, connected: false })] });
    expect(kit.current).toBe("sites");
    expect(kit.stages[2].action?.key).toBe("release_kit");
    const ready = computeStages({ ...base, versions: [live], aggregator: agg, sites: [site(), site({ connected: false })] });
    expect(ready.current).toBe("run");
    expect(ready.stages[2].status).toBe("1/2 connected");
    expect(ready.stages[3].action?.key).toBe("setup_run");
    expect(computeStages({ ...base, versions: [live], aggregator: agg, sites: [site()], activeStage: "run" }).stages[3].action?.key).toBe("start_run");
  });

  it("offers Save model for a completed run without a result", () => {
    const { stages } = computeStages({ ...base, versions: [live], aggregator: agg, sites: [site()], jobs: [{ id: "j", status: "COMPLETED", result: null }] });
    expect(stages[3].action?.key).toBe("save_model");
  });
});

describe("computeStages source loading", () => {
  it("shows a neutral loading state, not a missing-commit warning", () => {
    const { stages } = computeStages({ ...base, sourceCommit: null, sourceStatus: "loading" });
    const publish = stages.find((s) => s.key === "publish")!;
    expect(publish.status).toBe("Loading…");
    expect(publish.tone).toBe("idle");
    expect(publish.action).toBeUndefined();
  });
  it("distinguishes a load error from an empty repository", () => {
    const err = computeStages({ ...base, sourceCommit: null, sourceStatus: "error" }).stages.find((s) => s.key === "publish")!;
    expect(err.tone).toBe("error");
    const empty = computeStages({ ...base, sourceCommit: null, sourceStatus: "ready" }).stages.find((s) => s.key === "publish")!;
    expect(empty.action?.disabledReason).toBe("No saved commit to publish.");
  });
});
