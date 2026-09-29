import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  updatePeak,
  evaluateExit,
  ExitConfig,
  ExitState,
} from './exit-rules';

const BASE: ExitConfig = {
  AUTO_SELL: true,
  TP1_PERCENT: 30,
  TP2_PERCENT: 50,
  STOP_LOSS_PERCENT: 25,
  TRAILING_TP_ENABLED: false,
  TRAILING_TP_DROP_PERCENT: 15,
};

const TRAIL: ExitConfig = { ...BASE, TRAILING_TP_ENABLED: true };

function state(over: Partial<ExitState> = {}): ExitState {
  return { tp1Hit: false, tp2Hit: false, isSelling: false, ...over };
}

function run(pnl: number, over: Partial<ExitState> = {}, cfg: ExitConfig = BASE) {
  const s = state(over);
  updatePeak(s, pnl);
  return { s, out: evaluateExit(s, pnl, cfg) };
}

describe('exit-rules: tp1', () => {
  it('none below TP1', () => {
    assert.deepEqual(run(29.9).out, { action: 'none' });
  });
  it('tp1 exactly at boundary', () => {
    assert.deepEqual(run(30).out, { action: 'tp1' });
  });
  it('tp1 above boundary', () => {
    assert.deepEqual(run(45).out, { action: 'tp1' });
  });
  it('no second tp1 after hit (below TP2)', () => {
    assert.deepEqual(run(35, { tp1Hit: true }).out, { action: 'none' });
  });
});

describe('exit-rules: tp2', () => {
  it('tp2 exactly at boundary after TP1 (trailing off)', () => {
    assert.deepEqual(run(50, { tp1Hit: true }).out, { action: 'tp2' });
  });
  it('no tp2 just below boundary', () => {
    assert.deepEqual(run(49.9, { tp1Hit: true }).out, { action: 'none' });
  });
  it('gap jump past TP2 without TP1 hits TP1 first (priority preserved)', () => {
    // Matches src/index.ts: TP1 branch runs before the TP2 fallback on the
    // same tick; TP2 fires on the next tick once tp1Hit is set.
    const first = run(60);
    assert.deepEqual(first.out, { action: 'tp1' });
    first.s.tp1Hit = true; // simulate caller setting tp1Hit after partial sell
    assert.deepEqual(evaluateExit(first.s, 60, BASE), { action: 'tp2' });
  });
  it('fallback branch reachable when TP2 < TP1 (inverted config)', () => {
    const cfg: ExitConfig = { ...BASE, TP1_PERCENT: 80, TP2_PERCENT: 50 };
    assert.deepEqual(run(60, {}, cfg).out, { action: 'tp2' });
  });
  it('no tp2 after tp2Hit', () => {
    assert.deepEqual(run(200, { tp1Hit: true, tp2Hit: true }).out, { action: 'none' });
  });
});

describe('exit-rules: stop loss', () => {
  it('sl exactly at boundary', () => {
    const r = run(-25);
    assert.deepEqual(r.out, { action: 'sl', reason: 'SL -25%' });
  });
  it('none just above boundary', () => {
    assert.deepEqual(run(-24.9).out, { action: 'none' });
  });
  it('respects STOP_LOSS_PERCENT below cap', () => {
    const cfg: ExitConfig = { ...BASE, STOP_LOSS_PERCENT: 18 };
    assert.deepEqual(run(-18, {}, cfg).out, { action: 'sl', reason: 'SL -18%' });
    assert.deepEqual(run(-17.9, {}, cfg).out, { action: 'none' });
  });
  it('caps STOP_LOSS_PERCENT at 25', () => {
    const cfg: ExitConfig = { ...BASE, STOP_LOSS_PERCENT: 40 };
    assert.deepEqual(run(-25, {}, cfg).out, { action: 'sl', reason: 'SL -25%' });
    assert.deepEqual(run(-24, {}, cfg).out, { action: 'none' });
  });
  it('SL never fires after TP1 (deep red becomes trailing-sl)', () => {
    const r = run(-50, { tp1Hit: true });
    assert.deepEqual(r.out, { action: 'trailing-sl', reason: 'trailing-SL after TP1' });
  });
  it('SL never fires after TP2 either', () => {
    assert.deepEqual(run(-50, { tp1Hit: true, tp2Hit: true }).out, { action: 'none' });
  });
});

describe('exit-rules: gates', () => {
  it('isSelling returns none even at TP1', () => {
    assert.deepEqual(run(100, { isSelling: true }).out, { action: 'none' });
  });
  it('AUTO_SELL false returns none everywhere', () => {
    const cfg: ExitConfig = { ...BASE, AUTO_SELL: false };
    assert.deepEqual(run(100, {}, cfg).out, { action: 'none' });
    assert.deepEqual(run(-100, {}, cfg).out, { action: 'none' });
    assert.deepEqual(run(0, { tp1Hit: true }, cfg).out, { action: 'none' });
  });
  it('peak still updates when AUTO_SELL is false (caller calls updatePeak first)', () => {
    const s = state();
    updatePeak(s, 42);
    assert.equal(s.peakPnlPercent, 42);
    assert.deepEqual(evaluateExit(s, 42, { ...BASE, AUTO_SELL: false }), { action: 'none' });
  });
});

describe('exit-rules: trailing', () => {
  it('trailing off: TP2 still fires after TP1', () => {
    assert.deepEqual(run(60, { tp1Hit: true, peakPnlPercent: 60 }).out, { action: 'tp2' });
  });
  it('trailing on: TP2 suppressed, position rides', () => {
    assert.deepEqual(run(60, { tp1Hit: true, peakPnlPercent: 60 }, TRAIL).out, { action: 'none' });
  });
  it('trailing on vs off parity below TP2 drop threshold', () => {
    // peak 60, drop 15 → threshold 45; pnl 40 triggers trailing-tp when on,
    // nothing when off.
    assert.deepEqual(run(40, { tp1Hit: true, peakPnlPercent: 60 }, TRAIL).out, {
      action: 'trailing-tp',
      reason: 'trailing-TP (peak +60%)',
    });
    assert.deepEqual(run(40, { tp1Hit: true, peakPnlPercent: 60 }).out, { action: 'none' });
  });
  it('trailing-tp exactly at threshold', () => {
    const r = run(45, { tp1Hit: true, peakPnlPercent: 60 }, TRAIL);
    assert.deepEqual(r.out, { action: 'trailing-tp', reason: 'trailing-TP (peak +60%)' });
  });
  it('no trailing-tp just above threshold', () => {
    assert.deepEqual(run(45.1, { tp1Hit: true, peakPnlPercent: 60 }, TRAIL).out, {
      action: 'none',
    });
  });
  it('trailing-sl at breakeven', () => {
    assert.deepEqual(run(0, { tp1Hit: true, peakPnlPercent: 60 }, TRAIL).out, {
      action: 'trailing-sl',
      reason: 'trailing-SL after TP1',
    });
    assert.deepEqual(run(0, { tp1Hit: true, peakPnlPercent: 60 }).out, {
      action: 'trailing-sl',
      reason: 'trailing-SL after TP1',
    });
  });
  it('deep red after TP1 is trailing-sl even when trailing-tp threshold also met', () => {
    assert.deepEqual(run(-10, { tp1Hit: true, peakPnlPercent: 100 }, TRAIL).out, {
      action: 'trailing-sl',
      reason: 'trailing-SL after TP1',
    });
  });
  it('trailing-tp floor at breakeven: tiny peak never exits above zero', () => {
    // peak 10, drop 15 → max(0, -5) = 0; pnl 0.5 > 0 so no trailing-tp.
    assert.deepEqual(run(0.5, { tp1Hit: true, peakPnlPercent: 10 }, TRAIL).out, {
      action: 'none',
    });
    assert.deepEqual(run(0, { tp1Hit: true, peakPnlPercent: 10 }, TRAIL).out, {
      action: 'trailing-sl',
      reason: 'trailing-SL after TP1',
    });
  });
  it('no trailing before TP1', () => {
    // Falling back toward breakeven pre-TP1 is not an exit (unless SL).
    assert.deepEqual(run(5, { peakPnlPercent: 20 }, TRAIL).out, { action: 'none' });
  });
});

describe('exit-rules: peak', () => {
  it('peak is monotonic non-decreasing', () => {
    const s = state();
    updatePeak(s, 10);
    assert.equal(s.peakPnlPercent, 10);
    updatePeak(s, 5);
    assert.equal(s.peakPnlPercent, 10);
    updatePeak(s, 20);
    assert.equal(s.peakPnlPercent, 20);
    updatePeak(s, 20);
    assert.equal(s.peakPnlPercent, 20);
  });
  it('first observation seeds peak (even negative)', () => {
    const s = state();
    updatePeak(s, -5);
    assert.equal(s.peakPnlPercent, -5);
    updatePeak(s, -2);
    assert.equal(s.peakPnlPercent, -2);
  });
  it('peak recorded before TP1 then TP1 hit (realtime order)', () => {
    const s = state();
    updatePeak(s, 20);
    assert.deepEqual(evaluateExit(s, 20, BASE), { action: 'none' });
    updatePeak(s, 35);
    assert.equal(s.peakPnlPercent, 35);
    assert.deepEqual(evaluateExit(s, 35, BASE), { action: 'tp1' });
  });
});
