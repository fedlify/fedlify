from __future__ import annotations

import hashlib
import hmac
import json
import os
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import Any

from .models import KitRequest, Participant


class NvflareUnavailable(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sign_manifest(manifest: dict[str, Any], key: str) -> str:
    payload = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(key.encode(), payload, hashlib.sha256).hexdigest()


class FedlifyKitGenerator:
    def __init__(self, output_dir: Path, require_nvflare: bool = False, signing_key: str | None = None) -> None:
        self.output_dir = output_dir
        self.require_nvflare = require_nvflare
        self.signing_key = signing_key or os.environ.get("FEDLIFY_RELEASE_SIGNING_KEY", "fedlify-dev-signing-key")

    def generate(self, request: KitRequest) -> dict[str, Any]:
        workspace = self.output_dir / request.agent_run_id
        if workspace.exists():
            shutil.rmtree(workspace)
        workspace.mkdir(parents=True)

        self._write_project(request, workspace)
        self._write_app(request, workspace)
        self._try_nvflare_provision(workspace)

        artifacts_dir = workspace / "artifacts"
        artifacts_dir.mkdir()
        artifact_records = []

        artifact_records.append(self._zip_path(workspace / "server", artifacts_dir / "server-kit.zip", "SERVER_KIT"))
        artifact_records.append(self._zip_path(workspace / "admin", artifacts_dir / "admin-kit.zip", "ADMIN_KIT"))
        artifact_records.append(self._zip_path(workspace / "helm", artifacts_dir / "helm-chart.zip", "HELM_CHART"))

        for participant in request.participants:
            artifact_records.append(
                self._zip_path(
                    workspace / "sites" / participant.code,
                    artifacts_dir / f"{participant.code}-site-kit.zip",
                    "SITE_KIT",
                    site_code=participant.code,
                )
            )

        manifest = {
            "studyId": request.study_id,
            "agentRunId": request.agent_run_id,
            "framework": "nvflare",
            "dataBoundary": "site-only",
            "artifacts": artifact_records,
        }
        manifest["signature"] = sign_manifest(manifest, self.signing_key)

        manifest_path = artifacts_dir / "manifest.sha256.json"
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        artifact_records.append(
            {
                "kind": "CHECKSUM_MANIFEST",
                "filename": manifest_path.name,
                "path": str(manifest_path),
                "checksum": sha256_file(manifest_path),
                "sizeBytes": manifest_path.stat().st_size,
            }
        )

        return manifest

    def _try_nvflare_provision(self, workspace: Path) -> None:
        nvflare = shutil.which("nvflare")
        if not nvflare:
            if self.require_nvflare:
                raise NvflareUnavailable("nvflare CLI is required but was not found in PATH.")
            (workspace / "NVFLARE_FALLBACK.txt").write_text(
                "Generated with Fedlify deterministic fallback. Install nvflare and set "
                "FEDLIFY_REQUIRE_NVFLARE=true to force real provisioning.\n",
                encoding="utf-8",
            )
            return

        try:
            subprocess.run(
                [nvflare, "provision", "-p", str(workspace / "project.yml"), "-w", str(workspace / "provisioned")],
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as exc:
            if self.require_nvflare:
                raise
            (workspace / "NVFLARE_FALLBACK.txt").write_text(
                "nvflare CLI was found but provisioning failed in local fallback mode. "
                f"Exit code: {exc.returncode}.\n\nSTDOUT:\n{exc.stdout or ''}\n\nSTDERR:\n{exc.stderr or ''}\n",
                encoding="utf-8",
            )

    def _write_project(self, request: KitRequest, workspace: Path) -> None:
        participants_yaml = "\n".join(
            [
                "  - name: server\n    type: server\n    org: fedlify",
                "  - name: admin@fedlify.local\n    type: admin\n    org: fedlify",
                *[
                    f"  - name: {participant.nvflare_client_name}\n    type: client\n    org: {participant.code}"
                    for participant in request.participants
                ],
            ]
        )

        builders_yaml = "\n".join(
            [
                "  - path: nvflare.lighter.impl.static_file.StaticFileBuilder",
                "  - path: nvflare.lighter.impl.cert.CertBuilder",
                "  - path: nvflare.lighter.impl.signature.SignatureBuilder",
                "  - path: nvflare.lighter.impl.workspace.WorkspaceBuilder",
            ]
        )

        (workspace / "project.yml").write_text(
            "\n".join(
                [
                    f"name: {request.study_id}",
                    f"description: {request.title}",
                    "participants:",
                    participants_yaml,
                    "builders:",
                    builders_yaml,
                    "",
                ]
            ),
            encoding="utf-8",
        )

    def _write_app(self, request: KitRequest, workspace: Path) -> None:
        app_dir = workspace / "app"
        server_dir = workspace / "server"
        admin_dir = workspace / "admin"
        helm_dir = workspace / "helm"
        sites_dir = workspace / "sites"
        for path in [app_dir, server_dir, admin_dir, helm_dir, sites_dir]:
            path.mkdir(parents=True, exist_ok=True)

        config = {
            "studyId": request.study_id,
            "agentRunId": request.agent_run_id,
            "title": request.title,
            "need": request.need,
            "rawDataPolicy": "source datasets remain at participant sites",
            "centralSandbox": {"enabled": request.central_sandbox_enabled, "syntheticOnly": True},
            "participants": [participant.__dict__ for participant in request.participants],
        }
        (app_dir / "pipeline.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
        (server_dir / "README.md").write_text(self._server_readme(request), encoding="utf-8")
        (server_dir / "start_server.sh").write_text("#!/usr/bin/env bash\nset -euo pipefail\nnvflare server\n", encoding="utf-8")
        (admin_dir / "README.md").write_text(self._admin_readme(request), encoding="utf-8")
        (helm_dir / "values.yaml").write_text(self._helm_values(request), encoding="utf-8")

        for participant in request.participants:
            self._write_site(request, participant, sites_dir / participant.code)

    def _write_site(self, request: KitRequest, participant: Participant, site_dir: Path) -> None:
        site_dir.mkdir(parents=True, exist_ok=True)
        (site_dir / "README.md").write_text(
            "\n".join(
                [
                    f"# Fedlify site kit: {participant.institution_name}",
                    "",
                    "This kit is for a hospital-side NVFLARE participant agent.",
                    "Do not place raw clinical data in Fedlify object storage.",
                    f"Study: {request.title}",
                    f"NVFLARE client: {participant.nvflare_client_name}",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        (site_dir / "start_client.sh").write_text(
            "#!/usr/bin/env bash\nset -euo pipefail\nnvflare client\n",
            encoding="utf-8",
        )

    def _zip_path(self, source: Path, destination: Path, kind: str, site_code: str | None = None) -> dict[str, Any]:
        with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(source.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(source))
        return {
            "kind": kind,
            "siteCode": site_code,
            "filename": destination.name,
            "path": str(destination),
            "checksum": sha256_file(destination),
            "sizeBytes": destination.stat().st_size,
        }

    def _server_readme(self, request: KitRequest) -> str:
        return f"# Fedlify NVFLARE server kit\n\nStudy: {request.title}\n\nRun only after release approval.\n"

    def _admin_readme(self, request: KitRequest) -> str:
        return f"# Fedlify NVFLARE admin kit\n\nAgent run: {request.agent_run_id}\n"

    def _helm_values(self, request: KitRequest) -> str:
        return "\n".join(
            [
                "fedlify:",
                f"  studyId: {request.study_id}",
                f"  agentRunId: {request.agent_run_id}",
                "  dataBoundary: site-only",
                "  centralSandboxSyntheticOnly: true",
                "",
            ]
        )
