// Shared engine types. The engine is pure: no DOM, no I/O, no globals.

export type ModelKey = 'GR' | 'TGR' | 'CHAR' | 'MMAX';

export const MODEL_KEYS: readonly ModelKey[] = ['GR', 'TGR', 'CHAR', 'MMAX'] as const;

export type GmpeKey = 'allen' | 'gen' | 'scr';

export interface Params {
  /** Gutenberg-Richter b-value (slope of the exponential). */
  b: number;
  /** Fault slip rate, mm/yr. */
  slip: number;
  /** Along-strike fault length, km. */
  L: number;
  /** Down-dip fault width, km. */
  W: number;
  /** Minimum magnitude of the MFD. */
  Mmin: number;
  /** Characteristic / maximum magnitude (used when `lockMax` is false). */
  Mmax: number;
  /** When true, Mmax is overridden by the Wells & Coppersmith (1994) area scaling. */
  lockMax: boolean;
  /** Site distance from the fault (treated as rupture distance Rrup), km. */
  R: number;
  /** Time-averaged shear-wave velocity in the top 30 m, m/s (used by Allen 2012). */
  vs30: number;
  /** Ground-motion model key. `allen` = Allen (2012) SCR + SS14 site terms. */
  gmpe: GmpeKey;
  /** Magnitude bin width, dM. Default 0.1 to match the OpenQuake fixture grid. */
  binWidth?: number;
}

/** Incremental-rate description of a single MFD (one model). */
export interface Mfd {
  /** Bin-centre magnitudes. */
  mids: number[];
  /** Annual occurrence rate in each bin (already integrated over the bin). */
  rates: number[];
  /** Bin width used. */
  binWidth: number;
  /** Magnitude of the lowest bin centre. */
  minMag: number;
}

export interface EngineResult {
  params: Params;
  /** Effective Mmax used for the fault models (after lock-to-scaling logic). */
  Mmax: number;
  /** Wells & Coppersmith (1994) magnitude implied by the rupture area. */
  scalingMag: number;
  /** Fault moment rate, N·m/yr. */
  momentRate: number;
  /** Per-model incremental MFDs. */
  mfdByModel: Record<ModelKey, Mfd>;
  /** Per-model cumulative recurrence N(>=M) /yr, aligned to each model's own mids. */
  cumByModel: Record<ModelKey, number[]>;
  /** PGA levels (g) for the hazard curves. */
  pga: number[];
  /** Per-model annual rate of exceedance vs `pga`. */
  hazByModel: Record<ModelKey, number[]>;
  /** Return period (yr) of an ~Mmax event, per model. */
  recurrenceByModel: Record<ModelKey, number | null>;
  /** PGA (g) at the 475-yr and 2475-yr return periods, per model. */
  pgaAtRP: Record<ModelKey, { rp475: number | null; rp2475: number | null }>;
}
