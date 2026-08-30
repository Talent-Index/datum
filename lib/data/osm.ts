import { fetchCached, formEncode } from "./http";

/**
 * OpenStreetMap: geocoding and building footprints.
 *
 * Both endpoints are genuinely open, no key, no registration. They are the
 * only free sources in this project that give you independent evidence
 * about a physical site.
 *
 * What they are good for:
 *   - Turning a marketing address into coordinates for the geofence, so you
 *     are not trusting a developer's own claim about where the site is
 *   - Counting buildings already standing on a parcel, which contradicts a
 *     developer claiming greenfield, and gives a baseline to compare against
 *
 * What they are not good for:
 *   - Certifying a milestone. OSM is volunteer-mapped and lags reality by
 *     months to years in Nairobi's periphery. Absence of a building in OSM
 *     proves nothing. Presence of one is a real finding.
 *
 * Attribution: OSM data is ODbL. Credit OpenStreetMap contributors anywhere
 * you display it.
 */

export const NOMINATIM = "https://nominatim.openstreetmap.org/search";
export const OVERPASS = "https://overpass-api.de/api/interpreter";

export interface GeocodeResult {
  query: string;
  latitude: number;
  longitude: number;
  displayName: string;
  osmType: string;
  confidence: "exact" | "approximate" | "none";
}

export interface FootprintSummary {
  latitude: number;
  longitude: number;
  radiusM: number;
  buildingCount: number;
  nearestBuildingM: number | null;
  buildingsUnderConstruction: number;
  landuse: string[];
  note: string;
}

interface NominatimEntry {
  lat: string;
  lon: string;
  display_name?: string;
  osm_type?: string;
}

interface OverpassElement {
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
}

/**
 * Address to coordinates. Bias to Kenya, since half of Nairobi's estate
 * names collide with places elsewhere.
 */
export async function geocode(query: string, country = "ke"): Promise<GeocodeResult> {
  const url =
    NOMINATIM +
    "?" +
    formEncode({
      q: query,
      countrycodes: country,
      format: "jsonv2",
      limit: 1,
      addressdetails: 1,
    });
  const results = (await fetchCached(url)).json() as NominatimEntry[];
  if (!results.length) {
    return { query, latitude: 0, longitude: 0, displayName: "", osmType: "", confidence: "none" };
  }

  const top = results[0]!;
  // Nominatim's importance score is a poor confidence proxy, but the OSM
  // object type is a good one: a building or a way is a real mapped
  // feature, a node from a fuzzy name match is not.
  const kind = top.osm_type ?? "";
  return {
    query,
    latitude: Number.parseFloat(top.lat),
    longitude: Number.parseFloat(top.lon),
    displayName: top.display_name ?? "",
    osmType: kind,
    confidence: kind === "way" || kind === "relation" ? "exact" : "approximate",
  };
}

export function haversine(a: [number, number], b: [number, number]): number {
  const r = 6_371_000;
  const [lat1, lon1] = [(a[0] * Math.PI) / 180, (a[1] * Math.PI) / 180];
  const [lat2, lon2] = [(b[0] * Math.PI) / 180, (b[1] * Math.PI) / 180];
  const dlat = lat2 - lat1;
  const dlon = lon2 - lon1;
  const h =
    Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/** Buildings and land use within the geofence, from Overpass. */
export async function footprints(
  lat: number,
  lon: number,
  radiusM = 200,
): Promise<FootprintSummary> {
  const query = `[out:json][timeout:40];
(
  way["building"](around:${radiusM},${lat},${lon});
  relation["building"](around:${radiusM},${lat},${lon});
  way["landuse"](around:${radiusM},${lat},${lon});
);
out center tags;`;

  const payload = Buffer.from(formEncode({ data: query }));
  const data = (await fetchCached(OVERPASS, payload)).json() as {
    elements?: OverpassElement[];
  };
  const elements = data.elements ?? [];

  const buildings: OverpassElement[] = [];
  const landuse = new Set<string>();
  let underConstruction = 0;
  for (const el of elements) {
    const tags = el.tags ?? {};
    if (tags.landuse) landuse.add(tags.landuse);
    const building = tags.building;
    if (!building) continue;
    buildings.push(el);
    if (building === "construction" || "construction" in tags) underConstruction++;
  }

  const distances = buildings
    .filter((el) => el.center)
    .map((el) => haversine([lat, lon], [el.center!.lat, el.center!.lon]));

  return {
    latitude: lat,
    longitude: lon,
    radiusM,
    buildingCount: buildings.length,
    nearestBuildingM: distances.length
      ? Math.round(Math.min(...distances) * 10) / 10
      : null,
    buildingsUnderConstruction: underConstruction,
    landuse: [...landuse].sort(),
    note:
      "OpenStreetMap coverage in peri-urban Kenya lags reality. " +
      "Treat presence as evidence and absence as unknown.",
  };
}
