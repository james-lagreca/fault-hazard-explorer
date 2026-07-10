// Control state: read the DOM controls into Params, sync the value labels,
// and apply presets. Slip uses a log-mapped slider (0.01 … 30 mm/yr).

import type { GmpeKey, Params } from '../engine/types';

export const slipFromSlider = (s: number): number => 0.01 * Math.pow(3000, s / 1000);
export const sliderFromSlip = (v: number): number => 1000 * (Math.log(v / 0.01) / Math.log(3000));

const $ = <T extends HTMLElement = HTMLInputElement>(id: string): T =>
  document.getElementById(id) as T;

export function readParams(): Params {
  const lockMax = ($('lockmax') as HTMLInputElement).checked;
  return {
    b: +$('b').value,
    slip: slipFromSlider(+$('slip').value),
    L: +$('len').value,
    W: +$('wid').value,
    Mmin: +$('mmin').value,
    Mmax: +$('mmax').value,
    lockMax,
    R: +$('r').value,
    vs30: +$('vs30').value,
    gmpe: ($('gmpe') as unknown as HTMLSelectElement).value as GmpeKey,
    binWidth: 0.1,
  } satisfies Params;
}

export function syncLabels(): void {
  const set = (id: string, html: string) => {
    const e = document.getElementById(id);
    if (e) e.innerHTML = html;
  };
  set('vb', (+$('b').value).toFixed(2));
  set('vslip', slipFromSlider(+$('slip').value).toFixed(2) + ' <span class="u">mm/yr</span>');
  set('vlen', $('len').value + ' <span class="u">km</span>');
  set('vwid', $('wid').value + ' <span class="u">km</span>');
  set('vmmin', (+$('mmin').value).toFixed(1));
  set('vr', $('r').value + ' <span class="u">km</span>');
  set('vvs30', $('vs30').value + ' <span class="u">m/s</span>');
}

export interface Preset {
  b: number;
  slip: number; // mm/yr
  len: number;
  wid: number;
  mmin: number;
  r: number;
  vs30: number;
  gmpe: GmpeKey;
  lockMax: boolean;
}

export const PRESETS: Record<string, Preset> = {
  reset: { b: 1.0, slip: 0.3, len: 40, wid: 15, mmin: 5.0, r: 10, vs30: 760, gmpe: 'allen', lockMax: true },
  se: { b: 0.9, slip: 0.04, len: 30, wid: 15, mmin: 5.0, r: 12, vs30: 760, gmpe: 'allen', lockMax: true },
  nz: { b: 1.05, slip: 25, len: 120, wid: 18, mmin: 5.5, r: 8, vs30: 400, gmpe: 'gen', lockMax: true },
};

export function applyPreset(name: string): void {
  const p = PRESETS[name];
  if (!p) return;
  ($('b') as HTMLInputElement).value = String(p.b);
  ($('slip') as HTMLInputElement).value = String(sliderFromSlip(p.slip));
  ($('len') as HTMLInputElement).value = String(p.len);
  ($('wid') as HTMLInputElement).value = String(p.wid);
  ($('mmin') as HTMLInputElement).value = String(p.mmin);
  ($('r') as HTMLInputElement).value = String(p.r);
  ($('vs30') as HTMLInputElement).value = String(p.vs30);
  ($('gmpe') as unknown as HTMLSelectElement).value = p.gmpe;
  ($('lockmax') as HTMLInputElement).checked = p.lockMax;
}
