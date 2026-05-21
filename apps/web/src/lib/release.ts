import { sha256 } from "@/lib/crypto";

export function nextReleaseVersion(existingVersions: string[]): string {
  const max = existingVersions.reduce((current, version) => {
    const match = /^v(\d+)$/.exec(version);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `v${max + 1}`;
}

export function releaseChecksum(input: {
  studyId: string;
  agentRunId: string;
  version: string;
  storagePrefix: string;
}): string {
  return sha256(`${input.studyId}:${input.agentRunId}:${input.version}:${input.storagePrefix}`);
}
