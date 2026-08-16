#!/usr/bin/env python3
"""Evidence-locked FL framework evaluation workflow for the Fedlify paper.

The script intentionally uses only the Python standard library so the paper
analysis can run in a clean checkout without adding project dependencies.
It reads the existing human-coded Excel workbook, creates blinded prompt
packets for GPT and Claude, optionally calls the APIs when credentials are
available, validates normalized JSON outputs, and writes a derived .xlsx audit
workbook.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import textwrap
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


PAPER_DIR = Path(__file__).resolve().parents[1]
SOURCE_WORKBOOK = PAPER_DIR / "FL_Frameworks_Evaluation_10pt _method.xlsm"
OUTPUT_WORKBOOK = PAPER_DIR / "FL_Frameworks_Evaluation_10pt_method_llm.xlsx"
ANALYSIS_DIR = PAPER_DIR / "analysis"
RUN_DIR = ANALYSIS_DIR / "runs" / "evidence_locked"
ARTIFACT_DIR = RUN_DIR / "artifacts"
PROMPT_DIR = RUN_DIR / "prompts" / "shared"
RAW_DIR = RUN_DIR / "raw_responses"
NORMALIZED_DIR = RUN_DIR / "normalized"

EXPECTED_FRAMEWORKS = [
    "TensorFlow Federated (TFF)",
    "FATE",
    "FedML",
    "Flower",
    "NVFlare",
    "OpenFL",
    "IBM Federated Learning",
    "PaddleFL",
    "Substra / SubstraFL",
    "EasyFL",
    "FLGo",
    "Fedstellar",
    "FedOps",
]

EXPECTED_RATERS = ("gpt", "claude")
DEFAULT_GPT_MODEL = os.environ.get("GPT_MODEL", "gpt-5.5")
DEFAULT_CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet")

SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def slugify(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").lower()
    return text[:90] or "item"


def packet_id(framework: str, criterion: str) -> str:
    digest = hashlib.sha1(f"{framework}|{criterion}".encode("utf-8")).hexdigest()[:8]
    return f"{slugify(framework)}__{slugify(criterion)}__{digest}"


def col_to_int(col: str) -> int:
    value = 0
    for char in col:
        value = value * 26 + ord(char) - ord("A") + 1
    return value


def int_to_col(num: int) -> str:
    out = []
    while num:
        num, rem = divmod(num - 1, 26)
        out.append(chr(ord("A") + rem))
    return "".join(reversed(out))


def maybe_number(value: str) -> Any:
    if value is None:
        return ""
    text = str(value)
    if text == "":
        return ""
    try:
        number = float(text)
    except ValueError:
        return text
    if number.is_integer():
        return int(number)
    return number


def as_float(value: Any) -> float | None:
    if value in ("", None):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def band_for_score(score: float | None) -> str:
    if score is None:
        return ""
    if score <= 4:
        return "limited"
    if score <= 6:
        return "partial"
    return "full"


def read_xlsx_values(path: Path) -> dict[str, list[list[Any]]]:
    ns = {"a": SPREADSHEET_NS, "r": OFFICE_REL_NS, "pr": REL_NS}
    with zipfile.ZipFile(path) as zf:
        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            shared_root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for item in shared_root.findall("a:si", ns):
                text = "".join(node.text or "" for node in item.findall(".//a:t", ns))
                shared_strings.append(text)

        workbook = ET.fromstring(zf.read("xl/workbook.xml"))
        rel_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        rels = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rel_root.findall("pr:Relationship", ns)}

        sheets: dict[str, list[list[Any]]] = {}
        for sheet in workbook.find("a:sheets", ns):
            name = sheet.attrib["name"]
            rid = sheet.attrib[f"{{{OFFICE_REL_NS}}}id"]
            target = rels[rid]
            sheet_path = target if target.startswith("xl/") else f"xl/{target.lstrip('/')}"
            root = ET.fromstring(zf.read(sheet_path))
            rows: list[list[Any]] = []
            for row in root.findall("a:sheetData/a:row", ns):
                values: dict[int, Any] = {}
                for cell in row.findall("a:c", ns):
                    ref = cell.attrib.get("r", "")
                    match = re.match(r"([A-Z]+)", ref)
                    if not match:
                        continue
                    col_idx = col_to_int(match.group(1))
                    cell_type = cell.attrib.get("t", "")
                    value_node = cell.find("a:v", ns)
                    inline_node = cell.find("a:is", ns)
                    value: Any = ""
                    if cell_type == "s" and value_node is not None and value_node.text:
                        idx = int(value_node.text)
                        value = shared_strings[idx] if idx < len(shared_strings) else ""
                    elif cell_type == "inlineStr" and inline_node is not None:
                        value = "".join(node.text or "" for node in inline_node.findall(".//a:t", ns))
                    elif value_node is not None:
                        value = maybe_number(value_node.text or "")
                    values[col_idx] = value
                if values:
                    width = max(values)
                    rows.append([values.get(i, "") for i in range(1, width + 1)])
            sheets[name] = rows
    return sheets


def rows_to_dicts(rows: list[list[Any]], header_row: int = 0, data_start: int | None = None) -> list[dict[str, Any]]:
    if not rows:
        return []
    headers = [str(h).strip() for h in rows[header_row]]
    start = header_row + 1 if data_start is None else data_start
    out = []
    for row in rows[start:]:
        if not any(str(v).strip() for v in row):
            continue
        item = {headers[i]: row[i] if i < len(row) else "" for i in range(len(headers))}
        out.append(item)
    return out


def load_source() -> dict[str, Any]:
    sheets = read_xlsx_values(SOURCE_WORKBOOK)
    scores_rows = sheets["Scores_10pt"]
    score_headers = [str(v) for v in scores_rows[0]]
    criteria = score_headers[1:10]
    weights = {criterion: float(scores_rows[1][idx + 1]) for idx, criterion in enumerate(criteria)}

    human_scores: dict[tuple[str, str], float] = {}
    for row in scores_rows[2:]:
        if not row:
            continue
        framework = str(row[0])
        if framework not in EXPECTED_FRAMEWORKS:
            continue
        for idx, criterion in enumerate(criteria):
            score = as_float(row[idx + 1] if idx + 1 < len(row) else "")
            if score is not None:
                human_scores[(framework, criterion)] = score

    rubric_rows = rows_to_dicts(sheets["Rubric_10pt"])
    rubric = {row["Criterion"]: row for row in rubric_rows}
    registry_rows = rows_to_dicts(sheets["Framework_Registry"])
    registry = {row["Framework"]: row for row in registry_rows}
    definitions_rows = rows_to_dicts(sheets["Criteria_Definitions"])
    definitions = {row["Criterion"]: row for row in definitions_rows}
    evidence_rows = rows_to_dicts(sheets["Framework_Criteria_Evidence"])

    packets: list[dict[str, Any]] = []
    for framework in EXPECTED_FRAMEWORKS:
        for criterion in criteria:
            rub = rubric.get(criterion, {})
            subdimensions = [rub.get(f"Subdimension {i}", "") for i in range(1, 6)]
            evidence = [
                {
                    "evidence_summary": row.get("Evidence_Summary", ""),
                    "evidence_detail": row.get("Evidence_Detail", ""),
                    "source_title": row.get("Source_Title", ""),
                    "source_url": row.get("Source_URL", ""),
                    "source_year": row.get("Source_Year", ""),
                    "evidence_strength": row.get("Evidence_Strength", ""),
                }
                for row in evidence_rows
                if row.get("Framework") == framework and row.get("Criterion") == criterion
            ]
            packets.append(
                {
                    "packet_id": packet_id(framework, criterion),
                    "framework": framework,
                    "criterion": criterion,
                    "criterion_definition": {
                        "working_definition": definitions.get(criterion, {}).get("Working_Definition", ""),
                        "rationale": definitions.get(criterion, {}).get("Rationale", ""),
                        "health_ai_relevance": definitions.get(criterion, {}).get("Health_AI_Relevance", ""),
                        "key_method_papers": definitions.get(criterion, {}).get("Key_Method_Papers", ""),
                    },
                    "rubric": {
                        "subdimensions": subdimensions,
                        "anchor": rub.get("Anchor", ""),
                    },
                    "framework_context": {
                        "official_name": registry.get(framework, {}).get("Official_Name", framework),
                        "primary_positioning": registry.get(framework, {}).get("Primary_Positioning", ""),
                        "official_repo_url": registry.get(framework, {}).get("Official_Repo_URL", ""),
                        "official_docs_url": registry.get(framework, {}).get("Official_Docs_URL", ""),
                        "maintainer": registry.get(framework, {}).get("Organization_or_Maintainer", ""),
                        "core_scholarly_anchor": registry.get(framework, {}).get("Core_Scholarly_Anchor", ""),
                        "health_ai_relevance_notes": registry.get(framework, {}).get("Health_AI_Relevance_Notes", ""),
                        "selection_rationale": registry.get(framework, {}).get("Selection_Rationale", ""),
                    },
                    "evidence": evidence,
                }
            )

    return {
        "sheets": sheets,
        "criteria": criteria,
        "weights": weights,
        "human_scores": human_scores,
        "packets": packets,
    }


SYSTEM_PROMPT = (
    "You are an evidence-locked assistive coder for a biomedical informatics paper. "
    "Use only the evidence included in the prompt. Do not browse, infer from outside "
    "knowledge, or use memory of the framework beyond the supplied text. Return only "
    "valid JSON matching the requested schema."
)


PROMPT_TEMPLATE = """\
Task: Score one federated learning framework against one evaluation criterion for a health AI methods paper.

Rules:
- Use only the evidence packet below.
- Do not use external knowledge or web search.
- Score each of the five subdimensions as 0 absent/not documented, 1 partial/limited, or 2 explicit/strong.
- Sum the five subdimension scores to produce criterion_score from 0 to 10.
- Compute band from criterion_score: 0-4 limited, 5-6 partial, 7-10 full.
- If evidence is ambiguous, score conservatively and explain the ambiguity.

Return exactly this JSON shape:
{{
  "framework": "...",
  "criterion": "...",
  "subdimension_scores": [
    {{"name": "...", "score": 0, "rationale": "...", "evidence_refs": ["..."]}},
    {{"name": "...", "score": 0, "rationale": "...", "evidence_refs": ["..."]}},
    {{"name": "...", "score": 0, "rationale": "...", "evidence_refs": ["..."]}},
    {{"name": "...", "score": 0, "rationale": "...", "evidence_refs": ["..."]}},
    {{"name": "...", "score": 0, "rationale": "...", "evidence_refs": ["..."]}}
  ],
  "criterion_score": 0,
  "band": "limited",
  "confidence": "low",
  "key_evidence_summary": "...",
  "limitations_or_ambiguity": "..."
}}

Evidence packet:
{packet_json}
"""


def make_prompt(packet: dict[str, Any]) -> str:
    packet_json = json.dumps(packet, ensure_ascii=False, indent=2)
    return PROMPT_TEMPLATE.format(packet_json=packet_json)


def ensure_dirs() -> None:
    for path in [ARTIFACT_DIR, PROMPT_DIR, RAW_DIR, NORMALIZED_DIR]:
        path.mkdir(parents=True, exist_ok=True)
    for rater in EXPECTED_RATERS:
        (RAW_DIR / rater).mkdir(parents=True, exist_ok=True)


def prepare() -> dict[str, Any]:
    ensure_dirs()
    source = load_source()
    packets = source["packets"]
    (ARTIFACT_DIR / "evidence_packets.json").write_text(json.dumps(packets, ensure_ascii=False, indent=2), "utf-8")
    (ARTIFACT_DIR / "prompt_template.txt").write_text(PROMPT_TEMPLATE, "utf-8")
    for packet in packets:
        (PROMPT_DIR / f"{packet['packet_id']}.txt").write_text(make_prompt(packet), "utf-8")

    manifest = {
        "created_at": now_iso(),
        "source_workbook": str(SOURCE_WORKBOOK),
        "output_workbook": str(OUTPUT_WORKBOOK),
        "framework_count": len(EXPECTED_FRAMEWORKS),
        "criterion_count": len(source["criteria"]),
        "expected_packets": len(EXPECTED_FRAMEWORKS) * len(source["criteria"]),
        "actual_packets": len(packets),
        "expected_llm_ratings": len(packets) * len(EXPECTED_RATERS),
        "gpt_model_default": DEFAULT_GPT_MODEL,
        "claude_model_default": DEFAULT_CLAUDE_MODEL,
        "api_keys_present": {
            "OPENAI_API_KEY": bool(os.environ.get("OPENAI_API_KEY")),
            "ANTHROPIC_API_KEY": bool(os.environ.get("ANTHROPIC_API_KEY")),
        },
        "prompt_leakage_controls": [
            "Human score, band, rank, and weighted overall columns are excluded from evidence packets.",
            "Framework_Criteria_Coding and Score_Justifications are not included in prompts.",
            "Prompts instruct models to use only supplied evidence and no web search.",
        ],
    }
    (ARTIFACT_DIR / "run_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
    return source


def load_packets() -> list[dict[str, Any]]:
    path = ARTIFACT_DIR / "evidence_packets.json"
    if not path.exists():
        return prepare()["packets"]
    return json.loads(path.read_text("utf-8"))


def extract_openai_text(response: dict[str, Any]) -> str:
    if isinstance(response.get("output_text"), str):
        return response["output_text"]
    parts: list[str] = []
    for item in response.get("output", []):
        for content in item.get("content", []):
            text = content.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts)


def post_json(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: int = 120) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {body}") from exc


def call_gpt(prompt: str, model: str, temperature: float) -> tuple[dict[str, Any], str]:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    payload: dict[str, Any] = {
        "model": model,
        "input": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "temperature": temperature,
        "text": {"format": {"type": "json_object"}},
    }
    response = post_json(
        "https://api.openai.com/v1/responses",
        {"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        payload,
    )
    return response, extract_openai_text(response)


def call_claude(prompt: str, model: str, temperature: float) -> tuple[dict[str, Any], str]:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    payload: dict[str, Any] = {
        "model": model,
        "max_tokens": 2400,
        "temperature": temperature,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": prompt}],
    }
    response = post_json(
        "https://api.anthropic.com/v1/messages",
        {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        payload,
    )
    text = "\n".join(part.get("text", "") for part in response.get("content", []) if part.get("type") == "text")
    return response, text


def parse_json_response(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?", "", stripped).strip()
        stripped = re.sub(r"```$", "", stripped).strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("No JSON object found in response text")
    return json.loads(stripped[start : end + 1])


def normalize_response(
    rater: str,
    packet: dict[str, Any],
    raw_text: str,
    model: str,
    run_timestamp: str,
) -> dict[str, Any]:
    parsed = parse_json_response(raw_text)
    expected_subdimensions = packet["rubric"]["subdimensions"]
    given_subdimensions = parsed.get("subdimension_scores", [])
    if not isinstance(given_subdimensions, list):
        raise ValueError("subdimension_scores is not a list")

    normalized_subdimensions = []
    validation_notes = []
    for idx, expected_name in enumerate(expected_subdimensions):
        item = given_subdimensions[idx] if idx < len(given_subdimensions) and isinstance(given_subdimensions[idx], dict) else {}
        score = item.get("score", 0)
        try:
            score_int = int(score)
        except (TypeError, ValueError):
            score_int = 0
            validation_notes.append(f"subdimension {idx + 1} non-integer score coerced to 0")
        if score_int < 0 or score_int > 2:
            validation_notes.append(f"subdimension {idx + 1} out-of-range score coerced")
            score_int = max(0, min(2, score_int))
        normalized_subdimensions.append(
            {
                "name": expected_name,
                "score": score_int,
                "rationale": str(item.get("rationale", "")),
                "evidence_refs": item.get("evidence_refs", []),
            }
        )
    criterion_score = sum(item["score"] for item in normalized_subdimensions)
    return {
        "rater": rater,
        "model": model,
        "run_timestamp": run_timestamp,
        "packet_id": packet["packet_id"],
        "framework": packet["framework"],
        "criterion": packet["criterion"],
        "subdimension_scores": normalized_subdimensions,
        "criterion_score": criterion_score,
        "band": band_for_score(criterion_score),
        "confidence": str(parsed.get("confidence", "")),
        "key_evidence_summary": str(parsed.get("key_evidence_summary", "")),
        "limitations_or_ambiguity": str(parsed.get("limitations_or_ambiguity", "")),
        "validation_status": "valid" if not validation_notes else "valid_with_coercion",
        "validation_notes": "; ".join(validation_notes),
    }


def load_normalized(rater: str) -> list[dict[str, Any]]:
    path = NORMALIZED_DIR / f"{rater}.json"
    if not path.exists():
        return []
    return json.loads(path.read_text("utf-8"))


def write_normalized(rater: str, rows: list[dict[str, Any]]) -> None:
    path = NORMALIZED_DIR / f"{rater}.json"
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), "utf-8")


def run_api(raters: list[str], limit: int | None, force: bool, temperature: float) -> None:
    ensure_dirs()
    packets = load_packets()
    for rater in raters:
        model = DEFAULT_GPT_MODEL if rater == "gpt" else DEFAULT_CLAUDE_MODEL
        if rater == "gpt" and not os.environ.get("OPENAI_API_KEY"):
            print("Skipping GPT run: OPENAI_API_KEY is not set", file=sys.stderr)
            continue
        if rater == "claude" and not os.environ.get("ANTHROPIC_API_KEY"):
            print("Skipping Claude run: ANTHROPIC_API_KEY is not set", file=sys.stderr)
            continue

        existing = [] if force else load_normalized(rater)
        existing_ids = {row["packet_id"] for row in existing}
        to_run = [packet for packet in packets if force or packet["packet_id"] not in existing_ids]
        if limit is not None:
            to_run = to_run[:limit]

        rows = [] if force else existing
        for idx, packet in enumerate(to_run, start=1):
            prompt = make_prompt(packet)
            timestamp = now_iso()
            try:
                if rater == "gpt":
                    response_json, response_text = call_gpt(prompt, model, temperature)
                else:
                    response_json, response_text = call_claude(prompt, model, temperature)
                normalized = normalize_response(rater, packet, response_text, model, timestamp)
                status = "ok"
            except Exception as exc:  # noqa: BLE001 - captured for audit trail
                response_json = {"error": str(exc)}
                response_text = ""
                normalized = {
                    "rater": rater,
                    "model": model,
                    "run_timestamp": timestamp,
                    "packet_id": packet["packet_id"],
                    "framework": packet["framework"],
                    "criterion": packet["criterion"],
                    "criterion_score": "",
                    "band": "",
                    "validation_status": "failed",
                    "validation_notes": str(exc),
                }
                status = "failed"
            raw_record = {
                "rater": rater,
                "model": model,
                "run_timestamp": timestamp,
                "packet_id": packet["packet_id"],
                "framework": packet["framework"],
                "criterion": packet["criterion"],
                "temperature": temperature,
                "status": status,
                "prompt": prompt,
                "response_text": response_text,
                "response_json": response_json,
            }
            (RAW_DIR / rater / f"{packet['packet_id']}.json").write_text(
                json.dumps(raw_record, ensure_ascii=False, indent=2),
                "utf-8",
            )
            rows.append(normalized)
            write_normalized(rater, rows)
            print(f"{rater}: {idx}/{len(to_run)} {packet['framework']} | {packet['criterion']} -> {status}")


def normalized_lookup() -> dict[str, dict[tuple[str, str], dict[str, Any]]]:
    out: dict[str, dict[tuple[str, str], dict[str, Any]]] = {}
    for rater in EXPECTED_RATERS:
        rows = load_normalized(rater)
        out[rater] = {(row.get("framework", ""), row.get("criterion", "")): row for row in rows}
    return out


def evaluation_rows(rater: str, source: dict[str, Any]) -> list[list[Any]]:
    lookup = normalized_lookup()[rater]
    missing_key = "OPENAI_API_KEY" if rater == "gpt" else "ANTHROPIC_API_KEY"
    status = f"pending_missing_{missing_key}" if not os.environ.get(missing_key) else "pending_not_run"
    rows = [
        [
            "Framework",
            "Criterion",
            "Subdimension 1",
            "Subdimension 2",
            "Subdimension 3",
            "Subdimension 4",
            "Subdimension 5",
            "Criterion Score",
            "Band",
            "Confidence",
            "Key Evidence Summary",
            "Limitations or Ambiguity",
            "Validation Status",
            "Validation Notes",
            "Model",
            "Run Timestamp",
            "Packet ID",
        ]
    ]
    for packet in source["packets"]:
        record = lookup.get((packet["framework"], packet["criterion"]))
        if record and record.get("validation_status") != "failed":
            subs = record.get("subdimension_scores", [])
            sub_scores = [subs[i].get("score", "") if i < len(subs) else "" for i in range(5)]
            rows.append(
                [
                    packet["framework"],
                    packet["criterion"],
                    *sub_scores,
                    record.get("criterion_score", ""),
                    record.get("band", ""),
                    record.get("confidence", ""),
                    record.get("key_evidence_summary", ""),
                    record.get("limitations_or_ambiguity", ""),
                    record.get("validation_status", ""),
                    record.get("validation_notes", ""),
                    record.get("model", ""),
                    record.get("run_timestamp", ""),
                    packet["packet_id"],
                ]
            )
        else:
            validation = record.get("validation_status", status) if record else status
            notes = record.get("validation_notes", "") if record else ""
            rows.append([packet["framework"], packet["criterion"], "", "", "", "", "", "", "", "", "", "", validation, notes, "", "", packet["packet_id"]])
    return rows


def build_comparison(source: dict[str, Any]) -> tuple[list[list[Any]], list[list[Any]], list[list[Any]], list[list[Any]]]:
    lookups = normalized_lookup()
    human_scores = source["human_scores"]
    criteria = source["criteria"]
    weights = source["weights"]

    comparison = [
        [
            "Framework",
            "Criterion",
            "Human Score",
            "Human Band",
            "GPT Score",
            "GPT Band",
            "Claude Score",
            "Claude Band",
            "Abs Diff Human-GPT",
            "Abs Diff Human-Claude",
            "Abs Diff GPT-Claude",
            "Band Disagreement",
            "Adjudication Flag",
            "Status",
        ]
    ]
    adjudication = [
        [
            "Framework",
            "Criterion",
            "Reason",
            "Human Score",
            "GPT Score",
            "Claude Score",
            "Adjudicated Score",
            "Adjudicated Band",
            "Decision Note",
        ]
    ]

    for framework in EXPECTED_FRAMEWORKS:
        for criterion in criteria:
            human_score = human_scores.get((framework, criterion))
            human_band = band_for_score(human_score)
            gpt = lookups["gpt"].get((framework, criterion), {})
            claude = lookups["claude"].get((framework, criterion), {})
            gpt_score = as_float(gpt.get("criterion_score"))
            claude_score = as_float(claude.get("criterion_score"))
            gpt_band = band_for_score(gpt_score)
            claude_band = band_for_score(claude_score)
            diff_hg = abs(human_score - gpt_score) if human_score is not None and gpt_score is not None else ""
            diff_hc = abs(human_score - claude_score) if human_score is not None and claude_score is not None else ""
            diff_gc = abs(gpt_score - claude_score) if gpt_score is not None and claude_score is not None else ""
            band_disagreement = any(
                [
                    bool(gpt_band and human_band and gpt_band != human_band),
                    bool(claude_band and human_band and claude_band != human_band),
                    bool(gpt_band and claude_band and gpt_band != claude_band),
                ]
            )
            score_flag = any(diff != "" and diff >= 3 for diff in [diff_hg, diff_hc, diff_gc])
            missing_llm = gpt_score is None or claude_score is None
            flag = bool(score_flag or band_disagreement)
            status = "pending_llm_run" if missing_llm else ("requires_adjudication" if flag else "agreement_ok")
            reason_parts = []
            if score_flag:
                reason_parts.append("score difference >= 3")
            if band_disagreement:
                reason_parts.append("band disagreement")
            if missing_llm:
                reason_parts.append("pending LLM rating")
            comparison.append(
                [
                    framework,
                    criterion,
                    human_score if human_score is not None else "",
                    human_band,
                    gpt_score if gpt_score is not None else "",
                    gpt_band,
                    claude_score if claude_score is not None else "",
                    claude_band,
                    diff_hg,
                    diff_hc,
                    diff_gc,
                    "yes" if band_disagreement else "no",
                    "yes" if flag else "no",
                    status,
                ]
            )
            if flag or missing_llm:
                adjudication.append(
                    [
                        framework,
                        criterion,
                        "; ".join(reason_parts),
                        human_score if human_score is not None else "",
                        gpt_score if gpt_score is not None else "",
                        claude_score if claude_score is not None else "",
                        human_score if human_score is not None else "",
                        human_band,
                        "Uses human baseline until GPT and Claude ratings are complete and adjudicated.",
                    ]
                )

    adjudicated = [["Framework", *criteria, "Weighted overall (0-100)", "Rank", "Status"]]
    scored: list[tuple[str, float, list[Any]]] = []
    for framework in EXPECTED_FRAMEWORKS:
        values = [human_scores.get((framework, criterion), "") for criterion in criteria]
        weighted_total = 0.0
        for criterion, value in zip(criteria, values):
            numeric = as_float(value) or 0.0
            weighted_total += numeric * weights[criterion]
        weighted_score = round(weighted_total / 10.0, 1)
        row = [framework, *values, weighted_score, "", "human_baseline_pending_llm_adjudication"]
        scored.append((framework, weighted_score, row))
    for rank, (_, _, row) in enumerate(sorted(scored, key=lambda item: item[1], reverse=True), start=1):
        row[-2] = rank
        adjudicated.append(row)

    summary = [
        ["Metric", "Human-GPT", "Human-Claude", "GPT-Claude"],
    ]
    pair_defs = [
        ("Human-GPT", 8, 5),
        ("Human-Claude", 9, 7),
        ("GPT-Claude", 10, 7),
    ]
    metric_values: dict[str, dict[str, Any]] = {}
    body = comparison[1:]
    for label, diff_idx, band_idx in pair_defs:
        diffs = [as_float(row[diff_idx]) for row in body if as_float(row[diff_idx]) is not None]
        metric_values[label] = {
            "completed_pairs": len(diffs),
            "mean_abs_diff": round(sum(diffs) / len(diffs), 3) if diffs else "",
        }
    summary.append(["Completed criterion pairs", metric_values["Human-GPT"]["completed_pairs"], metric_values["Human-Claude"]["completed_pairs"], metric_values["GPT-Claude"]["completed_pairs"]])
    summary.append(["Mean absolute difference", metric_values["Human-GPT"]["mean_abs_diff"], metric_values["Human-Claude"]["mean_abs_diff"], metric_values["GPT-Claude"]["mean_abs_diff"]])
    summary.append(["Band disagreement rows", sum(1 for row in body if row[11] == "yes"), "", ""])
    summary.append(["Adjudication flags", sum(1 for row in body if row[12] == "yes"), "", ""])
    summary.append(["Pending LLM rows", sum(1 for row in body if row[13] == "pending_llm_run"), "", ""])
    return comparison, adjudication, adjudicated, summary


def metadata_rows(source: dict[str, Any]) -> list[list[Any]]:
    lookups = normalized_lookup()
    gpt_count = len([row for row in lookups["gpt"].values() if row.get("validation_status") in ("valid", "valid_with_coercion")])
    claude_count = len([row for row in lookups["claude"].values() if row.get("validation_status") in ("valid", "valid_with_coercion")])
    expected = len(source["packets"])
    return [
        ["Field", "Value"],
        ["Generated at", now_iso()],
        ["Source workbook", SOURCE_WORKBOOK.name],
        ["Derived workbook", OUTPUT_WORKBOOK.name],
        ["Evaluation mode", "evidence-locked; no web refresh"],
        ["Rater framing", "LLMs are assistive coders; human adjudication remains authoritative"],
        ["Framework count", len(EXPECTED_FRAMEWORKS)],
        ["Criterion count", len(source["criteria"])],
        ["Expected criterion ratings per LLM", expected],
        ["Expected total LLM ratings", expected * 2],
        ["Completed GPT ratings", gpt_count],
        ["Completed Claude ratings", claude_count],
        ["GPT model", DEFAULT_GPT_MODEL],
        ["Claude model", DEFAULT_CLAUDE_MODEL],
        ["OPENAI_API_KEY present", "yes" if os.environ.get("OPENAI_API_KEY") else "no"],
        ["ANTHROPIC_API_KEY present", "yes" if os.environ.get("ANTHROPIC_API_KEY") else "no"],
        ["Prompt leakage control", "Human scores, bands, ranks, weighted totals, Score_Justifications, and coding values are excluded from prompts"],
        ["Adjudication rule", "Flag any model-human score difference >= 3 or any band disagreement"],
    ]


def prompt_template_rows() -> list[list[Any]]:
    lines = textwrap.dedent(PROMPT_TEMPLATE).splitlines()
    return [["Line", "Prompt Template"], *[[idx, line] for idx, line in enumerate(lines, start=1)]]


def xml_text(parent: ET.Element, tag: str, text: str | None = None, attrib: dict[str, str] | None = None) -> ET.Element:
    child = ET.SubElement(parent, tag, attrib or {})
    if text is not None:
        child.text = text
    return child


def make_styles_xml() -> bytes:
    xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF305496"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>
"""
    return xml.encode("utf-8")


def sheet_xml(rows: list[list[Any]]) -> bytes:
    ET.register_namespace("", SPREADSHEET_NS)
    root = ET.Element(f"{{{SPREADSHEET_NS}}}worksheet")
    views = ET.SubElement(root, f"{{{SPREADSHEET_NS}}}sheetViews")
    view = ET.SubElement(views, f"{{{SPREADSHEET_NS}}}sheetView", {"workbookViewId": "0"})
    ET.SubElement(view, f"{{{SPREADSHEET_NS}}}pane", {"ySplit": "1", "topLeftCell": "A2", "activePane": "bottomLeft", "state": "frozen"})
    ET.SubElement(view, f"{{{SPREADSHEET_NS}}}selection", {"pane": "bottomLeft"})

    max_cols = max((len(row) for row in rows), default=1)
    cols = ET.SubElement(root, f"{{{SPREADSHEET_NS}}}cols")
    for col_idx in range(1, max_cols + 1):
        max_len = 10
        for row in rows[:250]:
            if col_idx - 1 < len(row):
                max_len = max(max_len, len(str(row[col_idx - 1])) + 2)
        width = min(max(max_len, 10), 60)
        ET.SubElement(cols, f"{{{SPREADSHEET_NS}}}col", {"min": str(col_idx), "max": str(col_idx), "width": str(width), "customWidth": "1"})

    sheet_data = ET.SubElement(root, f"{{{SPREADSHEET_NS}}}sheetData")
    for r_idx, row in enumerate(rows, start=1):
        row_el = ET.SubElement(sheet_data, f"{{{SPREADSHEET_NS}}}row", {"r": str(r_idx)})
        for c_idx, value in enumerate(row, start=1):
            if value in (None, ""):
                continue
            ref = f"{int_to_col(c_idx)}{r_idx}"
            attrib = {"r": ref}
            if r_idx == 1:
                attrib["s"] = "1"
            if isinstance(value, bool):
                cell = ET.SubElement(row_el, f"{{{SPREADSHEET_NS}}}c", {**attrib, "t": "b"})
                ET.SubElement(cell, f"{{{SPREADSHEET_NS}}}v").text = "1" if value else "0"
            elif isinstance(value, (int, float)):
                cell = ET.SubElement(row_el, f"{{{SPREADSHEET_NS}}}c", attrib)
                ET.SubElement(cell, f"{{{SPREADSHEET_NS}}}v").text = str(value)
            else:
                cell = ET.SubElement(row_el, f"{{{SPREADSHEET_NS}}}c", {**attrib, "t": "inlineStr"})
                inline = ET.SubElement(cell, f"{{{SPREADSHEET_NS}}}is")
                text = ET.SubElement(inline, f"{{{SPREADSHEET_NS}}}t")
                text.text = str(value)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def write_xlsx(path: Path, sheets: list[tuple[str, list[list[Any]]]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        overrides = [
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
            '<Default Extension="xml" ContentType="application/xml"/>',
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
            '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
            '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
        ]
        for idx, _ in enumerate(sheets, start=1):
            overrides.append(f'<Override PartName="/xl/worksheets/sheet{idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
        zf.writestr("[Content_Types].xml", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">{"".join(overrides)}</Types>')
        zf.writestr("_rels/.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>""")
        workbook_sheets = []
        workbook_rels = []
        for idx, (name, _) in enumerate(sheets, start=1):
            safe_name = name[:31]
            workbook_sheets.append(f'<sheet name="{escape_xml_attr(safe_name)}" sheetId="{idx}" r:id="rId{idx}"/>')
            workbook_rels.append(f'<Relationship Id="rId{idx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{idx}.xml"/>')
        workbook_rels.append(f'<Relationship Id="rId{len(sheets) + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>')
        zf.writestr("xl/workbook.xml", f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="{SPREADSHEET_NS}" xmlns:r="{OFFICE_REL_NS}">
  <sheets>{''.join(workbook_sheets)}</sheets>
</workbook>""")
        zf.writestr("xl/_rels/workbook.xml.rels", f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{''.join(workbook_rels)}</Relationships>""")
        zf.writestr("xl/styles.xml", make_styles_xml())
        zf.writestr("docProps/core.xml", f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Fedlify FL Framework LLM Evaluation</dc:title>
  <dc:creator>Fedlify analysis pipeline</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">{now_iso()}</dcterms:created>
</cp:coreProperties>""")
        zf.writestr("docProps/app.xml", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Fedlify analysis pipeline</Application>
</Properties>""")
        for idx, (_, rows) in enumerate(sheets, start=1):
            zf.writestr(f"xl/worksheets/sheet{idx}.xml", sheet_xml(rows))


def escape_xml_attr(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def build_workbook() -> dict[str, Any]:
    source = prepare()
    original_order = [
        "Scores_10pt",
        "Score_Justifications",
        "Evidence_Log",
        "Rubric_10pt",
        "Framework_Registry",
        "Criteria_Definitions",
        "Framework_Criteria_Evidence",
        "Framework_Criteria_Coding",
        "Literature_Support_for_Methods",
    ]
    comparison, adjudication, adjudicated, summary = build_comparison(source)
    sheets: list[tuple[str, list[list[Any]]]] = [(name, source["sheets"][name]) for name in original_order if name in source["sheets"]]
    sheets.extend(
        [
            ("LLM_Run_Metadata", metadata_rows(source)),
            ("LLM_Prompt_Template", prompt_template_rows()),
            ("GPT_Evaluations", evaluation_rows("gpt", source)),
            ("Claude_Evaluations", evaluation_rows("claude", source)),
            ("Rater_Comparison", comparison),
            ("Adjudication_Log", adjudication),
            ("Adjudicated_Scores", adjudicated),
            ("Agreement_Summary", summary),
        ]
    )
    write_xlsx(OUTPUT_WORKBOOK, sheets)
    return {"source": source, "sheets_written": [name for name, _ in sheets]}


def verify() -> dict[str, Any]:
    source = load_source()
    if not (ARTIFACT_DIR / "evidence_packets.json").exists():
        prepare()
    packets = json.loads((ARTIFACT_DIR / "evidence_packets.json").read_text("utf-8"))
    prompt_files = list(PROMPT_DIR.glob("*.txt"))
    bad_prompt_terms = ["Scores_10pt", "Score_Justifications", "Weighted overall", '"Rank"', "Coding_Value", "Score (0-10)"]
    leakage_hits = []
    for prompt_file in prompt_files:
        text = prompt_file.read_text("utf-8")
        for term in bad_prompt_terms:
            if term in text:
                leakage_hits.append(f"{prompt_file.name}: {term}")
    lookups = normalized_lookup()
    gpt_valid = len([row for row in lookups["gpt"].values() if row.get("validation_status") in ("valid", "valid_with_coercion")])
    claude_valid = len([row for row in lookups["claude"].values() if row.get("validation_status") in ("valid", "valid_with_coercion")])
    expected = len(EXPECTED_FRAMEWORKS) * len(source["criteria"])
    workbook_ok = OUTPUT_WORKBOOK.exists()
    formula_error_hits = []
    if workbook_ok:
        with zipfile.ZipFile(OUTPUT_WORKBOOK) as zf:
            for name in zf.namelist():
                if name.endswith(".xml"):
                    text = zf.read(name).decode("utf-8", errors="ignore")
                    for token in ["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A"]:
                        if token in text:
                            formula_error_hits.append(f"{name}: {token}")

    report = {
        "verified_at": now_iso(),
        "source_workbook_exists": SOURCE_WORKBOOK.exists(),
        "derived_workbook_exists": workbook_ok,
        "expected_packets": expected,
        "actual_packets": len(packets),
        "prompt_files": len(prompt_files),
        "prompt_leakage_hits": leakage_hits,
        "gpt_valid_ratings": gpt_valid,
        "claude_valid_ratings": claude_valid,
        "expected_valid_ratings_per_llm": expected,
        "total_valid_llm_ratings": gpt_valid + claude_valid,
        "expected_total_llm_ratings": expected * 2,
        "formula_error_hits": formula_error_hits,
        "status": "complete" if gpt_valid == expected and claude_valid == expected and not leakage_hits and not formula_error_hits else "warning",
        "warning": "LLM API ratings are incomplete when API keys are missing or runs have not completed.",
    }
    (ARTIFACT_DIR / "verification_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
    markdown = [
        "# Fedlify LLM Evaluation Verification",
        "",
        f"- Verified at: {report['verified_at']}",
        f"- Evidence packets: {report['actual_packets']} / {report['expected_packets']}",
        f"- Prompt files: {report['prompt_files']}",
        f"- GPT valid ratings: {report['gpt_valid_ratings']} / {report['expected_valid_ratings_per_llm']}",
        f"- Claude valid ratings: {report['claude_valid_ratings']} / {report['expected_valid_ratings_per_llm']}",
        f"- Prompt leakage hits: {len(leakage_hits)}",
        f"- Formula error hits: {len(formula_error_hits)}",
        f"- Status: {report['status']}",
    ]
    if leakage_hits:
        markdown.extend(["", "## Prompt Leakage Hits", *[f"- {hit}" for hit in leakage_hits]])
    if formula_error_hits:
        markdown.extend(["", "## Formula Error Hits", *[f"- {hit}" for hit in formula_error_hits]])
    (ARTIFACT_DIR / "verification_report.md").write_text("\n".join(markdown) + "\n", "utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Fedlify evidence-locked LLM framework evaluation workflow")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("prepare", help="Extract evidence packets and shared prompts")
    run_parser = sub.add_parser("run", help="Call configured LLM APIs and normalize responses")
    run_parser.add_argument("--rater", choices=["gpt", "claude", "both"], default="both")
    run_parser.add_argument("--limit", type=int, default=None)
    run_parser.add_argument("--force", action="store_true")
    run_parser.add_argument("--temperature", type=float, default=0.0)
    sub.add_parser("build-workbook", help="Write derived workbook")
    sub.add_parser("verify", help="Verify packets, leakage controls, ratings, and workbook")
    sub.add_parser("all", help="Prepare, run APIs if keys are present, build workbook, and verify")
    args = parser.parse_args()

    command = args.command or "all"
    if command == "prepare":
        prepare()
    elif command == "run":
        raters = list(EXPECTED_RATERS) if args.rater == "both" else [args.rater]
        run_api(raters, args.limit, args.force, args.temperature)
    elif command == "build-workbook":
        build_workbook()
    elif command == "verify":
        report = verify()
        print(json.dumps(report, indent=2))
    elif command == "all":
        prepare()
        raters = []
        if os.environ.get("OPENAI_API_KEY"):
            raters.append("gpt")
        if os.environ.get("ANTHROPIC_API_KEY"):
            raters.append("claude")
        if raters:
            run_api(raters, None, False, 0.0)
        else:
            print("No API keys found; generated prompts and pending workbook sheets without LLM ratings.", file=sys.stderr)
        build_workbook()
        report = verify()
        print(json.dumps(report, indent=2))
    else:
        parser.error(f"Unknown command: {command}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
