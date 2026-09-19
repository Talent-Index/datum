CREATE TABLE "build_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_account_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"location_name" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"budget_kes" integer NOT NULL,
	"initial_deposit_kes" integer NOT NULL,
	"deposit_paid_at" timestamp with time zone,
	"builder_account_id" integer,
	"trustee_account_id" integer,
	"milestones" jsonb,
	"price_kes" integer,
	"agreement_hash" text,
	"owner_signed_at" timestamp with time zone,
	"owner_sign_tx" text,
	"builder_signed_at" timestamp with time zone,
	"builder_sign_tx" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"project_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_payments" ADD COLUMN "build_request_id" text;--> statement-breakpoint
ALTER TABLE "build_requests" ADD CONSTRAINT "build_requests_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_requests_owner" ON "build_requests" USING btree ("owner_account_id");--> statement-breakpoint
CREATE INDEX "build_requests_status" ON "build_requests" USING btree ("status");