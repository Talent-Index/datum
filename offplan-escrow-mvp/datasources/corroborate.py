"""
Site corroboration.

Photographs prove what the camera saw. They do not prove the site is where the
developer says it is, that the company behind it is still trading, or that the
project was ever registered. Those come from public records, and checking them
costs nothing but a few HTTP calls.

The output sits alongside the photo verdict in the evidence bundle. A milestone
backed by clean photographs and a developer with a winding-up notice against
them is not a milestone anyone should release money on.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict, field
from datetime import date

from .http import OfflineMiss
from .osm import FootprintSummary, GeocodeResult, footprints, geocode
from .registers import DeveloperCheck, check_developer


@dataclass
class Corroboration:
    site_name: str
    developer: str
    coordinates: tuple[float, float]
    location: dict | None = None
    footprint: dict | None = None
    developer_check: dict | None = None
    corroborating: list[str] = field(default_factory=list)
    findings: list[str] = field(default_factory=list)
    unavailable: list[str] = field(default_factory=list)
    verdict: str = "unknown"


def corroborate(
    site_name: str,
    developer: str,
    latitude: float,
    longitude: float,
    project_ref: str | None = None,
    radius_m: int = 200,
    tolerance_m: int = 500,
    today: date | None = None,
) -> Corroboration:
    out = Corroboration(
        site_name=site_name,
        developer=developer,
        coordinates=(latitude, longitude),
    )

    # 1. Does the site name resolve anywhere near the claimed coordinates?
    try:
        g: GeocodeResult = geocode(site_name)
        out.location = asdict(g)
        if g.confidence == "none":
            out.findings.append("Site name does not resolve to any mapped place in Kenya")
        else:
            from .osm import _haversine
            drift = _haversine((latitude, longitude), (g.latitude, g.longitude))
            out.location["drift_m"] = round(drift, 1)
            if drift > tolerance_m:
                out.findings.append(
                    f"Claimed coordinates sit {drift:,.0f}m from where the site name resolves"
                )
            else:
                out.corroborating.append(
                    f"Site name resolves within {drift:,.0f}m of the claimed coordinates"
                )
    except OfflineMiss:
        out.unavailable.append("geocoding")

    # 2. What is actually standing there according to volunteer mapping?
    try:
        f: FootprintSummary = footprints(latitude, longitude, radius_m)
        out.footprint = asdict(f)
        if f.buildings_under_construction:
            out.corroborating.append(
                f"{f.buildings_under_construction} building(s) mapped as under construction "
                f"within {radius_m}m"
            )
        elif f.building_count == 0:
            out.corroborating.append(
                f"No mapped buildings within {radius_m}m, consistent with a greenfield site "
                "(OpenStreetMap coverage here is incomplete, so this is not proof)"
            )
    except OfflineMiss:
        out.unavailable.append("footprints")

    # 3. Is the company behind it in good standing?
    check: DeveloperCheck = check_developer(developer, project_ref=project_ref, today=today)
    out.developer_check = asdict(check)
    out.findings.extend(check.flags)

    if check.verdict == "do not proceed":
        out.verdict = "do not proceed"
    elif out.findings:
        out.verdict = "proceed with conditions"
    elif out.unavailable:
        out.verdict = "partially checked"
    else:
        out.verdict = "clear"

    return out
