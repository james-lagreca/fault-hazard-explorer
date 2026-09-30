// Epistemic uncertainty: a small logic tree over the fault inputs, collapsed to
// weighted fractile hazard curves per MFD model.
//
// compute() stays the single best-estimate (OpenQuake-parity) path; this module
// re-runs the same MFD → hazard chain over branches of slip rate, b-value and
// Mmax, then reads weighted quantiles across branches at each PGA level — the
// same statistic as OpenQuake's `hazardlib.stats.quantile_curve`.

import { momentRate } from './moment';
import { wc1994, leonard2014SCR, thingbaijam2017Reverse } from './scaling';
import { buildMfd } from './mfd';
import { makeGmm } from './gmpe';
import { hazardCurve, pgaGrid } from './hazard';
import { MODEL_KEYS } from './types';
import type { ModelKey, Params, ScalingKey } from './types';

/**
 * Keefer & Bodily (1983) three-point discretization: the 5th / 50th / 95th
 * percentiles of each input, weighted 0.185 / 0.63 / 0.185.
 */
export const BRANCH_WEIGHTS = [0.185, 0.63, 0.185] as const;

/** Slip-rate branches: multiplicative, ×/÷ 2 at the 5th/95th percentiles. */
export const SLIP_FACTORS = [0.5, 1, 2] as const;
/** b-value branches: additive offsets. */
export const B_OFFSETS = [-0.15, 0, 0.15] as const;
/** Mmax branches: additive offsets (applied to the scaling magnitude when locked). */
export const MMAX_OFFSETS = [-0.2, 0, 0.2] as const;

const SCALING_FN: Record<ScalingKey, (area_km2: number) => number> = {
  wc94: wc1994,
  leonard14: (a) => leonard2014SCR(a),
  tmg17: thingbaijam2017Reverse,
};

export interface HazardBand {
  lo: number[];
  hi: number[];
}

export interface UncertaintyResult {
  /** PGA levels (g), identical to compute().pga. */
  pga: number[];
  /** The quantiles the band spans, e.g. [0.15, 0.85]. */
  quantiles: [number, number];
  /** Per-model lower / upper fractile hazard curves vs `pga`. */
  bandByModel: Record<ModelKey, HazardBand>;
}

/**
 * Weighted quantile of `values`, matching hazardlib.stats.quantile_curve:
 * sort, accumulate the weights, and linearly interpolate the quantile on the
 * cumulative-weight axis (clamped at both ends).
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

/**
 * Per-model fractile hazard curves over the slip × b × Mmax logic tree
 * (27 branches). Hazard is linear in slip rate, so each (b, Mmax) branch is
 * integrated once and scaled by the slip factors.
 */
export function hazardBands(params: Params, quantiles: [number, number] = [0.15, 0.85]): UncertaintyResult {
  const binWidth = params.binWidth ?? 0.1;
  const scalingMag = SCALING_FN[params.scaling ?? 'wc94'](params.L * params.W);
  const Mmax0 = params.lockMax ? scalingMag : params.Mmax;
  const mRate = momentRate(params.L, params.W, params.slip);
  const gmm = makeGmm(params.gmpe, params.R, params.vs30);
  const pga = pgaGrid();

  const bandByModel = {} as Record<ModelKey, HazardBand>;
  for (const key of MODEL_KEYS) {
    const curves: number[][] = [];
    const weights: number[] = [];
    B_OFFSETS.forEach((db, ib) => {
      MMAX_OFFSETS.forEach((dm, im) => {
        const b = params.b + db;
        const Mmax = Mmax0 + dm;
        const mfd = buildMfd(key, { b, Mmin: params.Mmin, Mmax, binWidth }, mRate);
        const haz = hazardCurve(mfd, pga, gmm);
        SLIP_FACTORS.forEach((f, is) => {
          curves.push(haz.map((v) => v * f));
          weights.push(BRANCH_WEIGHTS[ib]! * BRANCH_WEIGHTS[im]! * BRANCH_WEIGHTS[is]!);
        });
      });
    });
    const lo: number[] = [];
    const hi: number[] = [];
    for (let i = 0; i < pga.length; i++) {
      const col = curves.map((c) => c[i]!);
      lo.push(weightedQuantile(col, weights, quantiles[0]));
      hi.push(weightedQuantile(col, weights, quantiles[1]));
    }
    bandByModel[key] = { lo, hi };
  }

  return { pga, quantiles, bandByModel };
}
