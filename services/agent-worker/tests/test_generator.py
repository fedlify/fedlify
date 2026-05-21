from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fedlify_agent_worker.generator import FedlifyKitGenerator
from fedlify_agent_worker.models import KitRequest, Participant


class GeneratorTests(unittest.TestCase):
    def test_generates_signed_kits(self) -> None:
        request = KitRequest(
            study_id="study_1",
            agent_run_id="agent_1",
            title="Cardiology model",
            need="Train a cross-silo model without moving source data.",
            participants=[
                Participant(code="uhn", institution_name="UHN", nvflare_client_name="site-uhn"),
                Participant(code="sickkids", institution_name="SickKids", nvflare_client_name="site-sickkids"),
            ],
        )

        with tempfile.TemporaryDirectory() as tmp:
            manifest = FedlifyKitGenerator(Path(tmp)).generate(request)
            artifact_names = {artifact["filename"] for artifact in manifest["artifacts"]}

            self.assertEqual(manifest["framework"], "nvflare")
            self.assertIn("server-kit.zip", artifact_names)
            self.assertIn("uhn-site-kit.zip", artifact_names)
            self.assertIn("sickkids-site-kit.zip", artifact_names)
            self.assertIn("signature", manifest)
            self.assertTrue((Path(tmp) / "agent_1" / "project.yml").exists())


if __name__ == "__main__":
    unittest.main()
