import { and, eq, or } from "drizzle-orm";

import { accountByEmail, sessionOwnsAccount } from "./accounts";
import { normaliseMsisdn } from "./chain";
import { db, schema } from "./db";
import { normaliseEmail } from "./email";
import { listProjects } from "./project";
import type { SenderSession } from "./auth";

/**
 * Visits are remembered against the email that signed in. A phone number
 * saved for M-Pesa is not a login and is not written here as a way to join
 * two accounts. A missing table must not block sign-in.
 */

export interface BuildTie {
  id: string;
  name: string;
  developer_name: string;
  tie: "sender" | "buyer" | "visited";
}

/** Union of buyer rows, sender phones and recorded visits. Order is stable. */
export function linkedProjectIds(input: { buyer: string[]; sender: string[]; touched: string[] }): string[] {
  const ids: string[] = [];
  for (const id of [...input.sender, ...input.buyer, ...input.touched]) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export async function rememberIdentity(input: {
  phone?: string | null;
  email?: string | null;
  googleSub?: string | null;
  accountId?: number | null;
  displayName?: string | null;
}): Promise<void> {
  const phone = input.phone ? normaliseMsisdn(input.phone) : null;
  const email = input.email ? normaliseEmail(input.email) : null;
  const googleSub = input.googleSub ?? null;
  if (!phone && !email && !googleSub) return;
  try {
    const database = db();
    const matches = [phone ? eq(schema.identityLinks.phone, phone) : undefined, email ? eq(schema.identityLinks.email, email) : undefined, googleSub ? eq(schema.identityLinks.googleSub, googleSub) : undefined].filter(
      (clause): clause is NonNullable<typeof clause> => clause !== undefined,
    );
    const where = matches.length === 1 ? matches[0]! : or(...matches);
    const rows = await database.select().from(schema.identityLinks).where(where);
    const row = rows[0];
    if (!row) {
      await database.insert(schema.identityLinks).values({
        phone,
        email,
        googleSub,
        accountId: input.accountId ?? null,
        displayName: input.displayName ?? null,
      });
      return;
    }
    await database
      .update(schema.identityLinks)
      .set({
        phone: phone ?? row.phone,
        email: email ?? row.email,
        googleSub: googleSub ?? row.googleSub,
        accountId: input.accountId ?? row.accountId,
        displayName: input.displayName ?? row.displayName,
        updatedAt: new Date(),
      })
      .where(eq(schema.identityLinks.id, row.id));
  } catch (error) {
    console.warn(`[identity] link not stored: ${error instanceof Error ? error.message : "unavailable"}`);
  }
}

export async function rememberTouch(subject: string | null | undefined, projectId: string, kind: string): Promise<void> {
  if (!subject || !projectId) return;
  try {
    const database = db();
    const [existing] = await database
      .select({ id: schema.identityTouches.id })
      .from(schema.identityTouches)
      .where(and(eq(schema.identityTouches.subject, subject), eq(schema.identityTouches.projectId, projectId)));
    if (existing) {
      await database
        .update(schema.identityTouches)
        .set({ kind, updatedAt: new Date() })
        .where(eq(schema.identityTouches.id, existing.id));
      return;
    }
    await database.insert(schema.identityTouches).values({ subject, projectId, kind });
  } catch (error) {
    console.warn(`[identity] visit not stored: ${error instanceof Error ? error.message : "unavailable"}`);
  }
}

/** Builds this session already belongs to, from its own account and its visits. */
export async function buildsForSession(session: SenderSession): Promise<BuildTie[]> {
  const projects = await listProjects();
  const byEmail = session.email ? await accountByEmail(session.email) : null;
  const owned = byEmail && sessionOwnsAccount(session, byEmail) ? byEmail : null;
  const phone = owned?.phone ? normaliseMsisdn(owned.phone) : session.phone && session.subject === session.phone ? normaliseMsisdn(session.phone) : null;
  const database = db();
  const buyerIds = phone
    ? (await database.select({ projectId: schema.buyers.projectId }).from(schema.buyers).where(eq(schema.buyers.phone, phone))).map((row) => row.projectId)
    : [];
  const senderIds = projects.filter((project) => phone && project.senderPhone === phone).map((project) => project.id);
  let touched: string[] = [];
  const subject = session.email ?? (session.subject === session.phone ? session.phone : null);
  if (subject) {
    try {
      touched = (
        await database
          .select({ projectId: schema.identityTouches.projectId })
          .from(schema.identityTouches)
          .where(eq(schema.identityTouches.subject, subject))
      ).map((row) => row.projectId);
    } catch {
      touched = [];
    }
  }
  const ids = linkedProjectIds({ buyer: buyerIds, sender: senderIds, touched });
  return ids.flatMap((id) => {
    const project = projects.find((item) => item.id === id);
    if (!project) return [];
    const tie: BuildTie["tie"] = senderIds.includes(id) ? "sender" : buyerIds.includes(id) ? "buyer" : "visited";
    return [{ id: project.id, name: project.name, developer_name: project.developerName, tie }];
  });
}

/**
 * Google has proved an inbox. The Datum session stays on that email.
 * A phone saved for M-Pesa is not copied into the session, and an unverified
 * contact email is not marked proven unless it is already this account's email.
 */
export async function linkGoogleIdentity(input: { email: string; googleSub: string | null; name: string | null }): Promise<{ email: string }> {
  const email = normaliseEmail(input.email);
  const account = await accountByEmail(email);
  if (account && account.email === email && !account.emailVerified) {
    await db().update(schema.accounts).set({ emailVerified: true }).where(eq(schema.accounts.id, account.id));
  }
  await rememberIdentity({
    email,
    googleSub: input.googleSub,
    accountId: account?.id ?? null,
    displayName: input.name,
  });
  return { email };
}
