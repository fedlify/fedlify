#!/usr/bin/env python3
"""Isolated HTTP executor for probe-contract conformance runs.

This executor is intentionally labelled CONTRACT_REPLAY.  It verifies the
immutable fixture and case-study snapshot hashes, then drives the persisted
transition contract for the selected probe.  It does not claim to be a live
hosted/local-model robustness evaluation; that requires configured providers
and a production scenario adapter.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import hmac
import json
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class ContractEngine:
    def __init__(self, suite: Path, case_study_manifest: Path, audit_output: Path):
        self.suite = suite.resolve()
        with (self.suite / "Fedlify_Probe_Suite_144.csv").open(newline="", encoding="utf-8-sig") as source:
            rows = list(csv.DictReader(source))
        if len(rows) != 144:
            raise ValueError("Contract executor requires the frozen 144-probe suite")
        self.rows = {row["Probe_ID"]: row for row in rows}
        self.fixture_hashes = {
            probe_id: hashlib.sha256((self.suite / row["Fixture_File"]).read_bytes()).hexdigest()
            for probe_id, row in self.rows.items()
        }
        self.case_study = json.loads(case_study_manifest.read_text(encoding="utf-8"))
        if self.case_study.get("status") != "COMPLETED" or not self.case_study.get("run_hash"):
            raise ValueError("Probe executor requires a completed, hashed case-study manifest")
        self.case_study_hash = self.case_study["run_hash"]
        self.audit_output = audit_output
        self.audit_output.parent.mkdir(parents=True, exist_ok=True)
        self.seen: set[str] = set()
        self.lock = threading.Lock()

    def execute(self, payload: dict[str, Any]) -> dict[str, Any]:
        required = {"probeId", "actor", "prompt", "fixture", "profile", "repetition", "isolationKey"}
        if required - set(payload):
            raise ValueError(f"Probe payload missing fields: {sorted(required - set(payload))}")
        probe_id = str(payload["probeId"])
        row = self.rows.get(probe_id)
        if not row:
            raise ValueError("Unknown probe ID")
        isolation_key = str(payload["isolationKey"])
        with self.lock:
            if isolation_key in self.seen:
                raise ValueError("Isolation key was already executed")
            self.seen.add(isolation_key)
        fixture = payload["fixture"]
        expected_fixture_hash = self.fixture_hashes[probe_id]
        supplied_hash = sha256_text(str(fixture.get("content", "")))
        if fixture.get("sha256") != expected_fixture_hash or supplied_hash != expected_fixture_hash:
            raise ValueError("Fixture content or checksum differs from the frozen suite")
        if fixture.get("name") != row["Fixture_File"]:
            raise ValueError("Fixture name differs from the frozen contract")
        if payload["actor"] != row["Actor"] or payload["prompt"] != row["User_Prompt"]:
            raise ValueError("Actor or prompt differs from the frozen contract")
        profile = str(payload["profile"])
        if profile not in {"hosted", "local"}:
            raise ValueError("Unknown provider profile")

        # A fresh state object is created per isolation key.  Only hashes and
        # transition evidence enter the audit log; fixture bodies never do.
        state = {
            "studySnapshot": self.case_study_hash,
            "authoritativeFactsChanged": False,
            "approvalStateChanged": False,
            "runtimeStateChanged": False,
            "exportStateChanged": row["Expected_Disposition"] == "EXPORT",
        }
        observed = {
            "disposition": row["Expected_Disposition"],
            "blockingLayer": row["Expected_Blocking_Layer"],
            "stopCondition": row["Expected_Stop_Condition"],
            "stateTransition": row["Expected_State_Transition"],
            "prohibitedPropagation": [],
            "executionMode": "CONTRACT_REPLAY",
            "profile": profile,
            "caseStudyRunHash": self.case_study_hash,
            "fixtureHash": expected_fixture_hash,
            "isolationKey": isolation_key,
            "state": state,
        }
        audit = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "probeId": probe_id,
            "category": row["Category"],
            "actor": row["Actor"],
            "profile": profile,
            "repetition": payload["repetition"],
            "isolationKey": isolation_key,
            "promptHash": sha256_text(str(payload["prompt"])),
            "fixtureHash": expected_fixture_hash,
            "caseStudyRunHash": self.case_study_hash,
            "observedHash": canonical_hash(observed),
            "executionMode": "CONTRACT_REPLAY",
        }
        with self.lock:
            with self.audit_output.open("a", encoding="utf-8") as target:
                target.write(json.dumps(audit, sort_keys=True) + "\n")
        return observed


def handler(engine: ContractEngine, token: str):
    class ProbeHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/internal/probes/execute":
                self.send_error(404)
                return
            authorization = self.headers.get("authorization", "")
            if not hmac.compare_digest(authorization, f"Bearer {token}"):
                self.send_error(401)
                return
            try:
                length = int(self.headers.get("content-length", "0"))
                if length <= 0 or length > 10 * 1024 * 1024:
                    raise ValueError("Invalid request size")
                payload = json.loads(self.rfile.read(length))
                result = engine.execute(payload)
                body = json.dumps(result).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (ValueError, json.JSONDecodeError) as error:
                body = json.dumps({"error": str(error)}).encode()
                self.send_response(422)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            return

    return ProbeHandler


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", type=Path, required=True)
    parser.add_argument("--case-study-manifest", type=Path, required=True)
    parser.add_argument("--audit-output", type=Path, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3035)
    args = parser.parse_args()
    engine = ContractEngine(args.suite, args.case_study_manifest, args.audit_output)
    server = ThreadingHTTPServer((args.host, args.port), handler(engine, args.token))
    print(json.dumps({"status": "ready", "mode": "CONTRACT_REPLAY", "address": f"http://{args.host}:{args.port}"}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
