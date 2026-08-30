"""
Evidence pipeline tests.

Run:  python3 tests/test_evidence.py

Each case is a fraud pattern a developer under cashflow pressure actually
tries. If the pipeline cannot catch these, the escrow releases on bad evidence
and the whole product is theatre.
"""

import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from evidence.fixtures import SITE_LAT, SITE_LON, build_demo_set, make_photo
from evidence.verifier import EvidenceVerifier, Site

PASS, FAIL = [], []


def check(label, actual, expected):
    if actual == expected:
        PASS.append(label)
        print(f"  PASS  {label}")
    else:
        FAIL.append(label)
        print(f"  FAIL  {label}: got {actual}, expected {expected}")


def main():
    now = datetime(2026, 8, 30, 11, 0, 0)
    site = Site(
        project_id="willow-park-a",
        name="Willow Park Block A, Kilimani",
        latitude=SITE_LAT,
        longitude=SITE_LON,
    )

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        sets = build_demo_set(root, now=now)
        v = EvidenceVerifier()

        print("\nHonest submission")
        good = v.verify(site, 0, "foundation", sets["honest"], now=now)
        check("accepted", good.accepted, True)
        check("all three images clean", sum(i.passed for i in good.images), 3)
        check("evidence hash produced", good.evidence_hash.startswith("0x"), True)

        print("\nSame photographs resubmitted for the next milestone")
        recycled = v.verify(site, 1, "foundation", sets["recycled"], now=now)
        check("rejected", recycled.accepted, False)
        check("novelty check failed", all(not i.checks["novelty"] for i in recycled.images), True)
        check(
            "reason names the earlier milestone",
            "already submitted" in recycled.summary,
            True,
        )

        print("\nPhotographs from a different site")
        elsewhere = v.verify(site, 1, "foundation", sets["wrong_site"], now=now)
        check("rejected", elsewhere.accepted, False)
        check("location check failed", all(not i.checks["location"] for i in elsewhere.images), True)

        print("\nLocation metadata stripped")
        stripped = v.verify(site, 1, "foundation", sets["no_gps"], now=now)
        check("rejected", stripped.accepted, False)
        check("missing GPS reported", "No GPS data" in " ".join(stripped.images[0].notes), True)

        print("\nWrong construction stage for the milestone claimed")
        wrong_stage = [
            make_photo(root / f"slab_{i}.jpg", "ground_slab", now - timedelta(days=1), seed=200 + i)
            for i in range(3)
        ]
        mismatch = v.verify(site, 1, "roofing", wrong_stage, now=now)
        check("rejected", mismatch.accepted, False)
        check("stage check failed", all(not i.checks["stage"] for i in mismatch.images), True)

        print("\nStale photographs presented as current")
        stale = [
            make_photo(root / f"old_{i}.jpg", "ground_slab", now - timedelta(days=120), seed=300 + i)
            for i in range(3)
        ]
        old = v.verify(site, 1, "ground_slab", stale, now=now)
        check("rejected", old.accepted, False)
        check("recency check failed", all(not i.checks["recency"] for i in old.images), True)

        print("\nGenuine progress to the next stage")
        progressed = [
            make_photo(root / f"prog_{i}.jpg", "ground_slab", now - timedelta(days=1), seed=400 + i)
            for i in range(3)
        ]
        nxt = v.verify(site, 1, "ground_slab", progressed, now=now)
        check("accepted", nxt.accepted, True)
        check("hash differs from milestone 0", nxt.evidence_hash != good.evidence_hash, True)

        print("\nToo few clean images")
        thin = v.verify(site, 2, "ground_slab", progressed[:1], now=now)
        check("rejected below the minimum", thin.accepted, False)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
