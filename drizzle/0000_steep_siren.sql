CREATE TABLE "BotEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Position" (
	"id" text PRIMARY KEY NOT NULL,
	"tokenMint" text NOT NULL,
	"symbol" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"entryPrice" double precision NOT NULL,
	"solSpent" double precision NOT NULL,
	"tokenAmount" double precision NOT NULL,
	"txSignature" text NOT NULL,
	"tweetText" text,
	"dex" text DEFAULT 'pump.fun' NOT NULL,
	"openedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "Position_tokenMint_unique" UNIQUE("tokenMint")
);
--> statement-breakpoint
CREATE TABLE "Trade" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"tokenMint" text NOT NULL,
	"symbol" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"solAmount" double precision NOT NULL,
	"tokenAmount" double precision DEFAULT 0 NOT NULL,
	"priceUsd" double precision DEFAULT 0 NOT NULL,
	"mcapUsd" double precision DEFAULT 0 NOT NULL,
	"pnlPercent" double precision,
	"pnlSol" double precision,
	"txSignature" text NOT NULL,
	"source" text DEFAULT 'gmgn' NOT NULL,
	"reason" text,
	"tweetText" text,
	"dex" text DEFAULT 'pump.fun' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "BotEvent_createdAt_idx" ON "BotEvent" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "BotEvent_type_idx" ON "BotEvent" USING btree ("type");--> statement-breakpoint
CREATE INDEX "Trade_tokenMint_idx" ON "Trade" USING btree ("tokenMint");--> statement-breakpoint
CREATE INDEX "Trade_createdAt_idx" ON "Trade" USING btree ("createdAt");