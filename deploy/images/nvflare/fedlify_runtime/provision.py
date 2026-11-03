"""Provision NVFLARE startup kits for one study aggregator and package them for Fedlify.

usage: python3 -m fedlify_runtime.provision --hostname hf-mortality.fedlify.com \
           --sites '[{"name":"site_a"},{"name":"site_b"}]' --out /work/kits [--project hf_mortality]

Layout written to --out:
  server-kit.tgz            server startup kit (Kubernetes Secret, never leaves the cluster)
  admin-kit.tgz             admin kit for the FLARE API adapter sidecar (Secret)
  clients/<name>.zip        one client startup kit per site (uploaded to object storage)
  project.yml               the NVFLARE project definition used
  kits/<participant>/...    unpacked kits (for local testing)

Clients dial <hostname>:443 (TLS passthrough at the ingress, routed by SNI = server name);
the server listens on 8002 (federated learning) and 8003 (admin, reached inside the pod).
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

FL_PORT = 8002
ADMIN_PORT = 8003
PUBLIC_PORT = 443
NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$")


def org_name(value: str) -> str:
    """NVFLARE orgs allow only [A-Za-z0-9_]; client names may also contain '-' (Fedlify uses site-<code>)."""
    return re.sub(r"[^A-Za-z0-9_]", "_", value)


def project_yaml(project: str, hostname: str, admin: str, sites: list) -> str:
    lines = [
        "api_version: 3",
        f"name: {project}",
        f'description: "Fedlify study aggregator {hostname}"',
        "participants:",
        f"  - name: {hostname}",
        "    type: server",
        "    org: fedlify",
        f"    fed_learn_port: {FL_PORT}",
        f"    admin_port: {ADMIN_PORT}",
        "    host_names:",
        f"      - {hostname}",
        f"  - name: {admin}",
        "    type: admin",
        "    org: fedlify",
        "    role: project_admin",
    ]
    for site in sites:
        lines += [
            f"  - name: {site['name']}",
            "    type: client",
            f"    org: {org_name(site.get('org') or site['name'])}",
            "    connect_to:",
            f"      name: {hostname}",
            f"      host: {hostname}",
            f"      port: {PUBLIC_PORT}",
        ]
    lines += [
        "builders:",
        "  - path: nvflare.lighter.impl.workspace.WorkspaceBuilder",
        "  - path: nvflare.lighter.impl.static_file.StaticFileBuilder",
        "    args:",
        "      config_folder: config",
        "      overseer_agent:",
        "        path: nvflare.ha.dummy_overseer_agent.DummyOverseerAgent",
        "        overseer_exists: false",
        "        args:",
        f"          sp_end_point: {hostname}:{FL_PORT}:{ADMIN_PORT}",
        "  - path: nvflare.lighter.impl.cert.CertBuilder",
        "  - path: nvflare.lighter.impl.signature.SignatureBuilder",
        "",
    ]
    return "\n".join(lines)


def tar_dir(source: Path, target: Path) -> None:
    with tarfile.open(target, "w:gz") as archive:
        for path in sorted(source.rglob("*")):
            archive.add(path, arcname=str(path.relative_to(source)), recursive=False)


def zip_dir(source: Path, target: Path, prefix: str) -> None:
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                info = zipfile.ZipInfo.from_file(path, f"{prefix}/{path.relative_to(source)}")
                archive.writestr(info, path.read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--hostname", required=True)
    parser.add_argument("--sites", required=True, help='JSON list: [{"name": "site_a", "org": "optional"}]')
    parser.add_argument("--out", required=True)
    parser.add_argument("--project", default=None)
    parser.add_argument("--admin", default="admin@fedlify.local")
    args = parser.parse_args()

    sites = json.loads(args.sites)
    if not sites:
        sys.exit("At least one site is required.")
    for site in sites:
        if not NAME_PATTERN.match(site.get("name", "")):
            sys.exit(f"Invalid NVFLARE client name: {site.get('name')!r}")
    project = args.project or re.sub(r"[^A-Za-z0-9_]", "_", args.hostname.split(".")[0])

    out = Path(args.out).resolve()
    shutil.rmtree(out, ignore_errors=True)
    (out / "clients").mkdir(parents=True)
    (out / "project.yml").write_text(project_yaml(project, args.hostname, args.admin, sites))

    workspace = out / "workspace"
    # NVFLARE reports validation errors on stdout, so keep it for the failure message.
    result = subprocess.run(["nvflare", "provision", "-p", str(out / "project.yml"), "-w", str(workspace)], capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"nvflare provision failed:\n{result.stdout}\n{result.stderr}")
    prod = workspace / project / "prod_00"

    kits = out / "kits"
    shutil.copytree(prod, kits)
    tar_dir(kits / args.hostname, out / "server-kit.tgz")
    tar_dir(kits / args.admin, out / "admin-kit.tgz")
    for site in sites:
        zip_dir(kits / site["name"], out / "clients" / f"{site['name']}.zip", "nvflare")
    shutil.rmtree(workspace)

    print(json.dumps({"project": project, "hostname": args.hostname, "sites": [s["name"] for s in sites], "out": str(out)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
