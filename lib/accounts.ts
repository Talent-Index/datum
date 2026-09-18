import { eq } from "drizzle-orm";
import type { Address } from "viem";

import { currentSender } from "./auth";
import { buyerAccount, normaliseMsisdn } from "./chain";
import { db, schema } from "./db";
import { isRegisteredOnChain, logActivity, registerOnChain, type Role, ROLES } from "./registry";

/**
 * Accounts sit on top of phone sessions. The session proves the number; the
 * account says what that number is here to do and which address is theirs.
 */

export type Account = typeof schema.accounts.$inferSelect;

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** The account behind the request's session, or null if there is none. */
export async function currentAccount(request: Request): Promise<Account | null> {
  const session = currentSender(request);
  if (!session) return null;
  return accountByPhone(session.phone);
}

export async function accountByPhone(phone: string): Promise<Account | null> {
  const [row] = await db()
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.phone, normaliseMsisdn(phone)));
  return row ?? null;
}

export async function accountById(id: number): Promise<Account | null> {
  const [row] = await db().select().from(schema.accounts).where(eq(schema.accounts.id, id));
  return row ?? null;
}

/** The managed address for a number: the same one buyer deposits use. */
export function accountAddress(phone: string): Address {
  return buyerAccount(phone).address;
}

export interface NewAccount {
  phone: string;
  role: Role;
  displayName: string;
  companyName?: string | null;
  registrationNumber?: string | null;
}

/**
 * Create the account, register its address and role on chain, and log the
 * sign-up as the first activity. The row is written before the chain so a
 * slow RPC never loses a sign-up; the registry transaction is recorded on
 * the row when it lands and retried by replay if it does not.
 */
export async function createAccount(input: NewAccount): Promise<Account> {
  const phone = normaliseMsisdn(input.phone);
  if (await accountByPhone(phone)) throw new Error("An account already exists for this number");
  const address = accountAddress(phone);
  const database = db();
  const [row] = await database
    .insert(schema.accounts)
    .values({
      phone,
      role: input.role,
      displayName: input.displayName.trim(),
      companyName: input.companyName?.trim() || null,
      registrationNumber: input.registrationNumber?.trim() || null,
      address,
    })
    .returning();
  const account = row!;

  let registryTxHash: string | null = null;
  try {
    registryTxHash = await registerOnChain(address, input.role);
    await database
      .update(schema.accounts)
      .set({ registryTxHash })
      .where(eq(schema.accounts.id, account.id));
  } catch {
    // Left null; ensureRegistered() retries on the next sign-in.
  }
  await logActivity({
    accountId: account.id,
    actorAddress: address,
    kind: "account.created",
    payload: { role: input.role, address, registryTxHash },
  });
  return { ...account, registryTxHash };
}

/**
 * Finish a registration whose chain write failed at sign-up. If the chain
 * already knows the address, the write landed and only the row was lost;
 * the transaction hash is gone but the fact is not, and the row records it.
 */
export const REGISTERED_WITHOUT_RECEIPT = "registered";

export async function ensureRegistered(account: Account): Promise<Account> {
  if (account.registryTxHash) return account;
  try {
    const address = account.address as Address;
    const registryTxHash = (await isRegisteredOnChain(address))
      ? REGISTERED_WITHOUT_RECEIPT
      : await registerOnChain(address, account.role as Role);
    await db().update(schema.accounts).set({ registryTxHash }).where(eq(schema.accounts.id, account.id));
    return { ...account, registryTxHash };
  } catch {
    return account;
  }
}

/** Trustees and the platform review; everyone else is refused. */
export function canReview(account: Account | null, operator: boolean): boolean {
  return operator || account?.role === "trustee";
}

export function publicAccount(a: Account) {
  return {
    id: a.id,
    phone: a.phone,
    role: a.role,
    display_name: a.displayName,
    company_name: a.companyName,
    registration_number: a.registrationNumber,
    address: a.address,
    kyc_status: a.kycStatus,
    registry_tx: a.registryTxHash?.startsWith("0x") ? a.registryTxHash : null,
    registered_on_chain: a.registryTxHash !== null,
    created_at: a.createdAt,
  };
}
