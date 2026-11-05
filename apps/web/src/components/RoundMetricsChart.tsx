"use client";

import { Alert, Select, Typography } from "antd";
import { useMemo, useState } from "react";
import { RecordTable } from "@/components/RecordTable";
import { buildScale, buildSeries, DEFAULT_BOX, seriesPath, siteStyle, thinRoundLabels } from "@/lib/chart-geometry";
import type { RoundSummary } from "@/lib/round-metrics";

export type MetricsPayload = {
  status: "stored" | "live" | "missing" | "unavailable" | "empty";
  reason?: string | null;
  disclaimer: string;
  checksum?: string | null;
  rounds?: RoundSummary[];
  metricKeys?: string[];
  sites?: string[];
  malformedLines?: number;
  droppedValues?: number;
  aggregateHidden?: boolean;
};

const COLORS = ["#2f6fb0", "#c2571a", "#2b8a5a", "#8a4fb0", "#a07a00", "#b03060", "#00838f", "#6d4c41", "#5c6bc0", "#7cb342"];
const AVERAGE = "__average__";
const fmt = (value: number | null | undefined) => (value === null || value === undefined ? null : value.toFixed(4));

/** Plain-SVG per-round chart drawn only from stored values, with a table that lists every value and every gap. */
export function RoundMetricsChart({ metrics }: { metrics: MetricsPayload }) {
  const rounds = useMemo(() => metrics.rounds ?? [], [metrics.rounds]);
  const keys = useMemo(() => metrics.metricKeys ?? [], [metrics.metricKeys]);
  const [chosen, setChosen] = useState<string | null>(null);
  const key = chosen && keys.includes(chosen) ? chosen : keys.includes("auroc") ? "auroc" : (keys[0] ?? null);

  if (metrics.status === "missing" || metrics.status === "unavailable" || metrics.status === "empty" || !rounds.length || !key) {
    const title = metrics.status === "unavailable" ? "Stored metrics could not be shown" : "No round metrics stored for this run";
    return (
      <Alert
        type={metrics.status === "unavailable" ? "warning" : "info"}
        showIcon
        message={title}
        description={`${metrics.reason ?? "Nothing was recorded."} No chart is drawn and no values are estimated. Runs from before metrics were stored have no per-round data.`}
        data-testid="metrics-empty"
      />
    );
  }

  const sites = metrics.sites ?? [];
  const series = buildSeries(rounds, key, sites);
  const scale = buildScale(series);
  const box = DEFAULT_BOX;
  const gaps = rounds.reduce((n, r) => n + (key in r.average ? 0 : 1) + sites.filter((s) => !r.sites.some((e) => e.site === s && key in e.metrics)).length, 0);
  const partialRounds = rounds.filter((r) => key in r.average && (r.missing[key]?.length ?? 0) > 0).length;
  // Style by position among site series, so the average line does not shift site colours.
  const style = (id: string) => {
    if (id === AVERAGE) return { color: "#1f1f1f", dash: undefined as string | undefined, width: 2.5 };
    const { colorIndex, dash } = siteStyle(series.filter((s) => s.id !== AVERAGE).findIndex((s) => s.id === id), COLORS.length);
    return { color: COLORS[colorIndex], dash, width: 1.5 };
  };
  const labelRounds = new Set(thinRoundLabels(rounds.map((r) => r.round)));

  return (
    <div data-testid="metrics-chart">
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message={metrics.disclaimer} />
      {metrics.status === "live" ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Live values from the running aggregator. They are stored when the model is saved." /> : null}
      {metrics.aggregateHidden ? <Alert type="info" showIcon style={{ marginBottom: 12 }} message="The cross-site average is hidden for rounds with fewer than three sites. You see your own site's values only." /> : null}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}>
        <Typography.Text>Metric</Typography.Text>
        <Select size="small" value={key} onChange={setChosen} options={keys.map((k) => ({ value: k, label: k }))} style={{ minWidth: 140 }} />
        <Typography.Text type="secondary">{rounds.length} round(s) stored</Typography.Text>
      </div>
      {scale ? (
        <svg viewBox={`0 0 ${box.width} ${box.height}`} role="img" aria-label={`${key} per round, ${series.map((s) => s.label).join(", ")}`} style={{ width: "100%", maxWidth: 720, height: "auto" }}>
          {scale.yTicks.map((tick) => (
            <g key={tick}>
              <line x1={box.left} x2={box.width - box.right} y1={scale.py(tick)} y2={scale.py(tick)} stroke="#d9d9d9" strokeWidth={1} />
              <text x={box.left - 6} y={scale.py(tick) + 4} fontSize={11} textAnchor="end" fill="#595959">
                {tick.toFixed(2)}
              </text>
            </g>
          ))}
          {rounds.filter((r) => labelRounds.has(r.round)).map((r) => (
            <text key={r.round} x={scale.px(r.round)} y={box.height - 14} fontSize={11} textAnchor="middle" fill="#595959">
              {r.round}
            </text>
          ))}
          <text x={(box.left + box.width - box.right) / 2} y={box.height - 1} fontSize={11} textAnchor="middle" fill="#595959">
            Round
          </text>
          {series.map((s) => {
            const { color, dash, width } = style(s.id);
            return (
              <g key={s.id} data-series={s.id}>
                <path d={seriesPath(s.points, scale)} fill="none" stroke={color} strokeWidth={width} strokeDasharray={dash} />
                {s.points.map((p) =>
                  p.y === null ? null : (
                    <circle key={p.x} cx={scale.px(p.x)} cy={scale.py(p.y)} r={3} fill={color} data-x={p.x} data-y={p.y}>
                      <title>{`${s.label}, round ${p.x}: ${key} ${p.y.toFixed(4)}`}</title>
                    </circle>
                  )
                )}
              </g>
            );
          })}
        </svg>
      ) : null}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "4px 0 12px" }}>
        {series.map((s) => (
          <span key={s.id} style={{ fontSize: 12 }}>
            <span style={{ display: "inline-block", width: 14, height: 3, background: style(s.id).color, marginRight: 6, verticalAlign: "middle" }} />
            {s.label}
          </span>
        ))}
      </div>
      <Typography.Paragraph type="secondary" data-testid="data-kind-note">
        Fedlify does not know whether these values come from real, synthetic, test or simulated data unless the pipeline declares it; the model card shows what it declares. Treat them as unverified.
      </Typography.Paragraph>
      {partialRounds > 0 ? <Typography.Paragraph type="secondary" data-testid="partial-note">{partialRounds} round average(s) for {key} cover only some of the sites; the table marks them as partial.</Typography.Paragraph> : null}
      {gaps > 0 ? <Typography.Paragraph type="secondary">{gaps} point(s) are missing for {key}; they are shown as gaps, not filled in.</Typography.Paragraph> : null}
      {metrics.malformedLines || metrics.droppedValues ? (
        <Typography.Paragraph type="secondary">
          Stored file issues: {metrics.malformedLines ?? 0} unreadable line(s), {metrics.droppedValues ?? 0} non-numeric value(s) left out.
        </Typography.Paragraph>
      ) : null}
      <RecordTable
        rowKey="round"
        pagination={false}
        dataSource={rounds}
        columns={[
          { title: "Round", dataIndex: "round", width: 80 },
          { title: `Average ${key}`, render: (_, r: RoundSummary) => {
              const absent = r.missing[key] ?? [];
              const avg = fmt(r.average[key]);
              if (avg === null) return <span className="fedlify-muted">{metrics.aggregateHidden ? "Hidden" : "Missing"}</span>;
              return absent.length ? <span>{avg} <span className="fedlify-muted">(partial, no {key} from {absent.join(", ")})</span></span> : avg;
            }, width: 140 },
          { title: "Weighting", render: (_, r: RoundSummary) => (key in r.weighting ? (r.weighting[key] === "samples" ? "By reported sample count (the runner's count, which may be training rows rather than validation rows)" : "Unweighted (sample counts missing)") : "-"), width: 200 },
          ...sites.map((site) => ({
            title: site,
            render: (_: unknown, r: RoundSummary) => {
              const entry = r.sites.find((s) => s.site === site);
              const value = entry && key in entry.metrics ? entry.metrics[key] : null;
              return fmt(value) ?? <span className="fedlify-muted">Missing</span>;
            }
          }))
        ]}
      />
    </div>
  );
}
