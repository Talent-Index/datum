import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { diskCachePath, formEncode } from "./http";
import { NOMINATIM, OVERPASS, footprints, geocode } from "./osm";

/**
 * Warm the public-data cache.
 *
 *     DATA_OFFLINE=0 DATA_CONTACT="you@example.com" \
 *       npm run warm -- --site "Willow Park, Kilimani, Nairobi" \
 *                       --lat -1.29210 --lon 36.78270
 *
 * Fetches from Nominatim and Overpass, writes to fixtures/cache (or the KV
 * store when configured), and from then on the app and the tests run
 * offline against exactly what you fetched. Commit the cache so a demo
 * never depends on someone else's uptime.
 *
 *     npm run warm -- --seed    write placeholder fixtures so the offline
 *                               demo runs before you have fetched anything
 */

interface Target {
  site: string;
  lat: number;
  lon: number;
  radius: number;
}

async function warm({ site, lat, lon, radius }: Target): Promise<void> {
  console.log(`geocoding  ${site}`);
  const g = await geocode(site);
  console.log(
    `  ${g.confidence.padEnd(12)} ${g.latitude.toFixed(5)}, ${g.longitude.toFixed(5)}  ${g.displayName.slice(0, 70)}`,
  );

  console.log(`footprints within ${radius}m of ${lat}, ${lon}`);
  const f = await footprints(lat, lon, radius);
  console.log(
    `  ${f.buildingCount} buildings, ${f.buildingsUnderConstruction} under construction`,
  );
  if (f.landuse.length) console.log(`  land use: ${f.landuse.join(", ")}`);
}

/**
 * Placeholder responses shaped exactly like the real APIs, so the offline
 * demo runs end to end before anyone has network access. Overwritten the
 * moment you warm the cache for real.
 */
function seed({ site, lat, lon, radius }: Target): void {
  const geoUrl =
    NOMINATIM +
    "?" +
    formEncode({
      q: site,
      countrycodes: "ke",
      format: "jsonv2",
      limit: 1,
      addressdetails: 1,
    });
  const geoBody = JSON.stringify([
    {
      place_id: 297451102,
      osm_type: "way",
      osm_id: 1043318877,
      lat: (lat + 0.0011).toFixed(7),
      lon: (lon - 0.0008).toFixed(7),
      display_name: `${site}, Nairobi, Kenya`,
      category: "landuse",
      type: "residential",
      importance: 0.27,
      address: { suburb: "Kilimani", city: "Nairobi", country_code: "ke" },
    },
  ]);

  const query = `[out:json][timeout:40];
(
  way["building"](around:${radius},${lat},${lon});
  relation["building"](around:${radius},${lat},${lon});
  way["landuse"](around:${radius},${lat},${lon});
);
out center tags;`;
  const overBody = JSON.stringify({
    version: 0.6,
    generator: "Overpass API",
    elements: [
      {
        type: "way",
        id: 411229301,
        center: { lat: lat + 0.00042, lon: lon + 0.00031 },
        tags: { building: "apartments", "building:levels": "6" },
      },
      {
        type: "way",
        id: 411229774,
        center: { lat: lat - 0.00061, lon: lon + 0.0009 },
        tags: { building: "residential" },
      },
      {
        type: "way",
        id: 902114553,
        center: { lat: lat + 0.00105, lon: lon - 0.00044 },
        tags: { building: "construction", construction: "apartments" },
      },
      {
        type: "way",
        id: 118844021,
        tags: { landuse: "residential", name: "Kilimani" },
      },
    ],
  });

  const targets: Array<[string, Buffer | null, string]> = [
    [geoUrl, null, geoBody],
    [OVERPASS, Buffer.from(formEncode({ data: query })), overBody],
  ];
  for (const [url, payload, body] of targets) {
    const path = diskCachePath(url, payload);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    console.log(`seeded  ${path}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      site: { type: "string", default: "Willow Park Block A, Kilimani" },
      lat: { type: "string", default: "-1.29210" },
      lon: { type: "string", default: "36.78270" },
      radius: { type: "string", default: "200" },
      seed: { type: "boolean", default: false },
    },
  });
  const target: Target = {
    site: values.site!,
    lat: Number.parseFloat(values.lat!),
    lon: Number.parseFloat(values.lon!),
    radius: Number.parseInt(values.radius!, 10),
  };

  if (values.seed) {
    seed(target);
    return;
  }
  if ((process.env.DATA_OFFLINE ?? "1") === "1") {
    console.error("Set DATA_OFFLINE=0 to fetch live, or pass --seed for placeholders");
    process.exitCode = 1;
    return;
  }
  await warm(target);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
