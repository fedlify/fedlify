import path from "node:path";

export class RuntimeConfigurationError extends Error {
  constructor(
    message: string,
    public readonly missing: string[] = []
  ) {
    super(message);
    this.name = "RuntimeConfigurationError";
  }
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function publicBaseUrl(fallbackOrigin?: string): string {
  return clean(process.env.FEDLIFY_PUBLIC_BASE_URL) ?? clean(process.env.NEXTAUTH_URL) ?? fallbackOrigin ?? "http://localhost:3000";
}

export function runtimeMode(): string {
  return clean(process.env.FEDLIFY_RUNTIME_MODE) ?? "local-docker";
}

export function runtimeRoot(): string {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), clean(process.env.FEDLIFY_RUNTIME_ROOT) ?? ".fedlify-runtime");
}

export function nvflarePublicHost(): string {
  return clean(process.env.NVFLARE_PUBLIC_HOST) ?? "localhost";
}

export function nvflarePortBase(): number {
  const parsed = Number.parseInt(process.env.NVFLARE_PORT_BASE ?? "18000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 18000;
}

export function nvflareAdminEmail(): string {
  return clean(process.env.NVFLARE_ADMIN_EMAIL) ?? "admin@fedlify.local";
}

export function nvflarePython(): string {
  return clean(process.env.NVFLARE_PYTHON) ?? "python3";
}

export function nvflareDockerImage(): string {
  return clean(process.env.NVFLARE_DOCKER_IMAGE) ?? "fedlify-nvflare:2.6.2";
}

export function flareApiBaseUrl(): string | null {
  return clean(process.env.NVFLARE_FLARE_API_BASE_URL)?.replace(/\/$/, "") ?? null;
}

export function giteaConfig() {
  const baseUrl = clean(process.env.GITEA_BASE_URL);
  const token = clean(process.env.GITEA_TOKEN);
  const owner = clean(process.env.GITEA_ORG) ?? clean(process.env.GITEA_PUBLIC_TEMPLATE_ORG);
  const repoPrefix = clean(process.env.GITEA_PIPELINE_REPO_PREFIX) ?? "fedlify";
  const missing = [
    !baseUrl ? "GITEA_BASE_URL" : null,
    !token ? "GITEA_TOKEN" : null,
    !owner ? "GITEA_ORG or GITEA_PUBLIC_TEMPLATE_ORG" : null
  ].filter((item): item is string => Boolean(item));

  if (missing.length > 0) {
    throw new RuntimeConfigurationError(
      `Gitea integration is not configured. Set ${missing.join(", ")} before creating pipeline proposals.`,
      missing
    );
  }
  const resolvedBaseUrl = baseUrl as string;
  const resolvedToken = token as string;
  const resolvedOwner = owner as string;

  return {
    baseUrl: resolvedBaseUrl.replace(/\/$/, ""),
    token: resolvedToken,
    owner: resolvedOwner,
    repoPrefix
  };
}

export function giteaPublicTemplateOrg(): string {
  try {
    return clean(process.env.GITEA_PUBLIC_TEMPLATE_ORG) ?? giteaConfig().owner;
  } catch {
    return clean(process.env.GITEA_PUBLIC_TEMPLATE_ORG) ?? "fedlify-templates";
  }
}

export function giteaStudyOrgPrefix(): string {
  return clean(process.env.GITEA_STUDY_ORG_PREFIX) ?? "fedlify-study";
}

export function openAiCodeAgentConfig(): { apiKey: string; model: string } | null {
  const apiKey = clean(process.env.OPENAI_API_KEY);
  if (!apiKey) return null;
  return {
    apiKey,
    model: clean(process.env.OPENAI_CODE_AGENT_MODEL) ?? "gpt-4.1"
  };
}
