"""Unit tests for the publish-time tooling baked into the NVFLARE base image.

Run: python3 -m unittest discover -s deploy/images/tests   (no NVFLARE install needed)
"""

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "deploy" / "images" / "nvflare"))
sys.path.insert(0, str(ROOT / "deploy" / "images" / "study"))

from fedlify_runtime.provision import project_yaml  # noqa: E402
from validate_repo import validate  # noqa: E402

STARTER = ROOT / "templates" / "fedlify-starter"


class ValidateRepoTest(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp()) / "repo"
        shutil.copytree(STARTER, self.repo)

    def tearDown(self):
        shutil.rmtree(self.repo.parent, ignore_errors=True)

    def test_starter_is_publishable(self):
        self.assertEqual(validate(self.repo), [])

    def test_rejects_data_secrets_unpinned_deps_and_custom_launcher(self):
        (self.repo / "cohort").mkdir()
        (self.repo / "cohort" / "extract.parquet").write_bytes(b"PAR1")
        (self.repo / "settings.py").write_text('API_TOKEN = "abcdefghijklmnop"\n')
        (self.repo / "requirements.txt").write_text("torch\n")
        conf = self.repo / "job" / "app" / "config" / "config_fed_client.conf"
        conf.write_text(conf.read_text().replace("/opt/fedlify/code/client.py", "custom/client.py"))
        errors = "\n".join(validate(self.repo))
        self.assertIn("cohort/extract.parquet", errors)
        self.assertIn("possible credential in settings.py", errors)
        self.assertIn("requirements.txt:1", errors)
        self.assertIn("/opt/fedlify/code/", errors)

    def test_rejects_syntax_errors_and_missing_job(self):
        (self.repo / "client.py").write_text("def broken(:\n")
        shutil.rmtree(self.repo / "job")
        errors = "\n".join(validate(self.repo))
        self.assertIn("client.py does not compile", errors)
        self.assertIn("missing required file: job/meta.conf", errors)


class ProvisionTest(unittest.TestCase):
    def test_clients_dial_443_and_verify_the_study_hostname(self):
        text = project_yaml("hf_mortality", "hf-mortality.fedlify.com", "admin@fedlify.local", [{"name": "site_a"}, {"name": "site_b"}])
        self.assertIn("  - name: hf-mortality.fedlify.com\n    type: server", text)
        self.assertEqual(text.count("      port: 443"), 2)
        self.assertIn("fed_learn_port: 8002", text)
        self.assertIn("admin_port: 8003", text)
        self.assertIn("config_folder: config", text)
        self.assertIn("sp_end_point: hf-mortality.fedlify.com:8002:8003", text)


class RenderAggregatorTest(unittest.TestCase):
    def test_renders_study_directory_with_passthrough_ingress(self):
        gitops = Path(tempfile.mkdtemp())
        try:
            values = {
                "SLUG": "hf-mortality",
                "NAMESPACE": "study-hf-mortality",
                "HOSTNAME": "hf-mortality.fedlify.com",
                "IMAGE": "harbor.fedlify.com/fedlify-studies/hf-mortality@sha256:" + "a" * 64,
                "STUDY_ID": "s1",
                "DEPLOYMENT_ID": "d1",
                "PIPELINE_VERSION_ID": "v1",
                "KIT_GENERATION": "1",
                "INGRESS_TARGET": "206.12.103.4",
            }
            args = [sys.executable, "-m", "fedlify_runtime.render_aggregator", "--gitops-dir", str(gitops), "--path", "studies/hf-mortality",
                    "--template", str(ROOT / "deploy" / "k8s" / "study-aggregator" / "aggregator.yaml.tmpl")]
            for key, value in values.items():
                args += ["--var", f"{key}={value}"]
            subprocess.run(args, check=True, cwd=ROOT / "deploy" / "images" / "nvflare", capture_output=True)
            rendered = (gitops / "studies" / "hf-mortality" / "aggregator.yaml").read_text()
            self.assertNotIn("${", rendered)
            self.assertIn('nginx.ingress.kubernetes.io/ssl-passthrough: "true"', rendered)
            self.assertIn('cloudflare-proxied: "false"', rendered)
            self.assertIn(values["IMAGE"], rendered)
            self.assertTrue((gitops / "studies" / "hf-mortality" / "kustomization.yaml").exists())

            escape = subprocess.run(args[:5] + ["--path", "../etc"] + args[7:], cwd=ROOT / "deploy" / "images" / "nvflare", capture_output=True)
            self.assertNotEqual(escape.returncode, 0)
        finally:
            shutil.rmtree(gitops, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
