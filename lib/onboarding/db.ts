import { and, eq, gte } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { OtpDirectory, OtpRecord } from "@/lib/onboarding/email-code";
import type { FeeDirectory, FeeRow } from "@/lib/onboarding/fee";

function toFee(row: typeof schema.pendingPayments.$inferSelect): FeeRow {
  return {
    id: row.id,
    accountId: row.accountId ?? 0,
    phone: row.phone,
    amountKes: row.amountKes,
    checkoutRequestId: row.checkoutRequestId,
    merchantRequestId: row.merchantRequestId,
    status: row.status,
    mpesaReceipt: row.mpesaReceipt,
    resultDescription: row.resultDescription,
    createdAt: row.createdAt.getTime(),
    completedAt: row.completedAt ? row.completedAt.getTime() : null,
  };
}

export function dbOtpDirectory(): OtpDirectory {
  return {
    async live(subject) {
      const [row] = await db().select().from(schema.otpCodes).where(eq(schema.otpCodes.phone, subject));
      if (!row) return null;
      const record: OtpRecord = {
        subject: row.phone,
        codeHash: row.codeHash,
        attempts: row.attempts,
        expiresAt: row.expiresAt.getTime(),
        createdAt: row.createdAt.getTime(),
      };
      return record;
    },
    async replace(record) {
      const database = db();
      await database.delete(schema.otpCodes).where(eq(schema.otpCodes.phone, record.subject));
      await database.insert(schema.otpCodes).values({
        phone: record.subject,
        codeHash: record.codeHash,
        attempts: record.attempts,
        expiresAt: new Date(record.expiresAt),
        createdAt: new Date(record.createdAt),
      });
    },
    async setAttempts(subject, attempts) {
      await db().update(schema.otpCodes).set({ attempts }).where(eq(schema.otpCodes.phone, subject));
    },
    async remove(subject) {
      await db().delete(schema.otpCodes).where(eq(schema.otpCodes.phone, subject));
    },
    async countEvents(subject, kind, since) {
      const rows = await db()
        .select({ id: schema.otpEvents.id })
        .from(schema.otpEvents)
        .where(and(eq(schema.otpEvents.subject, subject), eq(schema.otpEvents.kind, kind), gte(schema.otpEvents.createdAt, new Date(since))));
      return rows.length;
    },
    async addEvent(subject, kind, at) {
      await db().insert(schema.otpEvents).values({ subject, kind, createdAt: new Date(at) });
    },
  };
}

export function dbFeeDirectory(): FeeDirectory {
  return {
    async listFees(accountId) {
      const rows = await db()
        .select()
        .from(schema.pendingPayments)
        .where(and(eq(schema.pendingPayments.accountId, accountId), eq(schema.pendingPayments.purpose, "fee")));
      return rows.map(toFee);
    },
    async findByCheckout(checkoutRequestId) {
      const [row] = await db()
        .select()
        .from(schema.pendingPayments)
        .where(eq(schema.pendingPayments.checkoutRequestId, checkoutRequestId));
      return row && row.purpose === "fee" ? toFee(row) : null;
    },
    async findByReceipt(receipt) {
      const [row] = await db().select().from(schema.pendingPayments).where(eq(schema.pendingPayments.mpesaReceipt, receipt));
      return row ? toFee(row) : null;
    },
    async insert(row) {
      const [stored] = await db()
        .insert(schema.pendingPayments)
        .values({
          checkoutRequestId: row.checkoutRequestId,
          merchantRequestId: row.merchantRequestId,
          purpose: "fee",
          projectId: null,
          accountId: row.accountId,
          phone: row.phone,
          amountKes: row.amountKes,
          status: row.status,
          mpesaReceipt: row.mpesaReceipt,
          resultDescription: row.resultDescription,
          createdAt: new Date(row.createdAt),
          completedAt: row.completedAt ? new Date(row.completedAt) : null,
        })
        .returning();
      return toFee(stored!);
    },
    async update(id, patch) {
      const [stored] = await db()
        .update(schema.pendingPayments)
        .set({
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.mpesaReceipt !== undefined ? { mpesaReceipt: patch.mpesaReceipt } : {}),
          ...(patch.resultDescription !== undefined ? { resultDescription: patch.resultDescription } : {}),
          ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt ? new Date(patch.completedAt) : null } : {}),
        })
        .where(eq(schema.pendingPayments.id, id))
        .returning();
      return toFee(stored!);
    },
    async markFeePaid(accountId, at) {
      await db()
        .update(schema.accounts)
        .set({ feeStatus: "paid", feePaidAt: new Date(at) })
        .where(eq(schema.accounts.id, accountId));
    },
    async noteFeeClosed(accountId) {
      await db()
        .update(schema.accounts)
        .set({ feeStatus: "none" })
        .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.feeStatus, "pending")));
    },
  };
}
