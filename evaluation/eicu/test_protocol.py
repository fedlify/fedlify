import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from protocol import ALGORITHMS, build_protocol, validate_dataset


class ProtocolTests(unittest.TestCase):
    def test_frozen_dataset_matches_paper_cohort(self):
        path = Path(__file__).resolve().parents[3] / "eicu" / "GenAI-Multi-Site-Collaborative-Learning-2" / "data" / "eICU" / "heart_failure_data_v2.csv"
        summary = validate_dataset(path)
        self.assertEqual(13216, summary["training_rows"])
        self.assertEqual(1930, summary["external_validation_rows"])
        self.assertEqual(3600, summary["sites"]["420"]["stays"])

    def test_protocol_has_five_jobs_and_requires_approval(self):
        protocol = build_protocol({"dataset_sha256": "a" * 64})
        self.assertEqual(ALGORITHMS, [job["algorithm"] for job in protocol["jobs"]])
        self.assertEqual("DRAFT_REQUIRES_EXPERT_APPROVAL", protocol["status"])
        self.assertFalse(protocol["preprocessing"]["smote"])


if __name__ == "__main__":
    unittest.main()
