import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from './client';
import { insertLatencyTrace, listLatencyTraces } from './repo';
import type { Trace } from '../metrics/latency';

let db: Db;

before(async () => {
  db = await createDb(); // in-memory, migrations applied
});

after(async () => {
  await (db.$client as unknown as { close(): Promise<void> }).close();
});

function trace(over: Partial<Trace> = {}): Trace {
  return {
    id: `mint-${Math.random().toString(36).slice(2)}`,
    kind: 'BUY',
    symbol: 'TEST',
    mint: `mint-${Math.random().toString(36).slice(2)}`,
    startedAtWall: Date.now(),
    stages: { event_received: 0, buy_sent: 12.5 },
    segments: { 'event_received->buy_sent': 12.5 },
    totalMs: 42.25,
    notes: { outcome: 'bought', entrySlipPct: 1.25, paper: 1 },
    ...over,
  };
}

describe('db: latency traces', () => {
  it('inserts and lists newest-first', async () => {
    const first = await insertLatencyTrace(trace({ symbol: 'FIRST' }), db);
    await new Promise((r) => setTimeout(r, 5));
    const second = await insertLatencyTrace(trace({ symbol: 'SECOND' }), db);

    const rows = await listLatencyTraces({ limit: 10 }, db);
    const idxFirst = rows.findIndex((r) => r.id === first.id);
    const idxSecond = rows.findIndex((r) => r.id === second.id);
    assert.ok(idxFirst >= 0 && idxSecond >= 0);
    assert.ok(idxSecond < idxFirst); // newest first
  });

  it('filters by kind and respects limit', async () => {
    await insertLatencyTrace(trace({ kind: 'BUY', symbol: 'KB' }), db);
    await insertLatencyTrace(trace({ kind: 'SELL', symbol: 'KS' }), db);

    const buys = await listLatencyTraces({ limit: 50, kind: 'BUY' }, db);
    assert.ok(buys.length >= 1);
    assert.ok(buys.every((r) => r.kind === 'BUY'));

    const sells = await listLatencyTraces({ limit: 50, kind: 'SELL' }, db);
    assert.ok(sells.length >= 1);
    assert.ok(sells.every((r) => r.kind === 'SELL'));

    const one = await listLatencyTraces({ limit: 1 }, db);
    assert.equal(one.length, 1);
  });

  it('round-trips stages/segments/notes jsonb and outcome/totalMs', async () => {
    const stages = { event_received: 0, filters_passed: 3.75, buy_confirmed: 900.125 };
    const segments = { 'event_received->filters_passed': 3.75, 'filters_passed->buy_confirmed': 896.375 };
    const notes = { outcome: 'bought', exitSlipPct: -0.5, action: 'tp1', paper: 1 };
    const row = await insertLatencyTrace(trace({ stages, segments, notes, totalMs: 901.5 }), db);

    assert.equal(row.outcome, 'bought');
    assert.equal(row.totalMs, 901.5);
    assert.deepEqual(row.stages, stages);
    assert.deepEqual(row.segments, segments);
    assert.deepEqual(row.notes, notes);
    assert.ok(row.createdAt instanceof Date);
  });

  it('derives tokenMint from SELL trace ids (mint:counter)', async () => {
    const row = await insertLatencyTrace(
      trace({ id: 'MINTABC:7', kind: 'SELL', mint: undefined, symbol: 'S' }),
      db,
    );
    assert.equal(row.tokenMint, 'MINTABC');
    assert.equal(row.kind, 'SELL');
  });
});
