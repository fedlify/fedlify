import { giteaConfig, RuntimeConfigurationError } from "@/lib/runtime-config";

type GiteaRepoResponse = {
  name: string;
  full_name?: string;
  clone_url?: string;
  html_url?: string;
  default_branch?: string;
  owner?: { login?: string; username?: string };
};

type GiteaBranchResponse = {
  name: string;
  commit?: { id?: string; sha?: string };
};

type GiteaTreeResponse = {
  tree?: Array<{ path?: string; type?: string }>;
};

type GiteaContentResponse = {
  content?: string;
  encoding?: string;
};

type GiteaPullResponse = {
  number: number;
  html_url?: string;
  url?: string;
  head?: { sha?: string };
};

type GiteaOrgResponse = {
  username?: string;
  full_name?: string;
  html_url?: string;
  website?: string;
};

export type GiteaPipelineProposal = {
  owner: string;
  repo: string;
  repoUrl: string;
  branchName: string;
  branchUrl: string;
  baseBranch: string;
  commitSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
};

export type GiteaTemplateProposal = GiteaPipelineProposal;

export class GiteaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "GiteaApiError";
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function giteaBranchTreeUrl(repoUrl: string, branchName: string): string {
  const encodedBranch = branchName.split("/").map(encodeURIComponent).join("/");
  return `${repoUrl.replace(/\/$/, "")}/src/branch/${encodedBranch}`;
}

function repositoryIndexReadme(input: {
  repoName: string;
  projectName: string;
  branchName: string;
  branchUrl: string;
  pullRequestUrl: string;
  commitSha: string;
}) {
  return [
    `# ${input.repoName}`,
    "",
    `Fedlify pipeline workspace for ${input.projectName}.`,
    "",
    "Generated pipeline code is kept on a review branch until a human approves the immutable commit in Fedlify.",
    "",
    "## Active proposal",
    `- Generated branch: [${input.branchName}](${input.branchUrl})`,
    `- Pull request: [review in Gitea](${input.pullRequestUrl})`,
    `- Commit: \`${input.commitSha}\``,
    "",
    "The default branch is an index for governance. Open the proposal branch or pull request to inspect the NVFLARE job files.",
    ""
  ].join("\n");
}

async function giteaRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const config = giteaConfig();
  const response = await fetch(`${config.baseUrl}/api/v1${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `token ${config.token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new GiteaApiError(body?.message ?? `Gitea request failed with status ${response.status}.`, response.status, body);
  }
  return body as T;
}

async function giteaRequestNullable<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    return await giteaRequest<T>(path, init);
  } catch (error) {
    if (error instanceof GiteaApiError && error.status === 404) return null;
    throw error;
  }
}

export async function ensureGiteaRepository(input: {
  repoName: string;
  description: string;
  defaultBranch?: string;
  owner?: string;
}): Promise<{ owner: string; repo: string; repoUrl: string; defaultBranch: string }> {
  const config = giteaConfig();
  const defaultBranch = input.defaultBranch ?? "main";
  const owner = input.owner ?? config.owner;

  try {
    const created = await giteaRequest<GiteaRepoResponse>(`/orgs/${encodeURIComponent(owner)}/repos`, {
      method: "POST",
      body: JSON.stringify({
        name: input.repoName,
        description: input.description,
        private: true,
        auto_init: true,
        default_branch: defaultBranch
      })
    });
    return {
      owner,
      repo: created.name,
      repoUrl: created.html_url ?? `${config.baseUrl}/${owner}/${created.name}`,
      defaultBranch: created.default_branch ?? defaultBranch
    };
  } catch (error) {
    if (!(error instanceof GiteaApiError) || error.status !== 409) throw error;
  }

  const existing = await giteaRequest<GiteaRepoResponse>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(input.repoName)}`);
  return {
    owner,
    repo: existing.name,
    repoUrl: existing.html_url ?? `${config.baseUrl}/${owner}/${existing.name}`,
    defaultBranch: existing.default_branch ?? defaultBranch
  };
}

export async function ensureGiteaOrganization(input: {
  owner: string;
  fullName?: string;
  description?: string;
  visibility?: "public" | "limited" | "private";
}): Promise<{ owner: string; url: string }> {
  const config = giteaConfig();
  const existing = await giteaRequestNullable<GiteaOrgResponse>(`/orgs/${encodeURIComponent(input.owner)}`);
  if (existing) {
    return {
      owner: existing.username ?? input.owner,
      url: existing.html_url ?? `${config.baseUrl}/${input.owner}`
    };
  }

  try {
    const created = await giteaRequest<GiteaOrgResponse>("/orgs", {
      method: "POST",
      body: JSON.stringify({
        username: input.owner,
        full_name: input.fullName ?? input.owner,
        description: input.description,
        visibility: input.visibility ?? "private"
      })
    });
    return {
      owner: created.username ?? input.owner,
      url: created.html_url ?? `${config.baseUrl}/${input.owner}`
    };
  } catch (error) {
    if (!(error instanceof GiteaApiError) || (error.status !== 409 && error.status !== 422)) throw error;
  }

  const createdElsewhere = await giteaRequest<GiteaOrgResponse>(`/orgs/${encodeURIComponent(input.owner)}`);
  return {
    owner: createdElsewhere.username ?? input.owner,
    url: createdElsewhere.html_url ?? `${config.baseUrl}/${input.owner}`
  };
}

export async function ensureGiteaBranch(input: { owner: string; repo: string; baseBranch: string; branchName: string }) {
  const existing = await giteaRequestNullable<GiteaBranchResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/branches/${encodeURIComponent(input.branchName)}`
  );
  if (existing) return existing;

  return giteaRequest<GiteaBranchResponse>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/branches`, {
    method: "POST",
    body: JSON.stringify({
      old_branch_name: input.baseBranch,
      new_branch_name: input.branchName
    })
  });
}

export async function getGiteaBranch(input: { owner: string; repo: string; branchName: string }) {
  return giteaRequest<GiteaBranchResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/branches/${encodeURIComponent(input.branchName)}`
  );
}

async function contentSha(input: { owner: string; repo: string; branchName: string; path: string }): Promise<string | undefined> {
  const existing = await giteaRequestNullable<{ sha?: string }>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodePath(input.path)}?ref=${encodeURIComponent(
      input.branchName
    )}`
  );
  return existing?.sha;
}

export async function upsertGiteaFile(input: {
  owner: string;
  repo: string;
  branchName: string;
  path: string;
  content: string;
  message: string;
}) {
  const sha = await contentSha(input);
  const body = {
    branch: input.branchName,
    message: input.message,
    content: Buffer.from(input.content).toString("base64"),
    ...(sha ? { sha } : {})
  };

  return giteaRequest(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodePath(input.path)}`, {
    method: sha ? "PUT" : "POST",
    body: JSON.stringify(body)
  });
}

export async function createGiteaPullRequest(input: {
  owner: string;
  repo: string;
  baseBranch: string;
  branchName: string;
  title: string;
  body: string;
}) {
  return giteaRequest<GiteaPullResponse>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      base: input.baseBranch,
      head: input.branchName,
      title: input.title,
      body: input.body
    })
  });
}

export async function createGiteaPipelineProposal(input: {
  repoName: string;
  projectName: string;
  description: string;
  branchName: string;
  files: Array<{ path: string; content: string }>;
  pullRequestBody: string;
  owner?: string;
}): Promise<GiteaPipelineProposal> {
  const repo = await ensureGiteaRepository({
    repoName: input.repoName,
    description: input.description,
    defaultBranch: "main",
    owner: input.owner
  });
  await ensureGiteaBranch({ owner: repo.owner, repo: repo.repo, baseBranch: repo.defaultBranch, branchName: input.branchName });
  const branchUrl = giteaBranchTreeUrl(repo.repoUrl, input.branchName);

  for (const file of input.files) {
    await upsertGiteaFile({
      owner: repo.owner,
      repo: repo.repo,
      branchName: input.branchName,
      path: file.path,
      content: file.content,
      message: `Fedlify proposal: ${input.projectName}`
    });
  }

  const branch = await giteaRequest<GiteaBranchResponse>(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/branches/${encodeURIComponent(input.branchName)}`
  );
  const pull = await createGiteaPullRequest({
    owner: repo.owner,
    repo: repo.repo,
    baseBranch: repo.defaultBranch,
    branchName: input.branchName,
    title: `Fedlify proposal: ${input.projectName}`,
    body: input.pullRequestBody
  });
  const commitSha = pull.head?.sha ?? branch.commit?.id ?? branch.commit?.sha;
  if (!commitSha) {
    throw new GiteaApiError("Gitea did not return a branch head commit SHA.", 502);
  }
  const pullRequestUrl = pull.html_url ?? pull.url ?? `${repo.repoUrl}/pulls/${pull.number}`;

  try {
    await upsertGiteaFile({
      owner: repo.owner,
      repo: repo.repo,
      branchName: repo.defaultBranch,
      path: "README.md",
      content: repositoryIndexReadme({
        repoName: repo.repo,
        projectName: input.projectName,
        branchName: input.branchName,
        branchUrl,
        pullRequestUrl,
        commitSha
      }),
      message: `Fedlify workspace index: ${input.projectName}`
    });
  } catch {
    // The proposal branch and PR are the source of truth. If main is protected or stale,
    // do not fail an otherwise valid generated pipeline.
  }

  return {
    owner: repo.owner,
    repo: repo.repo,
    repoUrl: repo.repoUrl,
    branchName: input.branchName,
    branchUrl,
    baseBranch: repo.defaultBranch,
    commitSha,
    pullRequestNumber: pull.number,
    pullRequestUrl
  };
}

function templateIndexReadme(input: {
  repoName: string;
  templateName: string;
  branchName: string;
  branchUrl: string;
  pullRequestUrl: string;
  commitSha: string;
}) {
  return [
    `# ${input.templateName}`,
    "",
    "Fedlify reusable NVFLARE template repository.",
    "",
    "Template changes are kept on review branches until a human publishes an immutable template version in Fedlify.",
    "",
    "## Active proposal",
    `- Branch: [${input.branchName}](${input.branchUrl})`,
    `- Pull request: [review in Gitea](${input.pullRequestUrl})`,
    `- Commit: \`${input.commitSha}\``,
    "",
    "Open the pull request to inspect the NVFLARE job folder, agent instructions, and template manifest.",
    ""
  ].join("\n");
}

export async function createGiteaTemplateProposal(input: {
  repoName: string;
  templateName: string;
  description: string;
  branchName: string;
  files: Array<{ path: string; content: string }>;
  pullRequestBody: string;
  owner?: string;
}): Promise<GiteaTemplateProposal> {
  const repo = await ensureGiteaRepository({
    repoName: input.repoName,
    description: input.description,
    defaultBranch: "main",
    owner: input.owner
  });
  await ensureGiteaBranch({ owner: repo.owner, repo: repo.repo, baseBranch: repo.defaultBranch, branchName: input.branchName });
  const branchUrl = giteaBranchTreeUrl(repo.repoUrl, input.branchName);

  for (const file of input.files) {
    await upsertGiteaFile({
      owner: repo.owner,
      repo: repo.repo,
      branchName: input.branchName,
      path: file.path,
      content: file.content,
      message: `Fedlify template proposal: ${input.templateName}`
    });
  }

  const branch = await giteaRequest<GiteaBranchResponse>(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/branches/${encodeURIComponent(input.branchName)}`
  );
  const pull = await createGiteaPullRequest({
    owner: repo.owner,
    repo: repo.repo,
    baseBranch: repo.defaultBranch,
    branchName: input.branchName,
    title: `Fedlify template proposal: ${input.templateName}`,
    body: input.pullRequestBody
  });
  const commitSha = pull.head?.sha ?? branch.commit?.id ?? branch.commit?.sha;
  if (!commitSha) throw new GiteaApiError("Gitea did not return a template branch head commit SHA.", 502);
  const pullRequestUrl = pull.html_url ?? pull.url ?? `${repo.repoUrl}/pulls/${pull.number}`;

  try {
    await upsertGiteaFile({
      owner: repo.owner,
      repo: repo.repo,
      branchName: repo.defaultBranch,
      path: "README.md",
      content: templateIndexReadme({
        repoName: repo.repo,
        templateName: input.templateName,
        branchName: input.branchName,
        branchUrl,
        pullRequestUrl,
        commitSha
      }),
      message: `Fedlify template index: ${input.templateName}`
    });
  } catch {
    // Proposal branch and PR remain the source of truth.
  }

  return {
    owner: repo.owner,
    repo: repo.repo,
    repoUrl: repo.repoUrl,
    branchName: input.branchName,
    branchUrl,
    baseBranch: repo.defaultBranch,
    commitSha,
    pullRequestNumber: pull.number,
    pullRequestUrl
  };
}

export async function readGiteaRepositoryFiles(input: {
  owner: string;
  repo: string;
  ref: string;
}): Promise<Array<{ path: string; content: string }>> {
  const tree = await giteaRequest<GiteaTreeResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/trees/${encodeURIComponent(input.ref)}?recursive=1`
  );
  const paths = (tree.tree ?? [])
    .filter((item) => item.type === "blob" && item.path)
    .map((item) => item.path as string)
    .filter((path) => !path.startsWith(".git/"));

  const files = [];
  for (const filePath of paths) {
    const content = await giteaRequest<GiteaContentResponse>(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(
        input.ref
      )}`
    );
    if (!content.content) continue;
    const normalized = content.content.replace(/\s/g, "");
    const decoded = Buffer.from(normalized, content.encoding === "base64" || content.encoding == null ? "base64" : "utf8").toString("utf8");
    files.push({ path: filePath, content: decoded });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function isRuntimeConfigurationError(error: unknown): error is RuntimeConfigurationError {
  return error instanceof RuntimeConfigurationError;
}
