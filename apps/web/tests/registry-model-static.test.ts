import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const fedlify = path.resolve(__dirname, "../../..");
const repo = path.resolve(fedlify, "..");
const read = (p: string) => readFileSync(p, "utf8");
const workflow = read(path.join(fedlify, "deploy/k8s/publish-workflow-template.yaml"));
const terraform = read(path.join(repo, "IaC/day1/cicd/fedlify.tf"));

function templates(): Record<string, string> {
  const body = workflow.slice(workflow.indexOf("\n  templates:\n"));
  const out: Record<string, string> = {};
  const parts = body.split(/^    - name: /m).slice(1);
  // Comment lines are dropped: the comment above the next template trails the previous one after the split.
  for (const part of parts) out[part.split("\n")[0]!.trim()] = part.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  return out;
}
function resourceBlock(kind: string, name: string): string {
  const start = terraform.indexOf(`resource "${kind}" "${name}" {`);
  expect(start, `${kind}.${name} exists`).toBeGreaterThanOrEqual(0);
  const end = terraform.indexOf("\n}\n", start);
  return terraform.slice(start, end + 3);
}

describe("publish workflow: registry model", () => {
  const t = templates();

  it("only the legacy credential template references the Harbor admin secret; every per-study template uses the provisioner", () => {
    for (const [name, text] of Object.entries(t)) {
      if (name === "legacy-push-credential") expect(text).toContain("harbor-registry-credentials");
      else expect(text, name).not.toContain("harbor-registry-credentials");
    }
    for (const name of ["mint-push-robot", "mint-aggregator-robot", "prune-aggregator-robots", "delete-push-robot"]) {
      expect(t[name], name).toContain("name: harbor-provisioner");
      expect(t[name], name).not.toContain("harbor-registry-credentials");
    }
  });

  it("the build step holds no Harbor secret: it reads the docker config the previous step wrote", () => {
    const build = t["build-image"]!;
    expect(build).not.toMatch(/secretKeyRef/);
    expect(build).toContain("/work/push-docker-config.json");
    expect(build).toContain("rm -f /kaniko/.docker/config.json /work/push-docker-config.json");
    // set -eu skips a plain rm when kaniko fails, so the removal must be a trap that is set before the config is copied.
    expect(build).toMatch(/trap 'rm -f \/kaniko\/\.docker\/config\.json \/work\/push-docker-config\.json' EXIT/);
    expect(build.indexOf("trap '")).toBeLessThan(build.indexOf("cp /work/push-docker-config.json"));
  });

  it("every `when` quotes both sides: Argo's govaluate reads a bare per-study as per minus study", () => {
    const whens = [...workflow.matchAll(/^\s*when: "(.*)"$/gm)].map((m) => m[1]!);
    expect(whens.length).toBeGreaterThan(5);
    for (const when of whens.filter((w) => w.includes("registry-mode"))) expect(when).toMatch(/^'\{\{workflow\.parameters\.registry-mode\}\}' (==|!=) 'per-study'$/);
    expect(workflow).not.toMatch(/registry-mode\}\} [=!]= per-study/);
  });

  it("the aggregator pull robot goes to its own secret and never replaces the existing harbor-registry secret", () => {
    const prep = t["prepare-namespace"]!;
    expect(prep).toContain("pull_secret=harbor-registry-study");
    expect(prep).toMatch(/else\n\s+pull_secret=harbor-registry\n/);
    expect(prep).toContain('docker-registry "$pull_secret"');
    expect(prep).not.toMatch(/docker-registry harbor-registry\b/);
    const aggregator = read(path.join(fedlify, "deploy/k8s/study-aggregator/aggregator.yaml.tmpl"));
    expect(aggregator).toMatch(/- name: harbor-registry\n\s+- name: harbor-registry-study/);
  });

  it("the push credential is minted (or legacy-written) before the build, and the build comes before the aggregator robot", () => {
    const steps = workflow.slice(workflow.indexOf("    - name: publish\n"), workflow.indexOf("    - name: report-exit"));
    const at = (needle: string) => steps.indexOf(needle);
    expect(at("template: mint-push-robot")).toBeGreaterThan(0);
    expect(at("template: mint-push-robot")).toBeLessThan(at("template: build-image"));
    expect(at("template: legacy-push-credential")).toBeLessThan(at("template: build-image"));
    expect(at("template: build-image")).toBeLessThan(at("template: mint-aggregator-robot"));
    expect(at("template: mint-aggregator-robot")).toBeLessThan(at("template: prepare-namespace"));
    expect(at("template: prepare-namespace")).toBeLessThan(at("template: prune-aggregator-robots"));
  });

  it("the per-study steps run only in per-study mode and the legacy step only otherwise", () => {
    const steps = workflow.slice(workflow.indexOf("    - name: publish\n"), workflow.indexOf("    - name: report-exit"));
    for (const name of ["mint-push-robot", "mint-aggregator-robot", "prune-aggregator-robots"]) {
      expect(steps).toMatch(new RegExp(`template: ${name}\\n\\s+when: "'\\{\\{workflow.parameters.registry-mode\\}\\}' == 'per-study'"`));
    }
    expect(steps).toMatch(/template: legacy-push-credential\n\s+when: "'\{\{workflow.parameters.registry-mode\}\}' != 'per-study'"/);
    expect(workflow).toMatch(/- name: registry-mode\s+# legacy \| per-study\n\s+value: legacy/);
  });

  it("the exit handler deletes the push robot on success and failure, and a failed delete does not stop the callback", () => {
    const exit = workflow.slice(workflow.indexOf("    - name: report-exit"), workflow.indexOf("    # 1. Clone"));
    expect(exit).toContain("template: delete-push-robot");
    expect(exit).toMatch(/delete-push-robot[\s\S]*continueOn: \{ failed: true, error: true \}/);
    expect(exit.indexOf("delete-push-robot")).toBeLessThan(exit.indexOf("template: callback"));
    const deleteStep = exit.slice(exit.indexOf("- - name: delete-push-robot"), exit.indexOf("- - name: callback"));
    expect(deleteStep).not.toContain("workflow.status");
  });

  it("robots are named per run, short-lived or replaced, and the secret never reaches a command line or log", () => {
    expect(t["mint-push-robot"]).toContain("--push --days 1");
    expect(t["mint-aggregator-robot"]).toContain("--days 365");
    expect(t["mint-aggregator-robot"]).toContain("--credential-file /work/aggregator-robot.json");
    expect(t["prepare-namespace"]).toContain("rm -f /work/aggregator-robot.json");
    expect(t["prepare-namespace"]).not.toMatch(/echo[^\n]*PULL_PASSWORD/);
  });

  it("the base image copies the whole fedlify_runtime package, so harbor.py ships with it", () => {
    expect(read(path.join(fedlify, "deploy/images/nvflare/Dockerfile"))).toContain("deploy/images/nvflare/fedlify_runtime /opt/fedlify/runtime/fedlify_runtime");
  });
});

describe("terraform: registry resources", () => {
  it("fedlify-public is public and holds a push-only-to-itself robot", () => {
    expect(resourceBlock("harbor_project", "fedlify_public")).toMatch(/public\s+= true/);
    const push = resourceBlock("harbor_robot_account", "fedlify_helper_push");
    expect(push).toContain("harbor_project.fedlify_public.name");
    expect(push).not.toContain('namespace = "*"');
    expect(push).toMatch(/level\s+= "project"/);
  });

  it("the provisioner is a plain non-admin Harbor user, not a robot", () => {
    const block = resourceBlock("harbor_user", "fedlify_provisioner");
    expect(block).toMatch(/admin\s*=\s*false/);
    expect(terraform).not.toMatch(/resource "harbor_robot_account" "fedlify_provisioner"/);
  });

  it("Terraform does not manage shared Harbor settings", () => {
    expect(terraform).not.toMatch(/resource "harbor_config_/);
  });

  it("the provisioner Secret is its own resource, so a targeted apply depends on nothing but the robot and the namespace", () => {
    const secret = resourceBlock("kubernetes_secret_v1", "harbor_provisioner");
    expect(secret).toContain("random_password.fedlify_provisioner.result");
    expect(secret).not.toMatch(/local\.fedlify_secrets|random_password\.fedlify\[|gitea_token|fedlify_studies_pull/);
    expect(terraform).not.toMatch(/"harbor-provisioner" = \{/);
    const target = terraform.slice(terraform.indexOf("fedlify_secrets = {"), terraform.indexOf('resource "kubernetes_secret_v1" "fedlify"'));
    expect(target).not.toContain("fedlify_provisioner");
  });

  it("the provisioner secret exists for the cluster and the helper push secret is a sensitive output only", () => {
    expect(terraform).toMatch(/output "fedlify_helper_push_robot" \{[\s\S]*?sensitive\s+= true/);
    expect(terraform).not.toMatch(/"harbor-helper-push"/);
  });

  it("no existing Fedlify resource was rewritten: the legacy robot and studies project are still defined", () => {
    resourceBlock("harbor_robot_account", "fedlify_studies_pull");
    resourceBlock("harbor_project", "fedlify_studies");
    expect(terraform).toMatch(/"harbor-studies-pull" = \{/);
  });
});

describe("migration and schema are additive", () => {
  const dir = path.join(fedlify, "apps/web/prisma/migrations/20261109090000_registry_projects");
  const sql = read(path.join(dir, "migration.sql")).replace(/--.*$/gm, "");

  it("only creates types, tables, indexes and one foreign key, and drops or alters nothing existing", () => {
    for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      expect(statement).toMatch(/^(CREATE TYPE|CREATE TABLE|CREATE UNIQUE INDEX|CREATE INDEX|ALTER TABLE "RegistryRobot" ADD CONSTRAINT)/);
    }
    const withoutReferentialActions = sql.replace(/ON (DELETE|UPDATE) CASCADE/g, "");
    expect(withoutReferentialActions).not.toMatch(/\bDROP\b|\bDELETE\b|\bUPDATE\b|\bRENAME\b|ALTER TYPE/);
  });

  it("no column can hold a robot secret", () => {
    expect(sql).not.toMatch(/secret|password|token/i);
  });
});

describe("web deployment and sweeper", () => {
  const web = read(path.join(fedlify, "deploy/k8s/web-deployment.yaml"));

  it("ships in legacy mode with an optional provisioner, so web starts before Terraform is applied", () => {
    expect(web).toMatch(/FEDLIFY_REGISTRY_MODE\n\s+value: legacy/);
    for (const key of ["url", "username", "password"]) expect(web).toMatch(new RegExp(`name: harbor-provisioner, key: ${key}, optional: true`));
    expect(web).not.toContain("harbor-registry-credentials");
  });

  it("the sweeper is in the kustomization, signs like the Argo callback and holds no Harbor credential", () => {
    expect(read(path.join(fedlify, "deploy/k8s/kustomization.yaml"))).toContain("registry-sweeper.yaml");
    const sweeper = read(path.join(fedlify, "deploy/k8s/registry-sweeper.yaml"));
    expect(sweeper).toContain("registry-sweep");
    expect(sweeper).toContain("argo-webhook-secret");
    expect(sweeper).not.toMatch(/harbor-provisioner|harbor-registry-credentials/);
    expect(sweeper).toContain("concurrencyPolicy: Forbid");
  });

  it("the release script refuses any project but fedlify-public, never takes credentials as arguments, and prints a digest reference", () => {
    const script = read(path.join(fedlify, "scripts/release-helper-image.sh"));
    expect(script).toContain('[ "$project" = "fedlify-public" ] || die');
    expect(script).toContain("--password-stdin");
    expect(script).not.toMatch(/--password[ =]\S/);
    expect(script).toContain('echo "FEDLIFY_HELPER_IMAGE=$repo@$digest"');
    expect(script).toContain("--metadata-file");
  });
});
