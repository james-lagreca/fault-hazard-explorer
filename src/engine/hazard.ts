// Hazard-curve integration and return-period inversion.

import type { GmmEval } from './gmpe';
import type { Mfd } from './types';

/**
 * Standard-normal CDF (Abramowitz & Stegun 26.2.17 approximation).
 * Matches the JS prototype so the two engines are bit-comparable.
 */
export function ncdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * Log-spaced PGA grid (g): 0.001 … 3.0, 161 points. The wide low end matters for
 * weak-motion SCR models (e.g. Allen 2012), where the 475-yr crossing for some
 * MFDs sits well below 0.01 g — narrowing the grid would drop those as "—".
 */
export function pgaGrid(): number[] {
  const out: number[] = [];
  for (let i = 0; i <= 160; i++) out.push(0.001 * Math.pow(3000, i / 160));
  return out;
}

/**
 * Annual rate of exceedance λ(PGA > x) for one MFD, given a GMM evaluator:
 *   λ(>x) = Σᵢ rateᵢ · [1 − Φ((ln x − μᵢ) / σᵢ)]
 * where (μᵢ, σᵢ) is the GMM's ln-mean and ln-sigma at magnitude mᵢ. `rates` are
 * already per-bin annual rates, so there is no extra Δm factor here.
 */
export function hazardCurve(mfd: Mfd, pga: number[], gmm: GmmEval): number[] {
  // Precompute the GMM prediction per magnitude bin.
  const pred = mfd.mids.map((m) => gmm(m));
  return pga.map((x) => {
    const lnx = Math.log(x);
    let lam = 0;
    for (let i = 0; i < mfd.rates.length; i++) {
      const r = mfd.rates[i]!;
      if (r <= 0) continue;
      const p = pred[i]!;
      lam += r * (1 - ncdf((lnx - p.lnMean) / p.sigma));
    }
    return lam;
  });
}

/**
 * Invert a hazard curve in log-log space to read the PGA (g) at a target
 * annual rate `t` (e.g. 1/475). Returns null if the curve does not cross `t`.
 */
export function pgaAtRate(pga: number[], lam: number[], t: number): number | null {
  for (let i = 0; i < lam.length - 1; i++) {
    const a = lam[i]!;
    const b = lam[i + 1]!;
    if ((a - t) * (b - t) <= 0 && a !== b && a > 0 && b > 0) {
      const lx0 = Math.log(pga[i]!);
      const lx1 = Math.log(pga[i + 1]!);
      const ly0 = Math.log(a);
      const ly1 = Math.log(b);
      return Math.exp(lx0 + ((Math.log(t) - ly0) * (lx1 - lx0)) / (ly1 - ly0));
    }
  }
  return null;
}
