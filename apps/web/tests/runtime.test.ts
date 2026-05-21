import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { allocateNvflarePorts, buildNvflareProjectYaml, composeProjectName, serverAddressForPort } from "@/lib/nvflare-runtime";
import {
  buildPipelineFiles,
  prepareNvflareJobWorkspaceForRun,
  pipelineProjectSlug,
  runtimeParametersForSelectedSites,
  validatePipelineFiles
} from "@/lib/pipeline-code";
import { buildStartupKitFiles, buildStartupPackageManifest } from "@/lib/site-onboarding";

describe("runtime pilot helpers", () => {
  it("allocates deterministic local Docker ports", () => {
    expect(allocateNvflarePorts(0, 18000)).toEqual({ server: 18000, admin: 18001, overseer: 18002 });
    expect(allocateNvflarePorts(2, 18000).server).toBe(18020);
  });

  it("derives stable compose and server identifiers", () => {
    expect(composeProjectName("study-abcdefgh", "deployment-12345678")).toBe("fedlify-abcdefgh-12345678");
    expect(serverAddressForPort(18000)).toContain(":18000");
  });

  it("generates signed Docker-reachable NVFLARE project configuration", () => {
    const projectYaml = buildNvflareProjectYaml({
      study: { id: "study-1", title: "Sepsis Study" },
      ports: { server: 18000, admin: 18001, overseer: 18002 },
      sites: [{ code: "uhn", site: { nvflareClientName: "site_uhn" } }]
    });

    expect(projectYaml).toContain("host_names:");
    expect(projectYaml).toContain("host.docker.internal");
    expect(projectYaml).toContain("connect_to:");
    expect(projectYaml).toContain("port: 18000");
  });

  it("builds and validates NVFLARE pipeline files", () => {
    const files = buildPipelineFiles({
      study: {
        id: "study-1",
        title: "Sepsis Study",
        slug: "sepsis-study",
        goal: "Train a model",
        researchQuestion: "Can sites collaborate?",
        clinicalUseCase: "RISK_PREDICTION",
        dataModalities: "EHR",
        intendedUse: "RESEARCH_ONLY"
      },
      template: {
        name: "FedAvg",
        templateKey: "fedavg",
        framework: "nvflare",
        version: "1.0.0",
        spec: { workflow: "fedavg" }
      },
      projectName: "Sepsis Pipeline",
      prompt: "Create a validated FedAvg training pipeline.",
      sites: [{ id: "site-1", code: "uhn", name: "UHN", institutionName: "UHN", site: { nvflareClientName: "site-uhn" } }]
    });

    expect(pipelineProjectSlug("Sepsis Study", "Sepsis Pipeline")).toBe("fedlify-sepsis-study-sepsis-pipeline");
    expect(validatePipelineFiles(files).status).toBe("PASSED");
    expect(files.map((file) => file.path)).toContain("nvflare/app/config/config_fed_server.json");
    expect(files.find((file) => file.path === "nvflare/app/config/config_fed_server.json")?.content).toContain('"min_clients": 1');
  });

  it("applies job-level runtime parameters to a copied NVFLARE workspace", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "fedlify-runtime-test-"));
    const source = path.join(tempRoot, "source");
    const destination = path.join(tempRoot, "run", "nvflare-job");
    try {
      await mkdir(path.join(source, "app", "config"), { recursive: true });
      await writeFile(path.join(source, "meta.conf"), "{\n  min_clients = 2\n}\n");
      await writeFile(
        path.join(source, "app", "config", "config_fed_server.conf"),
        "{\n  workflows = [\n    {\n      args {\n        min_clients = 2\n        num_rounds = 5\n      }\n    }\n  ]\n}\n"
      );

      const runtimeParameters = runtimeParametersForSelectedSites({ selectedSiteCount: 1, numRounds: 2 });
      await prepareNvflareJobWorkspaceForRun({ sourceWorkspacePath: source, destinationWorkspacePath: destination, runtimeParameters });

      expect(await readFile(path.join(destination, "meta.conf"), "utf8")).toContain("min_clients = 1");
      const serverConfig = await readFile(path.join(destination, "app", "config", "config_fed_server.conf"), "utf8");
      expect(serverConfig).toContain("min_clients = 1");
      expect(serverConfig).toContain("num_rounds = 2");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("builds a runner-managed site startup kit env and compose file", () => {
    const manifest = buildStartupPackageManifest({
      apiBaseUrl: "http://localhost:3000",
      studyId: "study-1",
      studyTitle: "Sepsis Study",
      studySiteId: "study-site-1",
      siteId: "runtime-site-1",
      siteCode: "uhn",
      siteName: "UHN",
      nvflareClientName: "site_uhn",
      deployment: { id: "deployment-1", status: "RUNNING", serverAddress: "localhost:18000", adminAddress: "localhost:18001" },
      expiresAt: new Date("2026-01-01T00:00:00.000Z")
    });

    const files = buildStartupKitFiles(manifest);

    expect(files[".env"]).toContain("FEDLIFY_SITE_TOKEN=");
    expect(files[".env"]).toContain("FEDLIFY_HEARTBEAT_ENDPOINT=http://host.docker.internal:3000/api/v1/sites/runtime-site-1/heartbeat");
    expect(files["docker-compose.yml"]).toContain("env_file:");
    expect(files["docker-compose.yml"]).toContain("curl -fsS -X POST \"$$FEDLIFY_HEARTBEAT_ENDPOINT\"");
    expect(files["README.md"]).toContain("FEDLIFY_SITE_TOKEN=<token-from-fedlify> ./fedlify-runner.sh start --safe");
    expect(files["fedlify-runner.sh"]).toContain("Fedlify site runner");
    expect(files["fedlify-runner.sh"]).toContain("docker compose up -d");
  });
});
