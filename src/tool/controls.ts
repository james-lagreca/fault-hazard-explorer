// Control state: read the DOM controls into engine Params plus the derived
// geometry, sync the value labels, and apply presets. Slip uses a log-mapped
// slider (0.01 … 30 mm/yr). Width and Rrup are derived — dip, seismogenic
// thickness and top depth set the plane; the signed site-position slider
// (positive = hanging-wall side) sets the rupture distance.

import type { GmpeKey, Params, ScalingKey } from '../engine/types';
import { paramsFromInputs } from '../engine/uncertainty';
import type { FaultInputs } from '../engine/uncertainty';
import { widthFromDip, rrupFromTrace } from '../engine/geometry';
import type { SiteGeometry } from '../engine/geometry';

export const slipFromSlider = (s: number): number => 0.01 * Math.pow(3000, s / 1000);
export const sliderFromSlip = (v: number): number => 1000 * (Math.log(v / 0.01) / Math.log(3000));

/** Display bin width — finer than the OQ-parity default (0.1) for smooth curves. */
const DISPLAY_BIN_WIDTH = 0.02;

const $ = <T extends HTMLElement = HTMLInputElement>(id: string): T =>
  document.getElementById(id) as T;

export interface Geometry extends SiteGeometry {
  dip: number;
  thickness: number;
  ztor: number;
  /** Signed horizontal site position vs the trace, km (+ = hanging wall). */
  x: number;
  /** Derived down-dip width, km. */
  W: number;
}

export interface ToolState {
  params: Params;
  geom: Geometry;
  /** The raw fault description the logic tree perturbs. */
  inputs: FaultInputs;
}

function readGeometry(): Geometry {
  const dip = +$('dip').value;
  const thickness = +$('thick').value;
  const ztor = +$('ztor').value;
  const x = +$('r').value;
  const W = widthFromDip(thickness, dip);
  return { dip, thickness, ztor, x, W, ...rrupFromTrace(x, dip, ztor, W) };
}

export function readState(): ToolState {
  const geom = readGeometry();
  const inputs: FaultInputs = {
    b: +$('b').value,
    slip: slipFromSlider(+$('slip').value),
    L: +$('len').value,
    dip: geom.dip,
    thickness: geom.thickness,
    ztor: geom.ztor,
    x: geom.x,
    Mmin: +$('mmin').value,
    Mmax: +$('mmax').value,
    lockMax: ($('lockmax') as HTMLInputElement).checked,
    vs30: +$('vs30').value,
    gmpe: ($('gmpe') as unknown as HTMLSelectElement).value as GmpeKey,
    scaling: ($('scalerel') as unknown as HTMLSelectElement).value as ScalingKey,
    binWidth: DISPLAY_BIN_WIDTH,
    rupture: ($('rupmodel') as unknown as HTMLSelectElement).value === 'plane' ? 'plane' : 'floating',
    aspectRatio: +$('ar').value,
  };
  return { params: paramsFromInputs(inputs), geom, inputs };
}

export function syncLabels(): void {
  const set = (id: string, html: string) => {
    const e = document.getElementById(id);
    if (e) e.innerHTML = html;
  };
  const g = readGeometry();
  set('vb', (+$('b').value).toFixed(2));
  set('vslip', slipFromSlider(+$('slip').value).toFixed(2) + ' <span class="u">mm/yr</span>');
  set('vlen', $('len').value + ' <span class="u">km</span>');
  set('vdip', g.dip + '° <span class="u">→ W ' + g.W.toFixed(1) + ' km</span>');
  set('vthick', g.thickness + ' <span class="u">km</span>');
  set('vztor', g.ztor.toFixed(1) + ' <span class="u">km</span>');
  set('vmmin', (+$('mmin').value).toFixed(1));
  set(
    'vr',
    (g.x > 0 ? '+' : '') + g.x + ' <span class="u">km · ' + g.side + '</span>',
  );
  set('vvs30', $('vs30').value + ' <span class="u">m/s</span>');
  set('var', (+$('ar').value).toFixed(1));
}

export interface Preset {
  b: number;
  slip: number; // mm/yr
  len: number;
  dip: number;
  thick: number;
  ztor: number;
  mmin: number;
  x: number; // signed site position, km
  vs30: number;
  gmpe: GmpeKey;
  scaling: ScalingKey;
  lockMax: boolean;
}

export const PRESETS: Record<string, Preset> = {
  reset: { b: 1.0, slip: 0.3, len: 40, dip: 45, thick: 15, ztor: 0, mmin: 5.0, x: 10, vs30: 760, gmpe: 'allen', scaling: 'wc94', lockMax: true },
  se: { b: 0.9, slip: 0.04, len: 30, dip: 40, thick: 12, ztor: 1, mmin: 5.0, x: 12, vs30: 760, gmpe: 'allen', scaling: 'leonard14', lockMax: true },
  nz: { b: 1.05, slip: 25, len: 120, dip: 50, thick: 20, ztor: 0, mmin: 5.5, x: 8, vs30: 400, gmpe: 'gen', scaling: 'wc94', lockMax: true },
};

export function applyPreset(name: string): void {
  const p = PRESETS[name];
  if (!p) return;
  ($('b') as HTMLInputElement).value = String(p.b);
  ($('slip') as HTMLInputElement).value = String(sliderFromSlip(p.slip));
  ($('len') as HTMLInputElement).value = String(p.len);
  ($('dip') as HTMLInputElement).value = String(p.dip);
  ($('thick') as HTMLInputElement).value = String(p.thick);
  ($('ztor') as HTMLInputElement).value = String(p.ztor);
  ($('mmin') as HTMLInputElement).value = String(p.mmin);
  ($('r') as HTMLInputElement).value = String(p.x);
  ($('vs30') as HTMLInputElement).value = String(p.vs30);
  ($('gmpe') as unknown as HTMLSelectElement).value = p.gmpe;
  ($('scalerel') as unknown as HTMLSelectElement).value = p.scaling;
  ($('lockmax') as HTMLInputElement).checked = p.lockMax;
}
