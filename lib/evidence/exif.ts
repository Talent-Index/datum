import exifr from "exifr";

export interface ExifSummary {
  gps: [number, number] | null;
  capturedAt: Date | null;
  make: string | null;
  model: string | null;
}

/**
 * Pull GPS and capture time. Missing EXIF is a finding, not an error, so
 * every parse failure collapses to nulls and the checks report it.
 *
 * exifr returns GPS as signed decimal degrees, which is why the reference
 * implementation's DMS conversion helper has no equivalent here.
 */
export async function readExif(image: Buffer): Promise<ExifSummary> {
  const out: ExifSummary = { gps: null, capturedAt: null, make: null, model: null };

  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = await exifr.parse(image, {
      pick: [
        "Make",
        "Model",
        "DateTimeOriginal",
        "DateTime",
        "ModifyDate",
        "GPSLatitude",
        "GPSLongitude",
        "GPSLatitudeRef",
        "GPSLongitudeRef",
      ],
    });
  } catch {
    return out;
  }
  if (!parsed) return out;

  if (typeof parsed.Make === "string") out.make = parsed.Make;
  if (typeof parsed.Model === "string") out.model = parsed.Model;

  // EXIF DateTime tag is exposed as ModifyDate by exifr.
  const stamp = parsed.DateTimeOriginal ?? parsed.DateTime ?? parsed.ModifyDate;
  if (stamp instanceof Date && !Number.isNaN(stamp.getTime())) {
    out.capturedAt = stamp;
  }

  const coords = await exifr.gps(image).catch(() => undefined);
  if (
    coords &&
    typeof coords.latitude === "number" &&
    typeof coords.longitude === "number" &&
    Number.isFinite(coords.latitude) &&
    Number.isFinite(coords.longitude)
  ) {
    out.gps = [coords.latitude, coords.longitude];
  }

  return out;
}

export function haversineMetres(a: [number, number], b: [number, number]): number {
  const r = 6_371_000;
  const [lat1, lon1] = [a[0] * (Math.PI / 180), a[1] * (Math.PI / 180)];
  const [lat2, lon2] = [b[0] * (Math.PI / 180), b[1] * (Math.PI / 180)];
  const dlat = lat2 - lat1;
  const dlon = lon2 - lon1;
  const h =
    Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}
