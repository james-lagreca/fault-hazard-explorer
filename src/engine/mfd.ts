// Magnitude–frequency distributions, as moment-balanced incremental rates.
//
// IMPORTANT: the binning scheme and shape definitions here are mirrored exactly
// by validation/generate_fixtures.py so the TypeScript engine can be asserted
// equal to the OpenQuake fixtures. If you change the discretization, change it
// in both places.

import { balanceShape } from './moment';
import type { Mfd, ModelKey } from './types';

/** Fixed upper cap for the "unbounded GR" reference line (no fault cap). */
export const GR_CAP = 7.5;

/** Width of the YC1985 characteristic boxcar (magnitude units). */
const DELTA_CHAR = 0.5;

/** Round to kill floating-point dust on the magnitude grid. */
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** Python's round() (half away from zero) — matches openquake.baselib's round. */
const pyRound = (x: number): number => Math.floor(x + (x < 0 ? -0.5 : 0.5));

/**
 * Deterministic bin centres on [Mmin, Mmax]. Number of bins is rounded so the
 * grid is independent of float accumulation: mids run Mmin+Δm/2 … Mmax−Δm/2.
 */
export function magnitudeBins(Mmin: number, Mmax: number, bw: number): number[] {
  const nb = Math.max(1, Math.round((Mmax - Mmin) / bw));
  const mids: number[] = [];
  for (let i = 0; i < nb; i++) mids.push(r6(Mmin + (i + 0.5) * bw));
  return mids;
}

/** Dimensionless MFD shape g(m) sampled at bin centres. */
function shapeFor(kind: 'GR' | 'TGR' | 'MMAX', mids: number[], b: number, Mmax: number): number[] {
  switch (kind) {
    // Pure exponential. GR runs to GR_CAP (no fault cap); TGR is truncated at Mmax.
    case 'GR':
    case 'TGR':
      return mids.map((m) => Math.pow(10, -b * m));
    // Single characteristic: all moment in the top quarter-unit.
    case 'MMAX':
      return mids.map((m) => (m >= Mmax - 0.25 ? 1 : 0));
  }
}

/**
 * Youngs & Coppersmith (1985) characteristic MFD, reimplemented to match
 * OpenQuake's `YoungsCoppersmith1985MFD.from_total_moment_rate` (validated
 * against the real class in CI). Exponential G-R part on [min_mag, char_mag−0.25]
 * plus a uniform boxcar over [char_mag−0.25, char_mag+0.25]; the characteristic
 * rate density is anchored to the G-R rate at char_mag−1.25.
 *
 * `charMag` is the boxcar centre; the absolute maximum magnitude is charMag+0.25.
 */
export function youngsCoppersmith1985(
  minMag: number,
  bVal: number,
  charMag: number,
  totalMomentRate: number,
  bw: number,
): Mfd {
  // a_val + char_rate from the total moment rate (OQ __init__, moment branch).
  const coeffs = (tmr: number): { aVal: number; charRate: number } => {
    const beta = bVal * Math.LN10;
    const mu = charMag + DELTA_CHAR / 2;
    const m0 = minMag;
    const c = 1.5;
    const d = 9.05;
    const moU = Math.pow(10, c * mu + d);
    const c1 = Math.exp(-beta * (mu - m0 - 0.5));
    const c2 = Math.exp(-beta * (mu - m0 - 1.5));
    const c3 = (beta * c2) / (2 * (1 - c1) + beta * c2);
    const c4 =
      (bVal * Math.pow(10, -c / 2)) / (c - bVal) +
      (bVal * Math.exp(beta) * (1 - Math.pow(10, -c / 2))) / c;
    const nMinMag = ((1 - c1) * tmr) / ((1 - c3) * c1 * moU * c4);
    const charRate = c3 * nMinMag;
    const aVal = Math.log10(
      (nMinMag - charRate) /
        (Math.pow(10, -bVal * minMag) - Math.pow(10, -bVal * (charMag - 0.25))),
    );
    return { aVal, charRate };
  };

  // OQ _get_min_mag_and_num_bins: align to bin grid, count bins.
  let mn = pyRound(minMag / bw) * bw;
  let mx = pyRound((charMag + DELTA_CHAR / 2) / bw) * bw;
  mn += bw / 2;
  mx -= bw / 2;
  const num = Math.trunc(pyRound((mx - mn) / bw)) + 1;

  // Bin centres, accumulated exactly as OQ does (mag += bw), to keep the
  // exponential/boxcar boundary comparison float-identical.
  const mids: number[] = [];
  for (let i = 0, mag = mn; i < num; i++, mag += bw) mids.push(mag);

  const rateAt = (mag: number, aVal: number, charRate: number): number => {
    const magLo = mag - bw / 2;
    const magHi = mag + bw / 2;
    if (mag >= minMag && mag < charMag - DELTA_CHAR / 2) {
      return Math.pow(10, aVal - bVal * magLo) - Math.pow(10, aVal - bVal * magHi);
    }
    return (charRate / DELTA_CHAR) * bw;
  };

  // OQ from_total_moment_rate: build once, measure moment misfit, rescale, rebuild.
  const pass1 = coeffs(totalMomentRate);
  const rates1 = mids.map((m) => rateAt(m, pass1.aVal, pass1.charRate));
  const calcMoment = rates1.reduce((s, r, i) => s + r * Math.pow(10, 1.5 * mids[i]! + 9.05), 0);
  const adjusted = totalMomentRate / (calcMoment / totalMomentRate);
  const pass2 = coeffs(adjusted);
  const rates = mids.map((m) => rateAt(m, pass2.aVal, pass2.charRate));

  return { mids, rates, binWidth: bw, minMag: mids[0] ?? minMag };
}

/** Whether a YC1985 characteristic MFD is well-defined for these params. */
export function canBuildYC(minMag: number, Mmax: number, bw: number): boolean {
  const charMag = Mmax - DELTA_CHAR / 2;
  return charMag - 0.25 >= minMag + bw;
}

/**
 * Build one model's moment-balanced incremental MFD.
 * `momentRateValue` is the shared fault moment rate (N·m/yr) all models carry.
 */
export function buildMfd(
  kind: ModelKey,
  opts: { b: number; Mmin: number; Mmax: number; binWidth: number },
  momentRateValue: number,
): Mfd {
  const bw = opts.binWidth;
  if (kind === 'CHAR') {
    // CHAR is the real YC1985 model; its absolute max magnitude is the fault
    // Mmax, so the boxcar centre sits a quarter-unit below.
    if (!canBuildYC(opts.Mmin, opts.Mmax, bw)) {
      return { mids: [], rates: [], binWidth: bw, minMag: opts.Mmin };
    }
    return youngsCoppersmith1985(opts.Mmin, opts.b, opts.Mmax - DELTA_CHAR / 2, momentRateValue, bw);
  }
  const upper = kind === 'GR' ? Math.max(GR_CAP, opts.Mmax) : opts.Mmax;
  const mids = magnitudeBins(opts.Mmin, upper, bw);
  const shape = shapeFor(kind, mids, opts.b, opts.Mmax);
  const rates = balanceShape(mids, shape, bw, momentRateValue);
  return { mids, rates, binWidth: bw, minMag: mids[0] ?? opts.Mmin };
}

/** Cumulative recurrence N(≥M) /yr, aligned to the MFD's own bin centres. */
export function cumulative(mfd: Mfd): number[] {
  const out = new Array<number>(mfd.rates.length);
  let acc = 0;
  for (let i = mfd.rates.length - 1; i >= 0; i--) {
    acc += mfd.rates[i]!;
    out[i] = acc;
  }
  return out;
}

/** Return period (yr) of an event near magnitude `mTarget` for this MFD. */
export function recurrence(mfd: Mfd, cum: number[], mTarget: number): number | null {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < mfd.mids.length; i++) {
    const d = Math.abs(mfd.mids[i]! - mTarget);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const c = cum[best]!;
  return c > 0 ? 1 / c : null;
}
