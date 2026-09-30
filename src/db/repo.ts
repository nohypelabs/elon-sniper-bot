import { and, asc, count, desc, eq, gte, isNotNull, isNull, lte, ne, or } from 'drizzle-orm';
import { ensureDb, type Db } from './client';
import { botEvents, latencyTraces, paperAccount, positions, trades, type NewPaperAccount, type NewPosition, type NewTrade } from './schema';
import type { Trace } from '../metrics/latency';

async function handle(override?: Db): Promise<Db> {
  return override ?? ensureDb();
}

// ─── Trades ─────────────────────────────────────────────────────

export async function insertTrade(data: NewTrade, dbOverride?: Db) {
  const d = await handle(dbOverride);
  const [row] = await d.insert(trades).values(data).returning();
  return row;
}

export async function listTrades(
  opts: { page: number; limit: number },
  dbOverride?: Db,
) {
  const d = await handle(dbOverride);
  return d
    .select()
    .from(trades)
    .orderBy(desc(trades.createdAt))
    .limit(opts.limit)
    .offset((opts.page - 1) * opts.limit);
}

export async function countTrades(dbOverride?: Db): Promise<number> {
  const d = await handle(dbOverride);
  const [row] = await d.select({ n: count() }).from(trades);
  return Number(row?.n ?? 0);
}

/** All SELL rows, newest first (full columns). */
export async function listSells(dbOverride?: Db) {
  const d = await handle(dbOverride);
  return d.select().from(trades).where(eq(trades.type, 'SELL')).orderBy(desc(trades.createdAt));
}

/** SELL summaries for the Telegram /pnl message (no ordering — matches Prisma). */
export async function listSellSummaries(dbOverride?: Db) {
  const d = await handle(dbOverride);
  return d
    .select({ pnlSol: trades.pnlSol, pnlPercent: trades.pnlPercent, createdAt: trades.createdAt })
    .from(trades)
    .where(eq(trades.type, 'SELL'));
}

/** Most recent SELL rows (Telegram /history). */
export async function listRecentSells(limit: number, dbOverride?: Db) {
  const d = await handle(dbOverride);
  return d
    .select()
    .from(trades)
    .where(eq(trades.type, 'SELL'))
    .orderBy(desc(trades.createdAt))
    .limit(limit);
}

/** Latest BUY for a mint at or before a timestamp (Telegram /history pairing). */
export async function findLatestBuyBefore(tokenMint: string, before: Date, dbOverride?: Db) {
  const d = await handle(dbOverride);
  const rows = await d
    .select()
    .from(trades)
    .where(and(eq(trades.type, 'BUY'), eq(trades.tokenMint, tokenMint), lte(trades.createdAt, before)))
    .orderBy(desc(trades.createdAt))
    .limit(1);
  return rows[0];
}

/** BUY rows (mint/time/mcap) oldest-first for /api/trades/paired. */
export async function listBuysForPairing(dbOverride?: Db) {
  const d = await handle(dbOverride);
  return d
    .select({ tokenMint: trades.tokenMint, createdAt: trades.createdAt, mcapUsd: trades.mcapUsd })
    .from(trades)
    .where(eq(trades.type, 'BUY'))
    .orderBy(asc(trades.createdAt));
}

/** BUY rows (id/mint/time) oldest-first for /api/stats position grouping. */
export async function listBuysForStats(dbOverride?: Db) {
  const d = await handle(dbOverride);
  return d
    .select({ id: trades.id, tokenMint: trades.tokenMint, createdAt: trades.createdAt })
    .from(trades)
    .where(eq(trades.type, 'BUY'))
    .orderBy(asc(trades.createdAt));
}

/** All BUY rows oldest-first (loss-analysis script). */
export async function listAllBuys(dbOverride?: Db) {
  const d = await handle(dbOverride);
  return d.select().from(trades).where(eq(trades.type, 'BUY')).orderBy(asc(trades.createdAt));
}

export async function listSellsForPnl(
  opts: { since: Date | null; excludePaper: boolean },
  dbOverride?: Db,
) {
  const d = await handle(dbOverride);
  const conds = [eq(trades.type, 'SELL'), isNotNull(trades.pnlSol)];
  if (opts.since) conds.push(gte(trades.createdAt, opts.since));
  if (opts.excludePaper) conds.push(ne(trades.source, 'paper'));
  return d
    .select({
      createdAt: trades.createdAt,
      pnlSol: trades.pnlSol,
      pnlPercent: trades.pnlPercent,
      symbol: trades.symbol,
    })
    .from(trades)
    .where(and(...conds))
    .orderBy(asc(trades.createdAt));
}

export async function listSellsForStats(
  opts: { since: Date | null; excludePaper: boolean },
  dbOverride?: Db,
) {
  const d = await handle(dbOverride);
  const conds = [eq(trades.type, 'SELL')];
  if (opts.since) conds.push(gte(trades.createdAt, opts.since));
  if (opts.excludePaper) conds.push(ne(trades.source, 'paper'));
  return d
    .select({
      pnlSol: trades.pnlSol,
      pnlPercent: trades.pnlPercent,
      solAmount: trades.solAmount,
      tokenMint: trades.tokenMint,
      createdAt: trades.createdAt,
    })
    .from(trades)
    .where(and(...conds))
    .orderBy(asc(trades.createdAt));
}

/** SELL rows with zero/null pnlSol but non-zero pnlPercent (backfill script). */
export async function listSellsNeedingBackfill(dbOverride?: Db) {
  const d = await handle(dbOverride);
  return d
    .select({ id: trades.id, pnlPercent: trades.pnlPercent, solAmount: trades.solAmount })
    .from(trades)
    .where(
      and(
        eq(trades.type, 'SELL'),
        or(eq(trades.pnlSol, 0), isNull(trades.pnlSol)),
        // ≡ NOT (pnlPercent = 0 OR pnlPercent IS NULL)
        ne(trades.pnlPercent, 0),
        isNotNull(trades.pnlPercent),
      ),
    );
}

export async function updateTradePnl(id: string, pnlSol: number, dbOverride?: Db) {
  const d = await handle(dbOverride);
  await d.update(trades).set({ pnlSol }).where(eq(trades.id, id));
}

// ─── Positions ──────────────────────────────────────────────────

export async function listPositions(dbOverride?: Db) {
  const d = await handle(dbOverride);
  return d.select().from(positions).orderBy(desc(positions.openedAt));
}

export async function upsertPosition(
  create: NewPosition,
  update: Partial<NewPosition>,
  dbOverride?: Db,
) {
  const d = await handle(dbOverride);
  // Single atomic statement: no window between "exists?" and "insert".
  const [row] = await d
    .insert(positions)
    .values(create)
    .onConflictDoUpdate({ target: positions.tokenMint, set: update })
    .returning();
  return row;
}

export async function deletePosition(tokenMint: string, dbOverride?: Db) {
  const d = await handle(dbOverride);
  await d.delete(positions).where(eq(positions.tokenMint, tokenMint));
}

/**
 * Stage 9c: patch live state columns of a persisted Position row
 * (tp1Hit/tp2Hit/moonbag/remainingTokens/solSpent/peakPnlPercent/
 * currentPriceUsd/mcapUsd). Callers on the sell/buy hot path must invoke
 * this fire-and-forget (never await) and swallow errors.
 */
export async function updatePositionState(
  tokenMint: string,
  patch: Partial<NewPosition>,
  dbOverride?: Db,
) {
  const d = await handle(dbOverride);
  const [row] = await d
    .update(positions)
    .set(patch)
    .where(eq(positions.tokenMint, tokenMint))
    .returning();
  return row;
}

// ─── Paper account ────────────────────────────────────────────

/** The singleton 'main' paper account, or undefined when never created. */
export async function getPaperAccount(dbOverride?: Db) {
  const d = await handle(dbOverride);
  const rows = await d.select().from(paperAccount).where(eq(paperAccount.id, 'main')).limit(1);
  return rows[0];
}

/**
 * Insert the 'main' paper account. Idempotent: concurrent/second calls are
 * ignored (onConflictDoNothing), so the stored startSol never changes.
 */
export async function createPaperAccount(data: NewPaperAccount, dbOverride?: Db) {
  const d = await handle(dbOverride);
  const [row] = await d
    .insert(paperAccount)
    .values({ id: 'main', ...data })
    .onConflictDoNothing({ target: paperAccount.id })
    .returning();
  return row;
}

/** Paper-only trade rows (oldest first) for rebuilding the PaperLedger. */
export async function listPaperTradesForLedger(dbOverride?: Db) {
  const d = await handle(dbOverride);
  return d
    .select({
      type: trades.type,
      source: trades.source,
      solAmount: trades.solAmount,
      pnlSol: trades.pnlSol,
    })
    .from(trades)
    .where(eq(trades.source, 'paper'))
    .orderBy(asc(trades.createdAt));
}

// ─── Events ─────────────────────────────────────────────────────

export async function insertEvent(
  type: string,
  message: string,
  metadata?: Record<string, unknown> | null,
  dbOverride?: Db,
) {
  const d = await handle(dbOverride);
  const [row] = await d
    .insert(botEvents)
    .values({ type, message, metadata: metadata ?? null })
    .returning();
  return row;
}

export async function listEvents(limit: number, dbOverride?: Db) {
  const d = await handle(dbOverride);
  return d.select().from(botEvents).orderBy(desc(botEvents.createdAt)).limit(limit);
}

// ─── Latency traces ─────────────────────────────────────────────

export async function insertLatencyTrace(trace: Trace, dbOverride?: Db) {
  const d = await handle(dbOverride);
  const outcome = trace.notes?.outcome;
  const [row] = await d
    .insert(latencyTraces)
    .values({
      kind: trace.kind,
      tokenMint: trace.mint ?? trace.id.split(':')[0] ?? '',
      symbol: trace.symbol ?? '',
      outcome: typeof outcome === 'string' ? outcome : null,
      totalMs: trace.totalMs,
      stages: trace.stages,
      segments: trace.segments,
      notes: trace.notes,
    })
    .returning();
  return row;
}

export async function listLatencyTraces(
  opts: { limit: number; kind?: 'BUY' | 'SELL' },
  dbOverride?: Db,
) {
  const d = await handle(dbOverride);
  const base = d.select().from(latencyTraces);
  if (opts.kind) {
    return base
      .where(eq(latencyTraces.kind, opts.kind))
      .orderBy(desc(latencyTraces.createdAt))
      .limit(opts.limit);
  }
  return base.orderBy(desc(latencyTraces.createdAt)).limit(opts.limit);
}
