// Island entry: wires controls ↔ engine ↔ plots ↔ readout.
import { compute } from '../engine/index';
import { runLogicTree } from '../engine/uncertainty';
import { MODEL_KEYS } from '../engine/types';
import type { ModelKey } from '../engine/types';
import { MAX_WIDTH_KM } from '../engine/geometry';
import { MODEL_META, renderMFD, renderHazard, renderDeagg, renderTornado, resizePlots } from './plots';
import { applyPreset, readState, readTree, syncLabels } from './controls';

const shown: Record<ModelKey, boolean> = { GR: true, TGR: true, CHAR: true, MMAX: true };
let deaggRP: '475' | '2475' = '475';
let torRP: '475' | '2475' = '475';

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
  const torEl = $('tornado');
  if (!mfdEl || !hazEl || !deaggEl || !torEl) return;

  const { params: p, geom, inputs } = readState();
  const r = compute(p);
  const tree = readTree();
  const u = Object.keys(tree).length > 0 ? runLogicTree(inputs, tree) : null;

  renderMFD(mfdEl, r, shown);
  const showBand = ($('band') as HTMLInputElement | null)?.checked ?? false;
  renderHazard(hazEl, r, shown, showBand ? u : null);
  renderDeagg(deaggEl, r, shown, deaggRP);
  const torModel = (($('tormodel') as HTMLSelectElement | null)?.value ?? 'TGR') as ModelKey;
  renderTornado(torEl, u, torModel, torRP);

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
  // The logic tree re-runs compute() per branch, so coalesce bursts of slider
  // events into one render per frame.
  let pending = 0;
  const schedule = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      syncLabels();
      render();
    });
  };
  const treeIds = ['slip', 'dip', 'thickness', 'b', 'mmax'].flatMap((k) => [`lt_${k}`, `lt_${k}_on`]);
  const inputs = ['b', 'slip', 'len', 'dip', 'thick', 'ztor', 'mmin', 'mmax', 'r', 'vs30', 'gmpe', 'lockmax', 'scalerel', 'band', 'tormodel', ...treeIds];
  for (const id of inputs) {
    const el = $(id);
    if (el) el.addEventListener('input', schedule);
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

  // Two independent return-period toggles: deaggregation (c) and tornado (d).
  const wireRP = (groupId: string, set: (rp: '475' | '2475') => void) => {
    const btns = document.querySelectorAll<HTMLButtonElement>(`#${groupId} .rpbtn`);
    btns.forEach((btn) =>
      btn.addEventListener('click', () => {
        set(btn.dataset.rp === '2475' ? '2475' : '475');
        btns.forEach((b) => {
          const on = b === btn;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', String(on));
        });
        render();
      }),
    );
  };
  wireRP('rprow', (rp) => (deaggRP = rp));
  wireRP('torrp', (rp) => (torRP = rp));

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
      const torEl = $('tornado');
      if (mfdEl && hazEl && deaggEl && torEl) resizePlots(mfdEl, hazEl, deaggEl, torEl);
    });
  });

  syncLabels();
  render();
}
