"""Harbor robot minting for the publish workflow. Twin of apps/web/src/lib/harbor-registry.ts: keep the two in step.

usage (credentials from the environment: HARBOR_URL, HARBOR_USERNAME, HARBOR_PASSWORD = the limited provisioner robot):
  python3 -m fedlify_runtime.harbor mint --project fedlify-s-<slug> --name push-<run> --push --days 1 \
      --docker-config /work/push-docker-config.json
  python3 -m fedlify_runtime.harbor mint --project fedlify-s-<slug> --name agg-<run> --days 365 \
      --credential-file /work/aggregator-robot.json
  python3 -m fedlify_runtime.harbor delete --project fedlify-s-<slug> --name push-<run>
  python3 -m fedlify_runtime.harbor prune --project fedlify-s-<slug> --prefix agg- --keep agg-<run>

Rules: refuses any project that is not fedlify-s-<slug>; sends only the permission templates below; writes the secret only
to a mode 0600 file and never prints it; error messages never include a response body. Robot names contain "$": always
pass them through files or quoted variables, never an unquoted shell string. Unconfirmed against Harbor v2.15.2 until the
live checks in docs/site-runner-and-ux-design.md section 15.9 have been run.
"""

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

STUDY_PROJECT_RE = re.compile(r"^fedlify-s-[a-z0-9]+(?:-[a-z0-9]+)*$")
ROBOT_NAME_RE = re.compile(r"^[a-z0-9]+(?:[-_.][a-z0-9]+)*$")
TIMEOUT = 20


class HarborError(Exception):
    pass


def assert_study_project(name):
    if len(name) > 128 or not STUDY_PROJECT_RE.match(name):
        raise HarborError("refusing project %r: only fedlify-s-<slug> projects are managed here" % name[:60])
    return name


def permissions(project, push):
    actions = ["push", "pull"] if push else ["pull"]
    return [{
        "kind": "project",
        "namespace": assert_study_project(project),
        "access": [{"resource": "repository", "action": action} for action in actions],
    }]


def short_name(harbor_name):
    if "+" in harbor_name:
        return harbor_name.split("+", 1)[1]
    return harbor_name[len("robot$"):] if harbor_name.startswith("robot$") else harbor_name


class Client:
    def __init__(self, base_url, username, password, opener=None):
        self.base = base_url.rstrip("/") + "/api/v2.0"
        token = base64.b64encode(("%s:%s" % (username, password)).encode()).decode()
        self.headers = {"Authorization": "Basic " + token, "Accept": "application/json"}
        self.opener = opener or urllib.request.urlopen

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        headers = dict(self.headers)
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        label = "%s %s" % (method, re.sub(r"/\d+(?=/|$)", "/{id}", path.split("?")[0]))
        try:
            with self.opener(request, timeout=TIMEOUT) as response:
                text = response.read().decode() or "null"
                return response.status, json.loads(text)
        except urllib.error.HTTPError as error:
            # Never echo the body: it can contain account names.
            raise HarborError("Harbor returned HTTP %d (%s)" % (error.code, label))
        except (urllib.error.URLError, OSError):
            raise HarborError("Harbor is unreachable (%s)" % label)

    def project_id(self, project):
        _, data = self.call("GET", "/projects/" + urllib.parse.quote(assert_study_project(project)))
        if not isinstance(data, dict) or not isinstance(data.get("project_id"), int):
            raise HarborError("project %s not found" % project)
        return data["project_id"]

    def list_robots(self, project, page_size=100, max_pages=50):
        """Every robot of the project, following pages until a short page (a project can hold more than one page)."""
        query = urllib.parse.quote("Level=project,ProjectID=%d" % self.project_id(project))
        robots = []
        for page in range(1, max_pages + 1):
            _, data = self.call("GET", "/robots?q=%s&page=%d&page_size=%d" % (query, page, page_size))
            rows = data if isinstance(data, list) else []
            robots.extend(r for r in rows if isinstance(r, dict) and isinstance(r.get("id"), int) and r.get("name"))
            if len(rows) < page_size:
                return robots
        # A silently partial list would let a delete or prune report success while robots survive.
        raise HarborError("robot list exceeds %d pages" % max_pages)

    def mint(self, project, name, push, days):
        if not ROBOT_NAME_RE.match(name) or len(name) > 64:
            raise HarborError("bad robot name")
        if not 1 <= days <= 365:
            raise HarborError("robot lifetime must be 1 to 365 days")
        _, robot = self.call("POST", "/robots", {
            "name": name,
            "description": "Fedlify publish credential (managed; do not edit).",
            "duration": days,
            "level": "project",
            "disable": False,
            "permissions": permissions(project, push),
        })
        if not isinstance(robot, dict) or not robot.get("name") or not robot.get("secret"):
            raise HarborError("Harbor returned an incomplete robot")
        return robot

    def delete(self, project, name):
        """Delete by short name. Returns how many robots were removed (0 is fine: it is already gone)."""
        removed = 0
        for robot in self.list_robots(project):
            if short_name(robot["name"]) == name:
                self.call("DELETE", "/robots/%d" % robot["id"])
                removed += 1
        return removed

    def prune(self, project, prefix, keep):
        removed = 0
        for robot in self.list_robots(project):
            short = short_name(robot["name"])
            if short.startswith(prefix) and short != keep:
                self.call("DELETE", "/robots/%d" % robot["id"])
                removed += 1
        return removed


def write_private(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(content)


def docker_config(registry, username, password):
    auth = base64.b64encode(("%s:%s" % (username, password)).encode()).decode()
    return json.dumps({"auths": {registry: {"auth": auth}}})


def client_from_env(env=os.environ):
    url, user, password = env.get("HARBOR_URL"), env.get("HARBOR_USERNAME"), env.get("HARBOR_PASSWORD")
    if not (url and user and password):
        raise HarborError("HARBOR_URL, HARBOR_USERNAME and HARBOR_PASSWORD must be set (the harbor-provisioner secret)")
    return Client(url, user, password)


def main(argv=None, client=None):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    mint = sub.add_parser("mint")
    mint.add_argument("--project", required=True)
    mint.add_argument("--name", required=True)
    mint.add_argument("--push", action="store_true")
    mint.add_argument("--days", type=int, required=True)
    mint.add_argument("--docker-config")
    mint.add_argument("--registry")
    mint.add_argument("--credential-file")
    delete = sub.add_parser("delete")
    delete.add_argument("--project", required=True)
    delete.add_argument("--name", required=True)
    prune = sub.add_parser("prune")
    prune.add_argument("--project", required=True)
    prune.add_argument("--prefix", required=True)
    prune.add_argument("--keep", required=True)
    args = parser.parse_args(argv)
    try:
        client = client or client_from_env()
        if args.command == "mint":
            if not (args.docker_config or args.credential_file):
                raise HarborError("give --docker-config or --credential-file: the secret is never printed")
            robot = client.mint(args.project, args.name, args.push, args.days)
            if args.docker_config:
                write_private(args.docker_config, docker_config(args.registry or os.environ.get("HARBOR_REGISTRY", ""), robot["name"], robot["secret"]))
            if args.credential_file:
                write_private(args.credential_file, json.dumps({"username": robot["name"], "password": robot["secret"]}))
            print("minted robot %s for %s (push=%s, %d days)" % (args.name, args.project, args.push, args.days))
        elif args.command == "delete":
            print("deleted %d robot(s) named %s in %s" % (client.delete(args.project, args.name), args.name, args.project))
        else:
            print("pruned %d robot(s) with prefix %s in %s" % (client.prune(args.project, args.prefix, args.keep), args.prefix, args.project))
    except HarborError as error:
        print("harbor: %s" % error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
