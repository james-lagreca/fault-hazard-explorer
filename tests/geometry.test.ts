// Unit tests for the cross-section geometry, the Thingbaijam (2017) scaling
// relation, and the deaggregation normalization. Pure math — no fixtures.

import { describe, it, expect } from 'vitest';
import { widthFromDip, rrupFromTrace, MAX_WIDTH_KM } from '../src/engine/geometry';
import { thingbaijam2017Reverse, wc1994 } from '../src/engine/scaling';
import { deaggregate, hazardCurve, ncdf } from '../src/engine/hazard';
import { makeGmm } from '../src/engine/gmpe';
import { compute, MODEL_KEYS } from '../src/engine/index';
import { hazardBands, weightedQuantile } from '../src/engine/uncertainty';

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
  const gmm = makeGmm('allen', 10, 760);
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

describe('hazardBands (epistemic fractiles)', () => {
  const p = {
    b: 1.0, slip: 0.1, L: 60, W: 18, Mmin: 4.5, Mmax: 7.0, lockMax: true,
    R: 10, vs30: 760, gmpe: 'allen' as const, scaling: 'wc94' as const, binWidth: 0.05,
  };

  it('weightedQuantile matches hazardlib quantile_curve interpolation', () => {
    // cum weights 0.2, 0.7, 1.0 over sorted [1, 2, 3]
    expect(weightedQuantile([3, 1, 2], [0.3, 0.2, 0.5], 0.1)).toBe(1);
    expect(weightedQuantile([3, 1, 2], [0.3, 0.2, 0.5], 0.45)).toBeCloseTo(1.5, 12);
    expect(weightedQuantile([3, 1, 2], [0.3, 0.2, 0.5], 0.85)).toBeCloseTo(2.5, 12);
  });

  it('brackets the best-estimate curve for every model', () => {
    const r = compute(p);
    const u = hazardBands(p);
    expect(u.pga).toEqual(r.pga);
    for (const k of MODEL_KEYS) {
      const { lo, hi } = u.bandByModel[k];
      for (let i = 0; i < r.pga.length; i++) {
        expect(lo[i]!).toBeLessThanOrEqual(hi[i]! * (1 + 1e-12));
        expect(lo[i]!).toBeLessThanOrEqual(r.hazByModel[k][i]! * (1 + 1e-12));
        expect(hi[i]!).toBeGreaterThanOrEqual(r.hazByModel[k][i]! * (1 - 1e-12));
      }
      // non-degenerate at the low-PGA plateau (slip ×/÷ 2 alone spreads it)
      expect(hi[0]! / lo[0]!).toBeGreaterThan(1.2);
    }
  });
});
