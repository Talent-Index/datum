CREATE TABLE "otp_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "otp_events_subject_created" ON "otp_events" USING btree ("subject","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_payments_receipt" ON "pending_payments" USING btree ("mpesa_receipt");