import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Buyer phone numbers and identity live here, never on chain. There is no
 * erasure remedy against a blockchain, and this is personal data under the
 * Data Protection Act 2019. The chain carries only managed wallet
 * addresses and evidence hashes; the linkage from address to person exists
 * only in this database and deserves the same care as the phone numbers.
 */

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  developerName: text("developer_name").notNull(),
  projectRef: text("project_ref"),
  latitude: doublePrecision("latitude").notNull(),
  longitude: doublePrecision("longitude").notNull(),
  contractAddress: text("contract_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const milestones = pgTable(
  "milestones",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    milestoneIndex: integer("milestone_index").notNull(),
    description: text("description").notNull(),
    stage: text("stage").notNull(),
    percent: integer("percent").notNull(),
  },
  (table) => [
    uniqueIndex("milestones_project_index").on(table.projectId, table.milestoneIndex),
  ],
);

export const buyers = pgTable(
  "buyers",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    phone: text("phone").notNull(),
    walletAddress: text("wallet_address").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("buyers_project_phone").on(table.projectId, table.phone)],
);

/**
 * Created before the STK push response returns, keyed on the
 * CheckoutRequestID Daraja hands back. AccountReference is capped at 12
 * alphanumeric characters and is not echoed in the callback, so this row is
 * the only way to route a callback to a buyer and project.
 */
export const pendingPayments = pgTable(
  "pending_payments",
  {
    id: serial("id").primaryKey(),
    checkoutRequestId: text("checkout_request_id").notNull(),
    merchantRequestId: text("merchant_request_id"),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    phone: text("phone").notNull(),
    amountKes: integer("amount_kes").notNull(),
    status: text("status").notNull().default("pending"), // pending | confirmed | failed
    mpesaReceipt: text("mpesa_receipt"),
    resultDescription: text("result_description"),
    depositTxHash: text("deposit_tx_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("pending_payments_checkout_request").on(table.checkoutRequestId),
  ],
);

/**
 * One row per image that passed verification, with the perceptual hash the
 * novelty check compares against in SQL. BIGINT holds the unsigned 64-bit
 * hash mapped into the signed range.
 */
export const evidenceImages = pgTable(
  "evidence_images",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id").notNull(),
    milestoneIndex: integer("milestone_index"),
    phash: bigint("phash", { mode: "bigint" }).notNull(),
    label: text("label").notNull(),
    sha256: text("sha256"),
    filename: text("filename"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("evidence_images_project").on(table.projectId, table.phash)],
);

export const attestations = pgTable("attestations", {
  id: serial("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  milestoneIndex: integer("milestone_index").notNull(),
  role: smallint("role").notNull(), // 0 oracle | 1 surveyor | 2 platform
  evidenceHash: text("evidence_hash").notNull(),
  accepted: boolean("accepted").notNull(),
  summary: text("summary"),
  verdict: jsonb("verdict"),
  txHash: text("tx_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const corroborations = pgTable("corroborations", {
  id: serial("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  developerName: text("developer_name").notNull(),
  verdict: text("verdict").notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
