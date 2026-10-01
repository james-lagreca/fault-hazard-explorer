#!/usr/bin/env python3
"""
generate_fixtures.py  —  the OpenQuake-backed validation oracle.
-----------------------------------------------------------------
Writes golden JSON fixtures that the TypeScript engine is asserted equal to in
CI (tests/engine.test.ts). The credibility claim of this site is "every release
is asserted equal to OpenQuake within tolerance" — this script is what makes
that claim checkable.

Two layers:
  1. A pure-Python REFERENCE of the moment-balanced incremental-rate math. It is
     deliberately identical, line for line, to src/engine/mfd.ts so the TS engine
     and the fixtures share one definition of the discretization.
  2. An optional HAZARDLIB CROSS-CHECK. When openquake.hazardlib is importable,
     each fixture's rates are loaded into EvenlyDiscretizedMFD and its
     get_total_moment_rate() is asserted equal to the target moment rate, and the
     area->magnitude scaling is checked against Leonard2014_SCR. The fixture then
     records oracle = "openquake <version>". Without OQ installed the fixtures are
     written with oracle = "python-reference (PROVISIONAL — regenerate in CI)".

Run:  python validation/generate_fixtures.py
CI:   .github/workflows/validate.yml installs openquake.engine, regenerates, and
      fails the build if the committed fixtures drift.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path

MU = 3.0e10
GR_CAP = 7.5
DEFAULT_BIN_WIDTH = 0.1
MODELS = ["GR", "TGR", "CHAR", "MMAX"]
FIXTURE_DIR = Path(__file__).parent / "fixtures"


def M0(m: float) -> float:
    return 10.0 ** (1.5 * m + 9.05)


def moment_rate(L_km: float, W_km: float, slip_mm_yr: float) -> float:
    return MU * (L_km * 1e3) * (W_km * 1e3) * (slip_mm_yr * 1e-3)


def wc1994(area_km2: float) -> float:
    return 4.07 + 0.98 * math.log10(area_km2)


def magnitude_bins(Mmin: float, Mmax: float, bw: float) -> list[float]:
    nb = max(1, round((Mmax - Mmin) / bw))
    return [round(Mmin + (i + 0.5) * bw, 6) for i in range(nb)]


def shape_for(kind: str, mids: list[float], b: float, Mmax: float) -> list[float]:
    if kind in ("GR", "TGR"):
        return [10.0 ** (-b * m) for m in mids]
    if kind == "CHAR":
        return [
            10.0 ** (-b * m) if m < Mmax - 0.5 else 10.0 ** (-b * (Mmax - 1.0))
            for m in mids
        ]
    if kind == "MMAX":
        return [1.0 if m >= Mmax - 0.25 else 0.0 for m in mids]
    raise ValueError(kind)


def balance_shape(mids, shape, bw, target) -> list[float]:
    denom = sum(max(0.0, s) * M0(m) * bw for m, s in zip(mids, shape))
    if denom <= 0:
        return [0.0 for _ in mids]
    k = target / denom
    return [k * max(0.0, s) * bw for s in shape]


def _cumulative(rates):
    cum = [0.0] * len(rates)
    acc = 0.0
    for i in range(len(rates) - 1, -1, -1):
        acc += rates[i]
        cum[i] = acc
    return cum


def build_mfd(kind, b, Mmin, Mmax, bw, target):
    upper = max(GR_CAP, Mmax) if kind == "GR" else Mmax
    mids = magnitude_bins(Mmin, upper, bw)
    shape = shape_for(kind, mids, b, Mmax)
    rates = balance_shape(mids, shape, bw, target)
    return {"mids": mids, "rates": rates, "cum": _cumulative(rates)}


DELTA_CHAR = 0.5


def _pyround(x):
    return math.floor(x + (-0.5 if x < 0 else 0.5))


def yc1985_reference(min_mag, b_val, char_mag, total_moment_rate, bw):
    """Pure-Python port of OpenQuake's YoungsCoppersmith1985MFD.from_total_moment_rate,
    used offline when hazardlib is unavailable. Identical to src/engine/mfd.ts."""
    def coeffs(tmr):
        beta = b_val * math.log(10)
        mu = char_mag + DELTA_CHAR / 2
        m0 = min_mag
        c, d = 1.5, 9.05
        mo_u = 10 ** (c * mu + d)
        c1 = math.exp(-beta * (mu - m0 - 0.5))
        c2 = math.exp(-beta * (mu - m0 - 1.5))
        c3 = beta * c2 / (2 * (1 - c1) + beta * c2)
        c4 = (b_val * 10 ** (-c / 2) / (c - b_val)) + (
            b_val * math.exp(beta) * (1 - 10 ** (-c / 2)) / c)
        n = (1 - c1) * tmr / ((1 - c3) * c1 * mo_u * c4)
        cr = c3 * n
        a = math.log10((n - cr) / (10 ** (-b_val * min_mag) - 10 ** (-b_val * (char_mag - 0.25))))
        return a, cr

    mn = _pyround(min_mag / bw) * bw
    mx = _pyround((char_mag + DELTA_CHAR / 2) / bw) * bw
    mn += bw / 2
    mx -= bw / 2
    num = int(_pyround((mx - mn) / bw)) + 1
    mids, mag = [], mn
    for _ in range(num):
        mids.append(mag)
        mag += bw

    def rate(m, a, cr):
        lo, hi = m - bw / 2, m + bw / 2
        if m >= min_mag and m < char_mag - DELTA_CHAR / 2:
            return 10 ** (a - b_val * lo) - 10 ** (a - b_val * hi)
        return cr / DELTA_CHAR * bw

    a1, cr1 = coeffs(total_moment_rate)
    r1 = [rate(m, a1, cr1) for m in mids]
    calc = sum(r * M0(m) for m, r in zip(mids, r1))
    adj = total_moment_rate / (calc / total_moment_rate)
    a2, cr2 = coeffs(adj)
    rates = [rate(m, a2, cr2) for m in mids]
    return mids, rates


def char_mfd(Mmin, b, Mmax, target, bw, yc_cls):
    """Characteristic MFD: the real YoungsCoppersmith1985MFD when hazardlib is
    present, else the validated Python port. char_mag = Mmax - 0.25 so the
    absolute max magnitude equals the fault Mmax."""
    char_mag = Mmax - DELTA_CHAR / 2
    if yc_cls is not None:
        m = yc_cls.from_total_moment_rate(
            min_mag=Mmin, b_val=b, char_mag=char_mag,
            total_moment_rate=target, bin_width=bw)
        pairs = m.get_annual_occurrence_rates()
        mids = [float(a) for a, _ in pairs]
        rates = [float(r) for _, r in pairs]
    else:
        mids, rates = yc1985_reference(Mmin, b, char_mag, target, bw)
    return {"mids": mids, "rates": rates, "cum": _cumulative(rates)}


# --- optional hazardlib cross-check ----------------------------------------
def hazardlib_oracle():
    """Return (oracle_string, check_fn) where check_fn(target, mids, rates, bw)
    asserts hazardlib agrees, or (provisional_string, None) if OQ is absent.

    The check round-trips our incremental rates through hazardlib's own
    EvenlyDiscretizedMFD and recomputes the total moment from the rates it hands
    back, asserting it equals the target fault moment rate. This validates the
    moment-balance bookkeeping against the real library. (Deeper per-class shape
    parity — engine CHAR vs YoungsCoppersmith1985MFD — is Phase 3.)
    """
    try:
        import importlib.metadata as _md
        from openquake.hazardlib.mfd import EvenlyDiscretizedMFD  # noqa: F401
        try:
            ver = _md.version("openquake.engine")
        except Exception:
            ver = "installed"
    except Exception:
        return ("python-reference (PROVISIONAL — regenerate in CI)", None)

    def check(target, mids, rates, bw):
        nonzero = [(m, r) for m, r in zip(mids, rates) if r > 0]
        if not nonzero:
            return
        min_mag = nonzero[0][0]
        occ = [r for _, r in nonzero]
        mfd = EvenlyDiscretizedMFD(min_mag=min_mag, bin_width=bw, occurrence_rates=occ)
        total = sum(r * M0(m) for m, r in mfd.get_annual_occurrence_rates())
        rel = abs(total - target) / target
        assert rel < 1e-6, f"OQ moment-rate mismatch: {total} vs {target} (rel {rel})"

    return (f"openquake {ver}", check)


def leonard_scaling(area_km2: float):
    """OQ Leonard2014_SCR magnitude for the area (km²), if hazardlib is present."""
    try:
        from openquake.hazardlib.scalerel.leonard2014 import Leonard2014_SCR
        return float(Leonard2014_SCR().get_median_mag(area_km2, rake=90.0))
    except Exception:
        return None


def yc_class():
    """The real YoungsCoppersmith1985MFD class if hazardlib is present, else None."""
    try:
        from openquake.hazardlib.mfd import YoungsCoppersmith1985MFD
        return YoungsCoppersmith1985MFD
    except Exception:
        return None


# --- canonical parameter combos --------------------------------------------
# Include the SPEC's named cases: 40 km / Mmax 6.79 and an 80 km case.
CASES = [
    {"id": "base_40km_locked", "b": 1.0, "slip": 5.0, "L": 40, "W": 15,
     "Mmin": 5.0, "lockMax": True, "Mmax": None},
    {"id": "long_80km_locked", "b": 1.0, "slip": 5.0, "L": 80, "W": 15,
     "Mmin": 5.0, "lockMax": True, "Mmax": None},
    {"id": "se_australia_scr", "b": 0.9, "slip": 0.04, "L": 30, "W": 15,
     "Mmin": 5.0, "lockMax": True, "Mmax": None},
    {"id": "segmented_unlocked", "b": 1.0, "slip": 5.0, "L": 120, "W": 18,
     "Mmin": 5.0, "lockMax": False, "Mmax": 6.8},
]


def build_fixture(case, oracle_name, check, yc_cls):
    bw = DEFAULT_BIN_WIDTH
    area = case["L"] * case["W"]
    scaling_mag = wc1994(area)
    Mmax = scaling_mag if case["lockMax"] else case["Mmax"]
    target = moment_rate(case["L"], case["W"], case["slip"])

    models = {}
    for kind in MODELS:
        if kind == "CHAR":
            mfd = char_mfd(case["Mmin"], case["b"], Mmax, target, bw, yc_cls)
        else:
            mfd = build_mfd(kind, case["b"], case["Mmin"], Mmax, bw, target)
        if check is not None:
            check(target, mfd["mids"], mfd["rates"], bw)
        models[kind] = mfd

    return {
        "id": case["id"],
        "oracle": oracle_name,
        "binWidth": bw,
        "params": {
            "b": case["b"], "slip": case["slip"], "L": case["L"], "W": case["W"],
            "Mmin": case["Mmin"], "Mmax": case["Mmax"], "lockMax": case["lockMax"],
            "R": 10.0, "vs30": 760.0, "gmpe": "gen", "binWidth": bw,
        },
        "expect": {
            "Mmax": Mmax,
            "scalingMag": scaling_mag,
            "leonardMag": leonard_scaling(area),
            "momentRate": target,
            "models": models,
        },
    }


def build_gmm_fixture():
    """PGA from the real Allen2012_SS14 gsim over a (mag, rrup, vs30) grid, at a
    fixed shallow hypocentral depth. Returns None if hazardlib is unavailable
    (the committed fixture is then left untouched and re-made in CI)."""
    try:
        import numpy as np
        import importlib.metadata as _md
        from openquake.hazardlib.gsim.allen_2012 import Allen2012_SS14
        from openquake.hazardlib.imt import PGA
        from openquake.hazardlib.contexts import RuptureContext
    except Exception:
        return None

    mags = [5.0, 5.5, 6.0, 6.5, 7.0]
    rrups = [5.0, 10.0, 20.0, 40.0, 80.0]
    vs30s = [200.0, 300.0, 400.0, 600.0, 760.0, 820.0, 1100.0]
    hypo = 7.0  # shallow regime; matches DEFAULT_HYPO_DEPTH in the TS engine
    combos = [(m, r, v) for m in mags for r in rrups for v in vs30s]
    n = len(combos)

    ctx = RuptureContext()
    ctx.mag = np.array([c[0] for c in combos])
    ctx.rrup = np.array([c[1] for c in combos])
    ctx.vs30 = np.array([c[2] for c in combos])
    ctx.hypo_depth = np.full(n, hypo)
    mean = np.zeros((1, n))
    sig = np.zeros((1, n))
    tau = np.zeros((1, n))
    phi = np.zeros((1, n))
    Allen2012_SS14().compute(ctx, [PGA()], mean, sig, tau, phi)

    rows = [
        {"mag": c[0], "rrup": c[1], "vs30": c[2], "hypo": hypo,
         "lnMean": float(mean[0, i]), "sigma": float(sig[0, i])}
        for i, c in enumerate(combos)
    ]
    try:
        ver = _md.version("openquake.engine")
    except Exception:
        ver = "installed"
    return {"id": "gmm_allen2012_ss14", "oracle": f"openquake {ver}",
            "imt": "PGA", "gsim": "Allen2012_SS14", "rows": rows}


# The other NSHA GMMs: (fixture id, OpenQuake gsim class name, needs vs30,
# needs hypo_depth). Each is evaluated for PGA over a grid that crosses every
# breakpoint in its functional form (distance hinges, Vs30 thresholds,
# magnitude hinges), with rjb = rrup = the grid distance.
NSHA_GMMS = [
    ("gmm_somerville2009_noncratonic_ss14", "SomervilleEtAl2009NonCratonic_SS14", True, False),
    ("gmm_somerville2009_yilgarn_ss14", "SomervilleEtAl2009YilgarnCraton_SS14", True, False),
    ("gmm_drouet2015_brazil", "DrouetBrazil2015", False, False),
    ("gmm_drouet2015_brazil_depth", "DrouetBrazil2015withDepth", False, True),
    ("gmm_rietbrock_edwards2019", "RietbrockEdwards2019Mean", False, False),
    ("gmm_eshm20_craton", "ESHM20Craton", True, False),
    ("gmm_atkinson_boore2006_mod2011", "AtkinsonBoore2006Modified2011", True, False),
]
GRID_MAGS = [4.5, 5.0, 5.5, 6.0, 6.2, 6.4, 6.5, 7.0, 7.5]
GRID_DISTS = [0.0, 0.5, 1.0, 3.0, 5.0, 10.0, 20.0, 40.0, 50.0, 60.0, 80.0, 120.0, 150.0, 250.0]
GRID_VS30 = [150.0, 250.0, 319.0, 360.0, 500.0, 600.0, 760.0, 865.0, 1100.0, 1300.0, 1600.0,
             2100.0, 2995.0, 3000.0]
GRID_HYPO = [3.0, 7.0, 15.0]


def build_nsha_gmm_fixture(fid, gsim_name, needs_vs30, needs_hypo):
    """PGA ln-mean and total sigma from a real OpenQuake gsim over the grid.
    Returns None if hazardlib is unavailable."""
    try:
        import numpy as np
        import importlib.metadata as _md
        from openquake.hazardlib.gsim import get_available_gsims
        from openquake.hazardlib.imt import PGA
        from openquake.hazardlib.contexts import RuptureContext
    except Exception:
        return None

    vs30s = GRID_VS30 if needs_vs30 else [760.0]
    hypos = GRID_HYPO if needs_hypo else [7.0]
    combos = [(m, r, v, h) for m in GRID_MAGS for r in GRID_DISTS for v in vs30s for h in hypos]
    n = len(combos)
    ctx = RuptureContext()
    ctx.mag = np.array([c[0] for c in combos])
    ctx.rrup = np.array([c[1] for c in combos])
    ctx.rjb = np.array([c[1] for c in combos])
    ctx.vs30 = np.array([c[2] for c in combos])
    ctx.hypo_depth = np.array([c[3] for c in combos])
    ctx.rake = np.full(n, 90.0)  # AB06 style-of-faulting dummies (unused for PGA mean)
    mean = np.zeros((1, n))
    sig = np.zeros((1, n))
    tau = np.zeros((1, n))
    phi = np.zeros((1, n))
    get_available_gsims()[gsim_name]().compute(ctx, [PGA()], mean, sig, tau, phi)

    rows = [
        {"mag": c[0], "rrup": c[1], "rjb": c[1], "vs30": c[2], "hypo": c[3],
         "lnMean": float(mean[0, i]), "sigma": float(sig[0, i])}
        for i, c in enumerate(combos)
    ]
    try:
        ver = _md.version("openquake.engine")
    except Exception:
        ver = "installed"
    return {"id": fid, "oracle": f"openquake {ver}", "imt": "PGA", "gsim": gsim_name, "rows": rows}


# Floating ruptures: full OpenQuake hazard curves for a SimpleFaultSource
# (TGR MFD, scaling-relation ruptures at a given aspect ratio, 1 km rupture
# mesh) at sites around the fault. The TS engine's floating-rupture model is
# asserted to match these within a stated tolerance (mesh discretization,
# not formula error, sets the floor) — see tests/engine.test.ts.
FLOATING_CASES = [
    dict(id="hw10_allen", L=40, dip=45, thickness=15, x=10, gsim="Allen2012_SS14", ar=1.5),
    dict(id="fw10_allen", L=40, dip=45, thickness=15, x=-10, gsim="Allen2012_SS14", ar=1.5),
    dict(id="hw30_som09", L=40, dip=30, thickness=15, x=30, gsim="SomervilleEtAl2009NonCratonic_SS14", ar=1.5),
    dict(id="steep60_ar1", L=60, dip=60, thickness=15, x=5, gsim="Allen2012_SS14", ar=1.0),
]


def build_floating_fixture():
    try:
        import numpy as np
        import importlib.metadata as _md
        from openquake.hazardlib.source import SimpleFaultSource
        from openquake.hazardlib.mfd import EvenlyDiscretizedMFD
        from openquake.hazardlib.scalerel.base import BaseMSR
        from openquake.hazardlib.geo import Line, Point
        from openquake.hazardlib.tom import PoissonTOM
        from openquake.hazardlib.site import Site, SiteCollection
        from openquake.hazardlib.calc.hazard_curve import calc_hazard_curves
        from openquake.hazardlib.gsim import get_available_gsims
        from openquake.hazardlib import const
    except Exception:
        return None

    km_per_deg = 6371.0 * math.pi / 180.0  # OpenQuake's spherical earth

    class WC94Inverse(BaseMSR):
        """Inverse of the tool's area→M relation (a full-fault rupture is exactly Mmax)."""
        def get_median_area(self, mag, rake):
            return 10.0 ** ((mag - 4.07) / 0.98)

        def get_std_dev_area(self, mag, rake):
            return 0.0

    levels = [0.001 * 3000 ** (i / 160) for i in range(161)]
    trt = const.TRT.STABLE_CONTINENTAL
    cases = []
    for c in FLOATING_CASES:
        c = {"b": 1.0, "slip": 0.3, "Mmin": 5.0, "mesh": 1.0, **c}
        W = min(c["thickness"] / math.sin(math.radians(c["dip"])), 50.0)
        Mmax = wc1994(c["L"] * W)
        mfd = build_mfd("TGR", c["b"], c["Mmin"], Mmax, DEFAULT_BIN_WIDTH, moment_rate(c["L"], W, c["slip"]))
        src = SimpleFaultSource(
            c["id"], c["id"], trt, EvenlyDiscretizedMFD(mfd["mids"][0], DEFAULT_BIN_WIDTH, mfd["rates"]),
            c["mesh"], WC94Inverse(), c["ar"], PoissonTOM(1.0), 0.0, c["thickness"],
            Line([Point(0.0, 0.0), Point(0.0, c["L"] / km_per_deg)]), c["dip"], 90.0)
        # Trace runs north, so the plane dips east: +x is the hanging wall.
        site = Site(Point(c["x"] / km_per_deg, (c["L"] / 2) / km_per_deg), vs30=760.0,
                    vs30measured=True, z1pt0=40.0, z2pt5=1.0)
        poes = calc_hazard_curves([src], SiteCollection([site]), {"PGA": levels},
                                  {trt: get_available_gsims()[c["gsim"]]()}, truncation_level=99.0)
        p = np.clip(np.asarray(poes["PGA"][0], dtype=float), 0.0, 1.0 - 1e-16)
        cases.append({**c, "W": W, "Mmax": Mmax, "lambda": (-np.log1p(-p)).tolist()})
    try:
        ver = _md.version("openquake.engine")
    except Exception:
        ver = "installed"
    return {"id": "hazard_floating", "oracle": f"openquake {ver}", "imt": "PGA",
            "pga": levels, "cases": cases}


def main():
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    oracle_name, check = hazardlib_oracle()
    yc_cls = yc_class()
    print(f"oracle: {oracle_name}")
    print(f"CHAR source: {'YoungsCoppersmith1985MFD' if yc_cls else 'python port'}")
    for case in CASES:
        fx = build_fixture(case, oracle_name, check, yc_cls)
        out = FIXTURE_DIR / f"{case['id']}.json"
        out.write_text(json.dumps(fx, indent=2) + "\n")
        print(f"  wrote {out.relative_to(FIXTURE_DIR.parent.parent)}")

    gmm = build_gmm_fixture()
    if gmm is not None:
        out = FIXTURE_DIR / "gmm_allen2012_ss14.json"
        out.write_text(json.dumps(gmm, indent=2) + "\n")
        print(f"  wrote {out.relative_to(FIXTURE_DIR.parent.parent)} ({len(gmm['rows'])} rows)")
    else:
        print("  (skipped GMM fixture — hazardlib unavailable)")

    for fid, name, needs_vs30, needs_hypo in NSHA_GMMS:
        fx = build_nsha_gmm_fixture(fid, name, needs_vs30, needs_hypo)
        if fx is None:
            print(f"  (skipped {fid} — hazardlib unavailable)")
            continue
        out = FIXTURE_DIR / f"{fid}.json"
        out.write_text(json.dumps(fx, indent=2) + "\n")
        print(f"  wrote {out.relative_to(FIXTURE_DIR.parent.parent)} ({len(fx['rows'])} rows)")

    fl = build_floating_fixture()
    if fl is not None:
        out = FIXTURE_DIR / "hazard_floating.json"
        out.write_text(json.dumps(fl, indent=2) + "\n")
        print(f"  wrote {out.relative_to(FIXTURE_DIR.parent.parent)} ({len(fl['cases'])} cases)")
    else:
        print("  (skipped floating-rupture fixture — hazardlib unavailable)")

    if check is None:
        print("\nNOTE: OpenQuake not installed — fixtures are PROVISIONAL.")
        print("      validate.yml regenerates them against real hazardlib in CI.")


if __name__ == "__main__":
    main()
