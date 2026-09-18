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
  kesAddress: text("kes_address"),
  developerAddress: text("developer_address"),
  // A remittance build has one sender, whose managed wallet is attester 1
  // on its escrow. Null means a developer-led project countersigned by a
  // surveyor the platform appoints.
  senderPhone: text("sender_phone"),
  // What the developer needs raised before the build is fully funded, in
  // whole shillings. Buyers commit against it and deposit toward it.
  fundingTargetKes: integer("funding_target_kes"),
  // Who posted the listing this project came from, and which trustee holds
  // the second signature on its escrow. Null on projects created by hand.
  ownerAccountId: integer("owner_account_id"),
  trusteeAccountId: integer("trustee_account_id"),
  listingId: text("listing_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One account per phone number, with a role and a managed address. The
 * address is derived from the number, so a buyer's escrow wallet and their
 * account address are the same thing.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: serial("id").primaryKey(),
    phone: text("phone").notNull(),
    role: text("role").notNull(), // buyer | seller | developer | company | trustee
    displayName: text("display_name").notNull(),
    companyName: text("company_name"),
    registrationNumber: text("registration_number"),
    address: text("address").notNull(),
    kycStatus: text("kyc_status").notNull().default("none"), // none | pending | verified | rejected
    registryTxHash: text("registry_tx_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("accounts_phone").on(table.phone), uniqueIndex("accounts_address").on(table.address)],
);

/**
 * An identity check as submitted and as reviewed. The document itself is
 * not kept, only its hash and enough of the number to recognise it; the
 * verdict and the reviewer are recorded on chain against that hash.
 */
export const kycSubmissions = pgTable(
  "kyc_submissions",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id").notNull().references(() => accounts.id),
    fullName: text("full_name").notNull(),
    idType: text("id_type").notNull(), // national_id | passport | company_registration
    idNumberHash: text("id_number_hash").notNull(),
    idLast4: text("id_last4").notNull(),
    documentSha256: text("document_sha256").notNull(),
    documentName: text("document_name").notNull(),
    status: text("status").notNull().default("pending"), // pending | verified | rejected
    reviewerAccountId: integer("reviewer_account_id"),
    reviewNote: text("review_note"),
    txHash: text("tx_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => [index("kyc_submissions_account").on(table.accountId)],
);

/**
 * What a seller, developer or company advertises. Reviewed by a trustee;
 * on approval a development or build gets its escrow deployed and the
 * listing points at the project buyers commit to.
 */
export const listings = pgTable(
  "listings",
  {
    id: text("id").primaryKey(),
    ownerAccountId: integer("owner_account_id").notNull().references(() => accounts.id),
    kind: text("kind").notNull(), // property_sale | build | development
    title: text("title").notNull(),
    description: text("description").notNull(),
    locationName: text("location_name").notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    priceKes: integer("price_kes").notNull(),
    milestones: jsonb("milestones").notNull(),
    status: text("status").notNull().default("pending_review"), // pending_review | live | rejected | withdrawn
    projectId: text("project_id"),
    trusteeAccountId: integer("trustee_account_id"),
    reviewNote: text("review_note"),
    contentHash: text("content_hash").notNull(),
    txHash: text("tx_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("listings_owner").on(table.ownerAccountId), index("listings_status").on(table.status)],
);

/**
 * Everything anyone did, with the hash that was written to the registry
 * and the transaction that carried it. A null transaction means the write
 * failed and the replay job will retry it.
 */
export const activities = pgTable(
  "activities",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id"),
    actorAddress: text("actor_address").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    txHash: text("tx_hash"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("activities_account").on(table.accountId), index("activities_created").on(table.createdAt)],
);

/**
 * One-time codes, stored hashed. A phone number is proven by typing back a
 * code sent to it; the row is deleted on success, and attempts are counted
 * so a code cannot be brute-forced in the minutes it is live.
 */
export const otpCodes = pgTable(
  "otp_codes",
  {
    id: serial("id").primaryKey(),
    phone: text("phone").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("otp_codes_phone").on(table.phone)],
);

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
    // What this buyer undertook to pay in total. Deposits arrive in
    // instalments, so the commitment is what the ledger measures against.
    commitmentKes: integer("commitment_kes"),
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
