import { randomUUID } from 'node:crypto';
import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const trades = pgTable(
  'Trade',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    type: text('type').notNull(),
    tokenMint: text('tokenMint').notNull(),
    symbol: text('symbol').notNull(),
    name: text('name').notNull().default(''),
    solAmount: doublePrecision('solAmount').notNull(),
    tokenAmount: doublePrecision('tokenAmount').notNull().default(0),
    priceUsd: doublePrecision('priceUsd').notNull().default(0),
    mcapUsd: doublePrecision('mcapUsd').notNull().default(0),
    pnlPercent: doublePrecision('pnlPercent'),
    pnlSol: doublePrecision('pnlSol'),
    txSignature: text('txSignature').notNull(),
    source: text('source').notNull().default('gmgn'),
    reason: text('reason'),
    tweetText: text('tweetText'),
    dex: text('dex').notNull().default('pump.fun'),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('Trade_tokenMint_idx').on(t.tokenMint), index('Trade_createdAt_idx').on(t.createdAt)],
);

export const positions = pgTable('Position', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  tokenMint: text('tokenMint').notNull().unique(),
  symbol: text('symbol').notNull(),
  name: text('name').notNull().default(''),
  entryPrice: doublePrecision('entryPrice').notNull(),
  solSpent: doublePrecision('solSpent').notNull(),
  tokenAmount: doublePrecision('tokenAmount').notNull(),
  txSignature: text('txSignature').notNull(),
  tweetText: text('tweetText'),
  dex: text('dex').notNull().default('pump.fun'),
  openedAt: timestamp('openedAt', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const botEvents = pgTable(
  'BotEvent',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    type: text('type').notNull(),
    message: text('message').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('BotEvent_createdAt_idx').on(t.createdAt), index('BotEvent_type_idx').on(t.type)],
);

export type Trade = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;
export type Position = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;
export type BotEvent = typeof botEvents.$inferSelect;
export type NewBotEvent = typeof botEvents.$inferInsert;
