/** Small line diff (LCS) for the read-only code view. Bounded: very large inputs are reported as too large, not diffed. */
export type DiffLine = { kind: "context" | "add" | "del"; text: string; oldNo?: number; newNo?: number };
export type DiffResult = { lines: DiffLine[]; added: number; removed: number; tooLarge: boolean };

export const DIFF_MAX_LINES = 2000;

export function diffLines(oldText: string, newText: string, context = 3): DiffResult {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return { lines: [], added: 0, removed: 0, tooLarge: true };
  const n = a.length;
  const m = b.length;
  const table: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      all.push({ kind: "context", text: a[i], oldNo: i + 1, newNo: j + 1 });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      all.push({ kind: "del", text: a[i], oldNo: i + 1 });
      i += 1;
    } else {
      all.push({ kind: "add", text: b[j], newNo: j + 1 });
      j += 1;
    }
  }
  for (; i < n; i += 1) all.push({ kind: "del", text: a[i], oldNo: i + 1 });
  for (; j < m; j += 1) all.push({ kind: "add", text: b[j], newNo: j + 1 });
  const added = all.filter((l) => l.kind === "add").length;
  const removed = all.filter((l) => l.kind === "del").length;
  // Keep changed lines plus `context` lines around them.
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((line, index) => {
    if (line.kind === "context") return;
    for (let k = Math.max(0, index - context); k <= Math.min(all.length - 1, index + context); k += 1) keep[k] = true;
  });
  return { lines: all.filter((_, index) => keep[index]), added, removed, tooLarge: false };
}
