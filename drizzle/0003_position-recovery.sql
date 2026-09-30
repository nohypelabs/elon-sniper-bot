ALTER TABLE "Position" ADD COLUMN "mcapUsd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "Position" ADD COLUMN "tp1Hit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "Position" ADD COLUMN "tp2Hit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "Position" ADD COLUMN "moonbag" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "Position" ADD COLUMN "remainingTokens" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "Position" ADD COLUMN "peakPnlPercent" double precision;--> statement-breakpoint
ALTER TABLE "Position" ADD COLUMN "currentPriceUsd" double precision DEFAULT 0 NOT NULL;