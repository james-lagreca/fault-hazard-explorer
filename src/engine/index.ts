// Pure compute entry point. compute(params) → EngineResult.
// No DOM, no I/O — fully unit-testable and the single source of truth the UI and
// the OpenQuake fixtures both compare against.

import { momentRate } from './moment';
import { wc1994 } from './scaling';
import { buildMfd, cumulative, recurrence } from './mfd';
import { makeGmm } from './gmpe';
import { hazardCurve, pgaAtRate, pgaGrid } from './hazard';
import { MODEL_KEYS } from './types';
import type { EngineResult, Mfd, ModelKey, Params } from './types';

const DEFAULT_BIN_WIDTH = 0.1;
const RP_475 = 1 / 475;
const RP_2475 = 1 / 2475;

export function compute(params: Params): EngineResult {
  const binWidth = params.binWidth ?? DEFAULT_BIN_WIDTH;
  const area = params.L * params.W;
  const scalingMag = wc1994(area);
  const Mmax = params.lockMax ? scalingMag : params.Mmax;
  const mRate = momentRate(params.L, params.W, params.slip);
  const gmm = makeGmm(params.gmpe, params.R, params.vs30);
  const pga = pgaGrid();
  const mTarget = Mmax - 0.2;

  const mfdByModel = {} as Record<ModelKey, Mfd>;
  const cumByModel = {} as Record<ModelKey, number[]>;
  const hazByModel = {} as Record<ModelKey, number[]>;
  const recurrenceByModel = {} as Record<ModelKey, number | null>;
  const pgaAtRP = {} as Record<ModelKey, { rp475: number | null; rp2475: number | null }>;

  for (const key of MODEL_KEYS) {
    const mfd = buildMfd(key, { b: params.b, Mmin: params.Mmin, Mmax, binWidth }, mRate);
    const cum = cumulative(mfd);
    const haz = hazardCurve(mfd, pga, gmm);
    mfdByModel[key] = mfd;
    cumByModel[key] = cum;
    hazByModel[key] = haz;
    recurrenceByModel[key] = recurrence(mfd, cum, mTarget);
    pgaAtRP[key] = {
      rp475: pgaAtRate(pga, haz, RP_475),
      rp2475: pgaAtRate(pga, haz, RP_2475),
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
  };
}

export type { EngineResult, Params, ModelKey } from './types';
export { MODEL_KEYS } from './types';
