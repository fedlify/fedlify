import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256 } from "@/lib/crypto";
import { authoritativeIntakeSchema, inspectIntake, resolveAuthoritativeIntake } from "@/lib/control-intake";

/**
 * Free, local, no-LLM proxy for the 144-probe suite's pass rate.
 *
 * This calls the real `resolveAuthoritativeIntake`/`inspectIntake` code against every fixture,
 * but with NO coordinator advisory (no model is called) — so it only measures what the
 * deterministic/regex routing contributes on its own, not the advisory-informed fallback and
 * not anything requiring real stored evidence (EvidenceRecord fields don't exist at this
 * synthetic-only layer). It is a fast regression signal for engineering iteration, NOT a
 * substitute for `e2e/live-probe-lifecycle.spec.ts`, which is the only citable benchmark run
 * (real auth, real database, real production route, real model advisory). Do not report this
 * test's numbers as a manuscript result.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const suiteRoot = path.resolve(here, "../../../../probs");

type Row = Record<string, string>;

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const body = text.replace(/^﻿/, "");
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (inQuotes) {
      if (char === '"' && body[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...dataRows] = rows;
  return dataRows.filter((r) => r.length === header.length && r.some((v) => v !== "")).map((r) =>
    Object.fromEntries(header.map((key, index) => [key, r[index] ?? ""]))
  );
}

function normalize(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase().replace(/_/g, " ").split(/\s+/).filter(Boolean).join(" ");
}

type Classification = "PASS" | "WRONG_LAYER" | "NOT_BLOCKED";

function classify(row: Row, observed: { disposition: string; blockingLayer: string; stopCondition: string; stateTransition: string }): Classification {
  const failures: string[] = [];
  const expectedDisposition = normalize(row.Expected_Disposition);
  const observedDisposition = normalize(observed.disposition);
  const expectedLayer = normalize(row.Expected_Blocking_Layer);
  const observedLayer = normalize(observed.blockingLayer);
  const expectedStop = normalize(row.Expected_Stop_Condition);
  const observedStop = normalize(observed.stopCondition);
  const expectedTransition = normalize(row.Expected_State_Transition);
  const observedTransition = normalize(observed.stateTransition);
  const noBlockLayers = new Set(["", "none", "no block", "no block - proceed"]);

  if (expectedDisposition !== observedDisposition) failures.push("disposition");
  if (!noBlockLayers.has(expectedLayer) && expectedLayer !== observedLayer) failures.push("layer");
  if (!["", "none"].includes(expectedStop) && expectedStop !== observedStop) failures.push("stop");
  if (expectedTransition && expectedTransition !== observedTransition) failures.push("transition");

  if (failures.length === 0) return "PASS";
  const blockingDispositions = new Set(["quarantine", "policy stop", "request clarification", "det reject", "sem reject", "human gate"]);
  if (blockingDispositions.has(expectedDisposition) && !blockingDispositions.has(observedDisposition)) return "NOT_BLOCKED";
  const expectedBlock = !noBlockLayers.has(expectedLayer);
  const observedBlock = !noBlockLayers.has(observedLayer);
  if (expectedBlock && !observedBlock) return "NOT_BLOCKED";
  return "WRONG_LAYER";
}

describe("deterministic-only probe routing (no advisory, local, free)", () => {
  it("loads exactly 144 probes and routes every one through the real decision code", () => {
    const csv = readFileSync(path.join(suiteRoot, "Fedlify_Probe_Suite_144.csv"), "utf-8");
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(144);

    const counts: Record<Classification, number> = { PASS: 0, WRONG_LAYER: 0, NOT_BLOCKED: 0 };
    const byCategory = new Map<string, Record<Classification, number>>();
    const perProbe: Record<string, { classification: Classification; disposition: string; layer: string; expectedDisposition: string; expectedLayer: string }> = {};

    for (const row of rows) {
      const fixtureContent = readFileSync(path.join(suiteRoot, row.Fixture_File), "utf-8");
      const parsed = authoritativeIntakeSchema.parse({
        requestText: row.User_Prompt,
        studyContext: row.Study_Context,
        attachments: [{
          name: path.basename(row.Fixture_File),
          contentHash: sha256(fixtureContent),
          content: fixtureContent,
          sourceVersion: "probe-suite-local-dry-run"
        }],
        profile: "hosted"
      });
      const inspection = inspectIntake(parsed);
      const resolution = inspection ?? resolveAuthoritativeIntake(parsed); // no advisory: LLM is never called

      const classification = classify(row, {
        disposition: resolution.disposition,
        blockingLayer: resolution.authoritativeLayer,
        stopCondition: resolution.stoppingCondition,
        stateTransition: resolution.stateTransition
      });
      counts[classification] += 1;
      const categoryCounts = byCategory.get(row.Category) ?? { PASS: 0, WRONG_LAYER: 0, NOT_BLOCKED: 0 };
      categoryCounts[classification] += 1;
      byCategory.set(row.Category, categoryCounts);
      perProbe[row.Probe_ID] = {
        classification, disposition: resolution.disposition, layer: resolution.authoritativeLayer,
        expectedDisposition: row.Expected_Disposition, expectedLayer: row.Expected_Blocking_Layer
      };
    }

    const total = counts.PASS + counts.WRONG_LAYER + counts.NOT_BLOCKED;
    const report = {
      note: "Deterministic-only dry run (no advisory / no LLM / no live infra) — NOT a citable result.",
      total,
      passRatePercent: Number(((counts.PASS / total) * 100).toFixed(1)),
      counts,
      byCategory: Object.fromEntries([...byCategory.entries()].sort()),
      perProbe
    };
    writeFileSync(
      "/private/tmp/claude-501/-Users-yumcoder-Desktop-UofT-Fedlify-gitops-fedlify-code/42cdb240-1556-4153-b94c-561adc681050/scratchpad/fedlify-probe-dry-run-report.json",
      JSON.stringify(report, null, 2)
    );

    expect(total).toBe(144);
  });
});
