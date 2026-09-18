CREATE TABLE "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"role" text NOT NULL,
	"display_name" text NOT NULL,
	"company_name" text,
	"registration_number" text,
	"address" text NOT NULL,
	"kyc_status" text DEFAULT 'none' NOT NULL,
	"registry_tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer,
	"actor_address" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"tx_hash" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kyc_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"full_name" text NOT NULL,
	"id_type" text NOT NULL,
	"id_number_hash" text NOT NULL,
	"id_last4" text NOT NULL,
	"document_sha256" text NOT NULL,
	"document_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewer_account_id" integer,
	"review_note" text,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_account_id" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"location_name" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"price_kes" integer NOT NULL,
	"milestones" jsonb NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"project_id" text,
	"trustee_account_id" integer,
	"review_note" text,
	"content_hash" text NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "owner_account_id" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "trustee_account_id" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "listing_id" text;--> statement-breakpoint
ALTER TABLE "kyc_submissions" ADD CONSTRAINT "kyc_submissions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_phone" ON "accounts" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_address" ON "accounts" USING btree ("address");--> statement-breakpoint
CREATE INDEX "activities_account" ON "activities" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "activities_created" ON "activities" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "kyc_submissions_account" ON "kyc_submissions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "listings_owner" ON "listings" USING btree ("owner_account_id");--> statement-breakpoint
CREATE INDEX "listings_status" ON "listings" USING btree ("status");