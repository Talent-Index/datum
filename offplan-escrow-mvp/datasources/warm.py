"""
Warm the public-data cache.

    DATA_OFFLINE=0 DATA_CONTACT="you@example.com" \
      python3 -m datasources.warm --site "Willow Park, Kilimani, Nairobi" \
                                  --lat -1.29210 --lon 36.78270

Fetches from Nominatim and Overpass, writes to fixtures/cache, and from then
on the app and the tests run offline against exactly what you fetched. Commit
the cache so a demo never depends on someone else's uptime.

    python3 -m datasources.warm --seed     write placeholder fixtures so the
                                           offline demo runs before you have
                                           fetched anything real
    python3 -m datasources.warm --stats    what is cached
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.parse

from .http import CACHE_DIR, _cache_key, cache_stats
from .osm import NOMINATIM, OVERPASS


def warm(site: str, lat: float, lon: float, radius: int) -> None:
    from .osm import footprints, geocode

    print(f"geocoding  {site}")
    g = geocode(site)
    print(f"  {g.confidence:12} {g.latitude:.5f}, {g.longitude:.5f}  {g.display_name[:70]}")

    print(f"footprints within {radius}m of {lat}, {lon}")
    f = footprints(lat, lon, radius)
    print(f"  {f.building_count} buildings, {f.buildings_under_construction} under construction")
    if f.landuse:
        print(f"  land use: {', '.join(f.landuse)}")


def seed(site: str, lat: float, lon: float, radius: int) -> None:
    """
    Placeholder responses shaped exactly like the real APIs, so the offline
    demo runs end to end before anyone has network access. Overwritten the
    moment you warm the cache for real.
    """
    geo_url = NOMINATIM + "?" + urllib.parse.urlencode({
        "q": site, "countrycodes": "ke", "format": "jsonv2",
        "limit": 1, "addressdetails": 1,
    })
    geo_body = json.dumps([{
        "place_id": 297451102,
        "osm_type": "way",
        "osm_id": 1043318877,
        "lat": f"{lat + 0.0011:.7f}",
        "lon": f"{lon - 0.0008:.7f}",
        "display_name": f"{site}, Nairobi, Kenya",
        "category": "landuse",
        "type": "residential",
        "importance": 0.27,
        "address": {"suburb": "Kilimani", "city": "Nairobi", "country_code": "ke"},
    }]).encode()

    query = f"""
[out:json][timeout:40];
(
  way["building"](around:{radius},{lat},{lon});
  relation["building"](around:{radius},{lat},{lon});
  way["landuse"](around:{radius},{lat},{lon});
);
out center tags;
""".strip()
    over_body = json.dumps({
        "version": 0.6,
        "generator": "Overpass API",
        "elements": [
            {"type": "way", "id": 411229301,
             "center": {"lat": lat + 0.00042, "lon": lon + 0.00031},
             "tags": {"building": "apartments", "building:levels": "6"}},
            {"type": "way", "id": 411229774,
             "center": {"lat": lat - 0.00061, "lon": lon + 0.00090},
             "tags": {"building": "residential"}},
            {"type": "way", "id": 902114553,
             "center": {"lat": lat + 0.00105, "lon": lon - 0.00044},
             "tags": {"building": "construction", "construction": "apartments"}},
            {"type": "way", "id": 118844021,
             "tags": {"landuse": "residential", "name": "Kilimani"}},
        ],
    }).encode()

    for url, payload, body in [
        (geo_url, None, geo_body),
        (OVERPASS, urllib.parse.urlencode({"data": query}).encode(), over_body),
    ]:
        path = _cache_key(url, payload)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        print(f"seeded  {path.relative_to(CACHE_DIR.parent)}")


def main() -> None:
    p = argparse.ArgumentParser(description="Warm the public-data cache")
    p.add_argument("--site", default="Willow Park Block A, Kilimani")
    p.add_argument("--lat", type=float, default=-1.29210)
    p.add_argument("--lon", type=float, default=36.78270)
    p.add_argument("--radius", type=int, default=200)
    p.add_argument("--seed", action="store_true", help="write placeholder fixtures")
    p.add_argument("--stats", action="store_true", help="show cache contents")
    a = p.parse_args()

    if a.stats:
        s = cache_stats()
        print(f"{s['entries']} entries, {s['bytes']:,} bytes")
        print(f"offline={s['offline']}  {s['path']}")
        return
    if a.seed:
        seed(a.site, a.lat, a.lon, a.radius)
        return
    if os.getenv("DATA_OFFLINE", "1") == "1":
        p.error("Set DATA_OFFLINE=0 to fetch live, or pass --seed for placeholders")
    warm(a.site, a.lat, a.lon, a.radius)


if __name__ == "__main__":
    main()
