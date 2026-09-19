import { eq } from "drizzle-orm";
import type { Address } from "viem";

import { currentSender } from "./auth";
import { managedAccount, normaliseMsisdn } from "./chain";
import { db, schema } from "./db";
import { normaliseEmail } from "./email";
import { isRegisteredOnChain, logActivity, registerOnChain, type Role, ROLES } from "./registry";

/**
 * Accounts sit on top of sessions. The session proves a phone number or an
 * email address; the account says what that person is here to do, which
 * address is theirs, and whether they have paid to take part.
 */

export type Account = typeof schema.accounts.$inferSelect;

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Roles that sign in by email and pay the platform fee before posting or committing. */
export const FEE_ROLES: readonly Role[] = ["seller", "developer", "company", "sender"];

export function listingFeeKes(): number {
  const value = Number.parseInt(process.env.LISTING_FEE_KES ?? "200", 10);
  return Number.isFinite(value) && value > 0 ? value : 200;
}

export const feeRequired = (a: Account): boolean =>
  FEE_ROLES.includes(a.role as Role) && a.feeStatus !== "paid";

/** The account behind the request's session, or null if there is none. */
export async function currentAccount(request: Request): Promise<Account | null> {
  const session = currentSender(request);
  if (!session) return null;
  const direct = await accountBySubject(session.subject);
  if (direct) return direct;
  // An email account that added a number can sign in with that number: the
  // session just proved the handset, which is what the fee would have
  // proved, so the number is marked proven here too.
  if (session.phone) {
    const byPhone = await accountByPhone(session.phone);
    if (byPhone) {
      if (!byPhone.phoneVerified) {
        const [row] = await db().update(schema.accounts).set({ phoneVerified: true }).where(eq(schema.accounts.id, byPhone.id)).returning();
        return row ?? byPhone;
      }
      return byPhone;
    }
  }
  // A phone account that confirmed an email can sign in with it. Only a
  // proven email counts: one given as contact detail was never checked.
  if (session.email) {
    const byEmail = await accountByEmail(session.email);
    if (byEmail?.emailVerified) return byEmail;
  }
  return null;
}

/** A database error, said in words a person can act on. */
export function friendlyError(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/accounts_phone|accounts_subject/.test(text)) return "That number is already on another account; sign in with it instead";
  if (/accounts_email/.test(text)) return "That email is already on another account; sign in with it instead";
  if (/accounts_address/.test(text)) return "An account already exists for this identity";
  if (text.startsWith("Failed query")) return fallback;
  return text;
}

export async function accountBySubject(subject: string): Promise<Account | null> {
  const [row] = await db().select().from(schema.accounts).where(eq(schema.accounts.subject, subject));
  return row ?? null;
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

/** The managed address for an identity string, phone or email. */
export function accountAddress(subject: string): Address {
  return managedAccount(subject.includes("@") ? normaliseEmail(subject) : normaliseMsisdn(subject)).address;
}

/**
 * The M-Pesa number a request can pay from: the session's own number, or
 * the number the account added. Null means they have to add one first.
 */
export async function payerPhone(request: Request): Promise<{ phone: string; account: Account | null } | null> {
  const session = currentSender(request);
  if (!session) return null;
  const account = await accountBySubject(session.subject);
  const phone = session.phone ?? account?.phone ?? null;
  return phone ? { phone, account } : null;
}

export interface NewAccount {
  subject: string;
  role: Role;
  displayName: string;
  companyName?: string | null;
  registrationNumber?: string | null;
}

/**
 * Create the account, register its address and role on chain, and log the
 * sign-up as the first activity. The row is written before the chain so a
 * slow RPC never loses a sign-up; the registry transaction is recorded on
 * the row when it lands and retried on the next sign-in if it does not.
 */
export async function createAccount(input: NewAccount): Promise<Account> {
  const byEmail = input.subject.includes("@");
  const subject = byEmail ? normaliseEmail(input.subject) : normaliseMsisdn(input.subject);
  if (await accountBySubject(subject)) throw new Error("An account already exists for this address");
  const address = accountAddress(subject);
  const database = db();
  const [row] = await database
    .insert(schema.accounts)
    .values({
      subject,
      email: byEmail ? subject : null,
      phone: byEmail ? null : subject,
      phoneVerified: !byEmail,
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
    await database.update(schema.accounts).set({ registryTxHash }).where(eq(schema.accounts.id, account.id));
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

export async function accountByEmail(email: string): Promise<Account | null> {
  const [row] = await db().select().from(schema.accounts).where(eq(schema.accounts.email, normaliseEmail(email)));
  return row ?? null;
}

/**
 * Attach an email to a phone account. Verified when a code sent to it is
 * typed back; recorded unverified when it was given as contact detail at
 * commitment, so staff know which is which.
 */
export async function setAccountEmail(account: Account, email: string, verified: boolean): Promise<Account> {
  const normalised = normaliseEmail(email);
  const clash = await accountByEmail(normalised);
  if (clash && clash.id !== account.id) {
    throw new Error("That email already belongs to another account; sign in with it instead");
  }
  const [row] = await db()
    .update(schema.accounts)
    .set({ email: normalised, emailVerified: verified || (account.email === normalised && account.emailVerified) })
    .where(eq(schema.accounts.id, account.id))
    .returning();
  return row!;
}

/**
 * A buyer who commits without an account gets one on the number they
 * proved, with the name and email they gave, so the commitment is traceable
 * to a person and an address from the first shilling.
 */
export async function ensureBuyerAccount(subject: string, displayName: string, email: string | null): Promise<Account> {
  const existing = (await accountBySubject(subject)) ?? (subject.includes("@") ? null : await accountByPhone(subject));
  if (existing) {
    let account = existing;
    if (displayName.trim() && displayName.trim() !== account.displayName) {
      const [row] = await db().update(schema.accounts).set({ displayName: displayName.trim() }).where(eq(schema.accounts.id, account.id)).returning();
      account = row!;
    }
    if (email && normaliseEmail(email) !== account.email) account = await setAccountEmail(account, email, false);
    return account;
  }
  const account = await createAccount({ subject, role: "buyer", displayName });
  return email ? setAccountEmail(account, email, false) : account;
}

/** Attach the M-Pesa number an email account will pay from. Proven when the fee arrives from it. */
export async function setAccountPhone(account: Account, phone: string): Promise<Account> {
  const normalised = normaliseMsisdn(phone);
  const clash = await accountByPhone(normalised);
  if (clash && clash.id !== account.id) throw new Error("That number is already on another account");
  const [row] = await db()
    .update(schema.accounts)
    .set({ phone: normalised, phoneVerified: false })
    .where(eq(schema.accounts.id, account.id))
    .returning();
  return row!;
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
    subject: a.subject,
    email: a.email,
    email_verified: a.emailVerified,
    phone: a.phone,
    phone_verified: a.phoneVerified,
    role: a.role,
    display_name: a.displayName,
    company_name: a.companyName,
    registration_number: a.registrationNumber,
    address: a.address,
    kyc_status: a.kycStatus,
    fee_status: a.feeStatus,
    fee_required: feeRequired(a),
    fee_kes: listingFeeKes(),
    registry_tx: a.registryTxHash?.startsWith("0x") ? a.registryTxHash : null,
    registered_on_chain: a.registryTxHash !== null,
    created_at: a.createdAt,
  };
}
