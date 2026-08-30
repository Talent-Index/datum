"""
OpenStreetMap: geocoding and building footprints.

Both endpoints are genuinely open, no key, no registration. They are the only
free sources in this project that give you independent evidence about a
physical site.

What they are good for:
  - Turning a marketing address into coordinates for the geofence, so you are
    not trusting a developer's own claim about where the site is
  - Counting buildings already standing on a parcel, which contradicts a
    developer claiming greenfield, and gives a baseline to compare against

What they are not good for:
  - Certifying a milestone. OSM is volunteer-mapped and lags reality by months
    to years in Nairobi's periphery. Absence of a building in OSM proves
    nothing. Presence of one is a real finding.

Attribution: OSM data is ODbL. Credit OpenStreetMap contributors anywhere you
display it.
"""

from __future__ import annotations

import json
import math
import urllib.parse
from dataclasses import dataclass, field

from .http import fetch

NOMINATIM = "https://nominatim.openstreetmap.org/search"
OVERPASS = "https://overpass-api.de/api/interpreter"


@dataclass
class GeocodeResult:
    query: str
    latitude: float
    longitude: float
    display_name: str
    osm_type: str
    confidence: str  # exact | approximate | none


@dataclass
class FootprintSummary:
    latitude: float
    longitude: float
    radius_m: int
    building_count: int
    nearest_building_m: float | None
    buildings_under_construction: int
    landuse: list[str] = field(default_factory=list)
    note: str = ""


def geocode(query: str, country: str = "ke") -> GeocodeResult:
    """
    Address to coordinates. Bias to Kenya, since half of Nairobi's estate names
    collide with places elsewhere.
    """
    url = NOMINATIM + "?" + urllib.parse.urlencode({
        "q": query,
        "countrycodes": country,
        "format": "jsonv2",
        "limit": 1,
        "addressdetails": 1,
    })
    results = fetch(url).json()
    if not results:
        return GeocodeResult(query, 0.0, 0.0, "", "", "none")

    top = results[0]
    # Nominatim's importance score is a poor confidence proxy, but the OSM
    # object type is a good one: a building or a way is a real mapped feature,
    # a node from a fuzzy name match is not.
    kind = top.get("osm_type", "")
    confidence = "exact" if kind in ("way", "relation") else "approximate"
    return GeocodeResult(
        query=query,
        latitude=float(top["lat"]),
        longitude=float(top["lon"]),
        display_name=top.get("display_name", ""),
        osm_type=kind,
        confidence=confidence,
    )


def _haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6_371_000
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def footprints(lat: float, lon: float, radius_m: int = 200) -> FootprintSummary:
    """Buildings and land use within the geofence, from Overpass."""
    query = f"""
[out:json][timeout:40];
(
  way["building"](around:{radius_m},{lat},{lon});
  relation["building"](around:{radius_m},{lat},{lon});
  way["landuse"](around:{radius_m},{lat},{lon});
);
out center tags;
""".strip()

    data = fetch(OVERPASS, payload=urllib.parse.urlencode({"data": query}).encode()).json()
    elements = data.get("elements", [])

    buildings, landuse, under_construction = [], set(), 0
    for el in elements:
        tags = el.get("tags", {})
        if "landuse" in tags:
            landuse.add(tags["landuse"])
        b = tags.get("building")
        if not b:
            continue
        buildings.append(el)
        if b == "construction" or "construction" in tags:
            under_construction += 1

    distances = [
        _haversine((lat, lon), (c["lat"], c["lon"]))
        for el in buildings
        if (c := el.get("center"))
    ]

    return FootprintSummary(
        latitude=lat,
        longitude=lon,
        radius_m=radius_m,
        building_count=len(buildings),
        nearest_building_m=round(min(distances), 1) if distances else None,
        buildings_under_construction=under_construction,
        landuse=sorted(landuse),
        note="OpenStreetMap coverage in peri-urban Kenya lags reality. "
             "Treat presence as evidence and absence as unknown.",
    )
