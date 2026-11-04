import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  alignmentReport,
  applyContractToPipelineJson,
  DEFAULT_CONTRACT,
  importableFiles,
  isCommitRef,
  isZipJunk,
  contractFromPipelineJson,
  failureIsStale,
  featureAvailability,
  nameError,
  parseRepoUrl,
  pipelineRows,
  safeImportPath,
  sortByFit,
  stripCommonRoot
} from "@/lib/pipeline-start";

const goodClient = "import nvflare.client as flare\nflare.init()\nwhile flare.is_running():\n    m = flare.receive()\n    flare.send(m)\n";

describe("failureIsStale", () => {
  it("is stale only when the head differs from the failed commit", () => {
    expect(failureIsStale("abcdef1234", "abcdef1234")).toBe(false);
    expect(failureIsStale("abcdef12", "abcdef1234567")).toBe(false);
    expect(failureIsStale("abcdef1234", "ffffff0000")).toBe(true);
  });
  it("is not stale when either commit is unknown", () => {
    expect(failureIsStale(null, "abc1234")).toBe(false);
    expect(failureIsStale("abc1234", null)).toBe(false);
  });
});

describe("pipelineRows", () => {
  const projects = [
    { id: "p1", name: "HF v1", versions: [{ id: "v1", version: "v1", gitCommit: "a", validationStatus: "PASSED", publish: { status: "PASSED" } }] },
    { id: "p2", name: "HF v2", sourceKind: "copy" as const, parentProjectId: "p1", parentVersion: "v1", versions: [] }
  ];
  const rows = pipelineRows(projects, "v1", [{ id: "j1", status: "COMPLETED", createdAt: "2026-11-01T00:00:00Z", pipelineVersion: { id: "v1", version: "v1" } }]);
  it("marks the live pipeline and its last run", () => {
    expect(rows[0]).toMatchObject({ live: true, liveVersion: "v1", state: "PASSED", source: "Template" });
    expect(rows[0].lastRun?.status).toBe("COMPLETED");
  });
  it("shows lineage and an unpublished state", () => {
    expect(rows[1]).toMatchObject({ live: false, state: "Not published", lineage: "forked from HF v1 v1", lastRun: null, source: "Copy" });
  });
});

describe("misc helpers", () => {
  it("validates names", () => {
    expect(nameError("ab")).not.toBeNull();
    expect(nameError("  HF mortality ")).toBeNull();
  });
  it("sorts best fit first and keeps ties stable", () => {
    expect(sortByFit([{ fit: "different" as const, n: 1 }, { fit: "fits" as const, n: 2 }, { fit: "fits" as const, n: 3 }]).map((i) => i.n)).toEqual([2, 3, 1]);
  });
  it("parses repo urls and rejects odd ones", () => {
    expect(parseRepoUrl("https://git.example.com/org/repo.git")).toEqual({ owner: "org", repo: "repo" });
    expect(parseRepoUrl("https://git.example.com/org")).toBeNull();
    expect(parseRepoUrl("not a url")).toBeNull();
  });
  it("rejects unsafe zip paths and strips one common root", () => {
    expect(safeImportPath("../x.py")).toBe(false);
    expect(safeImportPath("/x.py")).toBe(false);
    expect(safeImportPath(".git/config")).toBe(false);
    expect(safeImportPath("a/b.py")).toBe(true);
    expect(stripCommonRoot(["r/a.py", "r/b/c.py"])).toEqual(["a.py", "b/c.py"]);
    expect(stripCommonRoot(["r/a.py", "b.py"])).toEqual(["r/a.py", "b.py"]);
  });
});

describe("contract json", () => {
  const existing = JSON.stringify({ name: "X", entrypoint: "client.py", dataContract: { label: "y", features: ["a"], minimumRows: 50 }, runtimeDefaults: { numRounds: 5, minClients: 2 } });
  it("round-trips and keeps other keys", () => {
    const next = applyContractToPipelineJson(existing, { label: "died", positiveValue: "1", positiveValueType: "string", features: ["a", "b"], numRounds: 8, minClients: 3 }, "N");
    const parsed = JSON.parse(next);
    expect(parsed.entrypoint).toBe("client.py");
    expect(parsed.dataContract.minimumRows).toBe(50);
    expect(contractFromPipelineJson(next)).toEqual({ label: "died", positiveValue: "1", positiveValueType: "string", features: ["a", "b"], numRounds: 8, minClients: 3 });
  });
  it("creates a file when none exists", () => {
    expect(JSON.parse(applyContractToPipelineJson(null, { label: "y", positiveValue: "", features: ["a"], numRounds: 5, minClients: 2 }, "New")).name).toBe("New");
  });
});

describe("featureAvailability", () => {
  it("marks unknown when a site lists no columns", () => {
    const rows = featureAvailability(["age", "ptt"], [
      { code: "A", name: "A", dataProfile: { datasetDescription: "Columns: age, ptt" } },
      { code: "B", name: "B", dataProfile: { datasetDescription: "Columns: age" } },
      { code: "C", name: "C", dataProfile: null }
    ]);
    expect(rows.find((r) => r.name === "ptt")?.bySite).toEqual({ A: "listed", B: "missing", C: "unknown" });
  });
});

const launcher = "script /opt/fedlify/code/client.py";
const goodPipeline = JSON.stringify({ packageType: "fedlify-study-pipeline", entrypoint: "client.py", dataContract: { label: "y", features: ["a"] } });
const okRepo = [
  { path: "client.py", content: goodClient },
  { path: "requirements.txt", content: "numpy==1.26.0\n" },
  { path: "tests/test_a.py", content: "" },
  { path: "AGENTS.md", content: "x" },
  { path: "fedlify-pipeline.json", content: goodPipeline },
  { path: "job/meta.conf", content: "{}" },
  { path: "job/app/config/config_fed_server.conf", content: "{}" },
  { path: "job/app/config/config_fed_client.conf", content: launcher }
];

describe("alignmentReport", () => {
  it("passes a conforming repo", () => {
    const report = alignmentReport(okRepo);
    expect(report.blocking).toEqual([]);
    expect(report.advisory).toEqual([]);
  });
  it("flags blocking items without echoing secrets", () => {
    const secret = "api_key = \"SUPERSECRETVALUE123\"";
    const report = alignmentReport([
      { path: "train.py", content: `import requests\nrequests.get("x")\npd.read_csv("data/p.csv")\n${secret}\n` },
      { path: "data/patients.csv", content: "" },
      { path: "requirements.txt", content: "torch\nnumpy==1\n" }
    ]);
    const ids = report.blocking.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["data-files", "secrets", "client-loop", "network", "data-path", "layout", "requirements"]));
    expect(report.advisory.map((f) => f.id)).toEqual(expect.arrayContaining(["tests"]));
    expect(JSON.stringify(report)).not.toContain("SUPERSECRETVALUE123");
  });
  it("treats every publish rule as blocking: contract, entrypoint, launcher, data suffixes, requirement forms", () => {
    const report = alignmentReport([
      ...okRepo.filter((f) => !["fedlify-pipeline.json", "job/app/config/config_fed_client.conf", "requirements.txt"].includes(f.path)),
      { path: "fedlify-pipeline.json", content: JSON.stringify({ packageType: "other", entrypoint: "nope.py", dataContract: { label: "y" } }) },
      { path: "job/app/config/config_fed_client.conf", content: "script /elsewhere/x.py" },
      { path: "requirements.txt", content: "git+https://x/y.git@v1==1\n-r other.txt\n" },
      { path: "data/a.tsv", content: "" },
      { path: "w.pkl", content: "" }
    ]);
    const text = JSON.stringify(report.blocking);
    expect(report.blocking.map((f) => f.id)).toEqual(expect.arrayContaining(["contract", "launcher", "requirements", "data-files"]));
    expect(text).toContain("packageType");
    expect(text).toContain("entrypoint");
    expect(text).toContain("label and a features list");
    expect(report.blocking.find((f) => f.id === "data-files")?.paths).toEqual(expect.arrayContaining(["data/a.tsv", "w.pkl"]));
  });
  it("matches validate_repo.py on the same fixtures", () => {
    const script = resolve(__dirname, "../../../deploy/images/study/validate_repo.py");
    const python = spawnSync("python3", ["--version"]);
    if (python.status !== 0 || !existsSync(script)) return;
    const fixtures: Array<Array<{ path: string; content: string }>> = [
      okRepo,
      okRepo.filter((f) => f.path !== "client.py"),
      [...okRepo.filter((f) => f.path !== "requirements.txt"), { path: "requirements.txt", content: "numpy\n" }],
      [...okRepo, { path: "x/data.tsv", content: "" }],
      [...okRepo.filter((f) => f.path !== "fedlify-pipeline.json"), { path: "fedlify-pipeline.json", content: JSON.stringify({ packageType: "fedlify-study-pipeline", dataContract: { label: "y" } }) }]
    ];
    for (const files of fixtures) {
      const dir = mkdtempSync(join(tmpdir(), "fedlify-fixture-"));
      try {
        for (const file of files) {
          mkdirSync(join(dir, dirname(file.path)), { recursive: true });
          writeFileSync(join(dir, file.path), file.content);
        }
        const rejected = spawnSync("python3", ["-I", script, dir]).status !== 0;
        const report = alignmentReport(files);
        // client-loop, network and data-path are Fedlify guidance, not CI rules, so they are left out of the comparison.
        const ciBlocking = report.blocking.filter((f) => !["client-loop", "network", "data-path"].includes(f.id));
        expect(ciBlocking.length > 0).toBe(rejected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe("importableFiles", () => {
  it("drops data-like files but keeps credential files so the server refuses them", () => {
    const kept = importableFiles([
      { path: "client.py", content: "x" },
      { path: "a.tsv", content: "" },
      { path: "data/patients.csv", content: "" },
      { path: "cfg.py", content: 'password = "hunter2hunter2"' }
    ]);
    expect(kept.map((f) => f.path)).toEqual(["client.py", "cfg.py"]);
  });
});

describe("zip paths", () => {
  it("drops macOS junk and keeps wrapper stripping working once it is gone", () => {
    expect(isZipJunk("__MACOSX/repo/._a.py")).toBe(true);
    expect(isZipJunk("repo/.DS_Store")).toBe(true);
    expect(isZipJunk("repo/a.py")).toBe(false);
    expect(stripCommonRoot(["repo-main/a.py", "repo-main/job/x.conf"])).toEqual(["a.py", "job/x.conf"]);
  });
  it("does not strip a lone folder that is a repo part", () => {
    expect(stripCommonRoot(["job/meta.conf", "job/app/a.conf"])).toEqual(["job/meta.conf", "job/app/a.conf"]);
    expect(stripCommonRoot(["tests/a.py"])).toEqual(["tests/a.py"]);
  });
});

describe("contract json types", () => {
  it("writes an unchanged numeric positiveValue back as a number", () => {
    const text = JSON.stringify({ dataContract: { label: "y", features: ["a"], positiveValue: 1 }, runtimeDefaults: { numRounds: 3, minClients: 2 } });
    const draft = contractFromPipelineJson(text)!;
    const out = JSON.parse(applyContractToPipelineJson(text, { ...draft, numRounds: 7 }, "n"));
    expect(out.dataContract.positiveValue).toBe(1);
    expect(out.runtimeDefaults.numRounds).toBe(7);
  });
  it("keeps the source's label and features when the wizard could not read them", () => {
    const text = JSON.stringify({ dataContract: { label: "y", features: ["a"] } });
    const out = JSON.parse(applyContractToPipelineJson(text, { ...DEFAULT_CONTRACT, numRounds: 9 }, "n", { keepBlank: true }));
    expect(out.dataContract).toEqual({ label: "y", features: ["a"] });
    expect(out.runtimeDefaults.numRounds).toBe(9);
  });
});

describe("isCommitRef", () => {
  it("tells commit ids from branch names", () => {
    expect(isCommitRef("0123abc")).toBe(true);
    expect(isCommitRef("a".repeat(40))).toBe(true);
    expect(isCommitRef("main")).toBe(false);
    expect(isCommitRef("feature/x")).toBe(false);
    expect(isCommitRef(undefined)).toBe(false);
  });
});
