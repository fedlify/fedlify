#!/usr/bin/env python3
"""Fedlify FLARE API adapter.

Runs next to one study aggregator (sidecar in Kubernetes) and exposes a small authenticated HTTP API
that the Fedlify web app uses to inspect connected sites, submit the job baked into the study image,
follow its progress, and fetch results. The web app never touches the adapter's filesystem.

Environment:
  FEDLIFY_ADAPTER_TOKEN     required bearer token for every endpoint except /healthz
  FEDLIFY_ADMIN_KIT_DIR     mounted NVFLARE admin startup kit (contains startup/fed_admin.json)
  FEDLIFY_JOB_DIR           NVFLARE job folder baked into the study image
  FEDLIFY_SERVER_WORKSPACE  aggregator workspace shared with the server container (live metrics)
"""

import io
import json
import os
import pathlib
import re
import shutil
import sys
import tempfile
import threading
import traceback
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from nvflare.fuel.flare_api import flare_api

METRICS_FILE = "fedlify_metrics.jsonl"
LOG_FILE = "log.txt"
LOG_TAIL_BYTES = 1_000_000  # the web app caps and redacts again; this only bounds the transfer
_kit_lock = threading.Lock()
_kit_location = None


def admin_kit_location():
    """Copy the read-only admin kit into a writable location once (the admin client writes transfer/)."""
    global _kit_location
    with _kit_lock:
        if _kit_location:
            return _kit_location
        source = pathlib.Path(os.environ.get("FEDLIFY_ADMIN_KIT_DIR", "/admin-kit"))
        if not (source / "startup" / "fed_admin.json").exists():
            raise RuntimeError(f"admin kit not found at {source}")
        target = pathlib.Path(tempfile.mkdtemp(prefix="fedlify-admin-")) / source.name
        shutil.copytree(source, target)
        (target / "transfer").mkdir(exist_ok=True)
        _kit_location = target
        return target


def admin_username(kit):
    """The admin identity is the CN of the kit's client certificate (the mount folder name is arbitrary)."""
    if os.environ.get("NVFLARE_ADMIN_EMAIL"):
        return os.environ["NVFLARE_ADMIN_EMAIL"]
    from cryptography import x509
    from cryptography.x509.oid import NameOID

    cert = x509.load_pem_x509_certificate((kit / "startup" / "client.crt").read_bytes())
    return cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value


def call_session(fn):
    kit = admin_kit_location()
    session = flare_api.new_secure_session(
        username=admin_username(kit),
        startup_kit_location=str(kit),
        debug=os.environ.get("NVFLARE_FLARE_API_DEBUG") == "1",
        timeout=float(os.environ.get("NVFLARE_FLARE_API_TIMEOUT", "30")),
    )
    try:
        return fn(session)
    finally:
        try:
            session.close()
        except Exception:
            pass


def set_conf_value(text, key, value):
    pattern = re.compile(rf"(^\s*{re.escape(key)}\s*[=:]\s*)[^\s,}}]+", re.MULTILINE)
    if not pattern.search(text):
        raise ValueError(f"{key} not found in job configuration")
    return pattern.sub(lambda match: f"{match.group(1)}{value}", text)


def prepare_job(params):
    """Copy the baked-in job and apply run-time parameters chosen in the Fedlify dashboard."""
    source = pathlib.Path(os.environ.get("FEDLIFY_JOB_DIR", "/opt/fedlify/code/job"))
    if not (source / "meta.conf").exists():
        raise RuntimeError(f"job folder not found at {source}")
    name = re.sub(r"[^A-Za-z0-9_-]", "-", str(params.get("jobName") or "fedlify-job"))[:60]
    target = pathlib.Path(tempfile.mkdtemp(prefix="fedlify-job-")) / name
    shutil.copytree(source, target)

    meta_path = target / "meta.conf"
    server_path = target / "app" / "config" / "config_fed_server.conf"
    meta = meta_path.read_text()
    server = server_path.read_text()
    meta = set_conf_value(meta, "name", json.dumps(name))
    if params.get("minClients"):
        meta = set_conf_value(meta, "min_clients", int(params["minClients"]))
        server = set_conf_value(server, "min_clients", int(params["minClients"]))
    if params.get("numRounds"):
        server = set_conf_value(server, "num_rounds", int(params["numRounds"]))
    meta_path.write_text(meta)
    server_path.write_text(server)
    return target


def system_info_payload(info):
    clients = [
        {"name": getattr(client, "name", str(client)), "lastConnectTime": getattr(client, "last_connect_time", None)}
        for client in getattr(info, "client_info", []) or []
    ]
    jobs = [
        {"jobId": getattr(job, "job_id", None), "appName": getattr(job, "app_name", None)}
        for job in getattr(info, "job_info", []) or []
    ]
    server = getattr(info, "server_info", None)
    return {
        "server": {"status": str(getattr(server, "status", "unknown")), "startTime": getattr(server, "start_time", None)},
        "clients": clients,
        "runningJobs": jobs,
    }


def read_metrics(path):
    records = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def live_metrics_path(job_id):
    workspace = pathlib.Path(os.environ.get("FEDLIFY_SERVER_WORKSPACE", "/workspace/participant"))
    candidate = workspace / job_id / METRICS_FILE
    return candidate if candidate.exists() else None


def live_log_path(job_id):
    workspace = pathlib.Path(os.environ.get("FEDLIFY_SERVER_WORKSPACE", "/workspace/participant"))
    candidate = workspace / job_id / LOG_FILE
    return candidate if candidate.exists() else None


def read_tail(path, limit=LOG_TAIL_BYTES):
    with open(path, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - limit))
        return handle.read()


def result_dir(session, job_id):
    return pathlib.Path(session.download_job_result(job_id))


def zip_directory(root):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(root))
    return buffer.getvalue()


class Handler(BaseHTTPRequestHandler):
    server_version = "FedlifyFlareApiAdapter/0.2"

    def _send(self, status, body, content_type="application/json"):
        payload = body if isinstance(body, bytes) else json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _error(self, status, error):
        debug = os.environ.get("NVFLARE_FLARE_API_DEBUG") == "1"
        self._send(status, {"error": str(error), "trace": traceback.format_exc() if debug else None})

    def _authorized(self):
        token = os.environ.get("FEDLIFY_ADAPTER_TOKEN", "")
        return bool(token) and self.headers.get("authorization") == f"Bearer {token}"

    def _read_json(self):
        length = int(self.headers.get("content-length", "0"))
        return json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}

    def _route(self, method):
        path = urlparse(self.path).path.rstrip("/")
        if method == "GET" and path == "/healthz":
            return self._send(200, {"ok": True, "adapter": "fedlify-flare-api"})
        if not self._authorized():
            return self._send(401, {"error": "unauthorized"})

        parts = path.strip("/").split("/")
        if method == "GET" and path == "/system-info":
            return self._send(200, call_session(lambda s: system_info_payload(s.get_system_info())))
        if method == "POST" and path == "/jobs":
            job_folder = prepare_job(self._read_json())
            try:
                job_id = call_session(lambda s: s.submit_job(str(job_folder)))
            finally:
                shutil.rmtree(job_folder.parent, ignore_errors=True)
            return self._send(201, {"nvflareJobId": job_id, "status": "SUBMITTED"})
        if len(parts) >= 2 and parts[0] == "jobs":
            job_id = parts[1]
            action = parts[2] if len(parts) > 2 else ""
            if method == "GET" and action == "":
                return self._send(200, {"nvflareJobId": job_id, "meta": call_session(lambda s: s.get_job_meta(job_id))})
            if method == "GET" and action == "metrics":
                live = live_metrics_path(job_id)
                if live:
                    return self._send(200, {"nvflareJobId": job_id, "source": "live", "records": read_metrics(live)})
                found = call_session(lambda s: next(result_dir(s, job_id).rglob(METRICS_FILE), None))
                records = read_metrics(found) if found else []
                return self._send(200, {"nvflareJobId": job_id, "source": "result", "records": records})
            if method == "GET" and action == "log":
                # Read the live workspace first: it exists while the job runs and right after an abort, before cleanup.
                live = live_log_path(job_id)
                if live:
                    return self._send(200, read_tail(live), "text/plain; charset=utf-8")
                found = call_session(lambda s: next(result_dir(s, job_id).rglob(LOG_FILE), None))
                if not found:
                    return self._send(404, {"error": "no_log"})
                return self._send(200, read_tail(found), "text/plain; charset=utf-8")
            if method == "GET" and action == "result.zip":
                root = call_session(lambda s: result_dir(s, job_id))
                return self._send(200, zip_directory(root), "application/zip")
            if method == "POST" and action == "abort":
                call_session(lambda s: s.abort_job(job_id))
                return self._send(200, {"nvflareJobId": job_id, "status": "ABORTED"})
        return self._send(404, {"error": "not_found"})

    def do_GET(self):
        try:
            self._route("GET")
        except Exception as error:
            self._error(500, error)

    def do_POST(self):
        try:
            self._route("POST")
        except Exception as error:
            self._error(500, error)

    def log_message(self, format, *args):
        sys.stderr.write("flare-api-adapter " + format % args + "\n")


def main():
    if not os.environ.get("FEDLIFY_ADAPTER_TOKEN"):
        sys.exit("FEDLIFY_ADAPTER_TOKEN is required.")
    host = os.environ.get("NVFLARE_FLARE_API_HOST", "127.0.0.1")
    port = int(os.environ.get("NVFLARE_FLARE_API_PORT", "3010"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Fedlify FLARE API adapter listening on http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
