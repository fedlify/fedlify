import csv
import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("run_probes.py")
SPEC = importlib.util.spec_from_file_location("run_probes", MODULE_PATH)
run_probes = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(run_probes)


class ProbeSuiteTests(unittest.TestCase):
    def test_frozen_suite_is_complete(self):
        root = Path(__file__).resolve().parents[3] / "probs"
        manifest, rows, fixture_hashes = run_probes.load_suite(root)
        summary = run_probes.validate_coverage(manifest, rows)
        self.assertEqual(144, len(rows))
        self.assertEqual(144, len(fixture_hashes))
        self.assertEqual(9, len(summary["category_counts"]))
        self.assertTrue(all(count == 16 for count in summary["category_counts"].values()))

    def test_refusal_at_wrong_layer_does_not_pass(self):
        row = {
            "Expected_Disposition": "POLICY_STOP", "Expected_Blocking_Layer": "policy/work-item",
            "Expected_Stop_Condition": "stop5", "Expected_State_Transition": "STOPPED",
            "Failure_If": "secret reaches agent", "Category": "Secrets"
        }
        result, critical, _ = run_probes.classify(row, {
            "disposition": "POLICY_STOP", "blockingLayer": "semantic verifier",
            "stopCondition": "stop5", "stateTransition": "STOPPED", "prohibitedPropagation": []
        })
        self.assertEqual("WRONG_LAYER", result)
        self.assertFalse(critical)

    def test_no_block_proceed_is_classified_as_not_blocked(self):
        row = {
            "Expected_Disposition": "POLICY_STOP", "Expected_Blocking_Layer": "Policy engine / work-item contract",
            "Expected_Stop_Condition": "1", "Expected_State_Transition": "STOPPED",
            "Failure_If": "patient data reaches evidence", "Category": "Sensitive input"
        }
        result, _, failures = run_probes.classify(row, {
            "disposition": "PROCEED_TO_DRAFT", "blockingLayer": "No block - proceed",
            "stopCondition": "None", "stateTransition": "CLASSIFIED", "prohibitedPropagation": []
        })
        self.assertEqual("NOT_BLOCKED", result)
        self.assertTrue(failures)

    def test_success_at_the_expected_export_stage_is_still_not_blocked(self):
        row = {
            "Expected_Disposition": "DET_REJECT", "Expected_Blocking_Layer": "Handoff exporter",
            "Expected_Stop_Condition": "6", "Expected_State_Transition": "STOPPED",
            "Failure_If": "secret is exported", "Category": "Runtime"
        }
        result, _, _ = run_probes.classify(row, {
            "disposition": "EXPORT", "blockingLayer": "Handoff exporter",
            "stopCondition": "None", "stateTransition": "EXPORTED", "prohibitedPropagation": []
        })
        self.assertEqual("NOT_BLOCKED", result)

    def test_authoritative_executor_does_not_load_oracle_fields(self):
        executor = Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e" / "live-probe-lifecycle.spec.ts"
        source = executor.read_text(encoding="utf-8")
        for forbidden in (
            "Expected_Blocking_Layer", "Expected_Disposition", "Expected_Stop_Condition",
            "Expected_State_Transition", "Deterministic_Pass_Criteria", "Failure_If", "scenarioLayer"
        ):
            self.assertNotIn(forbidden, source)
        self.assertIn("/intake", source)
        self.assertNotIn("/v1/probes/route", source)

    def test_product_code_has_no_probe_ids_or_fixture_names(self):
        """Guards the platform's authoritative decision code against being tuned to this
        benchmark instead of the general task. If a Probe_ID or fixture filename literal ever
        shows up in these files, that code is recognizing specific probes, not requests."""
        repo_root = Path(__file__).resolve().parents[3]
        suite_root = repo_root / "probs"
        with (suite_root / "Fedlify_Probe_Suite_144.csv").open(newline="", encoding="utf-8-sig") as source:
            rows = list(csv.DictReader(source))
        needles = set()
        for row in rows:
            needles.add(row["Probe_ID"])
            fixture_path = Path(row["Fixture_File"])
            needles.add(fixture_path.name)
            needles.add(fixture_path.stem)
        fedlify_root = repo_root / "fedlify"
        guarded_files = [
            fedlify_root / "apps" / "web" / "src" / "lib" / "control-intake.ts",
            fedlify_root / "apps" / "web" / "src" / "lib" / "control-enforcement.ts",
            fedlify_root / "apps" / "web" / "src" / "lib" / "control-intake-store.ts",
            fedlify_root / "apps" / "web" / "src" / "lib" / "control-plane.ts",
            fedlify_root / "apps" / "web" / "src" / "lib" / "orchestrator-client.ts",
        ]
        offenders = []
        for path in guarded_files:
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8")
            for needle in needles:
                if needle and needle in text:
                    offenders.append(f"{path.relative_to(repo_root)}: {needle!r}")
        self.assertEqual([], offenders, f"Product code references probe-suite literals: {offenders}")

    def test_infrastructure_failures_are_not_scored_as_probe_failures(self):
        row = {
            "Expected_Disposition": "POLICY_STOP", "Expected_Blocking_Layer": "Policy engine",
            "Expected_Stop_Condition": "1", "Expected_State_Transition": "STOPPED",
            "Failure_If": "escape", "Category": "Control"
        }
        result, critical, failures = run_probes.classify(row, {"infrastructureFailure": True})
        self.assertEqual("INFRA_FAILURE", result)
        self.assertFalse(critical)
        self.assertTrue(failures)


if __name__ == "__main__":
    unittest.main()
