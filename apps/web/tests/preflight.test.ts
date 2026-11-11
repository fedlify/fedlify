import { describe, expect, it } from "vitest";
import { evaluatePreflight, PREFLIGHT_SITE_PREFIXES, type PreflightSite, type PreflightSnapshot } from "@/lib/preflight";

const site = (code: string, over: Partial<PreflightSite> = {}): PreflightSite => ({
  studySiteId: `ss-${code}`,
  siteId: `ss-${code}`,
  code,
  name: `Hospital ${code}`,
  signedOff: true,
  connected: true,
  imageState: "CURRENT",
  ...over
});
const NOW = new Date("2026-11-10T12:00:00Z");
const publishSnap = (over: Partial<PreflightSnapshot> = {}): PreflightSnapshot => ({
  studyId: "s1",
  now: NOW,
  ethics: { status: "APPROVED", validUntil: null },
  questions: { answered: 29, total: 29 },
  sites: [site("A")],
  savedCode: true,
  publishInProgress: false,
  runInProgress: false,
  ...over
});
const runSnap = (over: Partial<PreflightSnapshot> = {}): PreflightSnapshot => ({
  studyId: "s1",
  now: NOW,
  ethics: { status: "APPROVED", validUntil: null },
  questions: { answered: 29, total: 29 },
  sites: [site("A"), site("B")],
  pipeline: { exists: true, approved: true, checksPassed: true },
  studyServer: { running: true, servesPipeline: true },
  ...over
});
const failed = (result: ReturnType<typeof evaluatePreflight>) => result.items.filter((i) => !i.ok).map((i) => i.code);

describe("evaluatePreflight publish", () => {
  it("passes with every item shown as a tick", () => {
    const result = evaluatePreflight("publish", publishSnap());
    expect(result.ok).toBe(true);
    expect(result.items.map((i) => i.code)).toEqual(["ethics", "study_questions", "sites", "saved_code", "publish_idle", "run_idle"]);
    expect(result.items.every((i) => i.ok && !i.detail)).toBe(true);
    expect(result.items[0].text).toBe("The ethics decision is recorded");
  });

  it("lists passed and failed items with plain text, owner and a link to fix", () => {
    const result = evaluatePreflight("publish", publishSnap({ ethics: null, questions: { answered: 26, total: 29 }, sites: [], savedCode: false, publishInProgress: true, runInProgress: true }));
    expect(result.ok).toBe(false);
    expect(failed(result)).toEqual(["ethics", "study_questions", "sites", "saved_code", "publish_idle", "run_idle"]);
    const byCode = Object.fromEntries(result.items.map((i) => [i.code, i]));
    expect(byCode.ethics).toMatchObject({ text: "Record the ethics decision", owner: "study", fixHref: "/studies/s1?section=protocol&tab=ethics" });
    expect(byCode.study_questions.text).toBe("Answer the remaining study questions (3 left)");
    expect(byCode.study_questions.detail).toBe("3 study questions need an answer or a decision. Suggested answers count only after you accept them. Open Protocol, then Study questions.");
    expect(byCode.sites.fixHref).toBe("/studies/s1?section=sites");
    expect(byCode.saved_code.fixHref).toBe("/studies/s1/projects");
    expect(byCode.publish_idle.owner).toBe("system");
  });

  it("says one question left in the singular", () => {
    const result = evaluatePreflight("publish", publishSnap({ questions: { answered: 28, total: 29 } }));
    expect(result.items.find((i) => i.code === "study_questions")?.detail).toBe("1 study question needs an answer or a decision. Suggested answers count only after you accept them. Open Protocol, then Study questions.");
  });

  it("leaves out items that were not checked", () => {
    const result = evaluatePreflight("publish", publishSnap({ savedCode: null, publishInProgress: undefined, runInProgress: undefined }));
    expect(result.items.map((i) => i.code)).toEqual(["ethics", "study_questions", "sites"]);
  });

  it("fails an expired ethics decision and names the date", () => {
    const result = evaluatePreflight("publish", publishSnap({ ethics: { status: "APPROVED", validUntil: "2026-03-05T00:00:00Z" } }));
    const ethics = result.items[0];
    expect(ethics.ok).toBe(false);
    expect(ethics.detail).toBe("The ethics decision expired on 5 March 2026. Record the renewed decision.");
  });

  it("fails an ethics record that is not an approval", () => {
    const result = evaluatePreflight("publish", publishSnap({ ethics: { status: "PENDING" } }));
    expect(result.items[0]).toMatchObject({ ok: false, detail: "The latest ethics decision is not an approval." });
  });
});

describe("evaluatePreflight run", () => {
  it("passes when everything is in place", () => {
    const result = evaluatePreflight("run", runSnap());
    expect(result.ok).toBe(true);
    expect(result.items.some((i) => i.code === "min_sites" && i.detail === "2 of 2 sites are connected.")).toBe(true);
  });

  it("gives each active site a sign-off, connection and code version item", () => {
    const result = evaluatePreflight("run", runSnap());
    for (const prefix of Object.values(PREFLIGHT_SITE_PREFIXES)) {
      expect(result.items.filter((i) => i.code.startsWith(prefix))).toHaveLength(2);
    }
  });

  it("names the site that is not connected, not signed off or out of date", () => {
    const result = evaluatePreflight("run", runSnap({ sites: [site("A"), site("B", { signedOff: false, connected: false, imageState: "OUTDATED" })] }));
    expect(result.ok).toBe(false);
    expect(failed(result)).toEqual(["site_signed_off:ss-B", "site_connected:ss-B", "site_code_version:ss-B", "min_sites"]);
    const items = Object.fromEntries(result.items.map((i) => [i.code, i]));
    expect(items["site_signed_off:ss-B"]).toMatchObject({ text: "Hospital B needs to sign off", owner: "site", fixHref: "/sites/ss-B" });
    expect(items["site_connected:ss-B"].detail).toBe("Hospital B is not connected to the study server.");
    expect(items["min_sites"].detail).toBe("1 of 2 sites is connected; at least 2 are needed.");
  });

  it("accepts fewer connected sites when the minimum is lower", () => {
    const result = evaluatePreflight("run", runSnap({ minSites: 1, sites: [site("A"), site("B", { connected: false })] }));
    expect(result.items.find((i) => i.code === "min_sites")?.ok).toBe(true);
  });

  it("fails when no pipeline version is published or the study server is down", () => {
    const result = evaluatePreflight("run", runSnap({ pipeline: { exists: false, approved: false, checksPassed: false }, studyServer: { running: false, servesPipeline: false } }));
    expect(failed(result)).toEqual(expect.arrayContaining(["pipeline_published", "study_server"]));
    expect(result.items.find((i) => i.code === "study_server")).toMatchObject({ owner: "system", text: "Start the study server" });
  });

  it("explains a study server that runs another pipeline version", () => {
    const result = evaluatePreflight("run", runSnap({ studyServer: { running: true, servesPipeline: false } }));
    expect(result.items.find((i) => i.code === "study_server")?.detail).toContain("different pipeline version");
  });

  it("fails when there are no active sites", () => {
    const result = evaluatePreflight("run", runSnap({ sites: [] }));
    expect(failed(result)).toContain("sites");
    expect(result.items.some((i) => i.code === "min_sites")).toBe(false);
  });

  it("leaves connection items out until the study server has been asked, and flags an unreachable one", () => {
    const unchecked = evaluatePreflight("run", runSnap({ sites: [site("A", { connected: null, imageState: null })] }));
    expect(unchecked.items.map((i) => i.code)).not.toContain("site_connected:ss-A");
    const unreachable = evaluatePreflight("run", runSnap({ sites: [site("A", { connected: null })], serverUnreachable: true }));
    expect(unreachable.items.find((i) => i.code === "site_connection_check")).toMatchObject({ ok: false, owner: "system" });
  });

  it("never shows raw ids or enum values as text", () => {
    const result = evaluatePreflight("run", runSnap({ sites: [site("A", { imageState: "NOT_REPORTED", connected: false, signedOff: false })] }));
    for (const entry of result.items) expect(`${entry.text} ${entry.detail ?? ""}`).not.toMatch(/NOT_REPORTED|OUTDATED|ss-A|sha256/);
  });
});

describe("evaluatePreflight busy and unchecked items", () => {
  it("makes a run wait for a publish or another run, and omits the items when not checked", () => {
    expect(evaluatePreflight("run", runSnap()).items.map((i) => i.code)).not.toContain("run_idle");
    const busy = evaluatePreflight("run", runSnap({ publishInProgress: true, runInProgress: true }));
    expect(failed(busy)).toEqual(expect.arrayContaining(["publish_idle", "run_idle"]));
    expect(busy.ok).toBe(false);
    const idle = evaluatePreflight("run", runSnap({ publishInProgress: false, runInProgress: false }));
    expect(idle.items.filter((i) => i.code === "publish_idle" || i.code === "run_idle").every((i) => i.ok)).toBe(true);
  });

  it("asks to check the saved code instead of saying none is saved when the code host could not be asked", () => {
    const result = evaluatePreflight("publish", publishSnap({ savedCode: false, savedCodeUnchecked: true }));
    expect(result.items.map((i) => i.code)).toContain("saved_code_check");
    expect(result.items.map((i) => i.code)).not.toContain("saved_code");
    expect(result.items.find((i) => i.code === "saved_code_check")).toMatchObject({ ok: false, owner: "system", text: "Check the saved code" });
  });

  it("sends the ethics and study question fixes to their own tabs", () => {
    const result = evaluatePreflight("publish", publishSnap({ ethics: null, questions: { answered: 3, total: 29 } }));
    expect(result.items.find((i) => i.code === "ethics")?.fixHref).toBe("/studies/s1?section=protocol&tab=ethics");
    expect(result.items.find((i) => i.code === "study_questions")?.fixHref).toBe("/studies/s1?section=protocol&tab=requirements");
  });
});
