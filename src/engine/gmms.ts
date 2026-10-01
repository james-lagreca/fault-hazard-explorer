// NSHA ground-motion models, PGA only, reimplemented to match the OpenQuake
// gsims named on each function (openquake.engine 3.16.1). Every one is
// asserted equal to its gsim to 1e-9 against hazardlib-generated fixtures
// (validation/fixtures/gmm_*.json, tests/engine.test.ts). Means are ln(g);
// sigma is the total ln standard deviation.

import { GRAVITY, linearSiteTerm, nonlinearSiteTerm } from './gmpe';
import type { GmmPrediction } from './gmpe';

// --------------------------------------------------------------------------
// Somerville et al. (2009) — non-cratonic & Yilgarn craton, with the SS14
// (Boore et al. 2014 / Seyhan & Stewart 2014) site terms Geoscience Australia
// applies: OpenQuake `SomervilleEtAl2009NonCratonic_SS14`,
// `SomervilleEtAl2009YilgarnCraton_SS14`. Reference rock is 865 m/s.
// --------------------------------------------------------------------------
interface SomervilleCoeffs {
  c1: number; c2: number; c3: number; c4: number; c5: number;
  c6: number; c7: number; c8: number; sigma: number;
}

const SOMERVILLE_PGA: Record<'noncratonic' | 'yilgarn', SomervilleCoeffs> = {
  noncratonic: { c1: 1.0378, c2: -0.0397, c3: -0.7943, c4: 0.1445, c5: -0.00618, c6: -0.7254, c7: -0.0359, c8: -0.0973, sigma: 0.5685 },
  yilgarn: { c1: 1.5456, c2: 1.4565, c3: -1.1151, c4: 0.1664, c5: -0.00567, c6: -1.049, c7: 1.0553, c8: 0.2, sigma: 0.5513 },
};

function somervilleMean(C: SomervilleCoeffs, mag: number, rjb: number): number {
  const m1 = 6.4;
  const r1 = 50;
  const h = 6;
  const R = Math.sqrt(rjb ** 2 + h ** 2);
  const R1 = Math.sqrt(r1 ** 2 + h ** 2);
  let mean = C.c1 + C.c4 * (mag - m1) * Math.log(R) + C.c5 * rjb + C.c8 * (8.5 - mag) ** 2;
  if (rjb < r1) mean += C.c3 * Math.log(R);
  else mean += C.c3 * Math.log(R1) + C.c6 * (Math.log(R) - Math.log(R1));
  mean += mag < m1 ? C.c2 * (mag - m1) : C.c7 * (mag - m1);
  return mean;
}

export function somerville2009SS14(
  variant: 'noncratonic' | 'yilgarn',
  mag: number,
  rjb: number,
  vs30: number,
): GmmPrediction {
  const C = SOMERVILLE_PGA[variant];
  const pgaRock = somervilleMean(C, mag, rjb); // PGA(865 m/s)
  const flin865 = linearSiteTerm(865);
  const fnl865 = nonlinearSiteTerm(865, Math.exp(pgaRock));
  const pgaRock760 = pgaRock - flin865 - fnl865;
  const lnMean =
    pgaRock - flin865 - fnl865 + linearSiteTerm(vs30) + nonlinearSiteTerm(vs30, Math.exp(pgaRock760));
  return { lnMean, sigma: C.sigma };
}

// --------------------------------------------------------------------------
// Drouet (2015) for Brazil, after Drouet & Cotton (2015): OpenQuake
// `DrouetBrazil2015` and `DrouetBrazil2015withDepth`. Hard rock, no site term.
// --------------------------------------------------------------------------
const DROUET_PGA = { c1: 2.575109, c2: -0.24314, c3: -0.155164, c4: -1.807995, c5: 0.156084, c6: 7.62941, c7: -0.003996, sigma: 0.625075, tau: 0.481226 };
const DROUET_DEPTH_PGA = { c1: 3.393123, c2: -0.139286, c3: -0.169796, c4: -1.695729, c5: 0.116686, c6: -0.003491, sigma: 0.609317, tau: 0.573384 };

export function drouetBrazil2015(mag: number, rjb: number): GmmPrediction {
  const C = DROUET_PGA;
  const f1 = C.c2 * (mag - 8.0) + C.c3 * (mag - 8.0) ** 2;
  const f2 = (C.c4 + C.c5 * mag) * Math.log(Math.sqrt(rjb ** 2 + C.c6 ** 2)) + C.c7 * rjb;
  // m/s² → g
  return { lnMean: C.c1 + f1 + f2 - Math.log(GRAVITY), sigma: Math.sqrt(C.sigma ** 2 + C.tau ** 2) };
}

export function drouetBrazil2015WithDepth(mag: number, rjb: number, hypoDepth: number): GmmPrediction {
  const C = DROUET_DEPTH_PGA;
  const f1 = C.c2 * (mag - 8.0) + C.c3 * (mag - 8.0) ** 2;
  const f2 = (C.c4 + C.c5 * mag) * Math.log(Math.sqrt(rjb ** 2 + hypoDepth ** 2)) + C.c6 * rjb;
  return { lnMean: C.c1 + f1 + f2 - Math.log(GRAVITY), sigma: Math.sqrt(C.sigma ** 2 + C.tau ** 2) };
}

// --------------------------------------------------------------------------
// Rietbrock & Edwards (2019), UK stochastic model: OpenQuake
// `RietbrockEdwards2019Mean`. Hard rock, no site term.
// --------------------------------------------------------------------------
const RE19_PGA = { c1: -2.178, c2: 1.6355, c3: -0.1241, c4: -1.8303, c5: 0.2165, c6: -1.8318, c7: 0.1622, c8: -1.9899, c9: 0.0678, c10: -0.002073, c11: 2.346, total: 0.3323 };

export function rietbrockEdwards2019(mag: number, rjb: number): GmmPrediction {
  const C = RE19_PGA;
  const rval = Math.sqrt(rjb ** 2 + C.c11 ** 2);
  const f0 = rval > 10 ? 0 : Math.log10(10 / rval);
  const f1 = rval > 50 ? Math.log10(50) : Math.log10(rval);
  const f2 = rval <= 100 ? 0 : Math.log10(rval / 100);
  const imean =
    C.c1 + (C.c2 * mag + C.c3 * mag ** 2) +
    ((C.c4 + C.c5 * mag) * f0 + (C.c6 + C.c7 * mag) * f1 + (C.c8 + C.c9 * mag) * f2 + C.c10 * rval);
  // log10(cm/s²) → ln(g)
  return { lnMean: Math.log(10 ** imean / 980.665), sigma: Math.log(10 ** C.total) };
}

// --------------------------------------------------------------------------
// ESHM20 craton backbone (Weatherill & Cotton 2020): OpenQuake `ESHM20Craton`
// at its central branch (epsilon = 0, site_epsilon = 0), with the NGA-East
// site model (Stewart et al. 2019 linear + Hashash et al. 2019 nonlinear) and
// the ergodic Al Atik (2015) "global" aleatory model.
// --------------------------------------------------------------------------
const ESHM20_PGA = {
  e1: 0.129433711217154, b1: 0.516399476752765, b2: -0.120321874005482, b3: 0.209372712495698,
  c1: -1.49820100429001, c2: 0.220432033342701, c3: -0.219311496696072,
};
const ESHM20_CONST = { Mref: 4.5, Rref: 1, Mh: 6.2, h: 5.0 };
const NGAE_CONST = { vref: 760, vL: 200, vU: 2000, vw1: 600, vw2: 400, wt1: 0.767, wt2: 0.1 };
const NGAE_LIN_PGA = { c: -0.29, v1: 319, v2: 760 };
const NGAE_NL_PGA = { f3: 0.0752, f4: -0.43755, f5: -0.00131, Vc: 2990 };
const NGAE_F760_PGA = { f760i: 0.185, f760g: 0.121 };
const GLOBAL_TAU_SA = { tau1: 0.4518, tau2: 0.427, tau3: 0.3863, tau4: 0.3508 };
const PHI_SS_GLOBAL_PGA = { a: 0.5477, b: 0.3505 };
const STEWART_PHIS2S_PGA = { s2s1: 0.533, s2s2: 0.566 };

const itpl = (mag: number, tu: number, tl: number, ml: number, f: number) => tl + ((tu - tl) * (mag - ml)) / f;

function eshm20HardRockMean(mag: number, rrup: number): number {
  const C = ESHM20_PGA;
  const K = ESHM20_CONST;
  const dm = mag - K.Mh;
  const fm = mag <= K.Mh ? C.e1 + C.b1 * dm + C.b2 * dm ** 2 : C.e1 + C.b3 * dm;
  const rval = Math.sqrt(rrup ** 2 + K.h ** 2);
  const rref = Math.sqrt(K.Rref ** 2 + K.h ** 2);
  const fr = (C.c1 + C.c2 * (mag - K.Mref)) * Math.log(rval / rref) + (C.c3 * (rval - rref)) / 100;
  return fm + fr;
}

/** NGA-East linear site term incl. the 3000 → 760 m/s reference shift (Stewart et al. 2019). */
function ngaEastLinear(vs30: number): number {
  const K = NGAE_CONST;
  let wimp = (K.wt1 - K.wt2) * (Math.log(vs30 / K.vw2) / Math.log(K.vw1 / K.vw2)) + K.wt2;
  if (vs30 >= K.vw1) wimp = K.wt1;
  if (vs30 < K.vw2) wimp = K.wt2;
  const f760 = wimp * NGAE_F760_PGA.f760i + (1 - wimp) * NGAE_F760_PGA.f760g;
  const C = NGAE_LIN_PGA;
  const const1 = C.c * Math.log(C.v1 / K.vref);
  const const2 = C.c * Math.log(C.v2 / K.vref);
  let fv = C.c * Math.log(vs30 / K.vref);
  if (vs30 <= C.v1) fv = const1;
  if (vs30 > C.v2) fv = const2;
  if (vs30 > K.vU) fv = const2 - (const2 + f760) * (Math.log(vs30 / K.vU) / Math.log(3000 / K.vU));
  if (vs30 >= 3000) fv = -f760;
  return fv + f760;
}

/** NGA-East nonlinear site term (Hashash et al. 2019), PGA (period ≤ 0.4 s → vref 760). */
function ngaEastNonlinear(vs30: number, pgaRock: number): number {
  const C = NGAE_NL_PGA;
  const vref = 760;
  if (!(vs30 < C.Vc)) return 0;
  const cvs = vs30 > vref ? vref : vs30;
  const f2 = C.f4 * (Math.exp(C.f5 * (cvs - 360)) - Math.exp(C.f5 * (vref - 360)));
  return f2 * Math.log((pgaRock + C.f3) / C.f3);
}

export function eshm20Craton(mag: number, rrup: number, vs30: number): GmmPrediction {
  const pgaR = eshm20HardRockMean(mag, rrup);
  const lnMean = pgaR + ngaEastLinear(vs30) + ngaEastNonlinear(vs30, Math.exp(pgaR));

  // Ergodic aleatory model: phi_ss (global) ⊕ phi_s2s (Stewart 2019), tau (global).
  const P = PHI_SS_GLOBAL_PGA;
  let phiSS = P.a + ((mag - 5.0) * (P.b - P.a)) / 1.5;
  if (mag <= 5.0) phiSS = P.a;
  if (mag > 6.5) phiSS = P.b;
  const S = STEWART_PHIS2S_PGA;
  let phiS2S = S.s2s1;
  if (vs30 > 1500) phiS2S = S.s2s2;
  else if (vs30 > 1200) phiS2S = S.s2s1 - ((S.s2s1 - S.s2s2) / (1500 - 1200)) * (vs30 - 1200);
  const phi = Math.sqrt(phiSS ** 2 + phiS2S ** 2);
  const T = GLOBAL_TAU_SA;
  let tau = T.tau1;
  if (mag > 6.5) tau = T.tau4;
  else if (mag > 5.5) tau = itpl(mag, T.tau4, T.tau3, 5.5, 1.0);
  else if (mag > 5.0) tau = itpl(mag, T.tau3, T.tau2, 5.0, 0.5);
  else if (mag > 4.5) tau = itpl(mag, T.tau2, T.tau1, 4.5, 0.5);
  return { lnMean, sigma: Math.sqrt(tau ** 2 + phi ** 2) };
}

// --------------------------------------------------------------------------
// Atkinson & Boore (2006), with the Atkinson & Boore (2011) stress-parameter
// modification: OpenQuake `AtkinsonBoore2006Modified2011`. BC-boundary
// coefficients + Boore & Atkinson (2008) soil terms below 2000 m/s.
// --------------------------------------------------------------------------
interface AB06Coeffs { c1: number; c2: number; c3: number; c4: number; c5: number; c6: number; c7: number; c8: number; c9: number; c10: number; }
const AB06_HR_PGA: AB06Coeffs = { c1: 0.9069, c2: 0.983, c3: -0.06595, c4: -2.698, c5: 0.1594, c6: -2.795, c7: 0.212, c8: -0.3011, c9: -0.06532, c10: -0.0004484 };
const AB06_BC_PGA: AB06Coeffs = { c1: 0.5233, c2: 0.9686, c3: -0.06196, c4: -2.439, c5: 0.1465, c6: -2.335, c7: 0.1912, c8: -0.08695, c9: -0.08285, c10: -0.0006304 };
const AB06_SOIL_PGA = { blin: -0.36, b1: -0.64, b2: -0.14 };
const AB06_STRESS_PGA = { delta: 0.15, M1: 0.5, Mh: 5.5 };

function ab06Log10Mean(C: AB06Coeffs, mag: number, r: number, scaleFac: number): number {
  const f0 = Math.max(Math.log10(10 / r), 0);
  const f1 = Math.min(Math.log10(r), Math.log10(70));
  const f2 = Math.max(Math.log10(r / 140), 0);
  const S = AB06_STRESS_PGA;
  const clipped = Math.max(mag - S.M1, 0);
  const sda = scaleFac * Math.min(0.05 + (S.delta * clipped) / (S.Mh - S.M1), S.delta + 0.05);
  return (
    C.c1 + C.c2 * mag + C.c3 * mag ** 2 +
    (C.c4 + C.c5 * mag) * f1 + (C.c6 + C.c7 * mag) * f2 + (C.c8 + C.c9 * mag) * f0 +
    C.c10 * r + sda
  );
}

function ab06NonlinearSlope(vs30: number): number {
  const { b1, b2 } = AB06_SOIL_PGA;
  const V1 = 180;
  const V2 = 300;
  const Vref = 760;
  if (vs30 <= V1) return b1;
  if (vs30 <= V2) return ((b1 - b2) * Math.log(vs30 / V2)) / Math.log(V1 / V2) + b2;
  if (vs30 < Vref) return (b2 * Math.log(vs30 / Vref)) / Math.log(V2 / Vref);
  return 0;
}

function ab06NonlinearTerm(pga4nl: number, bnl: number): number {
  const a1 = 0.03;
  const a2 = 0.09;
  const pgaLow = 0.06;
  if (pga4nl <= a1) return bnl * Math.log(pgaLow / 0.1);
  if (pga4nl <= a2) {
    const dx = Math.log(a2 / a1);
    const dy = bnl * Math.log(a2 / pgaLow);
    const c = (3 * dy - bnl * dx) / dx ** 2;
    const d = -(2 * dy - bnl * dx) / dx ** 3;
    return bnl * Math.log(pgaLow / 0.1) + c * Math.log(pga4nl / a1) ** 2 + d * Math.log(pga4nl / a1) ** 3;
  }
  return bnl * Math.log(pga4nl / 0.1);
}

export function atkinsonBoore2006Modified2011(mag: number, rrup: number, vs30: number): GmmPrediction {
  const r = rrup < 1 ? 1 : rrup;
  // Atkinson & Boore (2011) eq. 6: magnitude-dependent stress-drop factor.
  const stress = Math.min(10 ** (3.45 - 0.2 * mag), 10 ** (3.45 - 0.2 * 5.0));
  const scaleFac = Math.log10(stress / 140.0) / Math.log10(2.0);
  let mean: number;
  if (vs30 >= 2000) {
    mean = ab06Log10Mean(AB06_HR_PGA, mag, r, scaleFac);
  } else {
    mean = ab06Log10Mean(AB06_BC_PGA, mag, r, scaleFac);
    const pgaBC = (10 ** mean * 1e-2) / GRAVITY;
    const sal = Math.log10(Math.exp(AB06_SOIL_PGA.blin * Math.log(vs30 / 760.0)));
    const sanl = Math.log10(Math.exp(ab06NonlinearTerm(pgaBC, ab06NonlinearSlope(vs30))));
    mean = mean + sal + sanl;
  }
  return { lnMean: Math.log((10 ** mean * 1e-2) / GRAVITY), sigma: Math.log(10 ** 0.3) };
}
