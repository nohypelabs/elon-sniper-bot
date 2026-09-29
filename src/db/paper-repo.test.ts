import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './client';
import {
  createPaperAccount,
  getPaperAccount,
  insertTrade,
  listPaperTradesForLedger,
} from './repo';

function trade(over: Record<string, unknown>) {
  return {
    type: 'BUY',
    tokenMint: 'mint',
    symbol: 'SYM',
    name: 'Name',
    solAmount: 0.5,
    tokenAmount: 100,
    priceUsd: 0.001,
    mcapUsd: 1000,
    txSignature: `sig-${Math.random()}`,
    source: 'paper',
    dex: 'pump.fun',
    ...over,
  } as Parameters<typeof insertTrade>[0];
}

describe('paper account repo', () => {
  it('getPaperAccount is undefined before creation', async () => {
    const db = await createDb();
    assert.equal(await getPaperAccount(db), undefined);
  });

  it('create is idempotent: second insert keeps the original startSol', async () => {
    const db = await createDb();
    await createPaperAccount({ startUsd: 100, startSol: 0.5, solPriceAtStart: 200 }, db);
    const first = await getPaperAccount(db);
    assert.equal(first?.id, 'main');
    assert.equal(first?.startUsd, 100);
    assert.equal(first?.startSol, 0.5);
    assert.equal(first?.solPriceAtStart, 200);
    assert.ok(first?.createdAt instanceof Date);

    await createPaperAccount({ startUsd: 999, startSol: 9, solPriceAtStart: 111 }, db);
    const second = await getPaperAccount(db);
    assert.equal(second?.startUsd, 100);
    assert.equal(second?.startSol, 0.5);
    assert.equal(second?.solPriceAtStart, 200);
  });

  it('listPaperTradesForLedger returns only paper rows with ledger columns', async () => {
    const db = await createDb();
    await insertTrade(trade({ type: 'BUY', source: 'paper', solAmount: 0.5, txSignature: 'p-buy' }), db);
    await insertTrade(
      trade({ type: 'SELL', source: 'paper', solAmount: 0.4, pnlSol: 0.12, pnlPercent: 30, txSignature: 'p-sell' }),
      db,
    );
    await insertTrade(trade({ type: 'SELL', source: 'gmgn', solAmount: 9, pnlSol: 9, txSignature: 'g-sell' }), db);
    await insertTrade(trade({ type: 'BUY', source: 'jupiter', solAmount: 9, txSignature: 'j-buy' }), db);

    const rows = await listPaperTradesForLedger(db);
    assert.equal(rows.length, 2);
    assert.deepEqual(Object.keys(rows[0]!).sort(), ['pnlSol', 'solAmount', 'source', 'type']);
    for (const r of rows) assert.equal(r.source, 'paper');
    const buy = rows.find((r) => r.type === 'BUY')!;
    assert.equal(buy.solAmount, 0.5);
    assert.equal(buy.pnlSol, null);
    const sell = rows.find((r) => r.type === 'SELL')!;
    assert.equal(sell.solAmount, 0.4);
    assert.equal(sell.pnlSol, 0.12);
  });
});
