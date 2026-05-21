import { describe, expect, it } from "vitest";
import { buildStartupKitFiles, buildStartupPackageManifest, readinessStatus, startupPackageChecksum } from "@/lib/site-onboarding";

describe("site onboarding", () => {
  it("requires all readiness checks to pass", () => {
    expect(
      readinessStatus({
        connectivityVerified: true,
        kitInstalled: true,
        dependenciesVerified: true,
        policyAccepted: false
      })
    ).toBe("PENDING");
    expect(
      readinessStatus({
        connectivityVerified: true,
        kitInstalled: true,
        dependenciesVerified: true,
        policyAccepted: true
      })
    ).toBe("PASSED");
  });

  it("builds a site-local startup manifest without embedding the enrollment token", () => {
    const manifest = buildStartupPackageManifest({
      apiBaseUrl: "https://fedlify.example",
      studyId: "study-1",
      studyTitle: "Sepsis model",
      studySiteId: "study-site-1",
      siteId: "site-1",
      siteCode: "uhn",
      siteName: "UHN",
      nvflareClientName: "site-uhn",
      deployment: {
        id: "deployment-1",
        status: "ACTIVE",
        serverAddress: "localhost:18000",
        adminAddress: "localhost:18000 (admin@fedlify.local)"
      },
      expiresAt: new Date("2026-05-20T00:00:00Z")
    });

    expect(manifest.fedlify.heartbeatEndpoint).toBe("https://fedlify.example/api/v1/sites/site-1/heartbeat");
    expect(manifest.nvflare.serverAddress).toBe("localhost:18000");
    expect(JSON.stringify(manifest)).not.toContain("one-time-token");
    expect(startupPackageChecksum(manifest)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("builds a runner-managed startup kit without embedding the enrollment token", () => {
    const manifest = buildStartupPackageManifest({
      apiBaseUrl: "https://fedlify.example",
      studyId: "study-1",
      studyTitle: "Sepsis model",
      studySiteId: "study-site-1",
      siteId: "site-1",
      siteCode: "uhn",
      siteName: "UHN",
      nvflareClientName: "site-uhn",
      deployment: { id: "deployment-1", status: "ACTIVE", serverAddress: "localhost:18000", adminAddress: null },
      expiresAt: new Date("2026-05-20T00:00:00Z")
    });
    const files = buildStartupKitFiles(manifest);

    expect(files["docker-compose.yml"]).toContain("fedlify-site-agent");
    expect(files["fedlify-runner.sh"]).toContain("Fedlify site runner");
    expect(files["fedlify-runner.sh"]).toContain("docker compose up -d");
    expect(files["fedlify-runner.ps1"]).toContain("fedlify-runner.ps1 start -Token");
    expect(files[".env.example"]).toContain("NVFLARE_SERVER_ADDRESS=localhost:18000");
    expect(files[".env.example"]).not.toContain("one-time-token");
    expect(files["README.md"]).toContain("FEDLIFY_SITE_TOKEN=<token-from-fedlify> ./fedlify-runner.sh start --safe");
    expect(files["checksums.json"]).toContain("manifest.json");
    expect(files["checksums.json"]).toContain("fedlify-runner.sh");
  });
});
