CREATE TABLE "LatencyTrace" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"tokenMint" text NOT NULL,
	"symbol" text DEFAULT '' NOT NULL,
	"outcome" text,
	"totalMs" double precision DEFAULT 0 NOT NULL,
	"stages" jsonb,
	"segments" jsonb,
	"notes" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "LatencyTrace_createdAt_idx" ON "LatencyTrace" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "LatencyTrace_kind_idx" ON "LatencyTrace" USING btree ("kind");