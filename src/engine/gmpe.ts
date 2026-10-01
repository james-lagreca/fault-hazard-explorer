// Ground-motion models.
//
// `allen` is the real Allen (2012) cratonic-SCR GMPE with the Seyhan & Stewart
// (2014) site terms (as applied in Boore et al. 2014), reimplemented to match
// OpenQuake's `Allen2012_SS14` exactly — validated against the gsim in CI. The
// other NSHA models live in gmms.ts, each validated the same way.
// `gen`/`scr` are uncalibrated TOY models kept for shape comparison only.

import type { GmpeKey } from './types';
import {
  atkinsonBoore2006Modified2011,
  drouetBrazil2015,
  drouetBrazil2015WithDepth,
  eshm20Craton,
  rietbrockEdwards2019,
  somerville2009SS14,
} from './gmms';

/** Standard gravity, m/s² (scipy.constants.g) — used by Allen 2012's unit conversion. */
export const GRAVITY = 9.80665;

/** Representative hypocentral depth, km. < 10 km selects Allen's shallow coeffs. */
export const DEFAULT_HYPO_DEPTH = 7.0;

/** A GMM prediction for PGA: natural-log mean (PGA in g) and total ln-sigma. */
export interface GmmPrediction {
  lnMean: number;
  sigma: number;
}

/** Evaluate a GMM at a single magnitude (distance/site captured by the closure). */
export type GmmEval = (mag: number) => GmmPrediction;

// --------------------------------------------------------------------------
// Allen (2012) — PGA coefficients (== SA(0.01)), shallow & deep event tables.
// Verbatim from OpenQuake's allen_2012.py COEFFS_SHALLOW / COEFFS_DEEP.
// --------------------------------------------------------------------------
interface AllenCoeffs {
  c0: number; c1: number; c2: number; c3: number; c4: number; c5: number;
  c6: number; c7: number; c8: number; c9: number; c10: number; c11: number;
  sigma: number;
}

const ALLEN_PGA_SHALLOW: AllenCoeffs = {
  c0: 3.2586, c1: 0.5054, c2: -0.0693, c3: -1.8386, c4: 0.158, c5: 1.2466,
  c6: -0.2045, c7: -0.0441, c8: -5.1081, c9: -2.8612, c10: 0.252, c11: -0.6911,
  sigma: 0.412,
};

const ALLEN_PGA_DEEP: AllenCoeffs = {
  c0: 3.383, c1: 0.6034, c2: -0.0905, c3: -1.9289, c4: 0.1754, c5: 1.114,
  c6: -0.1822, c7: -0.0126, c8: -4.6974, c9: -3.149, c10: 0.3152, c11: -0.7242,
  sigma: 0.3653,
};

/** Allen (2012) rock (Vs30 = 820) mean ln(PGA/g), equation 18. */
function allenRockMeanLn(C: AllenCoeffs, mag: number, rrup: number): number {
  const R1 = 90;
  const R2 = 150;
  const mref = mag - 4;
  const r1 = R1 + C.c8 * mref;
  const r2 = R2 + C.c11 * mref;
  const g0 = Math.log10(Math.sqrt(Math.min(rrup, r1) ** 2 + (1 + C.c5 * mref) ** 2));
  const g1 = Math.max(Math.log10(rrup / r1), 0);
  const g2 = Math.max(Math.log10(rrup / r2), 0);
  const meanLog10 =
    C.c0 + C.c1 * mref + C.c2 * mref ** 2 +
    (C.c3 + C.c4 * mref) * g0 +
    (C.c6 + C.c7 * mref) * g1 +
    (C.c9 + C.c10 * mref) * g2;
  // log10(cm/s²) → ln(g)
  return Math.log((10 ** meanLog10 * 1e-2) / GRAVITY);
}

// --- Boore et al. (2014) / Seyhan & Stewart (2014) site terms (PGA row) ---
const BEA14_PGA = { c: -0.6, Vc: 1500, f4: -0.15, f5: -0.00701 };
const VREF = 760;
const SS_F1 = 0.0;
const SS_F3 = 0.1;

export function linearSiteTerm(vs30: number): number {
  const flin = vs30 > BEA14_PGA.Vc ? BEA14_PGA.Vc / VREF : vs30 / VREF;
  return BEA14_PGA.c * Math.log(flin);
}

export function nonlinearSiteTerm(vs30: number, pgaRock: number): number {
  const vs = vs30 > 760 ? 760 : vs30;
  const f2 = BEA14_PGA.f4 * (Math.exp(BEA14_PGA.f5 * (vs - 360)) - Math.exp(BEA14_PGA.f5 * 400));
  return SS_F1 + f2 * Math.log((pgaRock + SS_F3) / SS_F3);
}

/**
 * Allen (2012) + SS14, PGA mean ln(g) at a target Vs30. Mirrors OpenQuake's
 * `Allen2012_SS14.compute`: rock(820) → correct to 760 → re-amplify to Vs30.
 */
export function allen2012SS14(
  mag: number,
  rrup: number,
  vs30: number,
  hypoDepth: number = DEFAULT_HYPO_DEPTH,
): GmmPrediction {
  const C = hypoDepth < 10 ? ALLEN_PGA_SHALLOW : ALLEN_PGA_DEEP;
  const rock820 = allenRockMeanLn(C, mag, rrup);
  const rock760 = rock820 - linearSiteTerm(820) - nonlinearSiteTerm(820, Math.exp(rock820));
  const lnMean = rock760 + linearSiteTerm(vs30) + nonlinearSiteTerm(vs30, Math.exp(rock760));
  return { lnMean, sigma: Math.log(10 ** C.sigma) };
}

// --------------------------------------------------------------------------
// Toy parametric models — uncalibrated, shape only.
// --------------------------------------------------------------------------
interface Toy { c0: number; c1: number; c2: number; h: number; sig: number; }
const TOY: Record<'gen' | 'scr', Toy> = {
  gen: { c0: -3.5, c1: 0.9, c2: 1.2, h: 5, sig: 0.6 },
  scr: { c0: -2.9, c1: 0.82, c2: 1.45, h: 7, sig: 0.55 },
};

/** Site and source conditions a GMM evaluator is built for. */
export interface GmmSite {
  /** Rupture distance, km. */
  rrup: number;
  /** Joyner–Boore distance, km (defaults to rrup). */
  rjb?: number;
  /** Vs30, m/s. */
  vs30: number;
  /** Hypocentral depth, km. */
  hypoDepth?: number;
}

/** Build a GMM evaluator with distance and site conditions fixed. */
export function makeGmm(key: GmpeKey, site: GmmSite): GmmEval {
  const { rrup, vs30 } = site;
  const rjb = site.rjb ?? rrup;
  const hypo = site.hypoDepth ?? DEFAULT_HYPO_DEPTH;
  switch (key) {
    case 'allen':
      return (mag) => allen2012SS14(mag, rrup, vs30, hypo);
    case 'som09nc':
      return (mag) => somerville2009SS14('noncratonic', mag, rjb, vs30);
    case 'som09yc':
      return (mag) => somerville2009SS14('yilgarn', mag, rjb, vs30);
    case 'drouet15':
      return (mag) => drouetBrazil2015(mag, rjb);
    case 'drouet15d':
      return (mag) => drouetBrazil2015WithDepth(mag, rjb, hypo);
    case 're19':
      return (mag) => rietbrockEdwards2019(mag, rjb);
    case 'eshm20':
      return (mag) => eshm20Craton(mag, rrup, vs30);
    case 'ab06':
      return (mag) => atkinsonBoore2006Modified2011(mag, rrup, vs30);
    case 'gen':
    case 'scr': {
      const t = TOY[key];
      return (mag) => ({ lnMean: t.c0 + t.c1 * mag - t.c2 * Math.log(rrup + t.h), sigma: t.sig });
    }
  }
}
