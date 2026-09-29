import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  closeDb,
  createDb,
  getDb,
  initDb,
  logEvent,
  type Db,
} from './client';
import type { NewTrade } from './schema';
import {
  countTrades,
  deletePosition,
  findLatestBuyBefore,
  insertEvent,
  insertTrade,
  listEvents,
  listPositions,
  listRecentSells,
  listSells,
  listSellsNeedingBackfill,
  listTrades,
  updateTradePnl,
  upsertPosition,
} from './repo';

const MIGRATIONS = path.join(process.cwd(), 'drizzle');

let db: Db;

before(async () => {
  db = await createDb(); // in-memory, no files
});

after(async () => {
  await (db.$client as unknown as { close(): Promise<void> }).close();
  await closeDb().catch(() => {});
});

function trade(over: Partial<NewTrade> = {}): NewTrade {
  return {
    type: 'BUY',
    tokenMint: `mint-${Math.random().toString(36).slice(2)}`,
    symbol: 'TEST',
    solAmount: 0.5,
    txSignature: `sig-${Math.random().toString(36).slice(2)}`,
    ...over,
  };
}

describe('db: migrations', () => {
  it('applies cleanly on an empty DB', async () => {
    const fresh = await createDb();
    assert.equal(await countTrades(fresh), 0);
    await (fresh.$client as unknown as { close(): Promise<void> }).close();
  });

  it('is idempotent when run twice on the same instance', async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    assert.equal(await countTrades(db), 0);
  });
});

describe('db: trades ordering + pagination', () => {
  it('lists newest first (createdAt desc) with page/limit', async () => {
    const base = Date.UTC(2026, 0, 1);
    const mints: string[] = [];
    for (let i = 0; i < 3; i++) {
      const row = await insertTrade(
        trade({ createdAt: new Date(base + i * 1000), symbol: `T${i}` }),
        db,
      );
      mints.push(row.tokenMint);
    }
    const page1 = await listTrades({ page: 1, limit: 2 }, db);
    assert.equal(page1.length, 2);
    assert.equal(page1[0].symbol, 'T2');
    assert.equal(page1[1].symbol, 'T1');
    const page2 = await listTrades({ page: 2, limit: 2 }, db);
    assert.equal(page2.length, 1);
    assert.equal(page2[0].symbol, 'T0');
    assert.ok(mints.length === 3);
  });
});

describe('db: positions', () => {
  it('upsert twice on same tokenMint keeps one row and updates fields', async () => {
    const mint = `pos-${Date.now()}`;
    await upsertPosition(
      {
        tokenMint: mint, symbol: 'P', entryPrice: 1, solSpent: 0.5,
        tokenAmount: 100, txSignature: 'sig1',
      },
      { entryPrice: 1, solSpent: 0.5, tokenAmount: 100, txSignature: 'sig1' },
      db,
    );
    await upsertPosition(
      {
        tokenMint: mint, symbol: 'P', entryPrice: 2, solSpent: 1,
        tokenAmount: 200, txSignature: 'sig2',
      },
      { entryPrice: 2, solSpent: 1, tokenAmount: 200, txSignature: 'sig2' },
      db,
    );
    const rows = (await listPositions(db)).filter((p) => p.tokenMint === mint);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entryPrice, 2);
    assert.equal(rows[0].txSignature, 'sig2');
    await deletePosition(mint, db);
    assert.equal((await listPositions(db)).filter((p) => p.tokenMint === mint).length, 0);
  });
});

describe('db: jsonb + floats + nullables', () => {
  it('metadata round-trips nested objects and null', async () => {
    const nested = { a: { b: [1, 2, { c: 'x' }] }, n: 42, flag: true };
    const withMeta = await insertEvent('T', 'nested', nested, db);
    assert.deepEqual(withMeta.metadata, nested);
    const withNull = await insertEvent('T', 'null-meta', null, db);
    assert.equal(withNull.metadata, null);
    const listed = await listEvents(5, db);
    assert.ok(listed.some((e) => e.id === withMeta.id));
  });

  it('float fields keep precision', async () => {
    const row = await insertTrade(
      trade({ priceUsd: 0.123456789, mcapUsd: 1234567.8912345, solAmount: 1 / 3 }),
      db,
    );
    assert.strictEqual(row.priceUsd, 0.123456789);
    assert.strictEqual(row.mcapUsd, 1234567.8912345);
    assert.strictEqual(row.solAmount, 1 / 3);
  });

  it('pnl fields are nullable and defaulted columns keep Prisma defaults', async () => {
    const row = await insertTrade(trade(), db);
    assert.equal(row.pnlPercent, null);
    assert.equal(row.pnlSol, null);
    assert.equal(row.name, '');
    assert.equal(row.tokenAmount, 0);
    assert.equal(row.priceUsd, 0);
    assert.equal(row.mcapUsd, 0);
    assert.equal(row.source, 'gmgn');
    assert.equal(row.dex, 'pump.fun');
    assert.ok(row.createdAt instanceof Date);
  });
});

describe('db: counts + backfill helpers', () => {
  it('countTrades counts all rows', async () => {
    const before = await countTrades(db);
    await insertTrade(trade(), db);
    await insertTrade(trade(), db);
    assert.equal(await countTrades(db), before + 2);
  });

  it('lists sells needing backfill and updates pnl', async () => {
    const sell = await insertTrade(
      trade({ type: 'SELL', pnlPercent: 25, pnlSol: 0 }),
      db,
    );
    const needs = await listSellsNeedingBackfill(db);
    assert.ok(needs.some((t) => t.id === sell.id));
    await updateTradePnl(sell.id, 0.125, db);
    const after = await listSellsNeedingBackfill(db);
    assert.ok(!after.some((t) => t.id === sell.id));
    const recent = await listRecentSells(50, db);
    assert.equal(recent.find((t) => t.id === sell.id)?.pnlSol, 0.125);
    assert.ok((await listSells(db)).length >= 1);
  });

  it('findLatestBuyBefore pairs a sell with the prior buy', async () => {
    const mint = `pair-${Date.now()}`;
    const buy = await insertTrade(
      trade({ tokenMint: mint, createdAt: new Date(Date.UTC(2026, 5, 1, 12, 0, 0)) }),
      db,
    );
    const found = await findLatestBuyBefore(mint, new Date(Date.UTC(2026, 5, 1, 13, 0, 0)), db);
    assert.equal(found?.id, buy.id);
    const miss = await findLatestBuyBefore(mint, new Date(Date.UTC(2026, 5, 1, 11, 0, 0)), db);
    assert.equal(miss, undefined);
  });
});

describe('db: logEvent resilience', () => {
  it('swallows errors when the db is closed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sniper-logevt-'));
    try {
      await initDb(path.join(dir, 'sniper.pglite'));
      await logEvent('START', 'hello', { a: 1 }); // works while open
      await (getDb().$client as unknown as { close(): Promise<void> }).close();
      await assert.doesNotReject(logEvent('START', 'after close'));
      await assert.doesNotReject(logEvent('ERROR', 'after close', { x: [1] }));
    } finally {
      await closeDb().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('db: file persistence', () => {
  it('write → close → reopen same dir reads the row back', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sniper-persist-'));
    try {
      const first = await createDb(path.join(dir, 'sniper.pglite'));
      const inserted = await insertTrade(trade({ symbol: 'PERSIST' }), first);
      await (first.$client as unknown as { close(): Promise<void> }).close();

      const second = await createDb(path.join(dir, 'sniper.pglite'));
      try {
        assert.equal(await countTrades(second), 1);
        const rows = await listTrades({ page: 1, limit: 10 }, second);
        assert.equal(rows[0].id, inserted.id);
        assert.equal(rows[0].symbol, 'PERSIST');
      } finally {
        await (second.$client as unknown as { close(): Promise<void> }).close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
