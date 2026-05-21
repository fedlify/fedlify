import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { NvflareDeployment, Study, StudySite } from "@prisma/client";
import { directoryToArchiveMap, zipFiles, type ArchiveFileMap } from "@/lib/archive";
import { sha256 } from "@/lib/crypto";
import {
  nvflareAdminEmail,
  nvflareDockerImage,
  nvflarePortBase,
  nvflarePublicHost,
  runtimeMode,
  runtimeRoot
} from "@/lib/runtime-config";
import { objectKey, storageConfigured, uploadObject } from "@/lib/storage";

const execFileAsync = promisify(execFile);

type StudySiteWithRuntime = Pick<StudySite, "id" | "code" | "name" | "institutionName"> & {
  site?: { nvflareClientName: string } | null;
};

export function allocateNvflarePorts(existingDeploymentCount: number, basePort = nvflarePortBase()) {
  const offset = existingDeploymentCount * 10;
  return {
    server: basePort + offset,
    admin: basePort + offset + 1,
    overseer: basePort + offset + 2
  };
}

export function composeProjectName(studyId: string, deploymentId: string) {
  return `fedlify-${studyId.slice(-8)}-${deploymentId.slice(-8)}`.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

export function deploymentWorkspacePath(studyId: string, deploymentId: string) {
  return path.join(runtimeRoot(), studyId, deploymentId);
}

export function serverAddressForPort(port: number) {
  return `${nvflarePublicHost()}:${port}`;
}

export function nvflareSafeName(value: string, fallback = "site") {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

export function nvflareClientNameForSite(site: Pick<StudySite, "code"> & { site?: { nvflareClientName: string } | null }) {
  return nvflareSafeName(site.site?.nvflareClientName ?? `site_${site.code}`, `site_${site.code}`);
}

export function buildNvflareProjectYaml(input: {
  study: Pick<Study, "id" | "title">;
  ports: { server: number; admin: number; overseer: number };
  sites: Array<Pick<StudySite, "code"> & { site?: { nvflareClientName: string } | null }>;
}) {
  const serverName = nvflareSafeName(nvflarePublicHost(), "localhost");
  const dockerHost = nvflarePublicHost() === "localhost" || nvflarePublicHost() === "127.0.0.1" ? "host.docker.internal" : nvflarePublicHost();
  const participants = [
    [
      `  - name: ${serverName}`,
      "    type: server",
      "    org: fedlify",
      `    fed_learn_port: ${input.ports.server}`,
      `    admin_port: ${input.ports.admin}`,
      "    host_names:",
      `      - ${dockerHost}`
    ].join("\n"),
    [`  - name: ${nvflareAdminEmail()}`, "    type: admin", "    org: fedlify", "    role: project_admin"].join("\n"),
    ...input.sites.map((site) =>
      [
        `  - name: ${nvflareClientNameForSite(site)}`,
        "    type: client",
        `    org: ${nvflareSafeName(site.code, "site")}`,
        "    connect_to:",
        `      name: ${serverName}`,
        `      host: ${dockerHost}`,
        `      port: ${input.ports.server}`
      ].join("\n")
    )
  ].join("\n");

  return [
    "api_version: 3",
    `name: ${nvflareSafeName(input.study.id, "fedlify_study")}`,
    `description: ${JSON.stringify(input.study.title)}`,
    "participants:",
    participants,
    "builders:",
    "  - path: nvflare.lighter.impl.workspace.WorkspaceBuilder",
    "  - path: nvflare.lighter.impl.static_file.StaticFileBuilder",
    "    args:",
    "      overseer_agent:",
    "        path: nvflare.ha.dummy_overseer_agent.DummyOverseerAgent",
    "        overseer_exists: false",
    "        args:",
    `          sp_end_point: ${serverName}:${input.ports.server}:${input.ports.admin}`,
    "  - path: nvflare.lighter.impl.cert.CertBuilder",
    "  - path: nvflare.lighter.impl.signature.SignatureBuilder",
    ""
  ].join("\n");
}

export function buildDeploymentManifest(input: {
  study: Pick<Study, "id" | "title">;
  deploymentId: string;
  composeProject: string;
  ports: { server: number; admin: number; overseer: number };
  serverAddress: string;
  sites: StudySiteWithRuntime[];
}) {
  return {
    packageType: "fedlify-nvflare-deployment",
    studyId: input.study.id,
    studyTitle: input.study.title,
    deploymentId: input.deploymentId,
    runtimeMode: runtimeMode(),
    composeProject: input.composeProject,
    serverAddress: input.serverAddress,
    ports: input.ports,
    participants: input.sites.map((site) => ({
      studySiteId: site.id,
      code: site.code,
      name: site.name,
      institutionName: site.institutionName,
      nvflareClientName: nvflareClientNameForSite(site)
    }))
  };
}

export function buildDeploymentFiles(input: {
  study: Pick<Study, "id" | "title">;
  deploymentId: string;
  composeProject: string;
  ports: { server: number; admin: number; overseer: number };
  serverAddress: string;
  sites: StudySiteWithRuntime[];
}): ArchiveFileMap {
  const projectYaml = buildNvflareProjectYaml({ study: input.study, ports: input.ports, sites: input.sites });
  const manifest = buildDeploymentManifest(input);
  return {
    "project.yml": projectYaml,
    "manifest.json": JSON.stringify(manifest, null, 2)
  };
}

export function provisionedRootPath(input: { workspacePath: string; studyId: string }) {
  return path.join(input.workspacePath, "provisioned", nvflareSafeName(input.studyId, "fedlify_study"), "prod_00");
}

function serverStartupPath(input: { provisionedRoot: string }) {
  return path.join(input.provisionedRoot, nvflareSafeName(nvflarePublicHost(), "localhost"));
}

function adminStartupPath(input: { provisionedRoot: string }) {
  return path.join(input.provisionedRoot, nvflareAdminEmail(), "startup");
}

function clientStartupPaths(input: { provisionedRoot: string; sites: StudySiteWithRuntime[] }) {
  return Object.fromEntries(
    input.sites.map((site) => [site.id, path.join(input.provisionedRoot, nvflareClientNameForSite(site))])
  );
}

async function assertExists(targetPath: string, label: string) {
  try {
    await access(targetPath);
  } catch {
    throw new Error(`${label} was not generated at ${targetPath}.`);
  }
}

export function buildRuntimeCompose(input: {
  serverStartupPath: string;
  ports: { server: number; admin: number; overseer: number };
}) {
  return [
    "services:",
    "  nvflare-server:",
    `    image: ${nvflareDockerImage()}`,
    "    working_dir: /workspace/startup",
    "    command: [\"/bin/bash\", \"-lc\", \"chmod +x start.sh sub_start.sh stop_fl.sh && ./start.sh && tail -f /dev/null\"]",
    "    environment:",
    "      PYTHONUNBUFFERED: \"1\"",
    "    ports:",
    `      - \"${input.ports.server}:${input.ports.server}\"`,
    `      - \"${input.ports.admin}:${input.ports.admin}\"`,
    "    volumes:",
    "      - ./server:/workspace",
    ""
  ].join("\n");
}

async function writeDeploymentWorkspaceFiles(input: {
  workspacePath: string;
  files: ArchiveFileMap;
  serverStartupPath?: string;
  ports?: { server: number; admin: number; overseer: number };
}) {
  for (const [relativePath, body] of Object.entries(input.files)) {
    const destination = path.join(input.workspacePath, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, body);
  }
  if (input.serverStartupPath && input.ports) {
    const compose = buildRuntimeCompose({ serverStartupPath: input.serverStartupPath, ports: input.ports });
    await writeFile(path.join(input.workspacePath, "docker-compose.yml"), compose);
  }
}

export async function provisionNvflareDeployment(input: {
  study: Pick<Study, "id" | "title">;
  deploymentId: string;
  composeProject: string;
  workspacePath: string;
  ports: { server: number; admin: number; overseer: number };
  serverAddress: string;
  sites: StudySiteWithRuntime[];
}) {
  const files = buildDeploymentFiles(input);
  await writeDeploymentWorkspaceFiles({ workspacePath: input.workspacePath, files });
  const projectYamlPath = path.join(input.workspacePath, "project.yml");
  const provisionWorkspace = path.join(input.workspacePath, "provisioned");

  await execFileAsync("nvflare", ["provision", "-p", projectYamlPath, "-w", provisionWorkspace], {
    timeout: 120_000
  });

  const provisionedRoot = provisionedRootPath({ workspacePath: input.workspacePath, studyId: input.study.id });
  const serverPath = serverStartupPath({ provisionedRoot });
  const adminPath = adminStartupPath({ provisionedRoot });
  const clientPaths = clientStartupPaths({ provisionedRoot, sites: input.sites });

  await assertExists(path.join(serverPath, "startup", "start.sh"), "NVFLARE server startup script");
  await assertExists(path.join(adminPath, "fed_admin.json"), "NVFLARE admin startup kit");
  for (const [studySiteId, clientPath] of Object.entries(clientPaths)) {
    await assertExists(path.join(clientPath, "startup", "fed_client.json"), `NVFLARE client startup kit for ${studySiteId}`);
  }

  await writeDeploymentWorkspaceFiles({
    workspacePath: input.workspacePath,
    files,
    serverStartupPath: serverPath,
    ports: input.ports
  });
  await mkdir(path.join(input.workspacePath, "server"), { recursive: true });
  await execFileAsync("cp", ["-R", `${serverPath}/.`, path.join(input.workspacePath, "server")], { timeout: 30_000 });

  const serverKit = await zipFiles(await directoryToArchiveMap(serverPath));
  const adminKit = await zipFiles(await directoryToArchiveMap(adminPath));
  const serverStartupKitStorageKey = objectKey(["studies", input.study.id, "deployments", input.deploymentId, "server-kit.zip"]);
  const adminStartupKitStorageKey = objectKey(["studies", input.study.id, "deployments", input.deploymentId, "admin-kit.zip"]);

  if (storageConfigured()) {
    await uploadObject(serverStartupKitStorageKey, serverKit, "application/zip");
    await uploadObject(adminStartupKitStorageKey, adminKit, "application/zip");
  }

  return {
    serverStartupKitStorageKey,
    adminStartupKitStorageKey,
    serverStartupPath: serverPath,
    adminStartupPath: adminPath,
    clientStartupPaths: clientPaths,
    serverChecksum: sha256(serverKit),
    adminChecksum: sha256(adminKit),
    projectYaml: await readFile(projectYamlPath, "utf8")
  };
}

export async function buildAndUploadDeploymentArtifacts(input: {
  studyId: string;
  deploymentId: string;
  files: ArchiveFileMap;
}) {
  const serverKit = await zipFiles({
    "README.md": "# Fedlify NVFLARE server kit\n",
    "../project.yml": input.files["project.yml"],
    "../manifest.json": input.files["manifest.json"]
  });
  const adminKit = await zipFiles({
    "README.md": "# Fedlify NVFLARE admin kit\n",
    "../project.yml": input.files["project.yml"],
    "../manifest.json": input.files["manifest.json"]
  });
  const serverStartupKitStorageKey = objectKey(["studies", input.studyId, "deployments", input.deploymentId, "server-kit.zip"]);
  const adminStartupKitStorageKey = objectKey(["studies", input.studyId, "deployments", input.deploymentId, "admin-kit.zip"]);

  if (storageConfigured()) {
    await uploadObject(serverStartupKitStorageKey, serverKit, "application/zip");
    await uploadObject(adminStartupKitStorageKey, adminKit, "application/zip");
  }

  return {
    serverStartupKitStorageKey,
    adminStartupKitStorageKey,
    serverChecksum: sha256(serverKit),
    adminChecksum: sha256(adminKit)
  };
}

export async function writeDeploymentWorkspace(input: { workspacePath: string; files: ArchiveFileMap }) {
  await writeDeploymentWorkspaceFiles(input);
}

export async function startDockerComposeDeployment(input: Pick<NvflareDeployment, "workspacePath" | "composeProject">) {
  if (!input.workspacePath || !input.composeProject) {
    throw new Error("Deployment workspace is not prepared.");
  }
  await execFileAsync(
    "docker",
    ["compose", "-f", path.join(input.workspacePath, "docker-compose.yml"), "-p", input.composeProject, "up", "-d"],
    { timeout: 90_000 }
  );
}

export async function stopDockerComposeDeployment(input: Pick<NvflareDeployment, "workspacePath" | "composeProject">) {
  if (!input.workspacePath || !input.composeProject) return;
  await execFileAsync(
    "docker",
    ["compose", "-f", path.join(input.workspacePath, "docker-compose.yml"), "-p", input.composeProject, "down"],
    { timeout: 90_000 }
  );
}
