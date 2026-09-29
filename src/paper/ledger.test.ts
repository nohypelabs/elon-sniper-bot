import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PaperLedger, equity } from './ledger';

describe('PaperLedger: debit/credit/canAfford edges', () => {
  it('starts with cash == start when cashSol is omitted', () => {
    const l = new PaperLedger(10);
    assert.equal(l.startSol, 10);
    assert.equal(l.cashSol, 10);
  });

  it('accepts an explicit cashSol', () => {
    const l = new PaperLedger(10, 4);
    assert.equal(l.cashSol, 4);
  });

  it('canAfford: exact yes, over no, zero/negative/non-finite no', () => {
    const l = new PaperLedger(10);
    assert.equal(l.canAfford(10), true);
    assert.equal(l.canAfford(9.999), true);
    assert.equal(l.canAfford(10.0001), false);
    assert.equal(l.canAfford(0), false);
    assert.equal(l.canAfford(-1), false);
    assert.equal(l.canAfford(Number.NaN), false);
    assert.equal(l.canAfford(Number.POSITIVE_INFINITY), false);
  });

  it('debit reduces cash and returns true', () => {
    const l = new PaperLedger(10);
    assert.equal(l.debit(3), true);
    assert.equal(l.cashSol, 7);
  });

  it('debit of the full balance leaves exactly 0 (never negative)', () => {
    const l = new PaperLedger(10);
    assert.equal(l.debit(10), true);
    assert.equal(l.cashSol, 0);
    assert.ok(l.cashSol >= 0);
  });

  it('debit returns false with no change when not affordable', () => {
    const l = new PaperLedger(10);
    assert.equal(l.debit(10.5), false);
    assert.equal(l.cashSol, 10);
  });

  it('debit returns false with no change for sol <= 0 or non-finite', () => {
    const l = new PaperLedger(10);
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(l.debit(bad), false);
    }
    assert.equal(l.cashSol, 10);
  });

  it('credit adds; ignores non-finite or negative', () => {
    const l = new PaperLedger(10, 5);
    l.credit(2.5);
    assert.equal(l.cashSol, 7.5);
    l.credit(0);
    assert.equal(l.cashSol, 7.5);
    l.credit(-1);
    l.credit(Number.NaN);
    l.credit(Number.POSITIVE_INFINITY);
    assert.equal(l.cashSol, 7.5);
  });

  it('never NaN with garbage constructor inputs', () => {
    const l = new PaperLedger(Number.NaN, Number.NaN);
    assert.equal(l.startSol, 0);
    assert.equal(l.cashSol, 0);
    assert.equal(l.canAfford(1), false);
    assert.equal(l.debit(1), false);
    l.credit(Number.NaN);
    assert.equal(l.cashSol, 0);
    const e = l.equity([], Number.NaN);
    for (const v of Object.values(e)) assert.equal(v, 0);
  });
});

describe('PaperLedger.fromTrades', () => {
  it('empty list keeps the starting cash', () => {
    assert.equal(PaperLedger.fromTrades(10, []).cashSol, 10);
  });

  it('subtracts paper BUYs', () => {
    const l = PaperLedger.fromTrades(10, [
      { type: 'BUY', source: 'paper', solAmount: 0.5, pnlSol: null },
    ]);
    assert.equal(l.cashSol, 9.5);
  });

  it('full SELL credits cost basis + profit', () => {
    const l = PaperLedger.fromTrades(10, [
      { type: 'BUY', source: 'paper', solAmount: 0.5, pnlSol: null },
      { type: 'SELL', source: 'paper', solAmount: 0.5, pnlSol: 0.15 },
    ]);
    assert.ok(Math.abs(l.cashSol - 10.15) < 1e-9);
  });

  it('partial SELLs (TP1 then close), including a losing trade', () => {
    const l = PaperLedger.fromTrades(10, [
      { type: 'BUY', source: 'paper', solAmount: 1.0, pnlSol: null },
      { type: 'SELL', source: 'paper', solAmount: 0.8, pnlSol: 0.24 },
      { type: 'SELL', source: 'paper', solAmount: 0.2, pnlSol: -0.05 },
      { type: 'BUY', source: 'paper', solAmount: 0.5, pnlSol: null },
      { type: 'SELL', source: 'paper', solAmount: 0.5, pnlSol: -0.2 },
    ]);
    // 10 - 1 + (0.8+0.24) + (0.2-0.05) - 0.5 + (0.5-0.2) = 9.99
    assert.ok(Math.abs(l.cashSol - 9.99) < 1e-9);
  });

  it('ignores non-paper rows and null pnl', () => {
    const l = PaperLedger.fromTrades(10, [
      { type: 'BUY', source: 'gmgn', solAmount: 5, pnlSol: null },
      { type: 'SELL', source: 'jupiter', solAmount: 5, pnlSol: 99 },
      { type: 'SELL', source: 'paper', solAmount: 1, pnlSol: null },
      { type: 'HOLD', source: 'paper', solAmount: 7, pnlSol: 7 },
    ]);
    // paper SELL with null pnl credits its cost basis only
    assert.equal(l.cashSol, 11);
  });
});

describe('equity', () => {
  it('computes cash/open/equity/pnl vs start', () => {
    const e = equity(
      5,
      [
        { solSpent: 1, pnlPercent: 50 },
        { solSpent: 2, pnlPercent: -25 },
      ],
      100,
      10,
    );
    assert.equal(e.cashUsd, 500);
    assert.equal(e.openValueUsd, 300); // (1*1.5 + 2*0.75) * 100
    assert.equal(e.equityUsd, 800);
    assert.equal(e.startUsd, 1000);
    assert.equal(e.pnlUsd, -200);
    assert.equal(e.pnlPct, -20);
  });

  it('empty opens: equity == cash, pnl vs start', () => {
    const e = equity(8, [], 100, 10);
    assert.deepEqual(e, {
      startUsd: 1000, cashUsd: 800, openValueUsd: 0,
      equityUsd: 800, pnlUsd: -200, pnlPct: -20,
    });
  });

  it('zero start gives pnlPct 0 without NaN', () => {
    const e = equity(5, [{ solSpent: 1, pnlPercent: 10 }], 100, 0);
    assert.equal(e.pnlPct, 0);
    assert.ok(Number.isFinite(e.pnlUsd));
  });

  it('PaperLedger.equity uses its own cash and start', () => {
    const l = PaperLedger.fromTrades(10, [
      { type: 'BUY', source: 'paper', solAmount: 2, pnlSol: null },
    ]);
    const e = l.equity([{ solSpent: 2, pnlPercent: 25 }], 100);
    assert.equal(e.cashUsd, 800);
    assert.equal(e.openValueUsd, 250);
    assert.equal(e.equityUsd, 1050);
    assert.equal(e.startUsd, 1000);
    assert.equal(e.pnlUsd, 50);
    assert.equal(e.pnlPct, 5);
  });
});

describe('PaperLedger: 10-trade sequence', () => {
  it('ends at the exact expected cash', () => {
    const rows: { type: string; source: string; solAmount: number; pnlSol: number | null }[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push({ type: 'BUY', source: 'paper', solAmount: 0.5, pnlSol: null });
      rows.push({ type: 'SELL', source: 'paper', solAmount: 0.5, pnlSol: 0.25 });
    }
    const l = PaperLedger.fromTrades(10, rows);
    // 10 - 10*0.5 + 10*(0.5+0.25) = 12.5 (all binary-exact)
    assert.equal(l.cashSol, 12.5);
    assert.ok(l.cashSol >= 0);
  });
});
