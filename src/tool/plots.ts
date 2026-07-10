// Plotly wrappers for the two figures, themed for the gov-data-portal surface.
import Plotly from 'plotly.js-dist-min';
import type { EngineResult, ModelKey } from '../engine/types';
import { MODEL_KEYS } from '../engine/types';

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

export function renderMFD(el: HTMLElement, r: EngineResult, shown: Record<ModelKey, boolean>): void {
  const traces = MODEL_KEYS.filter((k) => shown[k]).map((k) => ({
    x: r.mfdByModel[k].mids,
    y: r.cumByModel[k],
    type: 'scatter',
    mode: 'lines',
    name: MODEL_META[k].name,
    line: { color: MODEL_META[k].color, width: 2.4, dash: MODEL_META[k].dash },
    hovertemplate: 'M %{x}<br>%{y:.2e}/yr<extra></extra>',
  }));

  const xMax = Math.max(7.5, r.Mmax + 0.5);
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
      title: figTitle('(a) Cumulative recurrence'),
      xaxis: axis({ title: 'Magnitude', range: [r.params.Mmin, xMax] }),
      yaxis: axis({ title: 'N(≥M) /yr', type: 'log', range: [-5, -0.7] }),
      shapes,
      annotations: anns,
    }),
    CONFIG,
  );
}

export function renderHazard(el: HTMLElement, r: EngineResult, shown: Record<ModelKey, boolean>): void {
  const traces = MODEL_KEYS.filter((k) => shown[k]).map((k) => ({
    x: r.pga,
    y: r.hazByModel[k],
    type: 'scatter',
    mode: 'lines',
    name: MODEL_META[k].name,
    line: { color: MODEL_META[k].color, width: 2.4, dash: MODEL_META[k].dash },
    hovertemplate: '%{x:.3f} g<br>%{y:.2e}/yr<extra></extra>',
  }));

  const shapes: Record<string, unknown>[] = [];
  const anns: Record<string, unknown>[] = [];
  ([[1 / 475, '475 yr'], [1 / 2475, '2475 yr']] as const).forEach(([rp, label]) => {
    shapes.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: rp, y1: rp, line: { color: MARK, width: 1, dash: 'dot' } });
    anns.push({ xref: 'paper', x: 0, y: Math.log10(rp), text: label, showarrow: false, font: { color: MARK, size: 10, family: "'Roboto Mono', monospace" }, xanchor: 'left', yanchor: 'bottom', xshift: 3 });
  });

  Plotly.react(
    el,
    traces,
    baseLayout({
      title: figTitle('(b) Hazard at the site'),
      xaxis: axis({ title: 'PGA (g)', type: 'log', range: [Math.log10(0.004), Math.log10(2.5)] }),
      yaxis: axis({ title: 'Annual rate of exceedance', type: 'log', range: [-5, -1] }),
      shapes,
      annotations: anns,
    }),
    CONFIG,
  );
}

export function resizePlots(...els: HTMLElement[]): void {
  for (const el of els) Plotly.Plots.resize(el);
}
