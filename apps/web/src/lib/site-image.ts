/**
 * Site image currency. A published study runs one image on the aggregator; every site must run the same one, or the run
 * trains on mismatched code. Each runner heartbeat reports the digest of the image its client container actually runs.
 *
 * Comparison is by the sha256 digest ONLY. The repository path can legitimately differ (a study moved to its own
 * registry project, a mirror), so the path is never part of "same image". The path matters for a different question:
 * whether the site's pull credential still reaches the new image (see updateNeedsNewKit).
 */
const SHA256_RE = /sha256:([0-9a-f]{64})/i;

/** The 64-hex sha256 of an image reference ("host/project/repo@sha256:..." or "sha256:..."), lowercased, or null. */
export function imageSha256(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const match = SHA256_RE.exec(ref.trim());
  return match ? match[1].toLowerCase() : null;
}

/** "host/project/repo" of a reference: digest and tag removed. Null when the reference has no path to speak of. */
export function imageRepositoryPath(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref.trim()) return null;
  const withoutDigest = ref.trim().split("@")[0];
  const path = withoutDigest.replace(/:[^/]*$/, "");
  return path.includes("/") ? path.toLowerCase() : null;
}

export type SiteImageState = "CURRENT" | "OUTDATED" | "NOT_REPORTED" | "UNKNOWN";

/** UNKNOWN: the deployment has no digest to compare against. NOT_REPORTED: the site never reported one (counts as a mismatch). */
export function siteImageState(reported: unknown, desired: unknown): SiteImageState {
  const want = imageSha256(desired);
  if (!want) return "UNKNOWN";
  const have = imageSha256(reported);
  if (!have) return "NOT_REPORTED";
  return have === want ? "CURRENT" : "OUTDATED";
}

/**
 * True when the new image lives somewhere the site's credential cannot reach: another registry host or project.
 * A per-site pull robot is limited to one project, so that case needs a fresh kit; a code-only publish keeps the path
 * and needs only `fedlify-runner update`. Unknown paths answer false (the update then fails loudly at pull time).
 */
export function updateNeedsNewKit(siteImageRef: unknown, desiredRef: unknown): boolean {
  const from = imageRepositoryPath(siteImageRef);
  const to = imageRepositoryPath(desiredRef);
  return Boolean(from && to && from !== to);
}

export function reportedImageDigest(heartbeatMetadata: unknown): string | null {
  if (!heartbeatMetadata || typeof heartbeatMetadata !== "object") return null;
  const value = (heartbeatMetadata as Record<string, unknown>).imageDigest;
  return typeof value === "string" && value ? value : null;
}

export type SiteImageCheck = {
  code: string;
  clientName: string;
  state: SiteImageState;
  reportedDigest: string | null;
  needsNewKit: boolean;
};

export function checkSiteImages(
  sites: Array<{ code: string; clientName: string; heartbeatMetadata: unknown; kitImageRef?: string | null }>,
  desiredRef: string | null | undefined
): SiteImageCheck[] {
  return sites.map((site) => {
    const reported = reportedImageDigest(site.heartbeatMetadata);
    const state = siteImageState(reported, desiredRef);
    return {
      code: site.code,
      clientName: site.clientName,
      state,
      reportedDigest: reported,
      needsNewKit: state !== "CURRENT" && state !== "UNKNOWN" && updateNeedsNewKit(reported ?? site.kitImageRef, desiredRef)
    };
  });
}

export function isImageMismatch(state: SiteImageState): boolean {
  return state === "OUTDATED" || state === "NOT_REPORTED";
}

const short = (ref: string | null) => {
  const sha = imageSha256(ref);
  return sha ? `sha256:${sha.slice(0, 12)}` : "none";
};

/** Operator-facing fix steps for one outdated site. Honest about the registry login and the new-kit case. */
export function siteImageFixSteps(check: Pick<SiteImageCheck, "state" | "needsNewKit">): string[] {
  if (check.needsNewKit) {
    return [
      "The study image moved to a different registry location, and this site's pull credential only covers the old one.",
      "Release a new site kit in Fedlify, unlock it, and run ./fedlify-runner.sh start (fedlify-runner.ps1 start on Windows) from the new kit folder."
    ];
  }
  return [
    "In the site's kit folder run ./fedlify-runner.sh update (fedlify-runner.ps1 update on Windows).",
    "Confirm the pipeline version and the first 12 characters of the new digest when asked. No new kit is needed.",
    "The runner logs in to the registry again with the kit's own credential file; if it was removed with logout or has expired, unlock a fresh kit instead.",
    check.state === "NOT_REPORTED" ? "This site has not reported an image digest: start the runner so its heartbeat reports one." : "Wait about 30 seconds for the next heartbeat, then start the run again."
  ];
}

export function describeImageMismatch(checks: SiteImageCheck[], desiredRef: string | null | undefined): string {
  const bad = checks.filter((check) => isImageMismatch(check.state));
  const list = bad.map((check) => `${check.clientName} (${check.state === "NOT_REPORTED" ? "no image reported" : `runs ${short(check.reportedDigest)}`})`).join(", ");
  const anyKit = bad.some((check) => check.needsNewKit);
  const fix = anyKit
    ? "At least one site needs a new kit (the study image moved registry location); the others run ./fedlify-runner.sh update."
    : "On each of these sites run ./fedlify-runner.sh update (fedlify-runner.ps1 update on Windows) and confirm the version and digest; no new kit is needed.";
  return `These sites are not running the published image ${short(desiredRef ?? null)}: ${list}. ${fix}`;
}
