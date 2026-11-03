import { describe, expect, it } from "vitest";
import { buildPublishedSiteKitFiles } from "@/lib/site-kit";
import { buildStartupPackageManifest } from "@/lib/site-onboarding";

const digest = "harbor.fedlify.com/fedlify-studies/hf-mortality@sha256:" + "a".repeat(64);

function kit() {
  const manifest = buildStartupPackageManifest({
    apiBaseUrl: "https://app.fedlify.com",
    studyId: "study-1",
    studyTitle: "HF mortality",
    studySiteId: "ss-1",
    siteId: "site-1",
    siteCode: "73",
    siteName: "Hospital 73",
    nvflareClientName: "site_73",
    deployment: { id: "dep-1", status: "ACTIVE", serverAddress: "hf-mortality.fedlify.com:443" },
    expiresAt: new Date("2026-11-01T00:00:00Z")
  });
  return buildPublishedSiteKitFiles({
    manifest,
    hostname: "hf-mortality.fedlify.com",
    imageDigest: digest,
    registry: { server: "harbor.fedlify.com", username: "robot$fedlify-studies+studies-pull", password: "p'ss" }
  });
}

describe("published site kit", () => {
  it("runs the published image by digest with site data mounted read-only", () => {
    const files = kit();
    const compose = String(files["docker-compose.yml"]);
    expect(compose).toContain("${FEDLIFY_STUDY_IMAGE:?");
    expect(compose).toContain("${FEDLIFY_DATA_DIR:-./data}:/data:ro");
    expect(compose).toContain("./nvflare:/kit:ro");
    expect(compose).not.toMatch(/ports:/);
    expect(compose).not.toContain("curlimages/curl:latest");
    expect(String(files[".env"])).toContain(`FEDLIFY_STUDY_IMAGE=${digest}`);
  });

  it("never ships a token, and quotes registry credentials for the shell", () => {
    const env = String(kit()[".env"]);
    expect(env).toMatch(/^FEDLIFY_SITE_TOKEN=$/m);
    expect(env).toContain(`FEDLIFY_REGISTRY_USERNAME='robot$fedlify-studies+studies-pull'`);
    expect(env).toContain(`FEDLIFY_REGISTRY_PASSWORD='p'"'"'ss'`);
  });

  it("points sites at the study hostname on 443 and supports updates", () => {
    const files = kit();
    expect(String(files[".env"])).toContain("NVFLARE_SERVER=hf-mortality.fedlify.com:443");
    expect(String(files["fedlify-runner.sh"])).toContain("desiredImageDigest");
    expect(JSON.parse(String(files["manifest.json"])).runtime).toEqual({ mode: "k8s", hostname: "hf-mortality.fedlify.com", imageDigest: digest });
  });
});
