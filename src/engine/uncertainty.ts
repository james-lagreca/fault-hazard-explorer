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
 * Keefer & Bodily (1983) three-point discretization weights (5th / 50th / 95th
 * percentiles) — used for the default tree.
 */
export const KB_WEIGHTS = [0.185, 0.63, 0.185] as const;

export type TreeParam = 'slip' | 'dip' | 'thickness' | 'b' | 'mmax';
export const TREE_PARAMS: readonly TreeParam[] = ['slip', 'dip', 'thickness', 'b', 'mmax'] as const;

/**
 * How a branch value is read. Branches follow the best-estimate inputs: slip
 * rate branches are multiplicative factors on the slider value, the rest are
 * additive offsets (degrees, km, b units, magnitude units). The `mmax` offset
 * applies to the scaling magnitude when Mmax is locked to area scaling.
 */
export const TREE_MODE: Record<TreeParam, 'factor' | 'offset'> = {
  slip: 'factor',
  dip: 'offset',
  thickness: 'offset',
  b: 'offset',
  mmax: 'offset',
};

/** One logic-tree branch: a factor/offset (per TREE_MODE) and its weight. */
export interface Branch {
  value: number;
  weight: number;
}

/**
 * User-defined branch sets, one per uncertain input. Weights within an input
 * are normalized to sum to 1; omit an input (or give it no branches) to hold
 * it at its best estimate.
 */
export type LogicTree = Partial<Record<TreeParam, Branch[]>>;

const kb = (lo: number, mid: number, hi: number): Branch[] =>
  [lo, mid, hi].map((value, i) => ({ value, weight: KB_WEIGHTS[i]! }));

export const DEFAULT_TREE: Record<TreeParam, Branch[]> = {
  slip: kb(0.5, 1, 2),
  dip: kb(-15, 0, 15),
  thickness: kb(-3, 0, 3),
  b: kb(-0.15, 0, 0.15),
  mmax: kb(-0.2, 0, 0.2),
};

/** The central (identity) branch value for an input: factor 1 or offset 0. */
export const identityValue = (p: TreeParam): number => (TREE_MODE[p] === 'factor' ? 1 : 0);

/**
 * The absolute input a branch resolves to, clamped to physical limits. For
 * `mmax` this is the offset itself (it is applied after scaling is resolved).
 */
export function branchInputValue(param: TreeParam, fi: FaultInputs, value: number): number {
  switch (param) {
    case 'slip':
      return fi.slip * Math.max(value, 1e-6);
    case 'dip':
      return Math.min(Math.max(fi.dip + value, 10), 90);
    case 'thickness':
      return Math.max(fi.thickness + value, 2);
    case 'b':
      return Math.max(fi.b + value, 0.3);
    case 'mmax':
      return value;
  }
}

/** Best-estimate Mmax the `mmax` offsets are applied to. */
export function bestMmax(fi: FaultInputs): number {
  return fi.lockMax ? scalingMagnitude(paramsFromInputs(fi)) : fi.Mmax;
}

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
      return fi; // handled in hazardFor (needs the scaling magnitude)
  }
}

/** Drop unusable branches (non-finite, non-positive weight) and normalize weights. */
export function cleanBranches(branches: Branch[] | undefined): Branch[] {
  const ok = (branches ?? []).filter((b) => Number.isFinite(b.value) && Number.isFinite(b.weight) && b.weight > 0);
  const total = ok.reduce((s, b) => s + b.weight, 0);
  return ok.map((b) => ({ value: b.value, weight: b.weight / total }));
}

export interface HazardBand {
  lo: number[];
  hi: number[];
}

export interface Sensitivity {
  param: TreeParam;
  /** Absolute input values of the lowest / highest branch (for mmax: magnitudes). */
  lowValue: number;
  highValue: number;
  /** Per model: PGA (g) at the RP on the low / high branch, the rest at best estimate. */
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
  const sets = {} as Record<TreeParam, Branch[]>;
  const enabled = TREE_PARAMS.filter((p) => {
    const c = cleanBranches(tree[p]);
    if (c.length > 0) sets[p] = c;
    return c.length > 0;
  });
  const physical = enabled.filter((p) => p !== 'slip');
  const slipSet: Branch[] = sets.slip ?? [{ value: 1, weight: 1 }];
  const Mbest = bestMmax(fi);

  // Branch choice per physical input: an index into its set, or -1 for the
  // best estimate (the slider value). All -1 → exactly compute(best inputs).
  type Choice = Partial<Record<TreeParam, number>>;
  const valueOf = (p: TreeParam, choice: Choice): number => {
    const i = choice[p] ?? -1;
    return i < 0 ? identityValue(p) : sets[p][i]!.value;
  };
  const cache = new Map<string, Record<ModelKey, number[]>>();
  let pga: number[] = [];
  const hazardFor = (choice: Choice): Record<ModelKey, number[]> => {
    const vals = physical.map((p) => valueOf(p, choice));
    const key = vals.join('|');
    const hit = cache.get(key);
    if (hit) return hit;
    let f = fi;
    physical.forEach((p, j) => {
      if (p !== 'mmax') f = applyBranch(f, p, branchInputValue(p, fi, vals[j]!));
    });
    const exact = physical.every((p, j) => vals[j] === identityValue(p));
    if (!exact) f = { ...f, binWidth: Math.max(fi.binWidth ?? 0.1, TREE_MIN_BIN_WIDTH) };
    const params = paramsFromInputs(f);
    const dm = physical.includes('mmax') ? valueOf('mmax', choice) : 0;
    if (dm !== 0) {
      // Offset the best-estimate Mmax of *this* branch's geometry (a dip or
      // thickness branch changes the area, hence the scaling magnitude).
      params.Mmax = (params.lockMax ? scalingMagnitude(params) : params.Mmax) + dm;
      params.lockMax = false;
    }
    const r = compute(params);
    pga = r.pga;
    cache.set(key, r.hazByModel);
    return r.hazByModel;
  };

  // Full tree: cartesian product over physical branch sets × slip factors.
  // Slip is linear in hazard, so slip branches reference a curve + a factor.
  const bases: Record<ModelKey, number[]>[] = [];
  const factors: number[] = [];
  const wList: number[] = [];
  const sizes = physical.map((p) => sets[p].length);
  const nPhys = sizes.reduce((a, b) => a * b, 1);
  for (let code = 0; code < nPhys; code++) {
    const choice: Choice = {};
    let w = 1;
    let c = code;
    physical.forEach((p, j) => {
      const i = c % sizes[j]!;
      c = Math.floor(c / sizes[j]!);
      choice[p] = i;
      w *= sets[p][i]!.weight;
    });
    const haz = hazardFor(choice);
    for (const sb of slipSet) {
      bases.push(haz);
      factors.push(sb.value);
      wList.push(w * sb.weight);
    }
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

  // One-at-a-time: each input at its lowest / highest branch value, every
  // other input at its best estimate.
  const sensitivity: Sensitivity[] = enabled.map((p) => {
    const set = sets[p];
    let iLo = 0;
    let iHi = 0;
    set.forEach((b, i) => {
      if (b.value < set[iLo]!.value) iLo = i;
      if (b.value > set[iHi]!.value) iHi = i;
    });
    const at = (i: number): Record<ModelKey, number[]> => {
      if (p !== 'slip') return hazardFor({ [p]: i });
      const sf = set[i]!.value;
      const out = {} as Record<ModelKey, number[]>;
      for (const k of MODEL_KEYS) out[k] = central[k].map((v) => v * sf);
      return out;
    };
    const lo = at(iLo);
    const hi = at(iHi);
    const byModel = {} as Sensitivity['byModel'];
    for (const k of MODEL_KEYS) {
      byModel[k] = {
        rp475: [pgaAtRate(pga, lo[k], RP_475), pgaAtRate(pga, hi[k], RP_475)],
        rp2475: [pgaAtRate(pga, lo[k], RP_2475), pgaAtRate(pga, hi[k], RP_2475)],
      };
    }
    const abs = (v: number) => (p === 'mmax' ? Mbest + v : branchInputValue(p, fi, v));
    return { param: p, lowValue: abs(set[iLo]!.value), highValue: abs(set[iHi]!.value), byModel };
  });

  return { pga, quantiles, nBranches: n, bandByModel, bandAtRP, bestAtRP, sensitivity };
}
