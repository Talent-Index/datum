import {
  http,
  createPublicClient,
  createWalletClient,
  defineChain,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Chain access for the escrow. Fuji (43113) by default; point RPC_URL at an
 * Anvil fork for local development and nothing else changes.
 *
 * Deliberately custodial: the buyer never holds a key. Managed buyer
 * accounts are derived from a master seed; in production this is a KMS or
 * an embedded-wallet provider, and the derivation lives behind the same
 * function.
 */

export const KES_UNITS = 100n; // token has 2 decimals: 100 units = KES 1.00

export const escrowAbi = [
  {
    type: "function",
    name: "depositFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "buyer", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "attest",
    stateMutability: "nonpayable",
    inputs: [
      { name: "milestoneId", type: "uint256" },
      { name: "role", type: "uint8" },
      { name: "evidenceHash", type: "bytes32" },
    ],
    outputs: [],
  },
  { type: "function", name: "declareStalled", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "claimRefund",
    stateMutability: "nonpayable",
    inputs: [{ name: "buyer", type: "address" }],
    outputs: [],
  },
  { type: "function", name: "totalDeposited", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalReleased", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "heldBalance", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nextMilestone", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "status", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "milestoneCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "milestones",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      { name: "description", type: "string" },
      { name: "releasePercent", type: "uint8" },
      { name: "cumulativePercent", type: "uint8" },
      { name: "evidenceHash", type: "bytes32" },
      { name: "approvals", type: "uint8" },
      { name: "released", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "hasAttested",
    stateMutability: "view",
    inputs: [
      { type: "uint256" },
      { type: "uint8" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "buyerPosition",
    stateMutability: "view",
    inputs: [{ name: "buyer", type: "address" }],
    outputs: [
      { name: "contributed", type: "uint256" },
      { name: "releasedOnTheirBehalf", type: "uint256" },
      { name: "stillHeld", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "deposited",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "refunded",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }],
  },
] as const;

export const kesAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set; see .env.example for the chain configuration`);
  }
  return value;
}

const FUJI_RPC = "https://api.avax-test.network/ext/bc/C/rpc";

export function chain(): Chain {
  return defineChain({
    id: Number.parseInt(process.env.CHAIN_ID ?? "43113", 10),
    name: "avalanche-fuji",
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    rpcUrls: { default: { http: [process.env.RPC_URL ?? FUJI_RPC] } },
  });
}

export function escrowAddress(): Address {
  return requireEnv("ESCROW_ADDRESS") as Address;
}

export function kesAddress(): Address {
  return requireEnv("KES_ADDRESS") as Address;
}

export function developerAddress(): Address {
  return requireEnv("DEVELOPER_ADDRESS") as Address;
}

export function publicClient(): PublicClient {
  return createPublicClient({ chain: chain(), transport: http() });
}

function walletFor(envName: string): { client: WalletClient; account: Account } {
  const account = privateKeyToAccount(requireEnv(envName) as Hex);
  return {
    client: createWalletClient({ account, chain: chain(), transport: http() }),
    account,
  };
}

/** The platform's settlement wallet: M-Pesa lands here, deposits are pulled from it. */
export const platformWallet = () => walletFor("PLATFORM_KEY");
export const oracleWallet = () => walletFor("ORACLE_KEY");
export const surveyorWallet = () => walletFor("SURVEYOR_KEY");

/**
 * Phone number in, managed account out. Derivation from a master seed keeps
 * refunds spendable; the buyer never sees the key and never signs.
 */
export function buyerAccount(phone: string): Account {
  const seed = requireEnv("BUYER_MASTER_SEED");
  return privateKeyToAccount(keccak256(toBytes(`${seed}:${phone}`)));
}

export function revertReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  for (const marker of ["reverted with the following reason:\n", "revert ", "execution reverted: "]) {
    const index = text.indexOf(marker);
    if (index >= 0) {
      return text.slice(index + marker.length).split("\n")[0]!.trim();
    }
  }
  return text.split("\n")[0]!.slice(0, 200);
}
