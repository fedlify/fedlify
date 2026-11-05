import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;

describe("run evidence migration", () => {
  const sql = readFileSync(`${root}prisma/migrations/20261107120000_run_evidence/migration.sql`, "utf8");
  const schema = readFileSync(`${root}prisma/schema.prisma`, "utf8");
  it("is additive only", () => {
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|RENAME|SET NOT NULL)\b/i);
    for (const col of ["gitCommit", "imageDigest", "siteDigests", "runParameters", "metricsSummary"]) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE "NvflareJob" ADD COLUMN "${col}" (TEXT|JSONB);`));
      expect(schema).toMatch(new RegExp(`model NvflareJob \\{[\\s\\S]*?\\n  ${col}\\s+(String|Json)\\?`));
    }
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'ROUND_METRICS'");
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'MODEL_CARD'");
    expect(schema).toMatch(/enum ModelArtifactKind \{[^}]*ROUND_METRICS[^}]*MODEL_CARD/);
  });
});
