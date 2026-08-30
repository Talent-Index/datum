"""
Public data layer tests.

Run:  python3 tests/test_data.py

Runs entirely offline against the committed cache and register fixtures. No
network, no keys, no flakiness. Warm the cache with real responses and these
same tests then assert against real data.
"""

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from datasources.corroborate import corroborate
from datasources.http import OfflineMiss, fetch
from datasources.osm import footprints, geocode
from datasources.registers import check_developer, find_contractor, find_notices

TODAY = date(2026, 8, 30)
SITE = "Willow Park Block A, Kilimani"
LAT, LON = -1.29210, 36.78270

PASS, FAIL = [], []


def check(label, actual, expected):
    if actual == expected:
        PASS.append(label)
        print(f"  PASS  {label}")
    else:
        FAIL.append(label)
        print(f"  FAIL  {label}: got {actual!r}, expected {expected!r}")


def test_cache():
    print("\nCache behaviour")
    g = geocode(SITE)
    check("geocode resolves from cache", g.confidence in ("exact", "approximate"), True)
    check("coordinates parsed", abs(g.latitude - LAT) < 0.05, True)

    try:
        fetch("https://nominatim.openstreetmap.org/search?q=nothing-cached")
        check("offline miss raises", "returned", "raised")
    except OfflineMiss:
        check("offline miss raises", "raised", "raised")


def test_footprints():
    print("\nBuilding footprints")
    f = footprints(LAT, LON, 200)
    check("buildings counted", f.building_count, 3)
    check("under-construction flagged", f.buildings_under_construction, 1)
    check("land use captured", "residential" in f.landuse, True)
    check("nearest distance computed", f.nearest_building_m is not None, True)
    check("coverage caveat present", "absence as unknown" in f.note, True)


def test_registers():
    print("\nKenyan registers")
    c = find_contractor("Willow Park Developments Limited")  # suffix differs
    check("name matching ignores Ltd/Limited", c is not None and c.status, "active")
    check("unknown company returns nothing", find_contractor("Nonexistent Co"), None)

    n = find_notices("Kilimani Heights Ltd")
    check("gazette notice found", len(n), 1)
    check("notice typed", n[0].notice_type, "winding-up")


def test_developer_verdicts():
    print("\nDeveloper verdicts")
    clear = check_developer("Willow Park Developments Ltd", "EBK/PR/2026/00812", TODAY)
    check("clean developer clears", clear.verdict, "clear")
    check("no flags raised", clear.flags, [])

    bad = check_developer("Kilimani Heights Ltd", today=TODAY)
    check("deregistered plus winding-up stops it", bad.verdict, "do not proceed")
    check("both reasons surfaced", len(bad.flags), 2)

    lapsed = check_developer("Athi Ridge Properties Ltd", "EBK/PR/2026/00999", TODAY)
    check("lapsed licence is conditional, not fatal", lapsed.verdict, "proceed with conditions")
    check("unregistered project flagged", lapsed.project_registered, False)

    unknown = check_developer("Backstreet Homes Ltd", today=TODAY)
    check("absence from the register is flagged", len(unknown.flags), 1)


def test_corroboration():
    print("\nSite corroboration")
    ok = corroborate(SITE, "Willow Park Developments Ltd", LAT, LON,
                     project_ref="EBK/PR/2026/00812", today=TODAY)
    check("clean site clears", ok.verdict, "clear")
    check("positive signals recorded", len(ok.corroborating) >= 2, True)
    check("no adverse findings", ok.findings, [])

    bad = corroborate(SITE, "Kilimani Heights Ltd", LAT, LON, today=TODAY)
    check("insolvent developer stops it", bad.verdict, "do not proceed")

    drifted = corroborate(SITE, "Willow Park Developments Ltd",
                          -1.35000, 36.90000, project_ref="EBK/PR/2026/00812", today=TODAY)
    check("coordinates far from the named site are flagged",
          any("from where the site name resolves" in f for f in drifted.findings), True)


if __name__ == "__main__":
    test_cache()
    test_footprints()
    test_registers()
    test_developer_verdicts()
    test_corroboration()
    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    sys.exit(1 if FAIL else 0)
