const sha = (ref: unknown) => (typeof ref === "string" ? /sha256:([0-9a-f]{64})/.exec(ref)?.[1] ?? null : null);

/** Sites whose image, as recorded when the run started, differs from the image the run's version was built into. */
export function imageMismatchSites(runImage: string | null, siteDigests: unknown): string[] {
  const expected = sha(runImage);
  if (!expected || !Array.isArray(siteDigests)) return [];
  return siteDigests
    .filter((entry): entry is { site?: unknown; imageDigest?: unknown } => Boolean(entry) && typeof entry === "object")
    .filter((entry) => {
      const got = sha(entry.imageDigest);
      return got !== null && got !== expected;
    })
    .map((entry) => String(entry.site ?? "unknown"));
}
