// Island entry: wires controls ↔ engine ↔ plots ↔ readout.
import { compute } from '../engine/index';
import { MODEL_KEYS } from '../engine/types';
import type { ModelKey } from '../engine/types';
import { MAX_WIDTH_KM } from '../engine/geometry';
import { MODEL_META, renderMFD, renderHazard, renderDeagg, resizePlots } from './plots';
import { applyPreset, readState, syncLabels } from './controls';

const shown: Record<ModelKey, boolean> = { GR: true, TGR: true, CHAR: true, MMAX: true };
let deaggRP: '475' | '2475' = '475';

const $ = (id: string) => document.getElementById(id);
const setHTML = (id: string, html: string) => {
  const e = $(id);
  if (e) e.innerHTML = html;
};

const fmtYears = (y: number | null): string =>
  y == null ? '—' : y >= 1e4 ? (y / 1e3).toFixed(1) + 'k yr' : Math.round(y).toLocaleString() + ' yr';
const fmtG = (g: number | null): string => (g == null ? '—' : g.toFixed(3) + ' g');

function render(): void {
  const mfdEl = $('mfd');
  const hazEl = $('haz');
  const deaggEl = $('deagg');
  if (!mfdEl || !hazEl || !deaggEl) return;

  const { params: p, geom } = readState();
  const r = compute(p);

  renderMFD(mfdEl, r, shown);
  renderHazard(hazEl, r, shown);
  renderDeagg(deaggEl, r, shown, deaggRP);

  // Mmax control: disabled & mirrored when locked to scaling.
  const mmaxInput = $('mmax') as HTMLInputElement | null;
  if (mmaxInput) {
    mmaxInput.disabled = p.lockMax;
    if (p.lockMax) mmaxInput.value = String(r.scalingMag);
  }
  setHTML('vmmax', r.Mmax.toFixed(2) + (p.lockMax ? ' <span class="u">(scaling)</span>' : ''));

  // Readout tiles.
  const exp = Math.floor(Math.log10(r.momentRate));
  setHTML(
    't_mo',
    (r.momentRate / Math.pow(10, exp)).toFixed(2) + '×10<sup>' + exp + '</sup> <span class="u">N·m/yr</span>',
  );
  const area = p.L * p.W;
  setHTML('t_area', area.toFixed(0) + ' km² <span class="u">· M</span>' + r.scalingMag.toFixed(2));
  setHTML('t_rrup', geom.rrup.toFixed(1) + ' km <span class="u">· ' + geom.side + '</span>');

  // Per-model table.
  let rows = '';
  for (const k of MODEL_KEYS) {
    const rp = r.pgaAtRP[k];
    rows +=
      `<tr class="${shown[k] ? '' : 'off'}">` +
      `<td><span class="mdot" style="background:${MODEL_META[k].color}"></span>${MODEL_META[k].name}</td>` +
      `<td>${fmtYears(r.recurrenceByModel[k])}</td>` +
      `<td>${fmtG(rp.rp475)}</td>` +
      `<td>${fmtG(rp.rp2475)}</td></tr>`;
  }
  setHTML('tbody', rows);

  // Scaling + segmentation notes.
  const widthCapped = geom.W >= MAX_WIDTH_KM;
  setHTML(
    'scalenote',
    'Area scaling → M' + r.scalingMag.toFixed(2) + (widthCapped ? ' · width capped at ' + MAX_WIDTH_KM + ' km' : ''),
  );
  const seg = $('segnote');
  if (seg) {
    if (!p.lockMax && p.Mmax < r.scalingMag - 0.05) {
      seg.classList.add('show');
      seg.innerHTML =
        'Segmented: M<sub>max</sub> capped ' +
        (r.scalingMag - p.Mmax).toFixed(2) +
        ' below full rupture. Same moment → same-size events more often, not bigger ones.';
    } else {
      seg.classList.remove('show');
    }
  }
}

export function initHazardTool(): void {
  const inputs = ['b', 'slip', 'len', 'dip', 'thick', 'ztor', 'mmin', 'mmax', 'r', 'vs30', 'gmpe', 'lockmax', 'scalerel'];
  for (const id of inputs) {
    const el = $(id);
    if (el) el.addEventListener('input', () => { syncLabels(); render(); });
  }

  document.querySelectorAll<HTMLButtonElement>('.chip').forEach((c) =>
    c.addEventListener('click', () => {
      const m = c.dataset.m as ModelKey;
      shown[m] = !shown[m];
      c.classList.toggle('on', shown[m]);
      c.setAttribute('aria-pressed', String(shown[m]));
      render();
    }),
  );

  document.querySelectorAll<HTMLButtonElement>('.rpbtn').forEach((btn) =>
    btn.addEventListener('click', () => {
      deaggRP = (btn.dataset.rp === '2475' ? '2475' : '475');
      document.querySelectorAll<HTMLButtonElement>('.rpbtn').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      render();
    }),
  );

  document.querySelectorAll<HTMLButtonElement>('.preset').forEach((btn) =>
    btn.addEventListener('click', () => {
      applyPreset(btn.dataset.p ?? 'reset');
      syncLabels();
      render();
    }),
  );

  let raf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const mfdEl = $('mfd');
      const hazEl = $('haz');
      const deaggEl = $('deagg');
      if (mfdEl && hazEl && deaggEl) resizePlots(mfdEl, hazEl, deaggEl);
    });
  });

  syncLabels();
  render();
}
