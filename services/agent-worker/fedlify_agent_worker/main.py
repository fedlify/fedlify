from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .generator import FedlifyKitGenerator
from .models import KitRequest


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Fedlify NVFLARE participant kits.")
    parser.add_argument("--input", required=True, help="Path to kit request JSON.")
    parser.add_argument("--output", required=True, help="Output workspace directory.")
    args = parser.parse_args()

    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    request = KitRequest.from_dict(payload)
    generator = FedlifyKitGenerator(
        output_dir=Path(args.output),
        require_nvflare=os.environ.get("FEDLIFY_REQUIRE_NVFLARE", "false").lower() == "true",
    )
    manifest = generator.generate(request)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
