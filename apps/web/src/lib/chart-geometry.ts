/**
 * Plain-SVG line chart geometry. Pure so tests can check that plotted coordinates map back to the stored values.
 * A missing value (null) breaks the line; it is never interpolated across.
 */
export type ChartPoint = { x: number; y: number | null };
export type ChartSeries = { id: string; label: string; points: ChartPoint[] };
export type ChartBox = { width: number; height: number; left: number; right: number; top: number; bottom: number };

export const DEFAULT_BOX: ChartBox = { width: 640, height: 280, left: 48, right: 16, top: 16, bottom: 36 };

export type ChartScale = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  px: (x: number) => number;
  py: (y: number) => number;
  yTicks: number[];
};

export function buildScale(series: ChartSeries[], box: ChartBox = DEFAULT_BOX): ChartScale | null {
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const ys = series.flatMap((s) => s.points.filter((p) => p.y !== null).map((p) => p.y as number));
  if (xs.length === 0 || ys.length === 0) return null;
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const rawMin = Math.min(...ys);
  const rawMax = Math.max(...ys);
  // Round down/up to a tenth so the axis is readable; a flat series still gets a visible range.
  let yMin = Math.floor(rawMin * 10) / 10;
  let yMax = Math.ceil(rawMax * 10) / 10;
  if (yMax - yMin < 0.1) {
    yMin = Math.floor((rawMin - 0.05) * 10) / 10;
    yMax = yMin + 0.1;
  }
  const innerW = box.width - box.left - box.right;
  const innerH = box.height - box.top - box.bottom;
  const px = (x: number) => box.left + (xMax === xMin ? innerW / 2 : ((x - xMin) / (xMax - xMin)) * innerW);
  const py = (y: number) => box.top + innerH - ((y - yMin) / (yMax - yMin)) * innerH;
  const yTicks: number[] = [];
  for (let i = 0; i <= 4; i += 1) yTicks.push(Number((yMin + ((yMax - yMin) * i) / 4).toFixed(4)));
  return { xMin, xMax, yMin, yMax, px, py, yTicks };
}

/** SVG path segments. Each run of consecutive present values is its own "M ... L ..." subpath. */
export function seriesPath(points: ChartPoint[], scale: ChartScale): string {
  let d = "";
  let pen = false;
  for (const point of points) {
    if (point.y === null) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${scale.px(point.x).toFixed(2)},${scale.py(point.y).toFixed(2)} `;
    pen = true;
  }
  return d.trim();
}

import type { RoundSummary } from "@/lib/round-metrics";

/**
 * Chart series for one metric key from stored round summaries. A round where a series has no value for the key yields
 * y = null (a gap), never 0 and never an interpolated value.
 */
export function buildSeries(rounds: RoundSummary[], key: string, sites: string[]): ChartSeries[] {
  const series: ChartSeries[] = [];
  if (rounds.some((r) => key in r.average)) {
    series.push({ id: "__average__", label: "Round average", points: rounds.map((r) => ({ x: r.round, y: key in r.average ? r.average[key] : null })) });
  }
  for (const site of sites) {
    series.push({
      id: site,
      label: site,
      points: rounds.map((r) => {
        const entry = r.sites.find((s) => s.site === site);
        return { x: r.round, y: entry && key in entry.metrics ? entry.metrics[key] : null };
      })
    });
  }
  return series;
}

/** Round numbers to label on the x axis: at most `max` of them, always including the first and last stored round. */
export function thinRoundLabels(rounds: number[], max = 10): number[] {
  if (rounds.length <= max) return rounds;
  const step = Math.ceil((rounds.length - 1) / (max - 1));
  const picked = rounds.filter((_, i) => i % step === 0);
  const last = rounds[rounds.length - 1];
  if (picked[picked.length - 1] !== last) {
    // Drop a tick that would crowd the last label.
    if (rounds.length - 1 - rounds.indexOf(picked[picked.length - 1]) < step / 2) picked.pop();
    picked.push(last);
  }
  return picked;
}

/** Site series styling: colours cycle through the palette, and each full cycle switches to a new dash pattern so no two sites look alike. */
export function siteStyle(siteIndex: number, paletteSize: number): { colorIndex: number; dash: string | undefined } {
  const dashes = ["5 3", "2 2", "8 3 2 3", undefined];
  return { colorIndex: siteIndex % paletteSize, dash: dashes[Math.floor(siteIndex / paletteSize) % dashes.length] };
}
