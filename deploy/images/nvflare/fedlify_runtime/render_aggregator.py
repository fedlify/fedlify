"""Render a study's aggregator manifests into a GitOps checkout.

usage: python3 -m fedlify_runtime.render_aggregator --gitops-dir /work/gitops --path studies/<slug> \
           --var SLUG=... --var NAMESPACE=... --var HOSTNAME=... --var IMAGE=... (all template variables)
"""

import argparse
import string
import sys
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent.parent / "aggregator.yaml.tmpl"
KUSTOMIZATION = """apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - aggregator.yaml
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gitops-dir", required=True)
    parser.add_argument("--path", required=True)
    parser.add_argument("--var", action="append", default=[], help="KEY=VALUE")
    parser.add_argument("--template", default=str(TEMPLATE))
    args = parser.parse_args()

    values = dict(item.split("=", 1) for item in args.var)
    rendered = string.Template(Path(args.template).read_text()).substitute(values)  # KeyError if a variable is missing

    target = Path(args.gitops_dir) / args.path
    if ".." in Path(args.path).parts or not str(args.path).startswith("studies/"):
        sys.exit(f"Refusing to write outside studies/: {args.path}")
    target.mkdir(parents=True, exist_ok=True)
    (target / "aggregator.yaml").write_text(rendered)
    (target / "kustomization.yaml").write_text(KUSTOMIZATION)
    print(f"Rendered {target}/aggregator.yaml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
