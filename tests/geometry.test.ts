// Unit tests for the cross-section geometry, the Thingbaijam (2017) scaling
// relation, and the deaggregation normalization. Pure math — no fixtures.

import { describe, it, expect } from 'vitest';
import { widthFromDip, rrupFromTrace, MAX_WIDTH_KM } from '../src/engine/geometry';
import { thingbaijam2017Reverse, wc1994 } from '../src/engine/scaling';
import { deaggregate, hazardCurve, ncdf } from '../src/engine/hazard';
import { makeGmm } from '../src/engine/gmpe';
import { atkinsonBoore2006Modified2011, eshm20Craton, rietbrockEdwards2019, somerville2009SS14 } from '../src/engine/gmms';
import { REAL_GMPES } from '../src/engine/types';
import { SCALING_AREA, ruptureDims, widthLimitMagnitude } from '../src/engine/floating';
import { compute, MODEL_KEYS } from '../src/engine/index';
import { DEFAULT_TREE, branchInputValue, paramsFromInputs, runLogicTree, weightedQuantile } from '../src/engine/uncertainty';
import type { FaultInputs } from '../src/engine/uncertainty';

describe('widthFromDip', () => {
  it('vertical fault: W equals the seismogenic thickness', () => {
    expect(widthFromDip(15, 90)).toBeCloseTo(15, 12);
  });
  it('45° dip sweeps a wider plane through the same depths', () => {
    expect(widthFromDip(15, 45)).toBeCloseTo(15 / Math.SQRT1_2 / Math.SQRT2 * Math.SQRT2, 6);
    expect(widthFromDip(15, 45)).toBeCloseTo(21.2132, 3);
  });
  it('shallow dips saturate at the width cap', () => {
    expect(widthFromDip(15, 10)).toBe(MAX_WIDTH_KM);
  });
});

describe('rrupFromTrace', () => {
  it('vertical surface-rupturing fault: Rrup is the horizontal distance', () => {
    const g = rrupFromTrace(10, 90, 0, 15);
    expect(g.rrup).toBeCloseTo(10, 12);
  });
  it('buried vertical fault: closest point is the top edge', () => {
    const g = rrupFromTrace(10, 90, 5, 15);
    expect(g.rrup).toBeCloseTo(Math.hypot(10, 5), 12);
  });
  it('hanging wall sits closer than the footwall at the same |x|', () => {
    const hw = rrupFromTrace(10, 45, 0, 20);
    const fw = rrupFromTrace(-10, 45, 0, 20);
    // hanging wall: projection onto the 45° plane → 10/√2; footwall: top edge → 10
    expect(hw.rrup).toBeCloseTo(10 / Math.SQRT2, 12);
    expect(fw.rrup).toBeCloseTo(10, 12);
    expect(hw.side).toBe('hanging wall');
    expect(fw.side).toBe('footwall');
  });
  it('site over the trace of a surface rupture touches the plane', () => {
    const g = rrupFromTrace(0, 45, 0, 20);
    expect(g.rrup).toBeCloseTo(0, 12);
    expect(g.side).toBe('on trace');
  });
});

describe('thingbaijam2017Reverse', () => {
  it('inverts log10(A) = -4.362 + 1.049·Mw', () => {
    // A = 600 km² → Mw = (log10(600) + 4.362) / 1.049
    const want = (Math.log10(600) + 4.362) / 1.049;
    expect(thingbaijam2017Reverse(600)).toBeCloseTo(want, 12);
    expect(want).toBeCloseTo(6.807, 3);
  });
  it('tracks WC94 closely, crossing near A ≈ 2000 km²', () => {
    expect(thingbaijam2017Reverse(600)).toBeGreaterThan(wc1994(600));
    expect(thingbaijam2017Reverse(3000)).toBeLessThan(wc1994(3000));
    expect(Math.abs(thingbaijam2017Reverse(3000) - wc1994(3000))).toBeLessThan(0.05);
  });
});

describe('deaggregate', () => {
  const gmm = makeGmm('allen', { rrup: 10, vs30: 760 });
  const mfd = { mids: [5.05, 5.55, 6.05, 6.55], rates: [1e-3, 5e-4, 2e-4, 1e-4], binWidth: 0.5, minMag: 5.05 };

  it('normalizes to 1 and matches the hand-computed shares', () => {
    const xstar = 0.05;
    const f = deaggregate(mfd, gmm, xstar)!;
    expect(f.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
    const lnx = Math.log(xstar);
    const raw = mfd.mids.map((m, i) => mfd.rates[i]! * (1 - ncdf((lnx - gmm(m).lnMean) / gmm(m).sigma)));
    const tot = raw.reduce((s, v) => s + v, 0);
    f.forEach((v, i) => expect(v).toBeCloseTo(raw[i]! / tot, 12));
  });
  it('returns null when the curve never reaches the target rate', () => {
    expect(deaggregate(mfd, gmm, null)).toBeNull();
  });
  it('is exposed per model on the engine result', () => {
    const r = compute({ b: 1, slip: 0.3, L: 40, W: 15, Mmin: 5, Mmax: 6.8, lockMax: true, R: 10, vs30: 760, gmpe: 'allen' });
    for (const key of ['GR', 'TGR', 'CHAR', 'MMAX'] as const) {
      const d = r.deaggByModel[key].rp475;
      if (d) expect(d.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
    }
  });
  it('deagg shares reproduce the hazard-curve rate decomposition', () => {
    const pga = [0.05];
    const lam = hazardCurve(mfd, pga, gmm)[0]!;
    const f = deaggregate(mfd, gmm, 0.05)!;
    // share × total rate re-sums to the curve value
    expect(f.reduce((s, v) => s + v * lam, 0)).toBeCloseTo(lam, 12);
  });
});

describe('scaling selection in compute()', () => {
  const base = { b: 1, slip: 0.3, L: 40, W: 15, Mmin: 5, Mmax: 6.8, lockMax: true, R: 10, vs30: 760, gmpe: 'allen' } as const;
  it('defaults to WC94 (fixture-compatible)', () => {
    expect(compute({ ...base }).scalingMag).toBeCloseTo(wc1994(600), 12);
  });
  it('honors the tmg17 selection', () => {
    expect(compute({ ...base, scaling: 'tmg17' }).scalingMag).toBeCloseTo(thingbaijam2017Reverse(600), 12);
  });
});

describe('logic tree (epistemic fractiles + sensitivity)', () => {
  const fi: FaultInputs = {
    b: 1.0, slip: 0.3, L: 40, dip: 45, thickness: 15, ztor: 0, x: 10, Mmin: 5.0, Mmax: 7.0,
    lockMax: true, vs30: 760, gmpe: 'allen', scaling: 'wc94', binWidth: 0.05,
  };
  const all = DEFAULT_TREE;

  it('weightedQuantile matches hazardlib quantile_curve interpolation', () => {
    // cum weights 0.2, 0.7, 1.0 over sorted [1, 2, 3]
    expect(weightedQuantile([3, 1, 2], [0.3, 0.2, 0.5], 0.1)).toBe(1);
    expect(weightedQuantile([3, 1, 2], [0.3, 0.2, 0.5], 0.45)).toBeCloseTo(1.5, 12);
    expect(weightedQuantile([3, 1, 2], [0.3, 0.2, 0.5], 0.85)).toBeCloseTo(2.5, 12);
  });

  it('paramsFromInputs derives W and Rrup from the cross-section', () => {
    const p = paramsFromInputs(fi);
    expect(p.W).toBeCloseTo(widthFromDip(15, 45), 12);
    expect(p.R).toBeCloseTo(rrupFromTrace(10, 45, 0, p.W).rrup, 12);
  });

  it('slip-only tree: 15th percentile is exactly the ÷2 branch', () => {
    const r = compute(paramsFromInputs(fi));
    const u = runLogicTree(fi, { slip: DEFAULT_TREE.slip });
    expect(u.nBranches).toBe(3);
    for (const k of MODEL_KEYS)
      for (let i = 0; i < r.pga.length; i++)
        expect(u.bandByModel[k].lo[i]!).toBeCloseTo(r.hazByModel[k][i]! * 0.5, 15);
  });

  it('full tree: 3^n branches, central branch == compute(), band brackets it', () => {
    const r = compute(paramsFromInputs(fi));
    const u = runLogicTree(fi, all);
    expect(u.nBranches).toBe(243);
    expect(u.pga).toEqual(r.pga);
    for (const k of MODEL_KEYS) {
      expect(u.bestAtRP[k].rp475).toBe(r.pgaAtRP[k].rp475);
      const { lo, hi } = u.bandByModel[k];
      for (let i = 0; i < r.pga.length; i++) {
        expect(lo[i]!).toBeLessThanOrEqual(hi[i]! * (1 + 1e-12));
        expect(lo[i]!).toBeLessThanOrEqual(r.hazByModel[k][i]! * (1 + 1e-12));
        expect(hi[i]!).toBeGreaterThanOrEqual(r.hazByModel[k][i]! * (1 - 1e-12));
      }
    }
  });

  it('sensitivity: one row per enabled input; dip moves the 475-yr motion', () => {
    const u = runLogicTree(fi, all);
    expect(u.sensitivity.map((s) => s.param)).toEqual(['slip', 'dip', 'thickness', 'b', 'mmax']);
    const dip = u.sensitivity.find((s) => s.param === 'dip')!;
    expect([dip.lowValue, dip.highValue]).toEqual([30, 60]);
    const [lo, hi] = dip.byModel.TGR.rp475;
    const best = u.bestAtRP.TGR.rp475!;
    expect(lo).not.toBeNull();
    expect(hi).not.toBeNull();
    expect(Math.abs(lo! / best - 1)).toBeGreaterThan(0.01);
    expect(Math.abs(hi! / best - 1)).toBeGreaterThan(0.01);
    // higher slip rate → more hazard → larger 475-yr motion
    const slip = u.sensitivity.find((s) => s.param === 'slip')!;
    expect(slip.byModel.TGR.rp475[1]!).toBeGreaterThan(best);
    expect(slip.byModel.TGR.rp475[0]!).toBeLessThan(best);
  });

  it('dip branches clamp to the physical range', () => {
    expect([-15, 0, 15].map((v) => branchInputValue('dip', { ...fi, dip: 85 }, v))).toEqual([70, 85, 90]);
    expect([-15, 0, 15].map((v) => branchInputValue('dip', { ...fi, dip: 15 }, v))).toEqual([10, 15, 30]);
  });

  it('user-defined branches: any count, weights normalized per input', () => {
    const r = compute(paramsFromInputs(fi));
    // slip ×1 / ×2 at equal weight: cum weights 0.5, 1.0 → 15% clamps to ×1, 85% = ×1.7
    for (const w of [0.5, 2]) {
      const u = runLogicTree(fi, { slip: [{ value: 1, weight: w }, { value: 2, weight: w }] });
      expect(u.nBranches).toBe(2);
      const i = 20;
      expect(u.bandByModel.TGR.lo[i]!).toBeCloseTo(r.hazByModel.TGR[i]!, 15);
      expect(u.bandByModel.TGR.hi[i]! / r.hazByModel.TGR[i]!).toBeCloseTo(1.7, 12);
    }
  });

  it('asymmetric branches: tornado uses the lowest / highest branch; bad rows dropped', () => {
    const u = runLogicTree(fi, {
      dip: [{ value: 20, weight: 0.3 }, { value: -5, weight: 0.7 }, { value: NaN, weight: 0.5 }, { value: 30, weight: 0 }],
      mmax: [{ value: 0.1, weight: 1 }],
    });
    expect(u.nBranches).toBe(2);
    const dip = u.sensitivity.find((s) => s.param === 'dip')!;
    expect([dip.lowValue, dip.highValue]).toEqual([40, 65]);
    const mm = u.sensitivity.find((s) => s.param === 'mmax')!;
    expect(mm.lowValue).toBeCloseTo(compute(paramsFromInputs(fi)).scalingMag + 0.1, 12);
  });
});

describe('Joyner–Boore distance + GMM wiring', () => {
  it('Rjb is 0 above the rupture, |x| on the footwall, past the down-dip edge beyond it', () => {
    // 45° plane, W = 20 → surface projection x ∈ [0, 14.142]
    expect(rrupFromTrace(5, 45, 0, 20).rjb).toBe(0);
    expect(rrupFromTrace(-7, 45, 0, 20).rjb).toBe(7);
    expect(rrupFromTrace(20, 45, 0, 20).rjb).toBeCloseTo(20 - 20 * Math.SQRT1_2, 12);
    // vertical fault: projection is the trace itself
    expect(rrupFromTrace(10, 90, 3, 15).rjb).toBeCloseTo(10, 12);
  });

  it('makeGmm routes Rjb models to rjb and Rrup models to rrup', () => {
    const site = { rrup: 12, rjb: 4, vs30: 500 };
    expect(makeGmm('som09nc', site)(6).lnMean).toBe(somerville2009SS14('noncratonic', 6, 4, 500).lnMean);
    expect(makeGmm('re19', site)(6).lnMean).toBe(rietbrockEdwards2019(6, 4).lnMean);
    expect(makeGmm('eshm20', site)(6).lnMean).toBe(eshm20Craton(6, 12, 500).lnMean);
    expect(makeGmm('ab06', site)(6).lnMean).toBe(atkinsonBoore2006Modified2011(6, 12, 500).lnMean);
  });

  it('every real GMM gives a finite, decreasing-with-distance PGA', () => {
    for (const k of REAL_GMPES) {
      const near = makeGmm(k, { rrup: 5, rjb: 3, vs30: 760 })(6.5);
      const far = makeGmm(k, { rrup: 80, rjb: 79, vs30: 760 })(6.5);
      expect(Number.isFinite(near.lnMean) && near.sigma > 0).toBe(true);
      expect(far.lnMean).toBeLessThan(near.lnMean);
    }
  });
});

describe('logic tree: GMM branches', () => {
  const fi: FaultInputs = {
    b: 1.0, slip: 0.3, L: 40, dip: 45, thickness: 15, ztor: 0, x: 10, Mmin: 5.0, Mmax: 7.0,
    lockMax: true, vs30: 760, gmpe: 'allen', scaling: 'wc94', binWidth: 0.05,
  };

  it('a single branch on the selected GMM is exactly compute()', () => {
    const r = compute(paramsFromInputs(fi));
    const u = runLogicTree(fi, { gmm: [{ key: 'allen', weight: 1 }] });
    expect(u.nBranches).toBe(1);
    expect(u.bandByModel.TGR.lo).toEqual(r.hazByModel.TGR);
  });

  it('two equal-weight GMMs: 15th percentile is the pointwise lower curve', () => {
    const a = compute(paramsFromInputs({ ...fi, gmpe: 'som09nc' }));
    const b = compute(paramsFromInputs({ ...fi, gmpe: 'drouet15' }));
    const u = runLogicTree(fi, { gmm: [{ key: 'som09nc', weight: 1 }, { key: 'drouet15', weight: 1 }] });
    for (let i = 0; i < a.pga.length; i += 10)
      expect(u.bandByModel.TGR.lo[i]!).toBeCloseTo(Math.min(a.hazByModel.TGR[i]!, b.hazByModel.TGR[i]!), 15);
  });

  it('GMM × slip crosses; tornado row names the lowest / highest GMM', () => {
    const keys = ['allen', 'som09nc', 'drouet15', 're19', 'eshm20'] as const;
    const u = runLogicTree(fi, { slip: DEFAULT_TREE.slip, gmm: keys.map((key) => ({ key, weight: 0.2 })) });
    expect(u.nBranches).toBe(15);
    const g = u.sensitivity.find((s) => s.param === 'gmm')!;
    const [kLo, kHi] = g.labels!.TGR.rp475;
    const at = (key: (typeof keys)[number]) => compute(paramsFromInputs({ ...fi, gmpe: key, binWidth: 0.05 })).pgaAtRP.TGR.rp475 ?? -Infinity;
    const vals = keys.map(at);
    expect(at(kLo as (typeof keys)[number])).toBe(Math.min(...vals));
    expect(at(kHi as (typeof keys)[number])).toBe(Math.max(...vals));
  });
});

describe('floating ruptures', () => {
  const spec = { L: 40, W: 20, aspectRatio: 1.5, scaling: 'wc94' as const };

  it('rupture dims: AR-shaped below the width limit, lengthened then length-capped above it', () => {
    const small = ruptureDims(5.5, spec);
    expect(small.length / small.width).toBeCloseTo(1.5, 12);
    expect(small.widthLimited).toBe(false);
    const mid = ruptureDims(widthLimitMagnitude(spec) + 0.1, spec);
    expect(mid.widthLimited).toBe(true);
    expect(mid.width).toBe(20);
    expect(mid.length * mid.width).toBeCloseTo(SCALING_AREA.wc94(widthLimitMagnitude(spec) + 0.1), 9);
    const big = ruptureDims(8, spec);
    expect(big.lengthLimited).toBe(true);
    expect([big.length, big.width]).toEqual([40, 20]);
  });

  it('width-limit magnitude inverts area = AR·W² for each scaling relation', () => {
    for (const k of ['wc94', 'leonard14', 'tmg17'] as const) {
      const m = widthLimitMagnitude({ ...spec, scaling: k });
      expect(SCALING_AREA[k](m)).toBeCloseTo(1.5 * 20 ** 2, 6);
    }
  });

  it('when every rupture fills the fault, floating equals the whole-plane model', () => {
    // 5 km × 5 km vertical fault: every magnitude ≥ 5.5 is width- and length-capped.
    const fi: FaultInputs = {
      b: 1, slip: 0.5, L: 5, dip: 90, thickness: 5, ztor: 0, x: 8, Mmin: 5.5, Mmax: 6.0,
      lockMax: false, vs30: 760, gmpe: 'som09nc', scaling: 'wc94', binWidth: 0.05,
    };
    const plane = compute(paramsFromInputs(fi));
    const fl = compute(paramsFromInputs({ ...fi, rupture: 'floating' }));
    for (let i = 0; i < plane.pga.length; i++) {
      const want = plane.hazByModel.TGR[i]!;
      if (want > 1e-8) expect(Math.abs(fl.hazByModel.TGR[i]! / want - 1)).toBeLessThan(1e-3);
    }
  });

  it('floating ruptures lower near-fault hazard vs the closest-distance plane model', () => {
    const fi: FaultInputs = {
      b: 1, slip: 0.3, L: 40, dip: 45, thickness: 15, ztor: 0, x: 10, Mmin: 5, Mmax: 7,
      lockMax: true, vs30: 760, gmpe: 'allen', scaling: 'wc94', binWidth: 0.05,
    };
    const plane = compute(paramsFromInputs(fi)).pgaAtRP.TGR.rp475!;
    const fl = compute(paramsFromInputs({ ...fi, rupture: 'floating' })).pgaAtRP.TGR.rp475!;
    expect(fl).toBeLessThan(plane);
  });
});
