import { asc, eq } from "drizzle-orm";
import { parseEther, type Address } from "viem";

import { escrowArtifact, kesArtifact } from "./artifacts";
import {
  KES_UNITS,
  WRITE_GAS,
  buyerAccount,
  normaliseMsisdn,
  platformWallet,
  publicClient,
} from "./chain";
import { db, schema } from "./db";

/**
 * Projects are rows, not constants. One development or one plot per row,
 * each with its own escrow; the code reads everything it needs from here,
 * so a second project is a form submission rather than a redeploy.
 */

export interface ProjectMilestone {
  index: number;
  description: string;
  stage: string;
  percent: number;
}

export interface Project {
  id: string;
  name: string;
  developerName: string;
  projectRef: string | null;
  latitude: number;
  longitude: number;
  contractAddress: Address;
  kesAddress: Address;
  developerAddress: Address;
  senderPhone: string | null;
  fundingTargetKes: number | null;
  ownerAccountId: number | null;
  trusteeAccountId: number | null;
  listingId: string | null;
  milestones: ProjectMilestone[];
}

/** A remittance build has one sender, whose wallet is attester 1. */
export const isRemittance = (p: Project): boolean => p.senderPhone !== null;

export const roleNames = (p: Project): Record<number, string> => ({
  0: "Evidence pipeline",
  1: isRemittance(p) ? "Sender" : "Quantity surveyor",
  2: "Platform",
});

function hydrate(
  row: typeof schema.projects.$inferSelect,
  milestones: Array<typeof schema.milestones.$inferSelect>,
): Project | null {
  if (!row.contractAddress || !row.kesAddress || !row.developerAddress) return null;
  return {
    id: row.id,
    name: row.name,
    developerName: row.developerName,
    projectRef: row.projectRef,
    latitude: row.latitude,
    longitude: row.longitude,
    contractAddress: row.contractAddress as Address,
    kesAddress: row.kesAddress as Address,
    developerAddress: row.developerAddress as Address,
    senderPhone: row.senderPhone,
    fundingTargetKes: row.fundingTargetKes,
    ownerAccountId: row.ownerAccountId,
    trusteeAccountId: row.trusteeAccountId,
    listingId: row.listingId,
    milestones: milestones
      .sort((a, b) => a.milestoneIndex - b.milestoneIndex)
      .map((m) => ({
        index: m.milestoneIndex,
        description: m.description,
        stage: m.stage,
        percent: m.percent,
      })),
  };
}

export async function getProject(id: string): Promise<Project | null> {
  const database = db();
  const [row] = await database.select().from(schema.projects).where(eq(schema.projects.id, id));
  if (!row) return null;
  const milestones = await database
    .select()
    .from(schema.milestones)
    .where(eq(schema.milestones.projectId, id));
  return hydrate(row, milestones);
}

export async function listProjects(): Promise<Project[]> {
  const database = db();
  const rows = await database.select().from(schema.projects).orderBy(asc(schema.projects.createdAt));
  const out: Project[] = [];
  for (const row of rows) {
    const milestones = await database
      .select()
      .from(schema.milestones)
      .where(eq(schema.milestones.projectId, row.id));
    const p = hydrate(row, milestones);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Which project a request is about: ?project=<id> on the URL. With exactly
 * one project deployed, omitting it resolves to that one, so a single-site
 * install and its curl demos keep working unchanged.
 */
export async function resolveProject(request: Request): Promise<Project | null> {
  const id = new URL(request.url).searchParams.get("project");
  if (id) return getProject(id);
  const all = await listProjects();
  return all.length === 1 ? all[0]! : null;
}

export interface NewProject {
  id: string;
  name: string;
  developerName: string;
  projectRef?: string | null;
  latitude: number;
  longitude: number;
  developerAddress: Address;
  /** Set for a remittance build: this number becomes attester 1. */
  senderPhone?: string | null;
  /**
   * The trustee's number, when a listing was approved with one assigned.
   * Their managed wallet becomes attester 1 and they countersign from their
   * dashboard. Ignored when senderPhone is set.
   */
  trusteePhone?: string | null;
  ownerAccountId?: number | null;
  trusteeAccountId?: number | null;
  listingId?: string | null;
  fundingTargetKes?: number | null;
  milestones: Array<{ description: string; stage: string; percent: number }>;
  /** Seconds of silence before anyone may declare the project stalled. */
  stallAfterSeconds?: number;
}

const SETTLEMENT_FLOAT_KES = 500_000_000n;
const SENDER_GAS = parseEther("0.05");

/**
 * Create a project and deploy its escrow.
 *
 * Four transactions from the platform wallet: the settlement token, the
 * escrow with this project's milestones and attesters baked in, a mint of
 * the settlement float, and the approval that lets depositFor pull from it.
 * On a remittance build the sender's managed wallet is attester 1 and is
 * given a little AVAX so their approval can pay its own gas.
 */
export async function createProject(input: NewProject): Promise<Project> {
  const total = input.milestones.reduce((s, m) => s + m.percent, 0);
  if (total !== 100) throw new Error(`Milestone percentages sum to ${total}; they must sum to 100`);
  if (!/^[a-z0-9-]{3,40}$/.test(input.id)) {
    throw new Error("Project id must be 3-40 characters of lowercase letters, digits and hyphens");
  }
  if (await getProject(input.id)) throw new Error(`Project '${input.id}' already exists`);

  const oracle = process.env.ORACLE_KEY;
  const surveyor = process.env.SURVEYOR_KEY;
  if (!oracle || !surveyor) throw new Error("ORACLE_KEY and SURVEYOR_KEY must be set");
  const { privateKeyToAccount } = await import("viem/accounts");
  const oracleAddress = privateKeyToAccount(oracle as `0x${string}`).address;
  const senderPhone = input.senderPhone ? normaliseMsisdn(input.senderPhone) : null;
  const managedAttester = senderPhone ?? (input.trusteePhone ? normaliseMsisdn(input.trusteePhone) : null);
  const attester1 = managedAttester
    ? buyerAccount(managedAttester).address
    : privateKeyToAccount(surveyor as `0x${string}`).address;

  const { client, account } = platformWallet();
  const chain = publicClient();
  const deploy = async (
    abi: readonly unknown[],
    bytecode: `0x${string}`,
    args: readonly unknown[],
  ): Promise<Address> => {
    const hash = await client.deployContract({
      abi: abi as never,
      bytecode,
      args: args as never,
      account,
      chain: client.chain,
    });
    const receipt = await chain.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("Deployment returned no contract address");
    return receipt.contractAddress;
  };

  const kesAddress = await deploy(kesArtifact.abi, kesArtifact.bytecode, []);
  const contractAddress = await deploy(escrowArtifact.abi, escrowArtifact.bytecode, [
    kesAddress,
    input.developerAddress,
    [oracleAddress, attester1, account.address],
    input.milestones.map((m) => m.description),
    input.milestones.map((m) => m.percent),
    BigInt(input.stallAfterSeconds ?? 30 * 24 * 3600),
  ]);

  const send = async (address: Address, functionName: string, args: readonly unknown[]) => {
    const hash = await client.writeContract({
      address,
      abi: kesArtifact.abi,
      functionName: functionName as never,
      args: args as never,
      account,
      chain: client.chain,
      gas: WRITE_GAS,
    });
    await chain.waitForTransactionReceipt({ hash });
  };
  await send(kesAddress, "mint", [account.address, SETTLEMENT_FLOAT_KES * KES_UNITS]);
  await send(kesAddress, "approve", [contractAddress, SETTLEMENT_FLOAT_KES * KES_UNITS]);

  // A managed attester pays its own gas to sign, so it is topped up once
  // here rather than begging for AVAX at the moment it matters.
  if (managedAttester && (await chain.getBalance({ address: attester1 })) < SENDER_GAS / 2n) {
    const hash = await client.sendTransaction({
      account,
      to: attester1,
      value: SENDER_GAS,
      chain: client.chain,
    });
    await chain.waitForTransactionReceipt({ hash });
  }

  const database = db();
  await database.insert(schema.projects).values({
    id: input.id,
    name: input.name,
    developerName: input.developerName,
    projectRef: input.projectRef ?? null,
    latitude: input.latitude,
    longitude: input.longitude,
    contractAddress,
    kesAddress,
    developerAddress: input.developerAddress,
    senderPhone,
    fundingTargetKes: input.fundingTargetKes ?? null,
    ownerAccountId: input.ownerAccountId ?? null,
    trusteeAccountId: input.trusteeAccountId ?? null,
    listingId: input.listingId ?? null,
  });
  await database.insert(schema.milestones).values(
    input.milestones.map((m, i) => ({
      projectId: input.id,
      milestoneIndex: i,
      description: m.description,
      stage: m.stage,
      percent: m.percent,
    })),
  );

  const project = await getProject(input.id);
  if (!project) throw new Error("Project was created but could not be read back");
  return project;
}
