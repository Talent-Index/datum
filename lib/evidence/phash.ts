import sharp from "sharp";

/**
 * DCT perceptual hash, deliberately owned rather than pulled off a shelf.
 * This check is what catches a photograph recycled from an earlier milestone
 * or another site, so its behaviour needs to be inspectable and fixed.
 *
 * Method, matching the reference implementation's imagehash.phash:
 * resize to 32x32 greyscale, 2D DCT-II, keep the top-left 8x8 block of
 * coefficients, threshold each against the median of the block, pack the 64
 * booleans row-major into a 64-bit value, most significant bit first.
 */

const SIZE = 32;
const BLOCK = 8;

export const PHASH_DISTANCE_THRESHOLD = 6;

function dct1d(input: Float64Array): Float64Array {
  // Unnormalised DCT-II, the scipy.fftpack default the reference relies on.
  // Only the low-frequency block survives, so an O(n^2) transform over 32
  // samples is cheap enough not to warrant an FFT.
  const n = input.length;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += input[i]! * Math.cos((Math.PI * k * (2 * i + 1)) / (2 * n));
    }
    out[k] = 2 * sum;
  }
  return out;
}

export async function phash(image: Buffer): Promise<bigint> {
  const { data } = await sharp(image)
    .greyscale()
    .resize(SIZE, SIZE, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // DCT along rows, then along columns.
  const rows: Float64Array[] = [];
  for (let y = 0; y < SIZE; y++) {
    const row = new Float64Array(SIZE);
    for (let x = 0; x < SIZE; x++) row[x] = data[y * SIZE + x]!;
    rows.push(dct1d(row));
  }
  const block: number[] = [];
  for (let x = 0; x < BLOCK; x++) {
    const col = new Float64Array(SIZE);
    for (let y = 0; y < SIZE; y++) col[y] = rows[y]![x]!;
    const t = dct1d(col);
    for (let y = 0; y < BLOCK; y++) block[y * BLOCK + x] = t[y]!;
  }

  const sorted = [...block].sort((a, b) => a - b);
  const median = (sorted[31]! + sorted[32]!) / 2;

  let hash = 0n;
  for (let i = 0; i < BLOCK * BLOCK; i++) {
    hash = (hash << 1n) | (block[i]! > median ? 1n : 0n);
  }
  return hash;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export function phashToHex(hash: bigint): string {
  return hash.toString(16).padStart(16, "0");
}

/** Postgres BIGINT is signed; map the unsigned hash into its range losslessly. */
export function phashToSigned(hash: bigint): bigint {
  return BigInt.asIntN(64, hash);
}

export function signedToPhash(value: bigint): bigint {
  return BigInt.asUintN(64, value);
}
