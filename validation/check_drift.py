"""Tolerance-based fixture drift check.

Compares the freshly regenerated fixtures on disk against the committed ones
(HEAD) numerically, at the same relative tolerance the TypeScript test suite
asserts (1e-9). A byte-exact `git diff` gate is flaky here: CI runners have
heterogeneous CPUs, and numpy's transcendental functions (exp/log10) can
differ by 1 ulp across microarchitectures, which is ~1e-16 — physically
meaningless but byte-visible. Strings (e.g. the `oracle` field) must still
match exactly, so a provisional non-hazardlib regeneration still fails loudly.
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

RTOL = 1e-9
ABS_FLOOR = 1e-30
FIXDIR = Path(__file__).resolve().parent / "fixtures"
REPO = FIXDIR.parent.parent


def compare(a, b, path: str) -> list[str]:
    if isinstance(a, dict) and isinstance(b, dict):
        errs = []
        if a.keys() != b.keys():
            errs.append(f"{path}: keys {sorted(a.keys() ^ b.keys())} differ")
        for k in a.keys() & b.keys():
            errs += compare(a[k], b[k], f"{path}.{k}")
        return errs
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return [f"{path}: length {len(a)} != {len(b)}"]
        errs = []
        for i, (x, y) in enumerate(zip(a, b)):
            errs += compare(x, y, f"{path}[{i}]")
        return errs
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not (
        isinstance(a, bool) or isinstance(b, bool)
    ):
        if not math.isclose(float(a), float(b), rel_tol=RTOL, abs_tol=ABS_FLOOR):
            return [f"{path}: {a!r} != {b!r}"]
        return []
    if a != b:
        return [f"{path}: {a!r} != {b!r}"]
    return []


def main() -> int:
    failed = False
    files = sorted(FIXDIR.glob("*.json"))
    if not files:
        print("::error::no fixtures found")
        return 1
    for f in files:
        rel = f"validation/fixtures/{f.name}"
        head = subprocess.run(
            ["git", "show", f"HEAD:{rel}"], capture_output=True, text=True, cwd=REPO
        )
        if head.returncode != 0:
            print(f"::error::{rel} is not committed — commit regenerated fixtures")
            failed = True
            continue
        try:
            committed = json.loads(head.stdout.lstrip("﻿"))
            regenerated = json.loads(f.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError as e:
            print(f"::error::{rel} is not valid JSON: {e}")
            failed = True
            continue
        errs = compare(committed, regenerated, f.name)
        if errs:
            failed = True
            for e in errs[:10]:
                print(f"::error::fixture drift beyond {RTOL:g}: {e}")
            if len(errs) > 10:
                print(f"::error::… and {len(errs) - 10} more in {f.name}")
        else:
            print(f"ok: {f.name}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
