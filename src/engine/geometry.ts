// Fault cross-section geometry: derived down-dip width and rupture distance.
//
// Model: a 2-D vertical cross-section perpendicular to strike, through the
// site (i.e. the site sits opposite the middle of the fault, so along-strike
// ends are ignored). x is horizontal distance from the surface trace — the
// up-dip projection of the fault's top edge — positive on the hanging-wall
// side (the dip direction). z is depth, positive down. The site is at the
// surface, (x, 0). The rupture plane is the segment from the top edge
// (0, ztor) down-dip to (W·cosδ, ztor + W·sinδ).

/** Width saturation cap, km: ruptures can't grow down-dip forever. */
export const MAX_WIDTH_KM = 50;

/**
 * Down-dip width from the seismogenic thickness (vertical extent of the
 * rupture, km) and dip (degrees): W = T / sin δ, capped at MAX_WIDTH_KM.
 * Shallow dips sweep out a wider plane through the same depth interval.
 */
export function widthFromDip(thickness: number, dipDeg: number): number {
  const s = Math.sin((dipDeg * Math.PI) / 180);
  return Math.min(thickness / Math.max(s, 1e-6), MAX_WIDTH_KM);
}

export interface SiteGeometry {
  /** Closest distance from the site to the rupture plane, km (Rrup). */
  rrup: number;
  /** Which side of the trace the site sits on. */
  side: 'hanging wall' | 'footwall' | 'on trace';
}

/**
 * Rupture distance for a surface site at signed horizontal distance `x` from
 * the trace (positive = hanging-wall side), fault dipping `dipDeg` from
 * `ztor` km depth with down-dip width `W` km. Point-to-segment distance in
 * the cross-section — exact for this 2-D idealization.
 */
export function rrupFromTrace(x: number, dipDeg: number, ztor: number, W: number): SiteGeometry {
  const dip = (dipDeg * Math.PI) / 180;
  const dx = W * Math.cos(dip); // horizontal reach of the plane
  const dz = W * Math.sin(dip); // vertical reach below ztor
  // Project the site (x, 0) onto the segment (0, ztor) → (dx, ztor + dz).
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? (x * dx - ztor * dz) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  const cx = t * dx;
  const cz = ztor + t * dz;
  const rrup = Math.hypot(x - cx, cz);
  const side = x > 0.5 ? 'hanging wall' : x < -0.5 ? 'footwall' : 'on trace';
  return { rrup, side };
}
