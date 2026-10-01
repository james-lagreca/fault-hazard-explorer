// Floating ruptures on the fault plane, in the manner of OpenQuake's
// SimpleFaultSource: each magnitude's rupture takes the median area of the
// chosen scaling relation and the rupture aspect ratio (L/W), is capped at the
// fault's down-dip width (then lengthened to keep the area) and at the fault
// length, and floats uniformly over the plane. Each position gets its own
// Rrup, Rjb and hypocentre (the rupture centroid, OpenQuake's default), and a
// bin's exceedance probability is the average over positions.
//
// Geometry (km): strike along y over [0, L]; x horizontal, positive in the dip
// direction (hanging wall); z depth. The plane's top edge runs along x = 0 at
// depth ztor and dips at δ to down-dip width W. The site is at the surface,
// (x, L/2, 0) — opposite the middle of the fault, as in the cross-section.

import { makeGmm } from './gmpe';
import { ncdf } from './hazard';
import type { GmpeKey, Mfd, ScalingKey } from './types';

/** Median rupture area (km²) for a magnitude: the inverse of each area→M relation. */
export const SCALING_AREA: Record<ScalingKey, (mag: number) => number> = {
  wc94: (m) => 10 ** ((m - 4.07) / 0.98),
  leonard14: (m) => 10 ** (m - 4.19), // dip-slip
  tmg17: (m) => 10 ** (-4.362 + 1.049 * m),
};

export interface FloatingSpec {
  L: number;
  W: number;
  dip: number;
  ztor: number;
  /** Signed site position across strike, km (+ = hanging wall). */
  x: number;
  /** Rupture aspect ratio, length / width. */
  aspectRatio: number;
  scaling: ScalingKey;
  gmpe: GmpeKey;
  vs30: number;
}

export interface RuptureDims {
  length: number;
  width: number;
  /** True when the rupture hit the fault's down-dip width and was lengthened. */
  widthLimited: boolean;
  /** True when it then also hit the fault length (area no longer conserved). */
  lengthLimited: boolean;
}

/** Rupture length / width for a magnitude (OpenQuake's get_rupture_dimensions logic). */
export function ruptureDims(mag: number, spec: Pick<FloatingSpec, 'L' | 'W' | 'aspectRatio' | 'scaling'>): RuptureDims {
  const area = SCALING_AREA[spec.scaling](mag);
  let length = Math.sqrt(area * spec.aspectRatio);
  let width = area / length;
  let widthLimited = false;
  let lengthLimited = false;
  if (width > spec.W) {
    width = spec.W;
    length = area / width;
    widthLimited = true;
  }
  if (length > spec.L) {
    length = spec.L;
    lengthLimited = true;
  }
  return { length, width, widthLimited, lengthLimited };
}

/** Magnitude above which ruptures are width-limited (rupture width = fault width). */
export function widthLimitMagnitude(spec: Pick<FloatingSpec, 'W' | 'aspectRatio' | 'scaling'>): number {
  // area = AR · W²  → invert the scaling relation numerically (monotone in M).
  const target = spec.aspectRatio * spec.W ** 2;
  let lo = 2;
  let hi = 10;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (SCALING_AREA[spec.scaling](mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Float positions: a rupture of extent `size` slides over [0, span] in steps
 * of FLOAT_STEP km (OpenQuake steps by its rupture mesh spacing), endpoints
 * included, evenly spread when the free length isn't a whole number of steps.
 */
export const FLOAT_STEP = 1.0;
function floatStarts(span: number, size: number): number[] {
  const free = Math.max(span - size, 0);
  const n = Math.floor(free / FLOAT_STEP + 1e-9) + 1;
  if (n <= 1) return [free / 2];
  return Array.from({ length: n }, (_, i) => (free * i) / (n - 1));
}

/** Rrup and Rjb from the site to one rupture rectangle on the plane. */
function rectDistances(
  spec: FloatingSpec,
  s0: number,
  len: number,
  d0: number,
  wid: number,
): { rrup: number; rjb: number; hypo: number } {
  const dip = (spec.dip * Math.PI) / 180;
  const cd = Math.cos(dip);
  const sd = Math.sin(dip);
  const ys = spec.L / 2;
  // In-plane coordinates of the site: u along strike, v down-dip from the top
  // edge; n² the squared offset normal to the plane.
  const u = ys;
  const v = spec.x * cd - spec.ztor * sd;
  const op2 = spec.x ** 2 + ys ** 2 + spec.ztor ** 2;
  const n2 = Math.max(op2 - u ** 2 - v ** 2, 0);
  const du = u < s0 ? s0 - u : u > s0 + len ? u - (s0 + len) : 0;
  const dv = v < d0 ? d0 - v : v > d0 + wid ? v - (d0 + wid) : 0;
  const rrup = Math.sqrt(du ** 2 + dv ** 2 + n2);
  // Surface projection: y ∈ [s0, s0+len], x ∈ [d0·cosδ, (d0+wid)·cosδ].
  const x0 = d0 * cd;
  const x1 = (d0 + wid) * cd;
  const dx = spec.x < x0 ? x0 - spec.x : spec.x > x1 ? spec.x - x1 : 0;
  const dy = ys < s0 ? s0 - ys : ys > s0 + len ? ys - (s0 + len) : 0;
  const rjb = Math.hypot(dx, dy);
  const hypo = spec.ztor + (d0 + wid / 2) * sd;
  return { rrup, rjb, hypo };
}

/**
 * Per-magnitude GMM predictions over the float positions, as (ln-mean, sigma,
 * weight) triples with weights summing to 1. Every float position is counted,
 * but along strike, positions whose distance to the site barely differs are
 * evaluated once: within each down-dip row, positions are sorted by their
 * along-strike offset from the site and grouped while the offset spread stays
 * within GROUP_TOL of the rupture distance (or GROUP_ABS km); each group is
 * evaluated at its median member with the group's total weight. Ruptures that
 * overlap the site along strike (offset 0) collapse into one group exactly.
 */
const GROUP_TOL = 0.03;
const GROUP_ABS = 0.5;

function predictionsFor(spec: FloatingSpec, mag: number): Float64Array {
  const d = ruptureDims(mag, spec);
  const ss = floatStarts(spec.L, d.length);
  const ds = floatStarts(spec.W, d.width);
  const ys = spec.L / 2;
  const wUnit = 1 / (ss.length * ds.length);
  // Along-strike offset of each start from the site (0 when the rupture spans it).
  const offsets = ss
    .map((s0) => (ys < s0 ? s0 - ys : ys > s0 + d.length ? ys - (s0 + d.length) : 0))
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const d0 of ds) {
    // Distance floor for this row (offset 0): sets the grouping tolerance scale.
    let i = 0;
    while (i < offsets.length) {
      const g0 = rectDistances(spec, ys - offsets[i]! - d.length, d.length, d0, d.width);
      const tol = Math.max(GROUP_ABS, GROUP_TOL * g0.rrup);
      let j = i;
      while (j + 1 < offsets.length && offsets[j + 1]! - offsets[i]! <= tol) j++;
      const mid = offsets[(i + j) >> 1]!;
      // A start placing the rupture's far end `mid` short of the site.
      const s0 = mid === 0 ? ys - d.length / 2 : ys - mid - d.length;
      const g = rectDistances(spec, s0, d.length, d0, d.width);
      const p = makeGmm(spec.gmpe, { rrup: g.rrup, rjb: g.rjb, vs30: spec.vs30, hypoDepth: g.hypo })(mag);
      out.push(p.lnMean, p.sigma, (j - i + 1) * wUnit);
      i = j + 1;
    }
  }
  return Float64Array.from(out);
}

/**
 * 1 − Φ(z) from a table of the engine's own ncdf, linearly interpolated: the
 * floating path evaluates it ~10⁶ times per curve set. Step 1/512 keeps the
 * interpolation error ≲ 1e-7, the same order as ncdf's own (A&S 26.2.17).
 */
const Q_ZMAX = 9;
const Q_STEP = 1 / 512;
const Q_TABLE = Float64Array.from({ length: Math.round((2 * Q_ZMAX) / Q_STEP) + 2 }, (_, i) => 1 - ncdf(-Q_ZMAX + i * Q_STEP));
function qfast(z: number): number {
  if (z <= -Q_ZMAX) return 1;
  if (z >= Q_ZMAX) return 0;
  const t = (z + Q_ZMAX) / Q_STEP;
  const i = t | 0;
  const f = t - i;
  return Q_TABLE[i]! + f * (Q_TABLE[i + 1]! - Q_TABLE[i]!);
}

function exceedance(pred: Float64Array, lnx: number): number {
  let s = 0;
  for (let j = 0; j < pred.length; j += 3) s += pred[j + 2]! * qfast((lnx - pred[j]!) / pred[j + 1]!);
  return s;
}

// Exceedance tables are pure functions of (geometry, GMM, site, magnitude), so
// they are shared across MFD models and across b / Mmax / slip branches.
interface GeomCache {
  preds: Map<number, Float64Array>;
  curves: Map<number, Float64Array>;
}
const CACHE = new Map<string, GeomCache>();
const CACHE_MAX = 48;

function geomCache(spec: FloatingSpec): GeomCache {
  const key = [spec.L, spec.W, spec.dip, spec.ztor, spec.x, spec.aspectRatio, spec.scaling, spec.gmpe, spec.vs30].join('|');
  let c = CACHE.get(key);
  if (!c) {
    if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value!);
    c = { preds: new Map(), curves: new Map() };
    CACHE.set(key, c);
  }
  return c;
}

const magKey = (m: number) => Math.round(m * 1e6) / 1e6;

/** Floating-rupture hazard engine for one fault geometry, GMM and site. */
export function floatingModel(spec: FloatingSpec, pga: number[]) {
  const cache = geomCache(spec);
  const lnPga = pga.map(Math.log);
  const predsAt = (m: number): Float64Array => {
    const k = magKey(m);
    let p = cache.preds.get(k);
    if (!p) {
      p = predictionsFor(spec, m);
      cache.preds.set(k, p);
    }
    return p;
  };
  const curveAt = (m: number): Float64Array => {
    const k = magKey(m);
    let c = cache.curves.get(k);
    if (!c) {
      const p = predsAt(m);
      c = Float64Array.from(lnPga, (lx) => exceedance(p, lx));
      cache.curves.set(k, c);
    }
    return c;
  };
  return {
    /** λ(>x) = Σᵢ rateᵢ · P̄ᵢ(X > x), P̄ averaged over float positions. */
    hazard(mfd: Mfd): number[] {
      const lam = new Array<number>(pga.length).fill(0);
      mfd.mids.forEach((m, i) => {
        const r = mfd.rates[i]!;
        if (r <= 0) return;
        const c = curveAt(m);
        for (let j = 0; j < pga.length; j++) lam[j]! += r * c[j]!;
      });
      return lam;
    },
    /** Magnitude deaggregation at x* with the position-averaged exceedance. */
    deaggregate(mfd: Mfd, xstar: number | null): number[] | null {
      if (xstar == null) return null;
      const lx = Math.log(xstar);
      const contrib = mfd.mids.map((m, i) => {
        const r = mfd.rates[i]!;
        return r > 0 ? r * exceedance(predsAt(m), lx) : 0;
      });
      const total = contrib.reduce((s, c) => s + c, 0);
      return total > 0 ? contrib.map((c) => c / total) : null;
    },
  };
}
