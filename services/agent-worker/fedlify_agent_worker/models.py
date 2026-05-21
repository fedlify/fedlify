from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Participant:
    code: str
    institution_name: str
    nvflare_client_name: str


@dataclass(frozen=True)
class KitRequest:
    study_id: str
    agent_run_id: str
    title: str
    need: str
    participants: list[Participant] = field(default_factory=list)
    central_sandbox_enabled: bool = True

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "KitRequest":
        participants = [
            Participant(
                code=str(item["code"]),
                institution_name=str(item.get("institutionName") or item.get("institution_name") or item["code"]),
                nvflare_client_name=str(item.get("nvflareClientName") or item.get("nvflare_client_name") or item["code"]),
            )
            for item in payload.get("participants", [])
        ]
        return cls(
            study_id=str(payload["studyId"]),
            agent_run_id=str(payload["agentRunId"]),
            title=str(payload["title"]),
            need=str(payload["need"]),
            participants=participants,
            central_sandbox_enabled=bool(payload.get("centralSandboxEnabled", True)),
        )
