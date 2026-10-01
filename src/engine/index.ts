// Pure compute entry point. compute(params) → EngineResult.
// No DOM, no I/O — fully unit-testable and the single source of truth the UI and
// the OpenQuake fixtures both compare against.

import { momentRate } from './moment';
import { wc1994, leonard2014SCR, thingbaijam2017Reverse } from './scaling';
import { buildMfd, cumulative, recurrence } from './mfd';
import { makeGmm } from './gmpe';
import { deaggregate, hazardCurve, pgaAtRate, pgaGrid } from './hazard';
import { floatingModel } from './floating';
import { MODEL_KEYS } from './types';
import type { EngineResult, Mfd, ModelKey, Params, ScalingKey } from './types';

const DEFAULT_BIN_WIDTH = 0.1;
const RP_475 = 1 / 475;
const RP_2475 = 1 / 2475;

const SCALING_FN: Record<ScalingKey, (area_km2: number) => number> = {
  wc94: wc1994,
  leonard14: (a) => leonard2014SCR(a),
  tmg17: thingbaijam2017Reverse,
};

/** Magnitude implied by the rupture area under the chosen scaling relation. */
export function scalingMagnitude(params: Params): number {
  return SCALING_FN[params.scaling ?? 'wc94'](params.L * params.W);
}

export function compute(params: Params): EngineResult {
  const binWidth = params.binWidth ?? DEFAULT_BIN_WIDTH;
  const scalingMag = scalingMagnitude(params);
  const Mmax = params.lockMax ? scalingMag : params.Mmax;
  const mRate = momentRate(params.L, params.W, params.slip);
  const gmm = makeGmm(params.gmpe, { rrup: params.R, rjb: params.Rjb, vs30: params.vs30 });
  const pga = pgaGrid();
  const floating =
    params.rupture === 'floating' && params.geom
      ? floatingModel(
          {
            L: params.L,
            W: params.W,
            dip: params.geom.dip,
            ztor: params.geom.ztor,
            x: params.geom.x,
            aspectRatio: params.aspectRatio ?? 1.5,
            scaling: params.scaling ?? 'wc94',
            gmpe: params.gmpe,
            vs30: params.vs30,
          },
          pga,
        )
      : null;
  const mTarget = Mmax - 0.2;

  const mfdByModel = {} as Record<ModelKey, Mfd>;
  const cumByModel = {} as Record<ModelKey, number[]>;
  const hazByModel = {} as Record<ModelKey, number[]>;
  const recurrenceByModel = {} as Record<ModelKey, number | null>;
  const pgaAtRP = {} as Record<ModelKey, { rp475: number | null; rp2475: number | null }>;
  const deaggByModel = {} as Record<ModelKey, { rp475: number[] | null; rp2475: number[] | null }>;

  for (const key of MODEL_KEYS) {
    const mfd = buildMfd(key, { b: params.b, Mmin: params.Mmin, Mmax, binWidth }, mRate);
    const cum = cumulative(mfd);
    const haz = floating ? floating.hazard(mfd) : hazardCurve(mfd, pga, gmm);
    mfdByModel[key] = mfd;
    cumByModel[key] = cum;
    hazByModel[key] = haz;
    recurrenceByModel[key] = recurrence(mfd, cum, mTarget);
    const rp = {
      rp475: pgaAtRate(pga, haz, RP_475),
      rp2475: pgaAtRate(pga, haz, RP_2475),
    };
    pgaAtRP[key] = rp;
    deaggByModel[key] = {
      rp475: floating ? floating.deaggregate(mfd, rp.rp475) : deaggregate(mfd, gmm, rp.rp475),
      rp2475: floating ? floating.deaggregate(mfd, rp.rp2475) : deaggregate(mfd, gmm, rp.rp2475),
    };
  }

  return {
    params,
    Mmax,
    scalingMag,
    momentRate: mRate,
    mfdByModel,
    cumByModel,
    pga,
    hazByModel,
    recurrenceByModel,
    pgaAtRP,
    deaggByModel,
  };
}

export type { EngineResult, Params, ModelKey } from './types';
export { MODEL_KEYS } from './types';
