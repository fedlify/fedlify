import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { checkLineage, sameCommit } from "@/lib/pipeline-lineage";
import { guardedLookup, isBlockedAddress, isSafeRef, parseImportUrl, prepareImport, readZipFiles, fetchPublicArchive, ImportError } from "@/lib/repo-import";
import { IMPORT_LIMITS, importProposalPrompt } from "@/lib/pipeline-start";

const GITEA = "git.fedlify.example";
const parse = (url: string, ref?: string) => parseImportUrl(url, ref, GITEA);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof ImportError ? error.code : "other";
  }
  return null;
};

describe("import URL safety", () => {
  it("accepts https github.com and this Gitea, normalises, and builds the archive URL itself", () => {
    expect(parse("https://github.com/acme/fl-model.git")).toMatchObject({ kind: "github", owner: "acme", repo: "fl-model", url: "https://github.com/acme/fl-model", archiveUrl: "https://codeload.github.com/acme/fl-model/zip/HEAD" });
    expect(parse("https://github.com/acme/fl-model/tree/dev")).toMatchObject({ ref: "dev", archiveUrl: "https://codeload.github.com/acme/fl-model/zip/dev" });
    expect((parse("https://github.com/acme/fl-model", "release/1.0") as { archiveUrl: string }).archiveUrl).toBe("https://codeload.github.com/acme/fl-model/zip/release/1.0");
    expect(parse(`https://${GITEA}/study-org/repo`)).toMatchObject({ kind: "gitea", owner: "study-org", repo: "repo" });
  });

  it("rejects non-https, credentials, ports, IP literals, other hosts, queries and odd paths", () => {
    expect(code(() => parse("http://github.com/a/b"))).toBe("url_not_https");
    expect(code(() => parse("git@github.com:a/b.git"))).toBe("invalid_url");
    expect(code(() => parse("https://user:pw@github.com/a/b"))).toBe("url_has_credentials");
    expect(code(() => parse("https://github.com:8443/a/b"))).toBe("url_port");
    expect(code(() => parse("https://127.0.0.1/a/b"))).toBe("url_ip_literal");
    expect(code(() => parse("https://169.254.169.254/a/b"))).toBe("url_ip_literal");
    expect(code(() => parse("https://[::1]/a/b"))).toBe("url_ip_literal");
    expect(code(() => parse("https://evil.example/a/b"))).toBe("host_not_allowed");
    expect(code(() => parse("https://github.com.evil.example/a/b"))).toBe("host_not_allowed");
    expect(code(() => parse("https://githubXcom/a/b"))).toBe("host_not_allowed");
    expect(code(() => parse("https://github.com/a/b?x=1"))).toBe("invalid_url");
    expect(code(() => parse("https://github.com/a"))).toBe("invalid_url");
    expect(code(() => parse("https://github.com/a/b/issues/1"))).toBe("invalid_url");
    expect(code(() => parse("https://github.com/a/b%2F..%2Fc"))).toBe("invalid_url");
    expect(code(() => parse(`https://github.com/a/${"x".repeat(400)}`))).toBe("invalid_url");
    expect(code(() => parseImportUrl("https://git.fedlify.example/a/b", null, null))).toBe("host_not_allowed");
  });

  it("rejects refs that could change the request", () => {
    for (const bad of ["../x", "a..b", "-rf", "a b", "a?b", "a#b", "a//b", "x.lock", "/abs"]) expect(isSafeRef(bad)).toBe(false);
    for (const good of ["main", "v1.2.3", "release/1.0", "0123456789abcdef0123456789abcdef01234567"]) expect(isSafeRef(good)).toBe(true);
    expect(code(() => parse("https://github.com/a/b", "../../etc"))).toBe("invalid_ref");
  });
});

describe("blocked addresses", () => {
  it("blocks private, loopback, link-local, metadata and reserved ranges, including mapped IPv6", () => {
    const blocked = ["0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:7f00:1::", "2001:db8::1", "not-an-ip", ""];
    for (const address of blocked) expect(isBlockedAddress(address), address).toBe(true);
  });

  it("allows ordinary public addresses", () => {
    for (const address of ["140.82.121.3", "8.8.8.8", "172.32.0.1", "100.63.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isBlockedAddress(address), address).toBe(false);
  });

  it("guardedLookup fails when any resolved address is blocked, and passes public ones", async () => {
    const resolver = (answers: string[]) => (_host: string, _options: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) => cb(null, answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
    const run = (answers: string[], all = false) =>
      new Promise<{ error: NodeJS.ErrnoException | null; address: unknown }>((resolve) =>
        guardedLookup(resolver(answers) as never)("h.example", { all } as never, (error, address) => resolve({ error, address }))
      );
    expect((await run(["8.8.8.8"])).address).toBe("8.8.8.8");
    expect((await run(["8.8.8.8", "8.8.4.4"], true)).address).toHaveLength(2);
    expect((await run(["10.0.0.5"])).error?.code).toBe("EBLOCKED");
    expect((await run(["8.8.8.8", "169.254.169.254"])).error?.code).toBe("EBLOCKED");
    expect((await run([])).error?.code).toBe("EBLOCKED");
  });

  it("fetchPublicArchive refuses hosts that are not archive endpoints before connecting", async () => {
    await expect(fetchPublicArchive("https://evil.example/x.zip")).rejects.toMatchObject({ code: "host_not_allowed" });
    await expect(fetchPublicArchive("http://codeload.github.com/a/b/zip/HEAD")).rejects.toMatchObject({ code: "host_not_allowed" });
    await expect(fetchPublicArchive("https://u:p@codeload.github.com/a/b/zip/HEAD")).rejects.toMatchObject({ code: "host_not_allowed" });
    await expect(fetchPublicArchive("https://codeload.github.com/a/b/zip/HEAD", { lookup: guardedLookup(((_h: string, _o: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: "127.0.0.1", family: 4 }])) as never) })).rejects.toMatchObject({ code: "host_not_allowed" });
  });
});

async function zipOf(entries: Record<string, string | { data: string; mode?: number }>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) {
    if (typeof value === "string") zip.file(name, value);
    else zip.file(name, value.data, { unixPermissions: value.mode, createFolders: false });
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "UNIX" });
}

const goodClient = "import nvflare.client as flare\nflare.init()\nwhile flare.is_running():\n    m = flare.receive()\n    flare.send(m)\n";

describe("zip safety", () => {
  it("strips the wrapper folder and ignores macOS metadata", async () => {
    const read = await readZipFiles(await zipOf({ "repo-main/client.py": goodClient, "repo-main/README.md": "hi", "__MACOSX/repo-main/._client.py": "x", "repo-main/.DS_Store": "x" }));
    expect(read.files.map((file) => file.path).sort()).toEqual(["README.md", "client.py"]);
  });

  it("never keeps an entry that climbs out of the repository (zip-slip), absolute, backslash or .git paths", async () => {
    const read = await readZipFiles(await zipOf({ "ok.py": "x=1", "../evil.py": "x", "a/../../evil2.py": "x", "/etc/passwd": "x", "dir\\win.py": "x", ".git/config": "x" }));
    const paths = read.files.map((file) => file.path);
    expect(paths).toEqual(["ok.py"]);
    expect(paths.join("|")).not.toMatch(/evil|passwd|win|config/);
    expect(read.skipped.length).toBeGreaterThan(0);
  });

  it("drops symlinks without reading them", async () => {
    const read = await readZipFiles(await zipOf({ "a.py": "x=1", link: { data: "/etc/passwd", mode: 0o120777 } }));
    expect(read.files.map((file) => file.path)).toEqual(["a.py"]);
    expect(read.skipped).toContain("link");
  });

  it("does not inflate data-like files, and skips binary and oversized files", async () => {
    const big = "a".repeat(IMPORT_LIMITS.maxFileBytes + 1);
    const read = await readZipFiles(await zipOf({ "data/patients.csv": "id,name\n1,x\n", "big.py": big, "model.py": "x=1" }));
    expect(read.files.find((file) => file.path === "data/patients.csv")?.content).toBe("");
    expect(read.skipped).toContain("big.py");
    expect(read.files.map((file) => file.path)).toContain("model.py");
  });

  it("stops a zip bomb: total inflated size is capped even when each file is small", async () => {
    const chunk = "0".repeat(IMPORT_LIMITS.maxFileBytes - 10);
    const entries: Record<string, string> = {};
    for (let i = 0; i < Math.ceil(IMPORT_LIMITS.maxTotalBytes / chunk.length) + 3; i += 1) entries[`f${i}.py`] = chunk;
    const bomb = await zipOf(entries);
    expect(bomb.length).toBeLessThan(IMPORT_LIMITS.maxZipBytes);
    await expect(readZipFiles(bomb)).rejects.toMatchObject({ code: "archive_too_large" });
  });

  it("rejects too many entries, non-zip bytes and oversized archives", async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 1001; i += 1) entries[`f${i}.py`] = "x";
    await expect(readZipFiles(await zipOf(entries))).rejects.toMatchObject({ code: "too_many_files" });
    await expect(readZipFiles(Buffer.from("not a zip at all"))).rejects.toMatchObject({ code: "bad_archive" });
    await expect(readZipFiles(Buffer.alloc(IMPORT_LIMITS.maxZipBytes + 1, 0x50))).rejects.toMatchObject({ code: "archive_too_large" });
  });
});

describe("prepareImport and the server-side alignment report", () => {
  const contract = JSON.stringify({ packageType: "fedlify-study-pipeline", name: "x", entrypoint: "job/app/custom/client.py", dataContract: { label: "y", features: ["a"] } });

  it("drops data-like paths and reports them, keeping code", () => {
    const out = prepareImport([
      { path: "client.py", content: goodClient },
      { path: "data/patients.csv", content: "" },
      { path: "raw_data/x.py", content: "x=1" },
      { path: "weights.parquet", content: "" }
    ]);
    expect(out.files.map((file) => file.path)).toEqual(["client.py"]);
    expect(out.dropped.sort()).toEqual(["data/patients.csv", "raw_data/x.py", "weights.parquet"]);
    expect(out.report.advisory.find((item) => item.id === "dropped-data")?.paths).toHaveLength(3);
  });

  it("rejects credentials without echoing them, naming only the path", () => {
    const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
    let error: ImportError | null = null;
    try {
      prepareImport([{ path: "client.py", content: goodClient }, { path: "config.py", content: `KEY = "${secret}"\n` }]);
    } catch (caught) {
      error = caught as ImportError;
    }
    expect(error?.code).toBe("secrets_found");
    expect(error?.status).toBe(422);
    expect(error?.paths).toEqual(["config.py"]);
    expect(JSON.stringify({ message: error?.message, paths: error?.paths })).not.toContain(secret);
  });

  it("flags what publish would reject: network calls, fixed data paths, missing client loop and files", () => {
    const out = prepareImport([
      { path: "train.py", content: 'import requests\nrequests.get("http://x")\npd.read_csv("local.csv")\n' },
      { path: "fedlify-pipeline.json", content: contract }
    ]);
    const ids = out.report.blocking.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(["client-loop", "network", "data-path"]));
    expect(out.report.advisory.map((item) => item.id)).toEqual(expect.arrayContaining(["tests", "agents-md"]));
  });

  it("enforces file count, per-file and total size, and unsafe or duplicate paths", () => {
    const many = Array.from({ length: IMPORT_LIMITS.maxFiles + 1 }, (_, i) => ({ path: `f${i}.py`, content: "x" }));
    expect(code(() => prepareImport(many))).toBe("too_many_files");
    const out = prepareImport([{ path: "ok.py", content: "x" }, { path: "ok.py", content: "y" }, { path: "../x.py", content: "x" }, { path: "big.py", content: "a".repeat(IMPORT_LIMITS.maxFileBytes + 1) }]);
    expect(out.files).toEqual([{ path: "ok.py", content: "x" }]);
    expect(out.skipped).toEqual(["../x.py", "big.py"]);
    expect(code(() => prepareImport([{ path: "a.csv", content: "" }]))).toBe("empty_source");
  });

  it("gives a stable digest for the same files in any order", () => {
    const a = prepareImport([{ path: "a.py", content: "1" }, { path: "b.py", content: "2" }]);
    const b = prepareImport([{ path: "b.py", content: "2" }, { path: "a.py", content: "1" }]);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds the proposal request from findings without file contents", () => {
    const out = prepareImport([{ path: "train.py", content: 'import requests\nrequests.get("http://x")\n' }]);
    const text = importProposalPrompt(out.report);
    expect(text).toContain("Fedlify contract");
    expect(text).toContain("train.py");
    expect(text).not.toContain("http://x");
  });
});

describe("lineage rules", () => {
  it("defaults the kind from the parent and allows a parent only for copy", () => {
    expect(checkLineage({})).toEqual({ ok: true, sourceKind: "template" });
    expect(checkLineage({ parentProjectId: "p" })).toEqual({ ok: true, sourceKind: "copy" });
    expect(checkLineage({ sourceKind: "copy", parentProjectId: "p", parentVersion: "v1" })).toEqual({ ok: true, sourceKind: "copy" });
    expect(checkLineage({ sourceKind: "import" })).toEqual({ ok: true, sourceKind: "import" });
    for (const bad of [{ sourceKind: "template" as const, parentProjectId: "p" }, { sourceKind: "assistant" as const, parentVersion: "v1" }, { sourceKind: "import" as const, parentProjectId: "p" }, { sourceKind: "copy" as const }, { sourceKind: "copy" as const, parentVersion: "v1" }]) {
      expect(checkLineage(bad)).toMatchObject({ ok: false, code: "invalid_lineage" });
    }
  });

  it("matches commits by full id or an abbreviation of at least 7 characters", () => {
    expect(sameCommit("0123456789abcdef", "0123456")).toBe(true);
    expect(sameCommit("0123456", "0123456789abcdef")).toBe(true);
    expect(sameCommit("012345", "0123456789abcdef")).toBe(false);
    expect(sameCommit("0123456789abcdef", "fedcba9876543210")).toBe(false);
    expect(sameCommit(null, "0123456")).toBe(false);
  });
});
