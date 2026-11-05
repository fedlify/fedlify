// "Your data" screen: schema, counts and type problems only. No row is ever returned. Values leave this module only as
// category labels of tiny-cardinality columns, and only when every category has at least MIN_CELL rows.
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { MIN_CELL, suppress } from "./security.mjs";

// Columns that must not be in a federated extract (design section 9): identifiers and time-offset columns.
const FORBIDDEN_NAMES = new Set(["patientunitstayid", "patienthealthsystemstayid", "uniquepid"]);
const IDENTIFIER_LIKE = /(^|_)(id|uid|mrn|ssn|name|dob|birth|address|phone|email|zip|postcode)$|offset/i;
export function classifyColumnName(name) {
  const lower = String(name).trim().toLowerCase();
  if (FORBIDDEN_NAMES.has(lower)) return "forbidden";
  if (IDENTIFIER_LIKE.test(lower)) return "identifier_like";
  return "ok";
}

const MAX_ROWS = 2_000_000;
const MAX_DISTINCT = 7; // tracked per column; more than 6 distinct values means "not a category column"

/** Streaming RFC 4180 reader: handles quoted fields, escaped quotes and newlines inside quotes. Calls onRecord(fields). */
export async function readCsv(file, onRecord, { maxRows = MAX_ROWS } = {}) {
  let field = "";
  let record = [];
  let quoted = false;
  let pendingQuote = false;
  let rows = 0;
  let truncated = false;
  const endField = () => { record.push(field); field = ""; };
  const endRecord = () => {
    endField();
    if (!(record.length === 1 && record[0] === "")) { onRecord(record); rows += 1; }
    record = [];
  };
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 16 });
  outer: for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (pendingQuote) {
        pendingQuote = false;
        if (c === '"') { field += '"'; continue; }
        quoted = false;
      }
      if (quoted) {
        if (c === '"') pendingQuote = true;
        else field += c;
        continue;
      }
      if (c === '"' && field === "") quoted = true;
      else if (c === ",") endField();
      else if (c === "\n") endRecord();
      else if (c === "\r") continue;
      else field += c;
      if (rows > maxRows) { truncated = true; stream.destroy(); break outer; }
    }
  }
  if (field !== "" || record.length > 0) endRecord();
  return { rows, truncated };
}

const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export async function profileCsv(file) {
  let header = null;
  let columns = [];
  let total = 0;
  let ragged = 0;
  const { truncated } = await readCsv(file, (fields) => {
    if (!header) {
      header = fields.map((h) => h.trim());
      columns = header.map(() => ({ filled: 0, numeric: 0, text: 0, distinct: new Map() }));
      return;
    }
    total += 1;
    if (fields.length !== header.length) ragged += 1;
    for (let i = 0; i < columns.length; i++) {
      const v = (fields[i] ?? "").trim();
      const col = columns[i];
      if (v === "") continue;
      col.filled += 1;
      if (NUMERIC.test(v)) col.numeric += 1;
      else col.text += 1;
      if (col.distinct.size < MAX_DISTINCT || col.distinct.has(v)) col.distinct.set(v, (col.distinct.get(v) ?? 0) + 1);
    }
  });
  if (!header) return { error: "empty_file" };
  return {
    rows: suppress(total),
    truncated,
    raggedRows: suppress(ragged),
    columns: header.map((name, i) => {
      const col = columns[i];
      const kind = classifyColumnName(name);
      const type = col.filled === 0 ? "empty" : col.numeric >= col.text ? "numeric" : "text";
      const minority = type === "numeric" ? col.text : type === "text" ? col.numeric : 0;
      const entry = {
        name,
        type,
        missing: suppress(total - col.filled),
        typeErrors: suppress(minority),
        nameCheck: kind
      };
      const labelsAllowed =
        kind === "ok" && type === "text" && col.distinct.size > 1 && col.distinct.size < MAX_DISTINCT && [...col.distinct.values()].every((n) => n >= MIN_CELL);
      if (labelsAllowed) entry.categories = [...col.distinct.entries()].map(([label, n]) => ({ label, count: n })).sort((a, b) => b.count - a.count);
      return entry;
    })
  };
}

export async function profileDataDir(dir) {
  let names;
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && /\.csv$/i.test(e.name)).map((e) => e.name).sort();
  } catch {
    return { present: false, files: [] };
  }
  const files = [];
  for (const name of names.slice(0, 20)) {
    try {
      files.push({ file: name, ...(await profileCsv(path.join(dir, name))) });
    } catch {
      files.push({ file: name, error: "unreadable" });
    }
  }
  const flagged = files.flatMap((f) => (f.columns ?? []).filter((c) => c.nameCheck !== "ok").map((c) => ({ file: f.file, column: c.name, problem: c.nameCheck })));
  return { present: true, files, flagged };
}
