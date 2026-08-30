import { OfflineMiss } from "./http";
import {
  type FootprintSummary,
  type GeocodeResult,
  footprints,
  geocode,
  haversine,
} from "./osm";
import { type DeveloperCheck, checkDeveloper } from "./registers";

/**
 * Site corroboration.
 *
 * Photographs prove what the camera saw. They do not prove the site is
 * where the developer says it is, that the company behind it is still
 * trading, or that the project was ever registered. Those come from public
 * records, and checking them costs nothing but a few HTTP calls.
 *
 * The output sits alongside the photo verdict in the evidence bundle. A
 * milestone backed by clean photographs and a developer with a winding-up
 * notice against them is not a milestone anyone should release money on.
 */

export interface Corroboration {
  siteName: string;
  developer: string;
  coordinates: [number, number];
  location: (GeocodeResult & { driftM?: number }) | null;
  footprint: FootprintSummary | null;
  developerCheck: DeveloperCheck | null;
  corroborating: string[];
  findings: string[];
  unavailable: string[];
  verdict: string;
}

function formatMetres(distance: number): string {
  return Math.round(distance).toLocaleString("en-US");
}

export async function corroborate(
  siteName: string,
  developer: string,
  latitude: number,
  longitude: number,
  projectRef: string | null = null,
  radiusM = 200,
  toleranceM = 500,
  today?: string,
): Promise<Corroboration> {
  const out: Corroboration = {
    siteName,
    developer,
    coordinates: [latitude, longitude],
    location: null,
    footprint: null,
    developerCheck: null,
    corroborating: [],
    findings: [],
    unavailable: [],
    verdict: "unknown",
  };

  // 1. Does the site name resolve anywhere near the claimed coordinates?
  try {
    const g = await geocode(siteName);
    out.location = { ...g };
    if (g.confidence === "none") {
      out.findings.push("Site name does not resolve to any mapped place in Kenya");
    } else {
      const drift = haversine([latitude, longitude], [g.latitude, g.longitude]);
      out.location.driftM = Math.round(drift * 10) / 10;
      if (drift > toleranceM) {
        out.findings.push(
          `Claimed coordinates sit ${formatMetres(drift)}m from where the site name resolves`,
        );
      } else {
        out.corroborating.push(
          `Site name resolves within ${formatMetres(drift)}m of the claimed coordinates`,
        );
      }
    }
  } catch (error) {
    if (!(error instanceof OfflineMiss)) throw error;
    out.unavailable.push("geocoding");
  }

  // 2. What is actually standing there according to volunteer mapping?
  try {
    const f = await footprints(latitude, longitude, radiusM);
    out.footprint = f;
    if (f.buildingsUnderConstruction) {
      out.corroborating.push(
        `${f.buildingsUnderConstruction} building(s) mapped as under construction ` +
          `within ${radiusM}m`,
      );
    } else if (f.buildingCount === 0) {
      out.corroborating.push(
        `No mapped buildings within ${radiusM}m, consistent with a greenfield site ` +
          "(OpenStreetMap coverage here is incomplete, so this is not proof)",
      );
    }
  } catch (error) {
    if (!(error instanceof OfflineMiss)) throw error;
    out.unavailable.push("footprints");
  }

  // 3. Is the company behind it in good standing?
  const check = checkDeveloper(developer, projectRef, today);
  out.developerCheck = check;
  out.findings.push(...check.flags);

  if (check.verdict === "do not proceed") {
    out.verdict = "do not proceed";
  } else if (out.findings.length) {
    out.verdict = "proceed with conditions";
  } else if (out.unavailable.length) {
    out.verdict = "partially checked";
  } else {
    out.verdict = "clear";
  }

  return out;
}
