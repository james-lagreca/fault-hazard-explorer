// Epistemic uncertainty: a configurable logic tree over the fault inputs,
// collapsed to weighted fractile hazard curves per MFD model, plus a
// one-at-a-time sensitivity (tornado) of the return-period motions.
//
// compute() stays the single best-estimate (OpenQuake-parity) path; every
// branch here is just compute() on perturbed inputs. Branches are taken on the
// raw fault description (dip, thickness, site position …), so a dip branch
// moves the down-dip width, area, moment rate, scaling Mmax and Rrup together,
// exactly as dragging the dip slider does. Fractiles are the same statistic as
// OpenQuake's `hazardlib.stats.quantile_curve`.

import { compute, scalingMagnitude } from './index';
import { widthFromDip, rrupFromTrace } from './geometry';
import { pgaAtRate } from './hazard';
import { MODEL_KEYS } from './types';
import type { GmpeKey, ModelKey, Params, ScalingKey } from './types';

/** The fault description as the user sets it; Params is derived from this. */
export interface FaultInputs {
  b: number;
  /** mm/yr */
  slip: number;
  /** Along-strike length, km. */
  L: number;
  /** Dip, degrees. */
  dip: number;
  /** Seismogenic thickness (vertical extent of rupture), km. */
  thickness: number;
  /** Depth to top of rupture, km. */
  ztor: number;
  /** Signed site position vs the trace, km (+ = hanging wall). */
  x: number;
  Mmin: number;
  Mmax: number;
  lockMax: boolean;
  vs30: number;
  gmpe: GmpeKey;
  scaling: ScalingKey;
  binWidth?: number;
}

/** Derive engine Params (W from dip/thickness, Rrup from the cross-section). */
export function paramsFromInputs(fi: FaultInputs): Params {
  const W = widthFromDip(fi.thickness, fi.dip);
  const { rrup } = rrupFromTrace(fi.x, fi.dip, fi.ztor, W);
  return {
    b: fi.b,
    slip: fi.slip,
    L: fi.L,
    W,
    Mmin: fi.Mmin,
    Mmax: fi.Mmax,
    lockMax: fi.lockMax,
    R: rrup,
    vs30: fi.vs30,
    gmpe: fi.gmpe,
    scaling: fi.scaling,
    binWidth: fi.binWidth,
  };
}

/**
 * Keefer & Bodily (1983) three-point discretization: each uncertain input's
 * 5th / 50th / 95th percentiles, weighted 0.185 / 0.63 / 0.185.
 */
export const BRANCH_WEIGHTS = [0.185, 0.63, 0.185] as const;

export type TreeParam = 'slip' | 'dip' | 'thickness' | 'b' | 'mmax';
export const TREE_PARAMS: readonly TreeParam[] = ['slip', 'dip', 'thickness', 'b', 'mmax'] as const;

/**
 * Enabled branch sets and their 5th/95th-percentile spreads. `slip` is a
 * multiplicative factor (÷f / ×f); the rest are ± offsets in their own units
 * (degrees, km, b units, magnitude units). `mmax` offsets the scaling
 * magnitude when Mmax is locked to area scaling. Omit a key to hold it fixed.
 */
export type LogicTree = Partial<Record<TreeParam, number>>;

export const DEFAULT_SPREADS: Record<TreeParam, number> = {
  slip: 2,
  dip: 15,
  thickness: 3,
  b: 0.15,
  mmax: 0.2,
};

/** The (low, central, high) input values of one branch set, clamped to physical limits. */
export function branchValues(param: TreeParam, fi: FaultInputs, spread: number): [number, number, number] {
  switch (param) {
    case 'slip':
      return [fi.slip / spread, fi.slip, fi.slip * spread];
    case 'dip':
      return [Math.max(fi.dip - spread, 10), fi.dip, Math.min(fi.dip + spread, 90)];
    case 'thickness':
      return [Math.max(fi.thickness - spread, 2), fi.thickness, fi.thickness + spread];
    case 'b':
      return [Math.max(fi.b - spread, 0.3), fi.b, fi.b + spread];
    case 'mmax':
      return [-spread, 0, spread]; // offsets, applied after scaling
  }
}

/** Apply one branch choice (0 = low, 1 = central, 2 = high) to the inputs. */
function applyBranch(fi: FaultInputs, param: TreeParam, v: number): FaultInputs {
  switch (param) {
    case 'slip':
      return { ...fi, slip: v };
    case 'dip':
      return { ...fi, dip: v };
    case 'thickness':
      return { ...fi, thickness: v };
    case 'b':
      return { ...fi, b: v };
    case 'mmax':
      return fi; // handled in paramsFor (needs the scaling magnitude)
  }
}

export interface HazardBand {
  lo: number[];
  hi: number[];
}

export interface Sensitivity {
  param: TreeParam;
  /** Input values of the low / high branch (for mmax: the resulting magnitudes). */
  lowValue: number;
  highValue: number;
  /** Per model: PGA (g) at the RP on the low / high branch, holding the rest central. */
  byModel: Record<ModelKey, { rp475: [number | null, number | null]; rp2475: [number | null, number | null] }>;
}

export interface UncertaintyResult {
  pga: number[];
  quantiles: [number, number];
  /** Number of end branches in the full tree. */
  nBranches: number;
  /** Per-model lower / upper fractile hazard curves vs `pga`. */
  bandByModel: Record<ModelKey, HazardBand>;
  /** PGA (g) read off the fractile curves at 475 / 2475 yr: [lo curve, hi curve]. */
  bandAtRP: Record<ModelKey, { rp475: [number | null, number | null]; rp2475: [number | null, number | null] }>;
  /** Best-estimate PGA at the RPs (central branch == compute()). */
  bestAtRP: Record<ModelKey, { rp475: number | null; rp2475: number | null }>;
  /** One-at-a-time swings, in TREE_PARAMS order (enabled params only). */
  sensitivity: Sensitivity[];
}

/**
 * Weighted quantile of `values`, matching hazardlib.stats.quantile_curve:
 * sort, accumulate the normalized weights, and linearly interpolate the
 * quantile on the cumulative-weight axis (clamped at both ends).
 */
export function weightedQuantile(values: number[], weights: number[], q: number): number {
  const idx = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const total = weights.reduce((s, w) => s + w, 0);
  let cum = 0;
  const cw: number[] = [];
  const sv: number[] = [];
  for (const i of idx) {
    cum += weights[i]! / total;
    cw.push(cum);
    sv.push(values[i]!);
  }
  if (q <= cw[0]!) return sv[0]!;
  for (let j = 1; j < cw.length; j++) {
    if (q <= cw[j]!) {
      const t = (q - cw[j - 1]!) / (cw[j]! - cw[j - 1]!);
      return sv[j - 1]! + t * (sv[j]! - sv[j - 1]!);
    }
  }
  return sv[sv.length - 1]!;
}

const RP_475 = 1 / 475;
const RP_2475 = 1 / 2475;

/**
 * Off-central branches integrate on a magnitude grid no finer than this (the
 * central branch keeps the caller's exact grid, so it equals compute()). The
 * fractiles move < ~1% between dM 0.02 and 0.05, for ~2.5× less work per branch.
 */
export const TREE_MIN_BIN_WIDTH = 0.05;

/**
 * Weighted quantiles of one column of a curve set, allocation-free: `vals` and
 * `idx` are scratch buffers of length n. Same interpolation as weightedQuantile.
 */
function columnQuantiles(
  vals: Float64Array,
  idx: Uint32Array,
  weights: Float64Array,
  qs: readonly number[],
): number[] {
  const n = vals.length;
  for (let j = 0; j < n; j++) idx[j] = j;
  idx.sort((a, b) => vals[a]! - vals[b]!);
  return qs.map((q) => {
    let prevC = 0;
    let prevV = vals[idx[0]!]!;
    for (let j = 0; j < n; j++) {
      const v = vals[idx[j]!]!;
      const c = prevC + weights[idx[j]!]!;
      if (q <= c) {
        if (j === 0) return v;
        return prevV + ((q - prevC) / (c - prevC)) * (v - prevV);
      }
      prevC = c;
      prevV = v;
    }
    return prevV;
  });
}

/**
 * Run the logic tree. Hazard is linear in slip rate, so slip branches scale a
 * curve instead of re-integrating it; every other combination is one
 * compute() call, memoized so the sensitivity runs reuse tree branches.
 */
export function runLogicTree(
  fi: FaultInputs,
  tree: LogicTree,
  quantiles: [number, number] = [0.15, 0.85],
): UncertaintyResult {
  const enabled = TREE_PARAMS.filter((p) => tree[p] != null);
  const values = {} as Record<TreeParam, [number, number, number]>;
  for (const p of enabled) values[p] = branchValues(p, fi, tree[p]!);
  const physical = enabled.filter((p) => p !== 'slip');
  const slipFactors: number[] = tree.slip != null ? values.slip.map((s) => s / fi.slip) : [1];
  const slipWeights: number[] = tree.slip != null ? [...BRANCH_WEIGHTS] : [1];

  // choice[p] ∈ {0,1,2}; missing → central.
  const cache = new Map<string, Record<ModelKey, number[]>>();
  let pga: number[] = [];
  const hazardFor = (choice: Partial<Record<TreeParam, number>>): Record<ModelKey, number[]> => {
    const key = physical.map((p) => choice[p] ?? 1).join('');
    const hit = cache.get(key);
    if (hit) return hit;
    let f = fi;
    for (const p of physical) f = applyBranch(f, p, values[p][choice[p] ?? 1]!);
    if (/[02]/.test(key)) f = { ...f, binWidth: Math.max(fi.binWidth ?? 0.1, TREE_MIN_BIN_WIDTH) };
    const params = paramsFromInputs(f);
    if (tree.mmax != null) {
      const dm = values.mmax[choice.mmax ?? 1]!;
      if (dm !== 0) {
        // Resolve the locked scaling magnitude first, then offset it.
        const base = params.lockMax ? scalingMagnitude(params) : params.Mmax;
        params.lockMax = false;
        params.Mmax = base + dm;
      }
    }
    const r = compute(params);
    pga = r.pga;
    cache.set(key, r.hazByModel);
    return r.hazByModel;
  };

  // Full tree: cartesian product over physical branches × slip factors. Slip
  // branches keep a reference to the physical curve plus a scale factor.
  const bases: Record<ModelKey, number[]>[] = [];
  const factors: number[] = [];
  const wList: number[] = [];
  const nPhys = Math.pow(3, physical.length);
  for (let code = 0; code < nPhys; code++) {
    const choice: Partial<Record<TreeParam, number>> = {};
    let w = 1;
    let c = code;
    for (const p of physical) {
      const i = c % 3;
      c = Math.floor(c / 3);
      choice[p] = i;
      w *= BRANCH_WEIGHTS[i]!;
    }
    const haz = hazardFor(choice);
    slipFactors.forEach((sf, is) => {
      bases.push(haz);
      factors.push(sf);
      wList.push(w * slipWeights[is]!);
    });
  }
  const n = wList.length;
  const wTotal = wList.reduce((a, b) => a + b, 0);
  const weights = Float64Array.from(wList, (w) => w / wTotal);

  const central = hazardFor({});
  const bandByModel = {} as Record<ModelKey, HazardBand>;
  const bandAtRP = {} as UncertaintyResult['bandAtRP'];
  const bestAtRP = {} as UncertaintyResult['bestAtRP'];
  const vals = new Float64Array(n);
  const idx = new Uint32Array(n);
  for (const k of MODEL_KEYS) {
    const lo: number[] = [];
    const hi: number[] = [];
    for (let i = 0; i < pga.length; i++) {
      for (let j = 0; j < n; j++) vals[j] = bases[j]![k][i]! * factors[j]!;
      const [a, b] = columnQuantiles(vals, idx, weights, quantiles);
      lo.push(a!);
      hi.push(b!);
    }
    bandByModel[k] = { lo, hi };
    bandAtRP[k] = {
      rp475: [pgaAtRate(pga, lo, RP_475), pgaAtRate(pga, hi, RP_475)],
      rp2475: [pgaAtRate(pga, lo, RP_2475), pgaAtRate(pga, hi, RP_2475)],
    };
    bestAtRP[k] = { rp475: pgaAtRate(pga, central[k], RP_475), rp2475: pgaAtRate(pga, central[k], RP_2475) };
  }

  // One-at-a-time: each enabled input at its low / high branch, rest central.
  const sensitivity: Sensitivity[] = enabled.map((p) => {
    const at = (i: 0 | 2): Record<ModelKey, number[]> => {
      if (p !== 'slip') return hazardFor({ [p]: i });
      const sf = slipFactors[i]!;
      const out = {} as Record<ModelKey, number[]>;
      for (const k of MODEL_KEYS) out[k] = central[k].map((v) => v * sf);
      return out;
    };
    const lo = at(0);
    const hi = at(2);
    const byModel = {} as Sensitivity['byModel'];
    for (const k of MODEL_KEYS) {
      byModel[k] = {
        rp475: [pgaAtRate(pga, lo[k], RP_475), pgaAtRate(pga, hi[k], RP_475)],
        rp2475: [pgaAtRate(pga, lo[k], RP_2475), pgaAtRate(pga, hi[k], RP_2475)],
      };
    }
    if (p === 'mmax') {
      const base = fi.lockMax ? scalingMagnitude(paramsFromInputs(fi)) : fi.Mmax;
      return { param: p, lowValue: base + values.mmax[0], highValue: base + values.mmax[2], byModel };
    }
    return { param: p, lowValue: values[p][0], highValue: values[p][2], byModel };
  });

  return { pga, quantiles, nBranches: n, bandByModel, bandAtRP, bestAtRP, sensitivity };
}
