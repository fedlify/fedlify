import { describe, expect, it } from "vitest";
import { buildPublishedSiteKitFiles, publishedKitManifest } from "@/lib/site-kit";
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

  it("keeps every secret out of .env and .env.example; the registry login is a separate file", () => {
    const files = kit();
    for (const name of [".env", ".env.example"]) {
      const env = String(files[name]);
      expect(env).not.toMatch(/^FEDLIFY_SITE_TOKEN=/m);
      const assignments = env.split("\n").filter((line) => line && !line.startsWith("#"));
      expect(assignments.join("\n")).not.toMatch(/PASSWORD|TOKEN|SECRET|CREDENTIAL|KEY/i);
      expect(env).not.toContain("p'ss");
      expect(env).not.toContain("robot$");
    }
    // Only the credential file carries the login, as two plain lines (username, password).
    expect(files[".fedlify/registry-credential"]).toBe("robot$fedlify-studies+studies-pull\np'ss\n");
    for (const [name, body] of Object.entries(files)) {
      if (name === ".fedlify/registry-credential") continue;
      expect(String(body)).not.toContain("p'ss");
    }
  });

  it("points sites at the study hostname on 443 and supports updates", () => {
    const files = kit();
    expect(String(files[".env"])).toContain("NVFLARE_SERVER=hf-mortality.fedlify.com:443");
    expect(String(files["fedlify-runner.sh"])).toContain("desiredImageDigest");
    for (const command of ["preflight", "status", "logout", "support-bundle"]) expect(String(files["fedlify-runner.sh"])).toContain(command);
    expect(String(files["fedlify-runner.sh"])).not.toMatch(/\bunlock\b/);
    expect(JSON.parse(String(files["manifest.json"])).runtime).toEqual({ mode: "k8s", hostname: "hf-mortality.fedlify.com", imageDigest: digest });
  });

  it("lists only files the kit really ships and never the missing PowerShell runner", () => {
    const files = kit();
    const manifest = JSON.parse(String(files["manifest.json"]));
    expect(Object.keys(files)).not.toContain("fedlify-runner.ps1");
    expect(JSON.stringify(manifest)).not.toMatch(/\.ps1/);
    for (const path of Object.values(manifest.files as Record<string, string>)) {
      // nvflare/ comes from the real client kit that the route adds to the zip.
      if (!path.startsWith("nvflare/")) expect(Object.keys(files)).toContain(path);
    }
    expect(manifest.installCommands.join(" ")).not.toContain("--safe");
    expect(publishedKitManifest(publishedKitManifest(manifest)).files).toEqual(manifest.files);
  });

  it("rotates container logs, checks client health, and has no fake CONNECTED sidecar", () => {
    const compose = String(kit()["docker-compose.yml"]);
    expect(compose).toContain("max-size: \"10m\"");
    expect(compose).toContain("healthcheck:");
    expect(compose).toContain("[c]lient_train");
    expect(compose).not.toContain("[f]edlify");
    expect(compose).not.toContain("fedlify-site-agent");
    expect(compose).not.toMatch(/CONNECTED/);
    expect(compose.match(/logging: \*default-logging/g)).toHaveLength(1);
  });
});
