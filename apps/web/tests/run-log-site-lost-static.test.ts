import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const web = new URL("..", import.meta.url).pathname;
const fedlify = path.join(web, "../..");
const read = (p: string) => readFileSync(p, "utf8");

describe("run log and site-lost migration", () => {
  const sql = read(path.join(web, "prisma/migrations/20261110090000_run_log_and_site_lost/migration.sql"));
  const schema = read(path.join(web, "prisma/schema.prisma"));
  it("is additive: nullable columns only, no defaults, no destructive statements", () => {
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|RENAME|SET NOT NULL|NOT NULL|DEFAULT)\b/i);
    const cols: Array<[string, string, RegExp]> = [
      ["logText", "TEXT", /String\?/], ["logChecksum", "TEXT", /String\?/], ["logTruncated", "BOOLEAN", /Boolean\?/], ["logCapturedAt", "TIMESTAMP\\(3\\)", /DateTime\?/],
      ["siteLostSince", "TIMESTAMP\\(3\\)", /DateTime\?/], ["siteLostSeenAt", "TIMESTAMP\\(3\\)", /DateTime\?/], ["siteLostSites", "JSONB", /Json\?/]
    ];
    for (const [col, type, prisma] of cols) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE "NvflareJob" ADD COLUMN "${col}" ${type};`));
      expect(schema).toMatch(new RegExp(`model NvflareJob \\{[\\s\\S]*?\\n  ${col}\\s+${prisma.source}`));
    }
  });
});

describe("run sweeper deployment", () => {
  it("is in the kustomization, runs every minute, signs like the Argo callback and forbids overlap", () => {
    expect(read(path.join(fedlify, "deploy/k8s/kustomization.yaml"))).toContain("run-sweeper.yaml");
    const yaml = read(path.join(fedlify, "deploy/k8s/run-sweeper.yaml"));
    expect(yaml).toContain('schedule: "* * * * *"');
    expect(yaml).toContain("/api/webhooks/run-sweep");
    expect(yaml).toContain("argo-webhook-secret");
    expect(yaml).toContain("concurrencyPolicy: Forbid");
    expect(yaml).not.toMatch(/harbor-provisioner|harbor-registry-credentials/);
  });
});

describe("flare api adapter log endpoint", () => {
  it("serves the job log, from the live workspace first", () => {
    const py = read(path.join(fedlify, "services/flare-api-adapter/fedlify_flare_api_adapter.py"));
    expect(py).toContain('action == "log"');
    expect(py.indexOf("live_log_path(job_id)")).toBeLessThan(py.indexOf("rglob(LOG_FILE)"));
  });
});

describe("run detail route", () => {
  it("re-reads the job when reconcile captured a log, so an unsaved run shows it on the same view", () => {
    const route = read(path.join(web, "src/app/api/v1/studies/[studyId]/runs/[jobId]/route.ts"));
    expect(route).toMatch(/reconciled\.metricsCaptured \|\| reconciled\.logCaptured/);
  });
});
