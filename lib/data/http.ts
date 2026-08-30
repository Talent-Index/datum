import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Cached HTTP for public data sources.
 *
 * Every fetch goes through here so three things are guaranteed:
 *
 *   - Responses are cached. Public endpoints are free but rate limited, and
 *     a demo that hammers Overpass will get the project blocked. On Vercel
 *     the filesystem is ephemeral, so the cache lives in Upstash Redis or
 *     Vercel KV when KV_REST_API_URL is set; without it, the disk cache
 *     under fixtures/cache keeps local development and tests working
 *     against committed fixtures.
 *   - Offline mode replays the cache and never touches the network. Tests
 *     run this way, so CI stays green on a plane.
 *   - Every request carries a contact User-Agent. Nominatim's usage policy
 *     requires it and will reject you without one. Set DATA_CONTACT before
 *     running live.
 *
 * Cache keys are SHA-256 of URL plus request body, identical to the
 * reference implementation, so its committed fixtures stay valid.
 */

const cacheDir = () =>
  process.env.DATA_CACHE ?? resolve(process.cwd(), "fixtures", "cache");
const contact = () =>
  process.env.DATA_CONTACT ?? "escrow-mvp (set DATA_CONTACT to your email)";
const offline = () => (process.env.DATA_OFFLINE ?? "1") === "1";

// Per-host minimum seconds between requests. Nominatim's policy is one call
// per second absolute; the others are courtesy limits.
const RATE_LIMITS: Record<string, number> = {
  "nominatim.openstreetmap.org": 1.1,
  "overpass-api.de": 2.0,
  "storage.googleapis.com": 0.2,
};
const lastCall = new Map<string, number>();

export class OfflineMiss extends Error {}

export class Response {
  constructor(
    readonly url: string,
    readonly body: Buffer,
    readonly fromCache: boolean,
  ) {}

  json(): unknown {
    return JSON.parse(this.body.toString("utf8"));
  }

  text(): string {
    return this.body.toString("utf8");
  }
}

/**
 * Byte-for-byte reimplementation of Python's urllib.parse.quote_plus so the
 * cache keys match the reference implementation's committed fixtures.
 * Unreserved set: ASCII letters, digits, and _.-~; space becomes +.
 */
function quotePlus(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let out = "";
  for (const byte of bytes) {
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x5f || // _
      byte === 0x2e || // .
      byte === 0x2d || // -
      byte === 0x7e // ~
    ) {
      out += String.fromCharCode(byte);
    } else if (byte === 0x20) {
      out += "+";
    } else {
      out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

export function formEncode(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([key, value]) => `${quotePlus(key)}=${quotePlus(String(value))}`)
    .join("&");
}

interface CacheKey {
  host: string;
  name: string;
}

function cacheKey(url: string, payload: Buffer | null): CacheKey {
  const hash = createHash("sha256")
    .update(url)
    .update(payload ?? Buffer.alloc(0))
    .digest("hex")
    .slice(0, 24);
  const host = new URL(url).host.replace(/:/g, "_") || "local";
  return { host, name: `${hash}.bin` };
}

function kvConfig(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function kvGet(key: CacheKey): Promise<Buffer | null> {
  const kv = kvConfig();
  if (!kv) return null;
  const response = await fetch(`${kv.url}/get/${key.host}:${key.name}`, {
    headers: { Authorization: `Bearer ${kv.token}` },
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { result: string | null };
  return data.result === null ? null : Buffer.from(data.result, "base64");
}

async function kvSet(key: CacheKey, body: Buffer): Promise<void> {
  const kv = kvConfig();
  if (!kv) return;
  await fetch(`${kv.url}/set/${key.host}:${key.name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${kv.token}` },
    body: body.toString("base64"),
  });
}

function diskGet(key: CacheKey): Buffer | null {
  try {
    return readFileSync(join(cacheDir(), key.host, key.name));
  } catch {
    return null;
  }
}

function diskSet(key: CacheKey, body: Buffer): void {
  const dir = join(cacheDir(), key.host);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, key.name), body);
}

async function throttle(url: string): Promise<void> {
  const host = new URL(url).host;
  const gap = RATE_LIMITS[host];
  if (!gap) return;
  const elapsed = (Date.now() - (lastCall.get(host) ?? 0)) / 1000;
  if (elapsed < gap) {
    await new Promise((r) => setTimeout(r, (gap - elapsed) * 1000));
  }
  lastCall.set(host, Date.now());
}

/** GET, or POST when payload is given. Cached by URL plus body. */
export async function fetchCached(
  url: string,
  payload: Buffer | null = null,
  timeoutMs = 45_000,
): Promise<Response> {
  const key = cacheKey(url, payload);

  const kvHit = await kvGet(key);
  if (kvHit) return new Response(url, kvHit, true);
  const diskHit = kvConfig() ? null : diskGet(key);
  if (diskHit) return new Response(url, diskHit, true);

  if (offline()) {
    throw new OfflineMiss(
      `No cached response for ${url}\n` +
        `Run with DATA_OFFLINE=0 to fetch it, then commit ${key.name} ` +
        `so this stays reproducible.`,
    );
  }

  await throttle(url);
  const response = await fetch(url, {
    method: payload ? "POST" : "GET",
    headers: {
      "User-Agent": contact(),
      Accept: "application/json, text/plain, */*",
      ...(payload ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: payload ? new Uint8Array(payload) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  const body = Buffer.from(await response.arrayBuffer());

  if (kvConfig()) await kvSet(key, body);
  else diskSet(key, body);
  return new Response(url, body, false);
}

/** Where a response for this request would be cached on disk; used by warm. */
export function diskCachePath(url: string, payload: Buffer | null = null): string {
  const key = cacheKey(url, payload);
  return join(cacheDir(), key.host, key.name);
}
