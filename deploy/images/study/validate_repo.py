#!/usr/bin/env python3
"""Publish-time checks for a Fedlify study repository (run by CI before the image is built).

usage: validate_repo.py <repo-dir>    exit code 0 = publishable, 1 = rejected (reasons on stderr)
"""

import json
import re
import sys
from pathlib import Path

REQUIRED = [
    "fedlify-pipeline.json",
    "client.py",
    "job/meta.conf",
    "job/app/config/config_fed_server.conf",
    "job/app/config/config_fed_client.conf",
]
DATA_SUFFIXES = {".csv", ".tsv", ".parquet", ".feather", ".sqlite", ".db", ".xlsx", ".xls", ".h5", ".hdf5", ".pkl", ".pickle", ".npz", ".npy"}
DATA_PATH_PATTERNS = [re.compile(p, re.I) for p in (r"patients?", r"clinical[-_ ]?extract", r"raw[-_ ]?data")]
SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(r"(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['\"][^'\"]{8,}['\"]", re.I),
]
# Row identifiers and time-offset columns must never be model features: identifiers let a model memorise
# patients, and offsets (minutes from admission) leak the outcome timeline. Keep in step with repo-checks.ts.
IDENTIFIER_FEATURES = {"patientunitstayid", "patienthealthsystemstayid", "uniquepid"}
OFFSET_LIKE = re.compile(r"offset", re.I)
LAUNCHER_PATH = "/opt/fedlify/code/"
MAX_REPO_BYTES = 20 * 1024 * 1024


def validate(root: Path) -> list:
    errors = []
    files = [p for p in root.rglob("*") if p.is_file() and ".git" not in p.relative_to(root).parts]
    relative = {p.relative_to(root).as_posix(): p for p in files}

    errors += [f"missing required file: {name}" for name in REQUIRED if name not in relative]

    total = sum(p.stat().st_size for p in files)
    if total > MAX_REPO_BYTES:
        errors.append(f"repository is {total // 1024} KB; the limit is {MAX_REPO_BYTES // 1024} KB (code only, no data or models)")

    for name, path in relative.items():
        if name in ("README.md", "fedlify-pipeline.json"):
            continue
        if path.suffix.lower() in DATA_SUFFIXES or any(p.search(name) for p in DATA_PATH_PATTERNS):
            errors.append(f"data-like file is not allowed in a study repository: {name}")
        if path.suffix.lower() in {".py", ".json", ".conf", ".yaml", ".yml", ".txt", ".md", ".sh", ".env", ".ini", ".cfg"}:
            text = path.read_text(errors="ignore")
            for pattern in SECRET_PATTERNS:
                if pattern.search(text):
                    errors.append(f"possible credential in {name} (matched {pattern.pattern[:30]}...)")
                    break

    if "fedlify-pipeline.json" in relative:
        try:
            config = json.loads(relative["fedlify-pipeline.json"].read_text())
            if config.get("packageType") != "fedlify-study-pipeline":
                errors.append('fedlify-pipeline.json: packageType must be "fedlify-study-pipeline"')
            entrypoint = config.get("entrypoint", "client.py")
            if entrypoint not in relative:
                errors.append(f"fedlify-pipeline.json: entrypoint {entrypoint} does not exist")
            contract = config.get("dataContract", {})
            if not contract.get("label") or not contract.get("features"):
                errors.append("fedlify-pipeline.json: dataContract needs a label and a features list")
            for feature in contract.get("features") or []:
                name = str(feature).strip()
                if name.lower() in IDENTIFIER_FEATURES or OFFSET_LIKE.search(name):
                    errors.append(f"fedlify-pipeline.json: feature {name} is an identifier or time-offset column and cannot be a model feature")
        except json.JSONDecodeError as error:
            errors.append(f"fedlify-pipeline.json is not valid JSON: {error}")

    client_conf = relative.get("job/app/config/config_fed_client.conf")
    if client_conf and LAUNCHER_PATH not in client_conf.read_text():
        errors.append(f"job client config must launch code from {LAUNCHER_PATH} (code is baked into the image)")

    requirements = relative.get("requirements.txt")
    if requirements:
        for number, line in enumerate(requirements.read_text().splitlines(), start=1):
            line = line.split("#", 1)[0].strip()
            if line and ("==" not in line or line.startswith(("-", "git+", "http"))):
                errors.append(f"requirements.txt:{number}: pin an exact version from PyPI (package==x.y.z): {line}")

    for name, path in relative.items():
        if path.suffix == ".py":
            try:
                compile(path.read_text(), name, "exec")
            except SyntaxError as error:
                errors.append(f"{name} does not compile: line {error.lineno}: {error.msg}")
    return errors


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    errors = validate(Path(sys.argv[1]).resolve())
    for error in errors:
        print(f"FAIL {error}", file=sys.stderr)
    print("Repository is publishable." if not errors else f"{len(errors)} problem(s) found.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
