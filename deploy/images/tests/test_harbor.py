"""Unit tests for fedlify_runtime.harbor (the publish workflow's Harbor client). No network: the opener is a fake.

Run: python3 -m unittest discover -s deploy/images/tests
"""

import io
import json
import os
import stat
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "deploy" / "images" / "nvflare"))

from fedlify_runtime import harbor  # noqa: E402

FAKE_SECRET = "unit-test-robot-secret-not-real"


class FakeResponse:
    def __init__(self, status, body):
        self.status, self._body = status, json.dumps(body).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeHarbor:
    def __init__(self, robots=None, fail=None):
        self.requests, self.robots, self.fail = [], robots or [], fail

    def __call__(self, request, timeout=None):
        path = request.full_url.split("/api/v2.0")[1]
        body = json.loads(request.data) if request.data else None
        self.requests.append((request.get_method(), path, body))
        if self.fail:
            raise urllib.error.HTTPError(request.full_url, self.fail, "x", {}, io.BytesIO(b'{"errors":[{"message":"robot$other secret"}]}'))
        if request.get_method() == "GET" and path.startswith("/projects/"):
            return FakeResponse(200, {"project_id": 7})
        if request.get_method() == "GET":
            return FakeResponse(200, self.robots)
        if request.get_method() == "POST":
            return FakeResponse(201, {"id": 99, "name": "robot$fedlify-s-demo+" + body["name"], "secret": FAKE_SECRET})
        return FakeResponse(200, None)


def client(fake):
    return harbor.Client("https://harbor.example", "robot$prov", "provisioner-pass", opener=fake)


class HarborClientTest(unittest.TestCase):
    def test_refuses_projects_outside_the_study_prefix(self):
        fake = FakeHarbor()
        for project in ["hivelab", "fedlify-studies", "fedlify-public", "lab-sites-x", "fedlify-s-", "fedlify-s-A", "fedlify-s-a/../b"]:
            with self.assertRaises(harbor.HarborError):
                client(fake).mint(project, "push-1", True, 1)
        self.assertEqual(fake.requests, [])

    def test_pull_robot_permissions_are_exactly_pull_on_one_project(self):
        fake = FakeHarbor()
        client(fake).mint("fedlify-s-demo", "agg-1", False, 365)
        method, path, body = fake.requests[0]
        self.assertEqual((method, path), ("POST", "/robots"))
        self.assertEqual(body["permissions"], [{"kind": "project", "namespace": "fedlify-s-demo", "access": [{"resource": "repository", "action": "pull"}]}])
        self.assertEqual((body["level"], body["duration"]), ("project", 365))
        self.assertNotIn("pattern", json.dumps(body))

    def test_push_robot_is_push_and_pull_and_expires(self):
        fake = FakeHarbor()
        client(fake).mint("fedlify-s-demo", "push-abc", True, 1)
        body = fake.requests[0][2]
        self.assertEqual([a["action"] for a in body["permissions"][0]["access"]], ["push", "pull"])
        self.assertEqual(body["duration"], 1)

    def test_lifetime_bounds_and_names(self):
        fake = FakeHarbor()
        for days in (0, 366, -1):
            with self.assertRaises(harbor.HarborError):
                client(fake).mint("fedlify-s-demo", "push-1", True, days)
        for name in ("Push", "a b", "robot$x", "", "x" * 65):
            with self.assertRaises(harbor.HarborError):
                client(fake).mint("fedlify-s-demo", name, True, 1)

    def test_delete_matches_short_name_only_and_prune_keeps_current(self):
        robots = [
            {"id": 1, "name": "robot$fedlify-s-demo+push-a"},
            {"id": 2, "name": "robot$fedlify-s-demo+push-b"},
            {"id": 3, "name": "robot$fedlify-s-demo+agg-old"},
            {"id": 4, "name": "robot$fedlify-s-demo+agg-new"},
            {"id": 5, "name": "robot$fedlify-s-demo+site-x-1"},
        ]
        fake = FakeHarbor(robots)
        self.assertEqual(client(fake).delete("fedlify-s-demo", "push-a"), 1)
        self.assertEqual([r for r in fake.requests if r[0] == "DELETE"], [("DELETE", "/robots/1", None)])
        fake = FakeHarbor(robots)
        self.assertEqual(client(fake).prune("fedlify-s-demo", "agg-", "agg-new"), 1)
        self.assertEqual([r[1] for r in fake.requests if r[0] == "DELETE"], ["/robots/3"])

    def test_robot_list_follows_pages_so_robots_beyond_100_are_found(self):
        robots = [{"id": i, "name": "robot$fedlify-s-demo+site-%d" % i} for i in range(1, 131)]
        robots.append({"id": 999, "name": "robot$fedlify-s-demo+push-late"})

        class Paged(FakeHarbor):
            def __call__(self, request, timeout=None):
                path = request.full_url.split("/api/v2.0")[1]
                if request.get_method() == "GET" and path.startswith("/robots"):
                    query = urllib.parse.parse_qs(urllib.parse.urlparse(request.full_url).query)
                    page, size = int(query["page"][0]), int(query["page_size"][0])
                    self.requests.append(("GET", path, None))
                    return FakeResponse(200, self.robots[(page - 1) * size: page * size])
                return super().__call__(request, timeout)

        fake = Paged(robots)
        self.assertEqual(client(fake).delete("fedlify-s-demo", "push-late"), 1)
        self.assertEqual([r[1] for r in fake.requests if r[0] == "DELETE"], ["/robots/999"])

    def test_robot_list_refuses_to_answer_partially(self):
        fake = FakeHarbor([{"id": i, "name": "robot$x+r%d" % i} for i in range(1, 101)])
        with self.assertRaises(harbor.HarborError):
            client(fake).list_robots("fedlify-s-demo", max_pages=3)

    def test_errors_never_include_the_response_body(self):
        with self.assertRaises(harbor.HarborError) as raised:
            client(FakeHarbor(fail=403)).mint("fedlify-s-demo", "push-1", True, 1)
        self.assertIn("403", str(raised.exception))
        self.assertNotIn("robot$other", str(raised.exception))
        self.assertNotIn("provisioner-pass", str(raised.exception))


class HarborCliTest(unittest.TestCase):
    def run_cli(self, argv, fake):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = harbor.main(argv, client=client(fake))
        return code, out.getvalue(), err.getvalue()

    def test_secret_goes_to_a_private_file_and_is_never_printed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "docker.json")
            code, out, err = self.run_cli(
                ["mint", "--project", "fedlify-s-demo", "--name", "push-1", "--push", "--days", "1", "--docker-config", path, "--registry", "harbor.example"],
                FakeHarbor(),
            )
            self.assertEqual(code, 0)
            self.assertNotIn(FAKE_SECRET, out + err)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
            auth = json.loads(Path(path).read_text())["auths"]["harbor.example"]["auth"]
            import base64
            self.assertEqual(base64.b64decode(auth).decode(), "robot$fedlify-s-demo+push-1:" + FAKE_SECRET)

    def test_mint_without_an_output_file_fails_instead_of_printing(self):
        code, out, err = self.run_cli(["mint", "--project", "fedlify-s-demo", "--name", "push-1", "--days", "1"], FakeHarbor())
        self.assertEqual(code, 1)
        self.assertNotIn(FAKE_SECRET, out + err)

    def test_harbor_failure_exits_nonzero_without_leaking(self):
        code, out, err = self.run_cli(["delete", "--project", "fedlify-s-demo", "--name", "push-1"], FakeHarbor(fail=500))
        self.assertEqual(code, 1)
        self.assertNotIn("provisioner-pass", out + err)

    def test_missing_credentials_are_reported(self):
        with self.assertRaises(harbor.HarborError):
            harbor.client_from_env({})


if __name__ == "__main__":
    unittest.main()
