#!/usr/bin/env python3
import json
import os
import pathlib
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from nvflare.fuel.flare_api import flare_api


JOBS = {}


def admin_user_from_startup_path(startup_path):
    path = pathlib.Path(startup_path).resolve()
    if path.name == "startup":
        return path.parent.name
    return os.environ.get("NVFLARE_ADMIN_EMAIL", "admin@fedlify.local")


def json_default(value):
    if isinstance(value, pathlib.Path):
        return str(value)
    if hasattr(value, "name"):
        return value.name
    return repr(value)


def secure_session(admin_startup_path):
    if not admin_startup_path:
        raise ValueError("adminStartupPath is required.")
    path = pathlib.Path(admin_startup_path).resolve()
    if not path.exists():
        raise ValueError(f"adminStartupPath does not exist: {path}")
    startup_kit_location = path.parent if path.name == "startup" else path
    return flare_api.new_secure_session(
        username=admin_user_from_startup_path(path),
        startup_kit_location=str(startup_kit_location),
        debug=os.environ.get("NVFLARE_FLARE_API_DEBUG") == "1",
        timeout=float(os.environ.get("NVFLARE_FLARE_API_TIMEOUT", "15")),
    )


def call_session(admin_startup_path, fn):
    session = secure_session(admin_startup_path)
    try:
        return fn(session)
    finally:
        try:
            session.close()
        except Exception:
            pass


def list_result_files(result_path):
    root = pathlib.Path(result_path)
    files = []
    if not root.exists():
        return files
    for path in sorted(root.rglob("*"))[:250]:
        relative_path = path.relative_to(root)
        files.append(
            {
                "path": str(relative_path),
                "kind": "directory" if path.is_dir() else "file",
                "sizeBytes": path.stat().st_size if path.is_file() else None,
            }
        )
    return files


class Handler(BaseHTTPRequestHandler):
    server_version = "FedlifyFlareApiAdapter/0.1"

    def _send(self, status, body):
        payload = json.dumps(body, default=json_default).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _error(self, status, error):
        self._send(
            status,
            {
                "error": str(error),
                "trace": traceback.format_exc() if os.environ.get("NVFLARE_FLARE_API_DEBUG") == "1" else None,
            },
        )

    def _read_json(self):
        length = int(self.headers.get("content-length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        query = {key: values[0] for key, values in parse_qs(parsed.query).items()}
        try:
            if parsed.path == "/healthz":
                self._send(
                    200,
                    {
                        "ok": True,
                        "adapter": "fedlify-flare-api",
                        "nvflareApi": "nvflare.fuel.flare_api.flare_api",
                    },
                )
                return
            if parsed.path == "/system-info":
                admin_startup_path = query.get("adminStartupPath")
                info = call_session(admin_startup_path, lambda session: session.get_system_info())
                self._send(200, {"systemInfo": info})
                return
            if parsed.path.startswith("/jobs/") and parsed.path.endswith("/meta"):
                job_id = parsed.path.split("/")[2]
                admin_startup_path = query.get("adminStartupPath") or JOBS.get(job_id, {}).get("adminStartupPath")
                meta = call_session(admin_startup_path, lambda session: session.get_job_meta(job_id))
                self._send(200, {"jobId": job_id, "meta": meta})
                return
            if parsed.path.startswith("/jobs/") and parsed.path.endswith("/result"):
                job_id = parsed.path.split("/")[2]
                admin_startup_path = query.get("adminStartupPath") or JOBS.get(job_id, {}).get("adminStartupPath")
                result_path = call_session(admin_startup_path, lambda session: session.download_job_result(job_id))
                self._send(200, {"jobId": job_id, "resultPath": result_path, "files": list_result_files(result_path)})
                return
            self._send(404, {"error": "not_found"})
        except Exception as error:
            self._error(500, error)

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            body = self._read_json()
            if parsed.path == "/jobs":
                admin_startup_path = body.get("adminStartupPath")
                job_workspace_path = body.get("jobWorkspacePath")
                if not job_workspace_path or not pathlib.Path(job_workspace_path).exists():
                    raise ValueError(f"jobWorkspacePath does not exist: {job_workspace_path}")
                nvflare_job_id = call_session(admin_startup_path, lambda session: session.submit_job(job_workspace_path))
                JOBS[nvflare_job_id] = {
                    "adminStartupPath": admin_startup_path,
                    "jobWorkspacePath": job_workspace_path,
                    "fedlifyJobId": body.get("jobId"),
                    "deploymentId": body.get("deploymentId"),
                }
                self._send(201, {"nvflareJobId": nvflare_job_id, "status": "SUBMITTED"})
                return
            if parsed.path.startswith("/jobs/") and parsed.path.endswith("/abort"):
                job_id = parsed.path.split("/")[2]
                admin_startup_path = body.get("adminStartupPath") or JOBS.get(job_id, {}).get("adminStartupPath")
                call_session(admin_startup_path, lambda session: session.abort_job(job_id))
                self._send(200, {"nvflareJobId": job_id, "status": "ABORTED"})
                return
            if parsed.path.startswith("/jobs/") and parsed.path.endswith("/monitor"):
                job_id = parsed.path.split("/")[2]
                admin_startup_path = body.get("adminStartupPath") or JOBS.get(job_id, {}).get("adminStartupPath")
                timeout = float(body.get("timeout", 0))
                poll_interval = float(body.get("pollInterval", 2))
                result = call_session(admin_startup_path, lambda session: session.monitor_job(job_id, timeout=timeout, poll_interval=poll_interval))
                self._send(200, {"nvflareJobId": job_id, "monitorResult": result})
                return
            self._send(404, {"error": "not_found"})
        except Exception as error:
            self._error(500, error)

    def log_message(self, format, *args):
        sys.stderr.write("flare-api-adapter " + format % args + "\n")


def main():
    host = os.environ.get("NVFLARE_FLARE_API_HOST", "127.0.0.1")
    port = int(os.environ.get("NVFLARE_FLARE_API_PORT", "3010"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Fedlify FLARE API adapter listening on http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
