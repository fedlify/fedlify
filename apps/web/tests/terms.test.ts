import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTION_LABELS, ROLE_LABELS, STATUS_LABELS, auditActionLabel, roleLabel, statusLabel } from "@/lib/terms";

const ROOT = path.resolve(__dirname, "..");
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");

function enumValues(name: string): string[] {
  const match = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(schema);
  if (!match) throw new Error(`enum ${name} not found`);
  return match[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean);
}

function allEnumNames(): string[] {
  return [...schema.matchAll(/^enum (\w+) \{/gm)].map((m) => m[1]);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

const BANNED = [
  "aggregator", "nvflare", "startup kit", "join package", "heartbeat", "participant site", "participating site", "save to main",
  "attestation", "machine evidence", "source workspace", "compose project", "gitea", "digest", "sha256", "study image",
  "readiness check", "agent", "client", "kit release", "commit hash"
];

// Status-like enums that can reach the UI as a status tag.
const STATUS_ENUMS = allEnumNames().filter((name) => name.endsWith("Status") && name !== "SiteJoinPackageKind");
const EXTRA_STATUS_ENUMS = ["ControlState", "StopCondition", "ProbeDisposition", "NvflareJobEventType", "EvidenceClassification"];

describe("status labels", () => {
  it("finds the status enums", () => {
    expect(STATUS_ENUMS.length).toBeGreaterThan(20);
  });

  for (const name of [...STATUS_ENUMS, ...EXTRA_STATUS_ENUMS]) {
    it(`labels every ${name} value`, () => {
      for (const value of enumValues(name)) {
        expect(STATUS_LABELS[value], `${name}.${value}`).toBeTruthy();
        expect(statusLabel(value)).toBe(STATUS_LABELS[value]);
      }
    });
  }

  it("never returns raw enum text", () => {
    for (const [key, label] of Object.entries(STATUS_LABELS)) {
      expect(label, key).not.toMatch(/_/);
      expect(label, key).not.toBe(key);
    }
  });

  it("falls back to sentence case", () => {
    expect(statusLabel("SOME_NEW_STATE")).toBe("Some new state");
    expect(statusLabel(null)).toBe("Unknown");
    expect(statusLabel("running")).toBe(STATUS_LABELS.RUNNING);
  });
});

describe("role labels", () => {
  for (const name of ["StudyRole", "SiteRole", "OrgRole", "PlatformRole"]) {
    it(`labels every ${name} value`, () => {
      for (const value of enumValues(name)) expect(ROLE_LABELS[value], `${name}.${value}`).toBeTruthy();
    });
  }
  it("roleLabel falls back readably", () => {
    expect(roleLabel("DATA_SCIENTIST")).toBe("Data scientist");
    expect(roleLabel("NEW_ROLE")).toBe("New role");
  });
});

describe("audit action labels", () => {
  function auditKeysInCode(): Set<string> {
    const keys = new Set<string>();
    for (const file of walk(path.join(ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/action:\s*"([\w-]+\.[\w.-]+)"/g)) keys.add(m[1]);
      for (const m of text.matchAll(/safeAudit\([^"\n]*"([\w-]+\.[\w.-]+)"/g)) keys.add(m[1]);
      for (const m of text.matchAll(/AGENT_PLAN_INVALID_ACTION\s*=\s*"([\w.]+)"/g)) keys.add(m[1]);
    }
    const types = readFileSync(path.join(ROOT, "src/lib/agent-thread-types.ts"), "utf8");
    const block = /AUDIT_ACTIONS = \{([^}]*)\}/.exec(types)?.[1] ?? "";
    for (const m of block.matchAll(/:\s*"([\w.]+)"/g)) keys.add(m[1]);
    return keys;
  }

  it("has a label for every audit action key written in the code", () => {
    const keys = auditKeysInCode();
    expect(keys.size).toBeGreaterThan(50);
    const missing = [...keys].filter((key) => !AUDIT_ACTION_LABELS[key]);
    expect(missing).toEqual([]);
  });

  it("covers the derived and dynamic keys", () => {
    for (const key of ["study.update", "study.activate", "study.archive", "study.reactivate", "control.fact.propose", "control.fact.confirm", "study.publish.succeeded", "study.publish.failed"]) {
      expect(AUDIT_ACTION_LABELS[key], key).toBeTruthy();
    }
  });

  it("labels the example from the brief", () => {
    expect(auditActionLabel("nvflare.job.submit")).toBe("Started a run");
  });

  it("has a readable fallback", () => {
    expect(auditActionLabel("widget.thing.frobnicate")).toBe("Thing frobnicate");
    expect(auditActionLabel("site.join_package.create_failed")).toBe(AUDIT_ACTION_LABELS["site.join_package.create_failed"]);
    expect(auditActionLabel("site.token.rotate_failed")).toMatch(/^Failed attempt/);
  });
});

describe("vocabulary", () => {
  it("uses no banned word in any label", () => {
    const labels = [...Object.values(STATUS_LABELS), ...Object.values(ROLE_LABELS), ...Object.values(AUDIT_ACTION_LABELS)];
    for (const label of labels) {
      for (const banned of BANNED) expect(label.toLowerCase(), `"${label}" contains "${banned}"`).not.toContain(banned);
    }
  });
});
