// Magnitude–area scaling relationships.

/**
 * Wells & Coppersmith (1994), all fault types, area → magnitude:
 *   M = 4.07 + 0.98 · log10(A_km²)
 * Coefficients are certain and hardcoded.
 */
export function wc1994(area_km2: number): number {
  return 4.07 + 0.98 * Math.log10(area_km2);
}

/**
 * Leonard (2014) stable-continental-region area → magnitude, matching
 * OpenQuake's `Leonard2014_SCR.get_median_mag(area, rake)` exactly (validated in
 * CI). The intercept depends on faulting style:
 *   strike-slip → 4.18 · dip-slip (thrust/normal) → 4.19 · undefined → 4.185
 *   M = log10(A_km²) + c
 * Default rake = 90 (dip-slip), the convention of the fault model here.
 * Provided for the "lock Mmax to area scaling" alternative; WC1994 is the default.
 */
export function leonard2014SCR(area_km2: number, rake = 90): number {
  let c: number;
  if ((rake >= -45 && rake <= 45) || rake >= 135 || rake <= -135) {
    c = 4.18; // strike-slip
  } else {
    c = 4.19; // dip-slip (thrust or normal)
  }
  return Math.log10(area_km2) + c;
}
