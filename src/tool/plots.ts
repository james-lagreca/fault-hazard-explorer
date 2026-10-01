// Plotly wrappers for the three figures, themed for the gov-data-portal surface.
import Plotly from 'plotly.js-dist-min';
import type { EngineResult, ModelKey } from '../engine/types';
import type { TreeParam, UncertaintyResult } from '../engine/uncertainty';
import { GMPE_META, MODEL_KEYS } from '../engine/types';

export const MODEL_META: Record<ModelKey, { name: string; color: string; dash: string }> = {
  GR: { name: 'GR (no cap)', color: '#7c8288', dash: 'dash' },
  TGR: { name: 'Truncated GR', color: '#005ea2', dash: 'solid' },
  CHAR: { name: 'Characteristic', color: '#c05600', dash: 'solid' },
  MMAX: { name: 'Mₘₐₓ', color: '#3e8a4e', dash: 'solid' },
};

const INK = '#565c65';
const INK_FAINT = '#71767a';
const RULE = '#dfe1e2';
const GRID = '#dfe1e2';
const MARK = '#71767a';

const CONFIG = { displayModeBar: false, responsive: true } as const;

function baseLayout(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: '#ffffff',
    font: { color: INK, family: "'Roboto Mono', ui-monospace, monospace", size: 11 },
    margin: { l: 64, r: 16, t: 34, b: 46 },
    showlegend: false,
    hoverlabel: {
      bgcolor: '#ffffff',
      bordercolor: RULE,
      font: { family: "'Roboto Mono', monospace", color: '#1b1b1b', size: 11 },
    },
    ...extra,
  };
}

function axis(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    gridcolor: GRID,
    zeroline: false,
    linecolor: INK,
    tickcolor: RULE,
    titlefont: { color: INK, size: 11 },
    ...extra,
  };
}

function figTitle(text: string): Record<string, unknown> {
  return {
    text: `<b>${text}</b>`,
    x: 0,
    xref: 'paper',
    font: { color: '#1b1b1b', family: "'Public Sans', system-ui, sans-serif", size: 14 },
  };
}

const log10 = Math.log10;
/** Snap a value's log10 down / up to the nearest half decade. */
const snapLo = (v: number): number => Math.floor(log10(v) * 2) / 2;
const snapHi = (v: number): number => Math.ceil(log10(v) * 2) / 2;

/** "once every ~1,200 yr" from an annual rate — the plain-language reading. */
function fmtEvery(rate: number): string {
  if (!(rate > 0)) return '—';
  const yr = 1 / rate;
  if (yr < 1.5) return `~${rate.toPrecision(2)}× per year`;
  const sig = yr < 100 ? Math.round(yr) : Number(yr.toPrecision(2));
  return yr >= 1e4
    ? `once every ~${(sig / 1e3).toLocaleString()}k yr`
    : `once every ~${sig.toLocaleString()} yr`;
}

/**
 * Data-driven log-axis range over the positive values of the visible traces,
 * snapped to half decades so it doesn't jitter as sliders move. Clamped to at
 * most `maxDecades` below the peak and at least `minDecades` tall.
 */
function logRange(traces: number[][], maxDecades: number, minDecades: number): [number, number] {
  let hi = 0;
  let lo = Infinity;
  for (const arr of traces)
    for (const v of arr)
      if (v > 0) {
        if (v > hi) hi = v;
        if (v < lo) lo = v;
      }
  if (!(hi > 0)) return [-5, 0];
  const hiL = snapHi(hi * 1.2);
  let loL = Math.max(snapLo(lo * 0.8), hiL - maxDecades);
  if (hiL - loL < minDecades) loL = hiL - minDecades;
  return [loL, hiL];
}

/** #rrggbb → rgba() with alpha, for soft deagg fills. */
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function renderMFD(el: HTMLElement, r: EngineResult, shown: Record<ModelKey, boolean>): void {
  const shownKeys = MODEL_KEYS.filter((k) => shown[k]);
  const traces = shownKeys.map((k) => ({
    x: r.mfdByModel[k].mids,
    y: r.cumByModel[k],
    type: 'scatter',
    mode: 'lines',
    name: MODEL_META[k].name,
    line: { color: MODEL_META[k].color, width: 2.4, dash: MODEL_META[k].dash },
    customdata: r.cumByModel[k].map(fmtEvery),
    hovertemplate: 'M ≥ %{x:.2f}<br>%{y:.2e}/yr — %{customdata}<extra></extra>',
  }));

  const xMax = Math.max(7.5, r.Mmax + 0.5);
  const yRange = logRange(shownKeys.map((k) => r.cumByModel[k]), 5, 2);
  const shapes: Record<string, unknown>[] = [
    { type: 'line', x0: r.Mmax, x1: r.Mmax, yref: 'paper', y0: 0, y1: 1, line: { color: MARK, width: 1, dash: 'dot' } },
  ];
  const anns: Record<string, unknown>[] = [
    { x: r.Mmax, yref: 'paper', y: 1, text: 'M<sub>max</sub> ' + r.Mmax.toFixed(2), showarrow: false, font: { color: MARK, size: 10.5, family: "'Roboto Mono', monospace" }, xanchor: 'left', yanchor: 'top', xshift: 4 },
  ];
  if (!r.params.lockMax && Math.abs(r.scalingMag - r.Mmax) > 0.03) {
    shapes.push({ type: 'line', x0: r.scalingMag, x1: r.scalingMag, yref: 'paper', y0: 0, y1: 1, line: { color: INK_FAINT, width: 1, dash: 'dash' } });
    anns.push({ x: r.scalingMag, yref: 'paper', y: 0.12, text: 'scaling ' + r.scalingMag.toFixed(2), showarrow: false, font: { color: INK_FAINT, size: 10, family: "'Roboto Mono', monospace" }, xanchor: 'left', xshift: 4 });
  }

  Plotly.react(
    el,
    traces,
    baseLayout({
      title: figTitle('(a) Cumulative recurrence'),
      xaxis: axis({ title: 'Magnitude', range: [r.params.Mmin, xMax] }),
      yaxis: axis({ title: 'N(≥M) /yr', type: 'log', range: yRange }),
      shapes,
      annotations: anns,
    }),
    CONFIG,
  );
}

export function renderHazard(
  el: HTMLElement,
  r: EngineResult,
  shown: Record<ModelKey, boolean>,
  band: UncertaintyResult | null = null,
): void {
  const shownKeys = MODEL_KEYS.filter((k) => shown[k]);

  // Epistemic fractile bands, drawn first so the best-estimate lines sit on top.
  // Zeros can't sit on a log axis; floor them far below the visible window.
  const bandTraces: Record<string, unknown>[] = [];
  if (band) {
    const floor = (v: number) => Math.max(v, 1e-20);
    for (const k of shownKeys) {
      const { lo, hi } = band.bandByModel[k];
      const c = MODEL_META[k].color;
      bandTraces.push(
        { x: band.pga, y: lo.map(floor), type: 'scatter', mode: 'lines', line: { color: hexA(c, 0.45), width: 0.8 }, hoverinfo: 'skip' },
        { x: band.pga, y: hi.map(floor), type: 'scatter', mode: 'lines', line: { color: hexA(c, 0.45), width: 0.8 }, fill: 'tonexty', fillcolor: hexA(c, 0.12), hoverinfo: 'skip' },
      );
    }
  }

  const meanTraces = shownKeys.map((k) => ({
    x: r.pga,
    y: r.hazByModel[k],
    type: 'scatter',
    mode: 'lines',
    name: MODEL_META[k].name,
    line: { color: MODEL_META[k].color, width: 2.4, dash: MODEL_META[k].dash },
    customdata: r.hazByModel[k].map(fmtEvery),
    hovertemplate: '%{x:.3f} g<br>%{y:.2e}/yr — %{customdata}<extra></extra>',
  }));

  // y: follow the data, but keep both return-period markers in frame.
  const lams = shownKeys.map((k) => r.hazByModel[k]);
  let [yLo, yHi] = logRange(lams, 4.5, 2);
  yHi = Math.max(yHi, log10(1 / 475) + 0.4);
  yLo = Math.min(yLo, log10(1 / 2475) - 0.6);

  // x: from where a curve visibly bends off its low-PGA plateau (drops below
  // 90% of its left-edge value inside the y-window) to where it leaves the
  // window bottom — skips the flat plateau that wastes the left of the panel.
  let xLo = Infinity;
  let xHi = 0;
  const yTop = Math.pow(10, yHi);
  const yBot = Math.pow(10, yLo);
  for (const lam of lams) {
    const plateau = lam[0]!;
    if (!(plateau > 0)) continue;
    for (let i = 0; i < r.pga.length; i++) {
      const v = lam[i]!;
      if (v > yTop || v < yBot) continue;
      const x = r.pga[i]!;
      if (v < plateau * 0.9 && x < xLo) xLo = x;
      if (x > xHi) xHi = x;
    }
  }
  const xRange: [number, number] =
    isFinite(xLo) && xHi > 0
      ? [Math.max(snapLo(xLo * 0.9), log10(0.001)), Math.min(snapHi(xHi * 1.1), log10(3))]
      : [log10(0.004), log10(2.5)];

  const shapes: Record<string, unknown>[] = [];
  const anns: Record<string, unknown>[] = [];
  ([[1 / 475, '475 yr'], [1 / 2475, '2475 yr']] as const).forEach(([rp, label]) => {
    shapes.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: rp, y1: rp, line: { color: MARK, width: 1, dash: 'dot' } });
    anns.push({ xref: 'paper', x: 0, y: Math.log10(rp), text: label, showarrow: false, font: { color: MARK, size: 10, family: "'Roboto Mono', monospace" }, xanchor: 'left', yanchor: 'bottom', xshift: 3 });
  });
  if (band && shownKeys.length > 0) {
    const [q0, q1] = band.quantiles.map((q) => Math.round(q * 100));
    const which = band.sensitivity.map((sv) => TREE_SHORT[sv.param]).join(' · ');
    anns.push({ xref: 'paper', yref: 'paper', x: 1, y: 1, text: `shaded: ${q0}–${q1}% (${which})`, showarrow: false, font: { color: INK_FAINT, size: 10, family: "'Roboto Mono', monospace" }, xanchor: 'right', yanchor: 'top' });
  }

  Plotly.react(
    el,
    [...bandTraces, ...meanTraces],
    baseLayout({
      title: figTitle('(b) Hazard at the site'),
      xaxis: axis({ title: 'PGA (g)', type: 'log', range: xRange }),
      yaxis: axis({ title: 'Annual rate of exceedance', type: 'log', range: [yLo, yHi] }),
      shapes,
      annotations: anns,
    }),
    CONFIG,
  );
}

const TREE_SHORT: Record<TreeParam | 'gmm', string> = {
  gmm: 'GMM',
  slip: 'slip',
  dip: 'dip',
  thickness: 'thickness',
  b: 'b',
  mmax: 'M<sub>max</sub>',
};

/** Tick label for one tornado row: the input and its low → high branch values. */
function tornadoLabel(p: TreeParam, lo: number, hi: number): string {
  switch (p) {
    case 'slip':
      return `Slip ${lo.toPrecision(2)}–${hi.toPrecision(2)} mm/yr`;
    case 'dip':
      return `Dip ${lo.toFixed(0)}–${hi.toFixed(0)}°`;
    case 'thickness':
      return `Thickness ${lo.toFixed(0)}–${hi.toFixed(0)} km`;
    case 'b':
      return `b ${lo.toFixed(2)}–${hi.toFixed(2)}`;
    case 'mmax':
      return `M<sub>max</sub> ${lo.toFixed(2)}–${hi.toFixed(2)}`;
  }
}

/**
 * One-at-a-time sensitivity: the % change in the model's RP motion when each
 * logic-tree input sits on its low / high branch (rest central), sorted by
 * swing, with the full tree's 15–85% range as the reference row at the top.
 */
export function renderTornado(
  el: HTMLElement,
  u: UncertaintyResult | null,
  model: ModelKey,
  rp: '475' | '2475',
): void {
  const field = rp === '475' ? 'rp475' : 'rp2475';
  const meta = MODEL_META[model];
  const title = figTitle(`(d) What drives the ${rp}-yr PGA — ${meta.name}`);
  const empty = (text: string) =>
    Plotly.react(
      el,
      [],
      baseLayout({
        title,
        xaxis: axis({ visible: false }),
        yaxis: axis({ visible: false }),
        annotations: [{ xref: 'paper', yref: 'paper', x: 0.5, y: 0.5, showarrow: false, text, font: { color: INK_FAINT, size: 12, family: "'Roboto Mono', monospace" } }],
      }),
      CONFIG,
    );

  if (!u || u.sensitivity.length === 0) return empty('tick an input in the logic tree to see its effect');
  const best = u.bestAtRP[model][field];
  if (best == null) return empty(`this model doesn't reach the ${rp}-yr rate here`);

  // null (curve never reaches the rate on that branch) → −100%: no motion at that RP.
  const pct = (g: number | null) => (g == null ? -100 : (g / best - 1) * 100);
  const rows = u.sensitivity
    .map((sv) => {
      const [gl, gh] = sv.byModel[model][field];
      const label =
        sv.param === 'gmm'
          ? `GMM ${sv.labels![model][field].map((g) => GMPE_META[g].short).join(' – ')}`
          : tornadoLabel(sv.param, sv.lowValue, sv.highValue);
      return { label, lo: pct(gl), hi: pct(gh), gl, gh };
    })
    .sort((a, b) => Math.abs(a.hi - a.lo) - Math.abs(b.hi - b.lo)); // biggest ends up on top

  const [bl, bh] = u.bandAtRP[model][field];
  const [q0, q1] = u.quantiles.map((q) => Math.round(q * 100));
  const allLabel = `<b>All · ${q0}–${q1}%</b>`;
  const fmt = (g: number | null) => (g == null ? 'not reached' : g.toFixed(3) + ' g');

  const y = rows.map((r) => r.label);
  const traces: Record<string, unknown>[] = [
    {
      type: 'bar', orientation: 'h', name: 'low branch', y, x: rows.map((r) => r.lo),
      marker: { color: hexA(meta.color, 0.35), line: { color: meta.color, width: 1 } },
      customdata: rows.map((r) => fmt(r.gl)),
      hovertemplate: '%{y}<br>low branch: %{customdata} (%{x:+.0f}%)<extra></extra>',
    },
    {
      type: 'bar', orientation: 'h', name: 'high branch', y, x: rows.map((r) => r.hi),
      marker: { color: meta.color },
      customdata: rows.map((r) => fmt(r.gh)),
      hovertemplate: '%{y}<br>high branch: %{customdata} (%{x:+.0f}%)<extra></extra>',
    },
    {
      type: 'bar', orientation: 'h', name: `all inputs ${q0}–${q1}%`, y: [allLabel],
      base: [pct(bl)], x: [pct(bh) - pct(bl)],
      marker: { color: hexA('#1b1b1b', 0.12), line: { color: INK, width: 1 } },
      customdata: [[fmt(bl), fmt(bh)]],
      hovertemplate: `all inputs: %{customdata[0]} – %{customdata[1]}<extra></extra>`,
    },
  ];

  const ext = Math.max(10, ...rows.flatMap((r) => [Math.abs(r.lo), Math.abs(r.hi)]), Math.abs(pct(bl)), Math.abs(pct(bh)));
  Plotly.react(
    el,
    traces,
    baseLayout({
      title,
      barmode: 'overlay',
      bargap: 0.35,
      showlegend: true,
      legend: { orientation: 'h', x: 0, y: -0.22, yanchor: 'top', font: { size: 10.5 } },
      margin: { l: 150, r: 16, t: 34, b: 46 },
      xaxis: axis({ title: `change vs best estimate (${best.toFixed(3)} g)`, ticksuffix: '%', range: [-ext * 1.1, ext * 1.1], zeroline: true, zerolinecolor: INK, zerolinewidth: 1 }),
      yaxis: axis({ categoryorder: 'array', categoryarray: [...y, allLabel], automargin: true, gridcolor: 'rgba(0,0,0,0)' }),
    }),
    CONFIG,
  );
}

export function renderDeagg(
  el: HTMLElement,
  r: EngineResult,
  shown: Record<ModelKey, boolean>,
  rp: '475' | '2475',
): void {
  const field = rp === '475' ? 'rp475' : 'rp2475';
  const traces: Record<string, unknown>[] = [];
  let yMax = 0;
  for (const k of MODEL_KEYS) {
    if (!shown[k]) continue;
    const d = r.deaggByModel[k][field];
    if (!d) continue;
    for (const v of d) if (v > yMax) yMax = v;
    traces.push({
      x: r.mfdByModel[k].mids,
      y: d,
      type: 'scatter',
      mode: 'lines',
      name: MODEL_META[k].name,
      line: { color: MODEL_META[k].color, width: 2, dash: MODEL_META[k].dash },
      fill: 'tozeroy',
      fillcolor: hexA(MODEL_META[k].color, 0.1),
      hovertemplate: `M %{x:.2f}: %{y:.1%} of exceedances<extra>${MODEL_META[k].name}</extra>`,
    });
  }

  const xMax = Math.max(7.5, r.Mmax + 0.5);
  const anns: Record<string, unknown>[] =
    traces.length === 0
      ? [{ xref: 'paper', yref: 'paper', x: 0.5, y: 0.5, showarrow: false, text: `no model reaches the ${rp}-yr motion here`, font: { color: INK_FAINT, size: 12, family: "'Roboto Mono', monospace" } }]
      : [];

  Plotly.react(
    el,
    traces,
    baseLayout({
      title: figTitle(`(c) Where the ${rp}-yr hazard comes from`),
      xaxis: axis({ title: 'Magnitude', range: [r.params.Mmin, xMax] }),
      yaxis: axis({ title: 'share of exceedances', tickformat: '.0%', range: [0, yMax > 0 ? yMax * 1.15 : 1] }),
      annotations: anns,
    }),
    CONFIG,
  );
}

export function resizePlots(...els: HTMLElement[]): void {
  for (const el of els) Plotly.Plots.resize(el);
}
