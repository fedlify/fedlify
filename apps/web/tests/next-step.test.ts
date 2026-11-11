import { describe, expect, it } from "vitest";
import { resolveStudySteps, visibleBlockers, type StepPermissions, type StepSite, type StepsSnapshot } from "@/lib/next-step";

const ALL = { manageEthics: true, manage: true, runAgent: true, approvePipeline: true, manageSites: true, submitJob: true, approveRelease: true };
const NOW = new Date("2026-11-10T12:00:00Z");
const site = (code: string, over: Partial<StepSite> = {}): StepSite => ({
  studySiteId: `ss-${code}`, code, name: `Hospital ${code}`, signedOff: true, kitReleased: true, kitImageDigest: null, connected: true, imageState: "CURRENT", needsNewKit: false, ...over
});
const fresh = (): StepsSnapshot => ({
  studyId: "s1", now: NOW, ethics: null, questions: { answered: 0, total: 29 }, hasProject: false, versions: [], aggregator: null, sites: [site("A", { connected: null }), site("B", { connected: null })], jobs: [], modelReleases: 0
});
const published = (over: Partial<StepsSnapshot> = {}): StepsSnapshot => ({
  ...fresh(),
  ethics: { status: "APPROVED" },
  questions: { answered: 29, total: 29 },
  hasProject: true,
  versions: [{ id: "v1", version: "v1", gitCommit: "abc", publish: { status: "SUCCEEDED" } }],
  aggregator: { status: "ACTIVE", pipelineVersionId: "v1", imageDigest: null },
  sites: [site("A"), site("B")],
  ...over
});
const step = (snap: StepsSnapshot, key: string, can: StepPermissions = ALL) => resolveStudySteps(snap, can).steps.find((s) => s.key === key)!;

describe("resolveStudySteps", () => {
  it("always has six steps in order with the plain titles", () => {
    const { steps } = resolveStudySteps(fresh(), ALL);
    expect(steps.map((s) => s.key)).toEqual(["authorize", "prepare", "approve", "deploy", "execute", "validate"]);
    expect(steps.map((s) => s.title)).toEqual(["Ethics decision", "Study questions", "Pipeline", "Sites", "Run", "Results"]);
  });

  it("points a fresh study at the ethics decision", () => {
    const result = resolveStudySteps(fresh(), ALL);
    expect(result.current).toBe("authorize");
    const first = result.steps[0];
    expect(first).toMatchObject({ status: "Not started", tone: "active", action: { label: "Record the ethics decision", href: "/studies/s1?section=protocol&tab=ethics", permission: "manageEthics" } });
    expect(first.blockers.map((b) => b.code)).toEqual(["ethics"]);
    expect(result.steps.slice(1).every((s) => s.tone !== "active")).toBe(true);
  });

  it("points an expired ethics decision at renewal", () => {
    const snap = { ...fresh(), ethics: { status: "APPROVED", validUntil: "2026-03-05T00:00:00Z" } };
    const first = resolveStudySteps(snap, ALL).steps[0];
    expect(first).toMatchObject({ status: "Expired", tone: "warn" });
    expect(first.detail).toContain("expired on 5 March 2026");
    expect(first.action?.label).toBe("Record the renewed decision");
  });

  it("shows study question progress", () => {
    const snap = { ...fresh(), ethics: { status: "APPROVED" }, questions: { answered: 3, total: 29 } };
    const result = resolveStudySteps(snap, ALL);
    expect(result.current).toBe("prepare");
    expect(result.steps[1].status).toBe("3 of 29 answered");
    expect(result.steps[1].blockers[0].detail).toBe("26 study questions need an answer or a decision. Suggested answers count only after you accept them. Open Protocol, then Study questions.");
  });

  it("points a study with every question answered at the pipeline", () => {
    const snap = { ...fresh(), ethics: { status: "APPROVED" }, questions: { answered: 29, total: 29 } };
    const result = resolveStudySteps(snap, ALL);
    expect(result.current).toBe("approve");
    expect(result.steps[2]).toMatchObject({ status: "Not started", action: { label: "Start the pipeline", permission: "runAgent" } });
  });

  it("offers to publish when a pipeline exists but nothing is published", () => {
    const snap = { ...fresh(), ethics: { status: "APPROVED" }, questions: { answered: 29, total: 29 }, hasProject: true };
    expect(step(snap, "approve")).toMatchObject({ status: "Not published", action: { label: "Review and publish", permission: "approvePipeline" } });
  });

  it("points published-but-sites-waiting at the sites", () => {
    const snap = published({ sites: [site("A"), site("B", { connected: false, signedOff: false })] });
    const result = resolveStudySteps(snap, ALL);
    expect(result.current).toBe("deploy");
    const deploy = result.steps[3];
    expect(deploy.status).toBe("1 of 2 sites connected");
    expect(deploy.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["site_signed_off:ss-B", "site_connected:ss-B"]));
    expect(deploy.action?.href).toBe("/sites/ss-B");
    expect(result.steps[2].tone).toBe("ok");
  });

  it("says a site needs a new code version without calling the run ready", () => {
    const snap = published({ sites: [site("A"), site("B", { imageState: "OUTDATED" })] });
    const result = resolveStudySteps(snap, ALL);
    expect(result.current).toBe("deploy");
    expect(result.steps[3].blockers.map((b) => b.code)).toContain("site_code_version:ss-B");
    expect(result.steps[4].action).toBeUndefined();
  });

  it("offers Start run when the sites are ready", () => {
    const result = resolveStudySteps(published(), ALL);
    expect(result.current).toBe("execute");
    expect(result.steps[3]).toMatchObject({ status: "Done", tone: "ok" });
    expect(result.steps[4]).toMatchObject({ status: "Not started", action: { label: "Start run", permission: "submitJob" } });
  });

  it("shows a run in progress", () => {
    const result = resolveStudySteps(published({ jobs: [{ id: "j1", status: "RUNNING", result: null }] }), ALL);
    expect(result.current).toBe("execute");
    expect(result.steps[4]).toMatchObject({ status: "In progress", tone: "active" });
  });

  it("points a finished run at the results", () => {
    const result = resolveStudySteps(published({ jobs: [{ id: "j1", status: "COMPLETED", result: null }] }), ALL);
    expect(result.current).toBe("validate");
    expect(result.steps[4].status).toBe("Done");
    expect(result.steps[5]).toMatchObject({ status: "Model not saved", action: { label: "Save the model", href: "/studies/s1/runs" } });
  });

  it("still points at the results when a site has gone offline since the run", () => {
    const snap = published({ sites: [site("A"), site("B", { connected: false })], jobs: [{ id: "j1", status: "COMPLETED", result: { id: "r1" } }] });
    const result = resolveStudySteps(snap, ALL);
    expect(result.current).toBe("validate");
    expect(result.steps[5]).toMatchObject({ status: "Model saved, not released", action: { label: "Review and release", permission: "approveRelease" } });
  });

  it("is finished once a model is released", () => {
    const result = resolveStudySteps(published({ jobs: [{ id: "j1", status: "COMPLETED", result: { id: "r1" } }], modelReleases: 1 }), ALL);
    expect(result.current).toBeNull();
    expect(result.steps.every((s) => s.tone === "ok" && s.blockers.length === 0 && !s.action)).toBe(true);
  });

  it("gives a person with no permissions no action buttons, only plain 'Ask a study lead' text", () => {
    const snaps = [fresh(), { ...fresh(), ethics: { status: "APPROVED" }, questions: { answered: 29, total: 29 } }, published(), published({ jobs: [{ id: "j1", status: "COMPLETED", result: null }] })];
    for (const snap of snaps) {
      const result = resolveStudySteps(snap, {});
      expect(result.steps.every((s) => s.action === undefined)).toBe(true);
      const current = result.steps.find((s) => s.key === result.current)!;
      expect(current.detail).toMatch(/^Ask a study lead to /);
    }
  });

  it("only keeps blockers on steps that are not done", () => {
    const result = resolveStudySteps(published(), ALL);
    for (const s of result.steps.filter((x) => x.tone === "ok")) expect(s.blockers).toEqual([]);
  });

  it("shows a failed study server and a failed publish as errors", () => {
    const failedServer = published({ aggregator: { status: "FAILED", pipelineVersionId: null, imageDigest: null, lastError: "no capacity" } });
    expect(step(failedServer, "deploy")).toMatchObject({ status: "Study server failed", tone: "error" });
    const failedPublish = published({ aggregator: null, versions: [{ id: "v1", version: "v1", gitCommit: "abc", publish: { status: "FAILED" } }] });
    expect(step(failedPublish, "approve")).toMatchObject({ status: "Publish failed", tone: "error", action: { label: "Publish again" } });
  });
});

describe("resolveStudySteps follow-up fixes", () => {
  const offline = () => published({ sites: [site("A"), site("B", { connected: false })] });

  it("lets a run start with the connected sites, as Code & run does", () => {
    const result = resolveStudySteps(offline(), ALL);
    expect(result.steps[3]).toMatchObject({ tone: "warn", status: "1 of 2 sites connected" });
    expect(result.steps[4]).toMatchObject({ status: "Not started", action: { label: "Start run" } });
  });

  it("does not let an offline, unsigned site stop a run that Code & run would start", () => {
    const snap = published({ sites: [site("A"), site("B", { connected: false, signedOff: false })] });
    expect(step(snap, "execute").action?.label).toBe("Start run");
  });

  it("does not offer a run when no site is connected", () => {
    const snap = published({ sites: [site("A", { connected: false }), site("B", { connected: false })] });
    const run = step(snap, "execute");
    expect(run.action).toBeUndefined();
    expect(run.blockers.map((b) => b.code)).toContain("min_sites");
  });

  it("sends site staff to their own site page instead of a dead end", () => {
    const snap = { ...published({ sites: [site("A"), site("B", { connected: false, signedOff: false })] }), mySiteIds: ["ss-B"] };
    const deploy = step(snap, "deploy", {});
    expect(deploy.action).toEqual({ label: "Open your site page", href: "/sites/ss-B" });
    expect(deploy.detail).toBe("Open your site page to install the runner and sign off.");
    expect(step(published({ sites: [site("A"), site("B", { connected: false })] }), "deploy", {}).action).toBeUndefined();
  });

  it("names a stopped study server and offers to publish again", () => {
    const snap = published({ aggregator: { status: "PAUSED", pipelineVersionId: "v1", imageDigest: null } });
    expect(step(snap, "deploy")).toMatchObject({ status: "Study server stopped", tone: "warn", action: { label: "Publish again", permission: "approvePipeline" } });
    expect(step(snap, "deploy", {}).detail).toMatch(/^Ask a study lead/);
    expect(step(snap, "approve")).toMatchObject({ status: "Done" });
  });

  it("says the study server waits for the publish while one is going on", () => {
    const snap = published({ aggregator: { status: "DRAFT", pipelineVersionId: "v1", imageDigest: null }, versions: [{ id: "v1", version: "v1", gitCommit: "abc", publish: { status: "RUNNING" } }] });
    expect(step(snap, "deploy")).toMatchObject({ status: "Waiting for publish", tone: "idle" });
  });

  it("never puts the raw server error in the Sites step", () => {
    const snap = published({ aggregator: { status: "FAILED", pipelineVersionId: null, imageDigest: null, lastError: "pod ImagePullBackOff 10.0.0.4" } });
    const deploy = step(snap, "deploy");
    expect(deploy.detail).not.toMatch(/ImagePullBackOff|10\.0/);
  });

  it("says what is wrong when every site is connected but one needs attention", () => {
    const snap = published({ sites: [site("A"), site("B", { imageState: "OUTDATED" })] });
    expect(step(snap, "deploy").status).toBe("1 site needs attention");
  });

  it("keeps a failed publish and a failed study server visible after a run has finished", () => {
    const done = { id: "j1", status: "COMPLETED", result: { id: "r1" } };
    const failedPublish = published({ jobs: [done], versions: [{ id: "v1", version: "v1", gitCommit: "abc", publish: { status: "FAILED" } }] });
    expect(step(failedPublish, "approve")).toMatchObject({ tone: "error", status: "Publish failed" });
    expect(resolveStudySteps(failedPublish, ALL).current).toBe("approve");
    const stopped = published({ jobs: [done], aggregator: { status: "FAILED", pipelineVersionId: null, imageDigest: null } });
    expect(step(stopped, "deploy")).toMatchObject({ tone: "error", status: "Study server failed" });
  });

  it("keeps a warning visible after a run but moves on to the results", () => {
    const snap = published({ jobs: [{ id: "j1", status: "COMPLETED", result: { id: "r1" } }], sites: [site("A"), site("B", { connected: false })] });
    expect(step(snap, "deploy").tone).toBe("warn");
    expect(resolveStudySteps(snap, ALL).current).toBe("validate");
  });

  it("does not hide a newer failed run behind an older finished one", () => {
    const snap = published({ jobs: [{ id: "j2", status: "FAILED", result: null }, { id: "j1", status: "COMPLETED", result: { id: "r1" } }] });
    const run = step(snap, "execute");
    expect(run).toMatchObject({ status: "Last run failed", tone: "warn" });
    expect(run.detail).toContain("1 earlier run finished");
    expect(resolveStudySteps(snap, ALL).current).toBe("validate");
  });

  it("shows a published version as live even when it is the only one the overview lists", () => {
    expect(step(published(), "approve")).toMatchObject({ status: "Done", detail: "Pipeline version v1 is published." });
  });

  it("does not repeat a step's own action as a blocker, and shows no blockers before a pipeline exists", () => {
    const first = resolveStudySteps(fresh(), ALL).steps[0];
    expect(visibleBlockers(first)).toEqual([]);
    const prepare = resolveStudySteps({ ...fresh(), ethics: { status: "APPROVED" } }, ALL).steps[1];
    expect(visibleBlockers(prepare)).toEqual([]);
    const start = resolveStudySteps({ ...fresh(), ethics: { status: "APPROVED" }, questions: { answered: 29, total: 29 }, sites: [] }, ALL).steps[2];
    expect(start).toMatchObject({ status: "Not started", action: { label: "Start the pipeline" } });
    expect(start.blockers).toEqual([]);
  });

  it("does not send a viewer to places they cannot act in", () => {
    const snap = published({ sites: [site("A"), site("B", { connected: false, signedOff: false })] });
    const deploy = step(snap, "deploy", {});
    const open = deploy.blockers.filter((b) => b.owner === "site");
    expect(open.every((b) => b.fixHref?.startsWith("/sites/"))).toBe(true);
    const noEthics = resolveStudySteps({ ...fresh(), ethics: null, questions: { answered: 3, total: 29 } }, {}).steps[1];
    expect(noEthics.blockers.every((b) => b.fixHref === undefined || b.owner !== "study")).toBe(true);
  });
});
