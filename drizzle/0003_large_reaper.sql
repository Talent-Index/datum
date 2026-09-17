CREATE TABLE "otp_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "kes_address" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "developer_address" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "sender_phone" text;--> statement-breakpoint
CREATE INDEX "otp_codes_phone" ON "otp_codes" USING btree ("phone");