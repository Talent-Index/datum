CREATE TABLE "listing_images" (
	"id" serial PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"position" integer NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"data_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_payments" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "subject" text;--> statement-breakpoint
UPDATE "accounts" SET "subject" = "phone" WHERE "subject" IS NULL;--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "subject" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "phone_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "fee_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "fee_paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pending_payments" ADD COLUMN "purpose" text DEFAULT 'deposit' NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_payments" ADD COLUMN "account_id" integer;--> statement-breakpoint
CREATE INDEX "listing_images_listing" ON "listing_images" USING btree ("listing_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_subject" ON "accounts" USING btree ("subject");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email" ON "accounts" USING btree ("email");