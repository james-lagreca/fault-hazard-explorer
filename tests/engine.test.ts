// Golden-fixture parity: the TS engine vs the OpenQuake-backed oracle.
//
// CI is RED if compute() drifts from the fixtures in validation/fixtures/.
// That red/green state is the site's "OpenQuake-backed" credibility claim.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compute } from '../src/engine/index';
import { MODEL_KEYS } from '../src/engine/types';
import { leonard2014SCR } from '../src/engine/scaling';
import { allen2012SS14 } from '../src/engine/gmpe';
import type { Params } from '../src/engine/types';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', 'validation', 'fixtures');

// The engine reproduces OpenQuake's math (incremental rates, moment balance,
// YC1985 characteristic MFD, Leonard/WC scaling) — so we hold it to a tight
// floating-point tolerance, not a loose "close enough" one.
const REL_TOL = 1e-9;
const ABS_FLOOR = 1e-30;

interface Mfd {
  mids: number[];
  rates: number[];
  cum: number[];
}
interface Fixture {
  id: string;
  oracle: string;
  binWidth: number;
  params: Params;
  expect: {
    Mmax: number;
    scalingMag: number;
    leonardMag: number | null;
    momentRate: number;
    models: Record<string, Mfd>;
  };
}

function relClose(got: number, want: number): boolean {
  if (Math.abs(want) < ABS_FLOOR) return Math.abs(got) < ABS_FLOOR;
  return Math.abs(got - want) / Math.abs(want) < REL_TOL;
}

// MFD fixtures; GMM fixtures (gmm_*.json) have a different shape and are tested separately.
const files = readdirSync(fixtureDir).filter((f) => f.endsWith('.json') && !f.startsWith('gmm_'));

describe('engine ↔ OpenQuake fixtures', () => {
  it('has fixtures to test', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const fx = JSON.parse(readFileSync(join(fixtureDir, file), 'utf8')) as Fixture;

    describe(`${fx.id} (oracle: ${fx.oracle})`, () => {
      const result = compute(fx.params);

      it('matches scalar expectations (Mmax, scaling, moment rate)', () => {
        expect(relClose(result.Mmax, fx.expect.Mmax)).toBe(true);
        expect(relClose(result.scalingMag, fx.expect.scalingMag)).toBe(true);
        expect(relClose(result.momentRate, fx.expect.momentRate)).toBe(true);
      });

      // Leonard (2014) SCR scaling must equal OpenQuake's Leonard2014_SCR class.
      it.runIf(fx.expect.leonardMag != null)('Leonard2014_SCR matches OpenQuake', () => {
        const area = fx.params.L * fx.params.W;
        expect(relClose(leonard2014SCR(area), fx.expect.leonardMag!)).toBe(true);
      });

      for (const key of MODEL_KEYS) {
        it(`model ${key}: bin grid + balanced rates match`, () => {
          const want = fx.expect.models[key]!;
          const got = result.mfdByModel[key]!;

          expect(got.mids.length).toBe(want.mids.length);
          for (let i = 0; i < want.mids.length; i++) {
            expect(Math.abs(got.mids[i]! - want.mids[i]!)).toBeLessThan(1e-6);
            expect(relClose(got.rates[i]!, want.rates[i]!)).toBe(true);
          }

          // moment balance: Σ rateᵢ · M0(mᵢ) == fault moment rate
          const moment = got.rates.reduce(
            (s, r, i) => s + r * Math.pow(10, 1.5 * got.mids[i]! + 9.05),
            0,
          );
          expect(relClose(moment, fx.expect.momentRate)).toBe(true);
        });
      }
    });
  }
});

// --- Ground-motion model parity: TS Allen2012_SS14 vs the OpenQuake gsim -----
interface GmmFixture {
  oracle: string;
  gsim: string;
  rows: { mag: number; rrup: number; vs30: number; hypo: number; lnMean: number; sigma: number }[];
}
const gmmPath = join(fixtureDir, 'gmm_allen2012_ss14.json');
const gmmFx: GmmFixture | null = existsSync(gmmPath)
  ? (JSON.parse(readFileSync(gmmPath, 'utf8')) as GmmFixture)
  : null;

describe.runIf(gmmFx)('Allen2012_SS14 GMM ↔ OpenQuake', () => {
  it(`PGA ln-mean + sigma match the gsim at all ${gmmFx?.rows.length} grid points`, () => {
    for (const row of gmmFx!.rows) {
      const p = allen2012SS14(row.mag, row.rrup, row.vs30, row.hypo);
      expect(relClose(p.lnMean, row.lnMean)).toBe(true);
      expect(relClose(p.sigma, row.sigma)).toBe(true);
    }
  });
});
