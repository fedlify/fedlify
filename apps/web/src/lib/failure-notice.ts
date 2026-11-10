/** Failure logs often repeat the same warning. Keep the first of each line, and use the last one as the headline because it says how the failure ended. */
export function failureNoticeText(lines: string[]): { headline: string | null; details: string[] } {
  const details = Array.from(new Set(lines.map((line) => line.trim()).filter(Boolean)));
  return { headline: details[details.length - 1] ?? null, details };
}
