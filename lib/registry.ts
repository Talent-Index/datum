import { asc, eq, isNull } from "drizzle-orm";
import { keccak256, stringToHex, toBytes, type Address, type Hex } from "viem";

import { WRITE_GAS, platformWallet, publicClient, revertReason } from "./chain";
import { db, schema } from "./db";

/**
 * The registry: who is on the platform, whether their identity was checked,
 * what they listed, and a hash of everything they did. Writes go from the
 * platform wallet, which owns the contract.
 *
 * An activity write that fails is recorded with the error and no
 * transaction, so the replay job can finish it. The user-facing action is
 * never blocked on chain availability; the record is what has to catch up.
 */

export const registryAbi = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "who", type: "address" }, { name: "role", type: "uint8" }], outputs: [] },
  { type: "function", name: "setKyc", stateMutability: "nonpayable", inputs: [{ name: "who", type: "address" }, { name: "verified", type: "bool" }, { name: "docHash", type: "bytes32" }, { name: "reviewer", type: "address" }], outputs: [] },
  { type: "function", name: "postListing", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "listingOwner", type: "address" }, { name: "contentHash", type: "bytes32" }], outputs: [] },
  { type: "function", name: "setListingLive", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "live", type: "bool" }], outputs: [] },
  { type: "function", name: "log", stateMutability: "nonpayable", inputs: [{ name: "actor", type: "address" }, { name: "kind", type: "bytes32" }, { name: "payloadHash", type: "bytes32" }], outputs: [{ name: "seq", type: "uint256" }] },
  { type: "function", name: "accounts", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "role", type: "uint8" }, { name: "kycVerified", type: "bool" }, { name: "kycHash", type: "bytes32" }, { name: "registeredAt", type: "uint64" }] },
  { type: "function", name: "listings", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "owner", type: "address" }, { name: "contentHash", type: "bytes32" }, { name: "live", type: "bool" }, { name: "postedAt", type: "uint64" }] },
  { type: "function", name: "activityCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

export type Role = "buyer" | "seller" | "developer" | "company" | "trustee";
export const ROLES: readonly Role[] = ["buyer", "seller", "developer", "company", "trustee"];
/** Roles a person may choose for themselves. Trustees are appointed. */
export const SELF_SERVICE_ROLES: readonly Role[] = ["buyer", "seller", "developer", "company"];
/** Roles that may advertise, once their identity is verified. */
export const LISTING_ROLES: readonly Role[] = ["seller", "developer", "company"];

const ROLE_CODE: Record<Role, number> = { buyer: 1, seller: 2, developer: 3, company: 4, trustee: 5 };

export function registryAddress(): Address {
  const value = process.env.REGISTRY_ADDRESS;
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error("REGISTRY_ADDRESS is not set; deploy contracts/script/DeployRegistry.s.sol and set it");
  }
  return value as Address;
}

export function listingKey(id: string): Hex {
  return keccak256(toBytes(id));
}

/** Keys sorted at every level, no whitespace: the same bytes every time. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return (
    "{" +
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v))
      .join(",") +
    "}"
  );
}

export function payloadHash(payload: unknown): Hex {
  return keccak256(stringToHex(canonicalJson(payload)));
}

async function write(functionName: "register" | "setKyc" | "postListing" | "setListingLive" | "log", args: readonly unknown[]): Promise<Hex> {
  const { client, account } = platformWallet();
  const hash = await client.writeContract({
    address: registryAddress(),
    abi: registryAbi,
    functionName,
    args: args as never,
    account,
    chain: client.chain,
    gas: WRITE_GAS,
  });
  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
  return hash;
}

export const registerOnChain = (who: Address, role: Role): Promise<Hex> =>
  write("register", [who, ROLE_CODE[role]]);

export const setKycOnChain = (who: Address, verified: boolean, docHash: Hex, reviewer: Address): Promise<Hex> =>
  write("setKyc", [who, verified, docHash, reviewer]);

export const postListingOnChain = (id: string, owner: Address, contentHash: Hex): Promise<Hex> =>
  write("postListing", [listingKey(id), owner, contentHash]);

export const setListingLiveOnChain = (id: string, live: boolean): Promise<Hex> =>
  write("setListingLive", [listingKey(id), live]);

export interface ActivityInput {
  accountId: number | null;
  actorAddress: Address;
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * Record what someone did, in Postgres first and on chain second. The row
 * exists even when the chain write fails; the error is kept beside it and
 * the replay job retries. Callers do not await the chain.
 */
export async function logActivity(input: ActivityInput): Promise<{ id: number; txHash: Hex | null }> {
  const database = db();
  const hash = payloadHash({ kind: input.kind, actor: input.actorAddress, ...input.payload });
  const [row] = await database
    .insert(schema.activities)
    .values({
      accountId: input.accountId,
      actorAddress: input.actorAddress,
      kind: input.kind,
      payload: input.payload,
      payloadHash: hash,
    })
    .returning({ id: schema.activities.id });
  const id = row!.id;
  try {
    const txHash = await write("log", [input.actorAddress, keccak256(stringToHex(input.kind)), hash]);
    await database.update(schema.activities).set({ txHash, error: null }).where(eqId(id));
    return { id, txHash };
  } catch (error) {
    await database.update(schema.activities).set({ error: revertReason(error).slice(0, 500) }).where(eqId(id));
    return { id, txHash: null };
  }
}

/** Retry every activity whose chain write failed. */
export async function replayActivities(limit = 20): Promise<{ retried: number; written: number }> {
  const database = db();
  const rows = await database
    .select()
    .from(schema.activities)
    .where(isNull(schema.activities.txHash))
    .orderBy(asc(schema.activities.id))
    .limit(limit);
  let written = 0;
  for (const row of rows) {
    try {
      const txHash = await write("log", [row.actorAddress as Address, keccak256(stringToHex(row.kind)), row.payloadHash as Hex]);
      await database.update(schema.activities).set({ txHash, error: null }).where(eqId(row.id));
      written++;
    } catch (error) {
      await database.update(schema.activities).set({ error: revertReason(error).slice(0, 500) }).where(eqId(row.id));
    }
  }
  return { retried: rows.length, written };
}

const eqId = (id: number) => eq(schema.activities.id, id);
