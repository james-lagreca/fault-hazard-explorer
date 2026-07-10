"""
hazard_api.py  —  authoritative hazard curves via openquake.hazardlib
---------------------------------------------------------------------
Mirrors the parameters of the JS prototype, but computes the real curve with
hazardlib: real fault geometry, real magnitude-scaling, real GSIMs, and the
real hazard-curve integrator. The JS UI can POST here and overlay the result.

Run:
    pip install "openquake.engine" fastapi "uvicorn[standard]"
    uvicorn hazard_api:app --reload --port 8008
    # then in the HTML, fetch('http://localhost:8008/hazard', {method:'POST', ...})

NOTE — three call signatures drift between OQ versions; they are flagged inline
with  # >>> VERIFY. If something errors, check them against your installed
openquake version first (`python -c "import openquake; print(openquake.__version__)"`).
"""
import math
import numpy as np
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from openquake.hazardlib.mfd import EvenlyDiscretizedMFD
from openquake.hazardlib.scalerel.leonard2014 import Leonard2014_SCR
from openquake.hazardlib.source import SimpleFaultSource
from openquake.hazardlib.geo import Point, Line
from openquake.hazardlib.tom import PoissonTOM
from openquake.hazardlib.site import Site, SiteCollection
from openquake.hazardlib.imt import PGA
from openquake.hazardlib.const import TRT
from openquake.hazardlib.calc.hazard_curve import calc_hazard_curves
from openquake.hazardlib.gsim.somerville_2009 import SomervilleEtAl2009NonCratonic

MU = 3.0e10            # shear modulus (Pa)
TRT_KEY = TRT.STABLE_CONTINENTAL

def M0(m):             # Hanks & Kanamori
    return 10 ** (1.5 * m + 9.05)

# ---------------------------------------------------------------------------
# Moment-balanced incremental rates (identical math to the JS preview, so the
# two engines are directly comparable). We hand hazardlib explicit per-bin
# rates via EvenlyDiscretizedMFD — robust across versions and exactly faithful.
# ---------------------------------------------------------------------------
def incremental_rates(kind, b, Mmin, Mmax, M0_rate, bin_width=0.1):
    edges = np.arange(Mmin, Mmax + bin_width, bin_width)
    mids = edges[:-1] + bin_width / 2
    if kind == "TGR":
        g = 10 ** (-b * mids)
    elif kind == "CHAR":                      # Youngs & Coppersmith 1985 style
        g = np.where(mids < Mmax - 0.5, 10 ** (-b * mids), 10 ** (-b * (Mmax - 1.0)))
    elif kind == "MMAX":                      # single characteristic near Mmax
        g = np.where(mids >= Mmax - 0.25, 1.0, 0.0)
    else:
        raise ValueError(kind)
    k = M0_rate / np.sum(g * M0(mids) * bin_width)
    rates = (k * g * bin_width)               # annual rate per bin
    return float(mids[0]), bin_width, [float(r) for r in rates]

def build_source(kind, p, M0_rate):
    min_mag, bw, rates = incremental_rates(kind, p.b, p.Mmin, p.Mmax, M0_rate)
    mfd = EvenlyDiscretizedMFD(min_mag=min_mag, bin_width=bw, occurrence_rates=rates)

    # geometry: straight trace length L, width set via seismogenic depths
    dip = 45.0
    usd = 0.0
    lsd = p.W * math.sin(math.radians(dip))          # so down-dip width ≈ p.W
    a = Point(0.0, 0.0)
    b = a.point_at(p.L, 0.0, 90.0)                    # L km east
    trace = Line([a, b])

    return SimpleFaultSource(                          # >>> VERIFY arg order
        source_id=f"flt_{kind}", name=kind, tectonic_region_type=TRT_KEY,
        mfd=mfd, rupture_mesh_spacing=2.0,
        magnitude_scaling_relationship=Leonard2014_SCR(),
        rupture_aspect_ratio=1.5, temporal_occurrence_model=PoissonTOM(1.0),
        upper_seismogenic_depth=usd, lower_seismogenic_depth=max(lsd, 2.0),
        fault_trace=trace, dip=dip, rake=90.0)

def hazard_for(kind, p, site, imtls, gsim):
    src = build_source(kind, p, MU * (p.L * 1e3) * (p.W * 1e3) * (p.slip * 1e-3))
    curves = calc_hazard_curves(                       # >>> VERIFY signature/return
        [src], SiteCollection([site]), imtls,
        {TRT_KEY: gsim}, truncation_level=3.0)
    poe = np.asarray(curves["PGA"][0])                 # POE in 1-yr window, site 0
    rate = -np.log1p(-np.clip(poe, 0, 1 - 1e-12))      # POE -> annual rate
    return [float(x) for x in rate]

# ---------------------------------------------------------------------------
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

class Params(BaseModel):
    b: float = 1.0
    slip: float = 5.0        # mm/yr
    L: float = 40.0          # km
    W: float = 15.0          # km
    Mmin: float = 5.0
    Mmax: float = 6.79
    R: float = 10.0          # km  (site offset perpendicular to trace midpoint)
    models: list[str] = ["TGR", "CHAR", "MMAX"]

@app.post("/hazard")
def hazard(p: Params):
    pga_levels = np.logspace(math.log10(0.01), math.log10(1.5), 40)
    imtls = {"PGA": pga_levels.tolist()}
    gsim = SomervilleEtAl2009NonCratonic()             # swap per neotectonic domain
    # site R km from the fault-trace midpoint (lat offset)
    mid = Point(0.0, 0.0).point_at(p.L / 2, 0.0, 90.0)
    spt = mid.point_at(p.R, 0.0, 0.0)                  # R km north
    site = Site(location=spt, vs30=760.0, vs30measured=True, z1pt0=50.0, z2pt5=1.0)
    out = {"pga": pga_levels.tolist(), "curves": {}}
    for k in p.models:
        try:
            out["curves"][k] = hazard_for(k, p, site, imtls, gsim)
        except Exception as e:                          # surface, don't crash the UI
            out["curves"][k] = {"error": str(e)}
    return out

# quick self-test without a server:  python hazard_api.py
if __name__ == "__main__":
    demo = Params()
    pga = np.logspace(math.log10(0.01), math.log10(1.5), 40)
    gsim = SomervilleEtAl2009NonCratonic()
    mid = Point(0.0, 0.0).point_at(demo.L / 2, 0.0, 90.0)
    site = Site(mid.point_at(demo.R, 0.0, 0.0), vs30=760.0,
                vs30measured=True, z1pt0=50.0, z2pt5=1.0)
    r = hazard_for("CHAR", demo, site, {"PGA": pga.tolist()}, gsim)
    print("CHAR hazard (annual rate):")
    for x, y in zip(pga[::8], r[::8]):
        print(f"  PGA {x:6.3f} g   rate {y:.3e}/yr")
