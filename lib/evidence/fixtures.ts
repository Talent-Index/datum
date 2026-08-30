import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "sharp";
import { dump, insert, load, TagValues, type IExif, type IExifElement } from "piexif-ts";

/**
 * Synthetic site photographs with real EXIF GPS and timestamps.
 *
 * Lets the evidence pipeline be exercised end to end before anyone has
 * driven to a site. Replace with real photographs as soon as you have them —
 * the fraud checks are only as good as the images you test them against.
 */

// Kilimani, Nairobi — stands in for a registered development site.
export const SITE_LAT = -1.2921;
export const SITE_LON = 36.7827;

const WIDTH = 640;
const HEIGHT = 480;

const STAGE_PALETTE: Record<string, [[number, number, number], [number, number, number]]> = {
  site_clearing: [[122, 108, 88], [150, 138, 116]],
  foundation: [[104, 100, 96], [138, 132, 124]],
  ground_slab: [[128, 126, 122], [162, 160, 154]],
  superstructure: [[146, 142, 134], [178, 174, 166]],
  roofing: [[92, 78, 70], [132, 112, 100]],
  finishing: [[186, 180, 170], [214, 208, 198]],
};

// Deterministic per-seed PRNG (mulberry32) so fixture images are stable
// within a run and distinct across seeds.
function rng(seed: number): () => number {
  let a = seed + 0x6d2b79f5;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(random: () => number, lo: number, hi: number): number {
  return lo + Math.floor(random() * (hi - lo + 1));
}

function exifTimestamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}:${pad(at.getMonth() + 1)}:${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

function degToDmsRational(value: number): number[][] {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minutesFull = (abs - deg) * 60;
  const minutes = Math.floor(minutesFull);
  const seconds = Math.round((minutesFull - minutes) * 60 * 10000);
  return [[deg, 1], [minutes, 1], [seconds, 10000]];
}

function buildExif(capturedAt: Date, lat: number, lon: number): string {
  const stamp = exifTimestamp(capturedAt);
  const zeroth: IExifElement = {
    [TagValues.ImageIFD.Make]: "Demo",
    [TagValues.ImageIFD.Model]: "SiteCapture",
    [TagValues.ImageIFD.DateTime]: stamp,
  };
  const exif: IExifElement = {
    [TagValues.ExifIFD.DateTimeOriginal]: stamp,
  };
  const gps: IExifElement = {
    [TagValues.GPSIFD.GPSLatitudeRef]: lat < 0 ? "S" : "N",
    [TagValues.GPSIFD.GPSLatitude]: degToDmsRational(lat),
    [TagValues.GPSIFD.GPSLongitudeRef]: lon < 0 ? "W" : "E",
    [TagValues.GPSIFD.GPSLongitude]: degToDmsRational(lon),
  };
  const exifObj: IExif = { "0th": zeroth, Exif: exif, GPS: gps };
  return dump(exifObj);
}

function insertExif(jpeg: Buffer, exifStr: string): Buffer {
  const withExif = insert(exifStr, jpeg.toString("binary"));
  return Buffer.from(withExif, "binary");
}

async function writeSidecar(path: string, content: string): Promise<void> {
  await writeFile(path + ".stage", content);
}

async function copySidecar(src: string, dst: string): Promise<void> {
  try {
    const content = await readFile(src + ".stage", "utf8");
    await writeSidecar(dst, content);
  } catch {
    // No sidecar on the source; nothing to copy.
  }
}

/** Write a JPEG with GPS + timestamp EXIF and a sidecar stage label. */
export async function makePhoto(
  path: string,
  stage: string,
  capturedAt: Date,
  lat: number = SITE_LAT,
  lon: number = SITE_LON,
  seed = 0,
): Promise<string> {
  const random = rng(seed);
  const [base, accent] = STAGE_PALETTE[stage] ?? [[120, 120, 120], [160, 160, 160]];

  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    pixels[i * 3] = base[0]!;
    pixels[i * 3 + 1] = base[1]!;
    pixels[i * 3 + 2] = base[2]!;
  }

  // Enough structure that two photos of the same stage are not identical,
  // so perceptual hashing has something real to distinguish.
  for (let r = 0; r < 24; r++) {
    const x0 = randInt(random, 0, 600);
    const y0 = randInt(random, 120, 440);
    const w = randInt(random, 20, 90);
    const h = randInt(random, 20, 70);
    const color = accent.map((c) => Math.min(255, Math.max(0, c + randInt(random, -24, 24))));
    for (let y = y0; y < Math.min(y0 + h, HEIGHT); y++) {
      for (let x = x0; x < Math.min(x0 + w, WIDTH); x++) {
        const i = (y * WIDTH + x) * 3;
        pixels[i] = color[0]!;
        pixels[i + 1] = color[1]!;
        pixels[i + 2] = color[2]!;
      }
    }
  }
  // Sky band across the top.
  for (let y = 0; y < 110; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 3;
      pixels[i] = 150;
      pixels[i + 1] = 168;
      pixels[i + 2] = 190;
    }
  }

  const jpeg = await sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, insertExif(jpeg, buildExif(capturedAt, lat, lon)));
  await writeSidecar(path, `${stage} 0.93`);
  return path;
}

/** A photo with the location metadata removed. */
export async function stripGps(src: string, dst: string): Promise<string> {
  // Re-encoding without withMetadata() drops all EXIF, as the reference
  // implementation's plain re-save did.
  const jpeg = await sharp(await readFile(src)).jpeg({ quality: 90 }).toBuffer();
  await mkdir(dirname(dst), { recursive: true });
  await writeFile(dst, jpeg);
  await copySidecar(src, dst);
  return dst;
}

/** Same pixels, different claimed capture time — the classic resubmission. */
export async function relabelTimestamp(
  src: string,
  dst: string,
  capturedAt: Date,
): Promise<string> {
  const source = await readFile(src);
  const exifObj = load(source.toString("binary"));
  const stamp = exifTimestamp(capturedAt);
  exifObj["0th"] = { ...exifObj["0th"], [TagValues.ImageIFD.DateTime]: stamp };
  exifObj.Exif = { ...exifObj.Exif, [TagValues.ExifIFD.DateTimeOriginal]: stamp };

  const jpeg = await sharp(source).jpeg({ quality: 90 }).toBuffer();
  await mkdir(dirname(dst), { recursive: true });
  await writeFile(dst, insertExif(jpeg, dump(exifObj)));
  await copySidecar(src, dst);
  return dst;
}

export interface DemoSet {
  honest: string[];
  wrong_site: string[];
  no_gps: string[];
  recycled: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A clean submission plus one of each fraud pattern. */
export async function buildDemoSet(root: string, now: Date = new Date()): Promise<DemoSet> {
  await mkdir(root, { recursive: true });

  const honest = await Promise.all(
    [0, 1, 2].map((i) =>
      makePhoto(`${root}/foundation_${i}.jpg`, "foundation", new Date(now.getTime() - 2 * DAY_MS), SITE_LAT, SITE_LON, i),
    ),
  );
  const wrongSite = await Promise.all(
    [0, 1, 2].map((i) =>
      makePhoto(
        `${root}/elsewhere_${i}.jpg`,
        "foundation",
        new Date(now.getTime() - DAY_MS),
        -1.305, // ~1.5km away
        36.795,
        50 + i,
      ),
    ),
  );
  const noGps = await Promise.all(
    [0, 1, 2].map((i) => stripGps(honest[i]!, `${root}/nogps_${i}.jpg`)),
  );
  const recycled = await Promise.all(
    [0, 1, 2].map((i) =>
      relabelTimestamp(honest[i]!, `${root}/recycled_${i}.jpg`, new Date(now.getTime() - 6 * 3600 * 1000)),
    ),
  );
  return { honest, wrong_site: wrongSite, no_gps: noGps, recycled };
}
