CREATE TABLE "identity_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" text,
	"email" text,
	"google_sub" text,
	"account_id" integer,
	"display_name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_touches" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_phone" ON "identity_links" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_email" ON "identity_links" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_google" ON "identity_links" USING btree ("google_sub");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_touches_subject_project" ON "identity_touches" USING btree ("subject","project_id");