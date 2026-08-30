CREATE TABLE "attestations" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"milestone_index" integer NOT NULL,
	"role" smallint NOT NULL,
	"evidence_hash" text NOT NULL,
	"accepted" boolean NOT NULL,
	"summary" text,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buyers" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"phone" text NOT NULL,
	"wallet_address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corroborations" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"developer_name" text NOT NULL,
	"verdict" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_images" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"milestone_index" integer,
	"phash" bigint NOT NULL,
	"label" text NOT NULL,
	"sha256" text,
	"filename" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"milestone_index" integer NOT NULL,
	"description" text NOT NULL,
	"stage" text NOT NULL,
	"percent" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"checkout_request_id" text NOT NULL,
	"merchant_request_id" text,
	"project_id" text NOT NULL,
	"phone" text NOT NULL,
	"amount_kes" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"mpesa_receipt" text,
	"result_description" text,
	"deposit_tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"developer_name" text NOT NULL,
	"project_ref" text,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"contract_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyers" ADD CONSTRAINT "buyers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corroborations" ADD CONSTRAINT "corroborations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_payments" ADD CONSTRAINT "pending_payments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buyers_project_phone" ON "buyers" USING btree ("project_id","phone");--> statement-breakpoint
CREATE INDEX "evidence_images_project" ON "evidence_images" USING btree ("project_id","phash");--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_project_index" ON "milestones" USING btree ("project_id","milestone_index");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_payments_checkout_request" ON "pending_payments" USING btree ("checkout_request_id");