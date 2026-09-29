CREATE TABLE "PaperAccount" (
	"id" text PRIMARY KEY NOT NULL,
	"startUsd" double precision NOT NULL,
	"startSol" double precision NOT NULL,
	"solPriceAtStart" double precision NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
