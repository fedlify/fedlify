"""Server-side widget that records every client's per-round metrics for the Fedlify dashboard.

Writes one JSON line per accepted contribution to <run_dir>/fedlify_metrics.jsonl. The FLARE API
adapter sidecar reads the file live, and it is part of the downloaded job result.
"""

import json
import os
import time

from nvflare.apis.dxo import MetaKey, from_shareable
from nvflare.apis.fl_constant import FLContextKey
from nvflare.apis.fl_context import FLContext
from nvflare.app_common.app_constant import AppConstants
from nvflare.app_common.app_event_type import AppEventType
from nvflare.widgets.widget import Widget

METRICS_FILE = "fedlify_metrics.jsonl"


def _plain(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return str(value)


class FedlifyMetricsCollector(Widget):
    def handle_event(self, event_type: str, fl_ctx: FLContext):
        if event_type == AppEventType.BEFORE_CONTRIBUTION_ACCEPT:
            self._record_contribution(fl_ctx)
        elif event_type == AppEventType.ROUND_DONE:
            self._write(fl_ctx, {"event": "round_done", "round": fl_ctx.get_prop(AppConstants.CURRENT_ROUND)})

    def _record_contribution(self, fl_ctx: FLContext):
        peer_ctx = fl_ctx.get_peer_context()
        try:
            dxo = from_shareable(peer_ctx.get_prop(FLContextKey.SHAREABLE))
        except Exception:
            return
        metrics = dxo.get_meta_prop(MetaKey.INITIAL_METRICS) or {}
        if not isinstance(metrics, dict):
            metrics = {"value": metrics}
        self._write(
            fl_ctx,
            {
                "event": "contribution",
                "round": fl_ctx.get_prop(AppConstants.CURRENT_ROUND),
                "site": peer_ctx.get_identity_name(default="?"),
                "numSamples": _plain(dxo.get_meta_prop(MetaKey.NUM_STEPS_CURRENT_ROUND, 0)),
                "metrics": {key: _plain(value) for key, value in metrics.items()},
            },
        )

    def _write(self, fl_ctx: FLContext, record: dict):
        try:
            run_dir = fl_ctx.get_engine().get_workspace().get_run_dir(fl_ctx.get_job_id())
            with open(os.path.join(run_dir, METRICS_FILE), "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"ts": time.time(), **record}) + "\n")
        except Exception as error:  # metrics must never break training
            self.log_warning(fl_ctx, f"fedlify metrics not recorded: {error}")
