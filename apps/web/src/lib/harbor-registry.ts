/**
 * The only module that talks to the Harbor API (docs/site-runner-and-ux-design.md section 15).
 *
 * It holds the limited "provisioner" credential, never Harbor's admin account. Harbor cannot restrict a robot to a
 * project-name prefix, so this module is the guard: it refuses every project that is not `fedlify-s-<slug>` and only ever
 * sends the permission templates below. That protects against bugs and injection, not against a stolen credential.
 *
 * Unconfirmed against Harbor v2.15.2 until the live checks in section 15.9 are run: request and response shapes below
 * follow the Harbor v2.0 REST API as remembered, and the robot name format is read from the create response, not built.
 */

export const STUDY_PROJECT_PREFIX = "fedlify-s-";
const STUDY_PROJECT_RE = /^fedlify-s-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROBOT_NAME_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const REQUEST_TIMEOUT_MS = 15_000;

export class HarborError extends Error {
  constructor(
    message: string,
    public readonly code: "not_configured" | "forbidden_project" | "bad_name" | "unavailable" | "rejected" | "conflict" | "not_found",
    public readonly status?: number
  ) {
    super(message);
    this.name = "HarborError";
  }
}

export type HarborConfig = { baseUrl: string; username: string; password: string };

export function harborConfig(env: Record<string, string | undefined> = process.env): HarborConfig | null {
  const username = env.FEDLIFY_HARBOR_PROVISIONER_USERNAME?.trim();
  const password = env.FEDLIFY_HARBOR_PROVISIONER_PASSWORD;
  const registry = env.FEDLIFY_HARBOR_URL?.trim() || (env.FEDLIFY_HARBOR_REGISTRY ? `https://${env.FEDLIFY_HARBOR_REGISTRY.trim()}` : "");
  if (!username || !password || !registry) return null;
  return { baseUrl: registry.replace(/\/+$/, ""), username, password };
}

export function studyProjectName(runtimeSlug: string): string {
  return assertStudyProject(`${STUDY_PROJECT_PREFIX}${runtimeSlug}`);
}

export function assertStudyProject(name: string): string {
  if (name.length > 128 || !STUDY_PROJECT_RE.test(name)) {
    throw new HarborError(`Refusing to touch Harbor project "${name.slice(0, 60)}": only ${STUDY_PROJECT_PREFIX}<slug> projects are managed by Fedlify.`, "forbidden_project");
  }
  return name;
}

/** `harbor.fedlify.com/fedlify-s-<slug>/<slug>@sha256:...` gives `fedlify-s-<slug>`; anything else (legacy project) gives null. */
export function studyProjectFromImage(image: string | null | undefined): string | null {
  if (!image) return null;
  const parts = image.split("/");
  const project = parts.length >= 3 ? parts[1] : null;
  return project && STUDY_PROJECT_RE.test(project) ? project : null;
}

export function robotSafeName(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!cleaned || !ROBOT_NAME_RE.test(cleaned)) throw new HarborError("Robot name is empty after sanitising.", "bad_name");
  return cleaned;
}

// The permission templates. Site robots get exactly pull on `repository` of one project; nothing else is ever sent.
export function pullPermissions(project: string) {
  return [{ kind: "project", namespace: assertStudyProject(project), access: [{ resource: "repository", action: "pull" }] }];
}

type Json = Record<string, unknown>;

async function call(method: string, path: string, body?: unknown, config = harborConfig()): Promise<{ status: number; data: unknown }> {
  if (!config) throw new HarborError("Harbor provisioner credentials are not configured (FEDLIFY_HARBOR_PROVISIONER_USERNAME/PASSWORD).", "not_configured");
  const label = `${method} ${path.split("?")[0].replace(/\/\d+(?=\/|$)/g, "/{id}")}`;
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/api/v2.0${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error"
    });
  } catch {
    // The underlying error can carry the URL; keep only the operation.
    throw new HarborError(`Harbor is unreachable (${label}).`, "unavailable");
  }
  const text = await response.text().catch(() => "");
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (response.status >= 500) throw new HarborError(`Harbor returned HTTP ${response.status} (${label}).`, "unavailable", response.status);
  if (response.status === 409) throw new HarborError(`Harbor reports a conflict (${label}).`, "conflict", 409);
  if (response.status === 404) throw new HarborError(`Harbor says not found (${label}).`, "not_found", 404);
  if (response.status >= 400) throw new HarborError(`Harbor rejected the request with HTTP ${response.status} (${label}).`, "rejected", response.status);
  return { status: response.status, data };
}

export async function getProject(name: string): Promise<{ projectId: number; retentionId: number | null } | null> {
  assertStudyProject(name);
  try {
    const { data } = await call("GET", `/projects/${encodeURIComponent(name)}`);
    const project = data as { project_id?: number; metadata?: { retention_id?: string } } | null;
    if (typeof project?.project_id !== "number") return null;
    const retention = Number(project.metadata?.retention_id);
    return { projectId: project.project_id, retentionId: Number.isFinite(retention) && retention > 0 ? retention : null };
  } catch (error) {
    if (error instanceof HarborError && error.code === "not_found") return null;
    throw error;
  }
}

/**
 * Create the private project. `created: false` means Harbor already had it (409); the caller decides whether that is ours,
 * because an unknown existing project belongs to someone else on the shared Harbor.
 */
export async function createProject(input: { name: string; quotaBytes: number }): Promise<{ created: boolean }> {
  const name = assertStudyProject(input.name);
  try {
    await call("POST", "/projects", {
      project_name: name,
      public: false,
      storage_limit: input.quotaBytes,
      metadata: { public: "false", auto_scan: "true", prevent_vul: "false" }
    });
    return { created: true };
  } catch (error) {
    if (error instanceof HarborError && error.code === "conflict") return { created: false };
    throw error;
  }
}

/** Keep the newest `keep` pushed tags per repository, and never the tag `active` (the running study image). */
export function retentionPolicy(projectId: number, keep: number): Json {
  const everything = { kind: "doublestar", decoration: "matches", pattern: "**" };
  const scope = { repository: [{ kind: "doublestar", decoration: "repoMatches", pattern: "**" }] };
  return {
    algorithm: "or",
    rules: [
      { disabled: false, action: "retain", template: "latestPushedK", params: { latestPushedK: keep }, tag_selectors: [everything], scope_selectors: scope },
      {
        disabled: false,
        action: "retain",
        template: "always",
        params: {},
        tag_selectors: [{ kind: "doublestar", decoration: "matches", pattern: "active" }],
        scope_selectors: scope
      }
    ],
    trigger: { kind: "Schedule", settings: { cron: "0 0 3 * * *" } },
    scope: { level: "project", ref: projectId }
  };
}

export async function ensureRetention(name: string, keep: number): Promise<{ created: boolean }> {
  const project = await getProject(name);
  if (!project) throw new HarborError("The study project does not exist in Harbor.", "not_found", 404);
  if (project.retentionId) return { created: false };
  await call("POST", "/retentions", retentionPolicy(project.projectId, keep));
  return { created: true };
}

export type CreatedRobot = { id: number; name: string; secret: string; expiresAt: Date };

export async function createPullRobot(input: { project: string; name: string; days: number }): Promise<CreatedRobot> {
  const project = assertStudyProject(input.project);
  const name = robotSafeName(input.name);
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 365) throw new HarborError("Robot lifetime must be 1 to 365 days.", "bad_name");
  const { data } = await call("POST", "/robots", {
    name,
    description: "Fedlify site pull credential (managed; do not edit).",
    duration: input.days,
    level: "project",
    disable: false,
    permissions: pullPermissions(project)
  });
  const robot = data as { id?: number; name?: string; secret?: string; expires_at?: number } | null;
  if (typeof robot?.id !== "number" || !robot.name || !robot.secret) throw new HarborError("Harbor returned an incomplete robot.", "rejected");
  const expiresAt = robot.expires_at ? new Date(robot.expires_at * 1000) : new Date(Date.now() + input.days * 86_400_000);
  return { id: robot.id, name: robot.name, secret: robot.secret, expiresAt };
}

/** Deleting a robot that is already gone counts as success. */
export async function deleteRobot(id: number): Promise<void> {
  try {
    await call("DELETE", `/robots/${id}`);
  } catch (error) {
    if (error instanceof HarborError && error.code === "not_found") return;
    throw error;
  }
}

export type HarborRobotSummary = { id: number; name: string; expiresAt: Date | null };

const ROBOT_PAGE_SIZE = 100;
const ROBOT_MAX_PAGES = 50;

/** Every robot of the project: follows pages until a short page, so a project with more than 100 robots is not truncated. */
export async function listProjectRobots(name: string): Promise<HarborRobotSummary[]> {
  const project = await getProject(name);
  if (!project) return [];
  const q = encodeURIComponent(`Level=project,ProjectID=${project.projectId}`);
  const out: HarborRobotSummary[] = [];
  for (let page = 1; page <= ROBOT_MAX_PAGES; page += 1) {
    const { data } = await call("GET", `/robots?q=${q}&page=${page}&page_size=${ROBOT_PAGE_SIZE}`);
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const robot = row as { id?: number; name?: string; expires_at?: number };
      if (typeof robot.id !== "number" || !robot.name) continue;
      // Harbor reports -1 or 0 for "never expires"; only a positive epoch is an expiry.
      const expiresAt = typeof robot.expires_at === "number" && robot.expires_at > 0 ? new Date(robot.expires_at * 1000) : null;
      out.push({ id: robot.id, name: robot.name, expiresAt });
    }
    if (rows.length < ROBOT_PAGE_SIZE) return out;
  }
  // Refusing to answer is safer than a silently partial list: callers would report a revocation as complete.
  throw new HarborError("Harbor robot list exceeds the page limit.", "unavailable");
}
