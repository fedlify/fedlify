import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isLegacyTemplateCommit,
  languageForPath,
  parseSourceRef,
  readLocalSourceFiles,
  toReviewSourceFiles
} from "@/lib/source-review";

describe("source review helpers", () => {
  it("parses source review refs", () => {
    expect(parseSourceRef()).toEqual({ kind: "current", id: null });
    expect(parseSourceRef("current")).toEqual({ kind: "current", id: null });
    expect(parseSourceRef("version:template-version-1")).toEqual({ kind: "version", id: "template-version-1" });
    expect(parseSourceRef("proposal:proposal-1")).toEqual({ kind: "proposal", id: "proposal-1" });
    expect(parseSourceRef("unknown:value")).toEqual({ kind: "current", id: null });
  });

  it("detects legacy seed template commits", () => {
    expect(isLegacyTemplateCommit("legacy-seed-nvflare-cross-silo-fedavg")).toBe(true);
    expect(isLegacyTemplateCommit("668010fac1c6")).toBe(false);
    expect(isLegacyTemplateCommit(null)).toBe(false);
  });

  it("maps common pipeline source files to readable languages", () => {
    expect(languageForPath("README.md")).toBe("markdown");
    expect(languageForPath("nvflare-job/app/config/config_fed_server.conf")).toBe("config");
    expect(languageForPath("fedlify_pipeline/executor.py")).toBe("python");
    expect(languageForPath("docker-compose.yml")).toBe("yaml");
  });

  it("filters binary-like files out of review source payloads", () => {
    const files = toReviewSourceFiles([
      { path: "README.md", content: "# Template" },
      { path: "workspace/models/server.npy", content: "binary" }
    ]);
    expect(files.map((file) => file.path)).toEqual(["README.md"]);
  });

  it("reads local source files for dev fallback review", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fedlify-source-review-"));
    try {
      await mkdir(path.join(root, "nvflare-job", "app", "config"), { recursive: true });
      await writeFile(path.join(root, "README.md"), "# Local pipeline\n");
      await writeFile(path.join(root, "nvflare-job", "app", "config", "config_fed_server.conf"), "min_clients = 1\n");
      await writeFile(path.join(root, "server.npy"), "not returned\n");

      const files = await readLocalSourceFiles(root);

      expect(files.map((file) => file.path).sort()).toEqual(["README.md", "nvflare-job/app/config/config_fed_server.conf"].sort());
      expect(files.find((file) => file.path === "README.md")?.language).toBe("markdown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
