// Seismic moment and fault moment-rate bookkeeping.
// Every MFD in this tool is moment-balanced against the same fault moment rate;
// only the *shape* of the distribution differs.

/** Shear modulus, Pa. */
export const MU = 3.0e10;

/**
 * Seismic moment of a magnitude-m event, N·m (Hanks & Kanamori).
 *   M0(m) = 10^(1.5 m + 9.05)
 */
export const M0 = (m: number): number => Math.pow(10, 1.5 * m + 9.05);

/**
 * Fault moment rate, N·m/yr:  Ṁ0 = μ · A · ṡ
 * with A = L·W (converted km → m) and slip converted mm/yr → m/yr.
 */
export function momentRate(L_km: number, W_km: number, slip_mm_yr: number): number {
  const A_m2 = L_km * 1e3 * (W_km * 1e3);
  return MU * A_m2 * (slip_mm_yr * 1e-3);
}

/**
 * Moment-balance a dimensionless shape g(m) sampled at bin centres `mids`
 * (bin width `bw`) so that the implied annual rates carry exactly `targetMoment`
 * N·m/yr.  Returns the per-bin annual occurrence rates.
 *
 *   k = Ṁ0 / Σ g(mᵢ) · M0(mᵢ) · Δm
 *   rateᵢ = k · g(mᵢ) · Δm
 */
export function balanceShape(
  mids: number[],
  shape: number[],
  bw: number,
  targetMoment: number,
): number[] {
  let denom = 0;
  for (let i = 0; i < mids.length; i++) {
    denom += Math.max(0, shape[i]!) * M0(mids[i]!) * bw;
  }
  if (denom <= 0) return mids.map(() => 0);
  const k = targetMoment / denom;
  return mids.map((_, i) => k * Math.max(0, shape[i]!) * bw);
}
