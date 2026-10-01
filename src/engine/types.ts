// Shared engine types. The engine is pure: no DOM, no I/O, no globals.

export type ModelKey = 'GR' | 'TGR' | 'CHAR' | 'MMAX';

export const MODEL_KEYS: readonly ModelKey[] = ['GR', 'TGR', 'CHAR', 'MMAX'] as const;

export type GmpeKey =
  | 'allen'
  | 'som09nc'
  | 'som09yc'
  | 'drouet15'
  | 'drouet15d'
  | 're19'
  | 'eshm20'
  | 'ab06'
  | 'gen'
  | 'scr';

/** Display metadata per GMM: label, OpenQuake gsim, and what drives it. */
export const GMPE_META: Record<GmpeKey, { label: string; short: string; gsim: string | null; dist: 'rrup' | 'rjb'; usesVs30: boolean }> = {
  allen: { label: 'Allen 2012 — SE Aus. SCR (+SS14 site)', short: 'Allen12', gsim: 'Allen2012_SS14', dist: 'rrup', usesVs30: true },
  som09nc: { label: 'Somerville et al. 2009 — non-cratonic (+SS14)', short: 'Som09 NC', gsim: 'SomervilleEtAl2009NonCratonic_SS14', dist: 'rjb', usesVs30: true },
  som09yc: { label: 'Somerville et al. 2009 — Yilgarn craton (+SS14)', short: 'Som09 Yil', gsim: 'SomervilleEtAl2009YilgarnCraton_SS14', dist: 'rjb', usesVs30: true },
  drouet15: { label: 'Drouet 2015 — Brazil (hard rock)', short: 'Drouet15', gsim: 'DrouetBrazil2015', dist: 'rjb', usesVs30: false },
  drouet15d: { label: 'Drouet 2015 — Brazil, with depth (hard rock)', short: 'Drouet15d', gsim: 'DrouetBrazil2015withDepth', dist: 'rjb', usesVs30: false },
  re19: { label: 'Rietbrock & Edwards 2019 — UK (hard rock)', short: 'RE19', gsim: 'RietbrockEdwards2019Mean', dist: 'rjb', usesVs30: false },
  eshm20: { label: 'ESHM20 craton (+NGA-East site)', short: 'ESHM20', gsim: 'ESHM20Craton', dist: 'rrup', usesVs30: true },
  ab06: { label: 'Atkinson & Boore 2006 (mod. 2011)', short: 'AB06', gsim: 'AtkinsonBoore2006Modified2011', dist: 'rrup', usesVs30: true },
  gen: { label: 'Generic active-crust (toy)', short: 'toy gen', gsim: null, dist: 'rrup', usesVs30: false },
  scr: { label: 'SCR hard-rock (toy)', short: 'toy SCR', gsim: null, dist: 'rrup', usesVs30: false },
};

/** The validated (OpenQuake-backed) GMMs, in menu order. */
export const REAL_GMPES: readonly GmpeKey[] = ['allen', 'som09nc', 'som09yc', 'drouet15', 'drouet15d', 're19', 'eshm20', 'ab06'] as const;

/** Magnitude–area scaling relation used when `lockMax` is true. */
export type ScalingKey = 'wc94' | 'leonard14' | 'tmg17';

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
  /** Joyner–Boore distance, km, for Rjb-based GMMs. Defaults to R. */
  Rjb?: number;
  /** Time-averaged shear-wave velocity in the top 30 m, m/s (used by Allen 2012). */
  vs30: number;
  /** Ground-motion model key. `allen` = Allen (2012) SCR + SS14 site terms. */
  gmpe: GmpeKey;
  /** Magnitude bin width, dM. Default 0.1 to match the OpenQuake fixture grid. */
  binWidth?: number;
  /** Area→magnitude scaling relation. Default 'wc94' (fixture-compatible). */
  scaling?: ScalingKey;
  /**
   * Rupture model. 'plane' (default): every magnitude uses the closest
   * distance to the whole fault plane, hypocentre fixed at 7 km. 'floating':
   * scaling-relation ruptures float over the plane (needs `geom`).
   */
  rupture?: 'plane' | 'floating';
  /** Floating-rupture aspect ratio, length / width. Default 1.5. */
  aspectRatio?: number;
  /** Fault-plane geometry for floating ruptures. */
  geom?: { dip: number; ztor: number; x: number };
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
  /**
   * Magnitude deaggregation: each model's normalized per-bin share of the
   * exceedances of its own 475-yr / 2475-yr motion (aligned to mfd mids).
   * Null when the hazard curve never reaches that return period.
   */
  deaggByModel: Record<ModelKey, { rp475: number[] | null; rp2475: number[] | null }>;
}
