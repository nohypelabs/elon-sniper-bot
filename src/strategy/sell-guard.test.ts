import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffMs,
  canAttemptSell,
  isPlaceholder,
  recordSellFailure,
  recordSellSuccess,
  shouldAlertSellFailure,
  type SellGuardState,
} from './sell-guard';

function pos(over: Partial<SellGuardState> = {}): SellGuardState {
  return { sellFailures: 0, nextSellAttemptAt: 0, ...over };
}

describe('sell-guard: backoffMs', () => {
  it('backoff table: 0, 5s, 10s, 20s, 40s, then capped at 60s', () => {
    assert.equal(backoffMs(0), 0);
    assert.equal(backoffMs(1), 5_000);
    assert.equal(backoffMs(2), 10_000);
    assert.equal(backoffMs(3), 20_000);
    assert.equal(backoffMs(4), 40_000);
    assert.equal(backoffMs(5), 60_000); // 80s capped
    assert.equal(backoffMs(6), 60_000);
    assert.equal(backoffMs(100), 60_000);
  });
  it('non-positive / non-finite input yields 0', () => {
    assert.equal(backoffMs(-1), 0);
    assert.equal(backoffMs(Number.NaN), 0);
    assert.equal(backoffMs(Number.POSITIVE_INFINITY), 0);
  });
});

describe('sell-guard: canAttemptSell boundaries', () => {
  it('attempt allowed when gate is 0', () => {
    assert.equal(canAttemptSell(pos(), 0), true);
    assert.equal(canAttemptSell(pos(), Date.now()), true);
  });
  it('blocked strictly before the gate, allowed exactly at the gate', () => {
    const p = pos({ sellFailures: 1, nextSellAttemptAt: 1_000 });
    assert.equal(canAttemptSell(p, 999), false);
    assert.equal(canAttemptSell(p, 1_000), true);
    assert.equal(canAttemptSell(p, 1_001), true);
  });
});

describe('sell-guard: failure/success transitions', () => {
  it('recordSellFailure increments and arms the gate from now', () => {
    const p = pos();
    recordSellFailure(p, 10_000);
    assert.equal(p.sellFailures, 1);
    assert.equal(p.nextSellAttemptAt, 10_000 + 5_000);
    recordSellFailure(p, 16_000);
    assert.equal(p.sellFailures, 2);
    assert.equal(p.nextSellAttemptAt, 16_000 + 10_000);
    assert.equal(canAttemptSell(p, 25_999), false);
    assert.equal(canAttemptSell(p, 26_000), true);
  });
  it('recordSellSuccess resets both fields', () => {
    const p = pos({ sellFailures: 3, nextSellAttemptAt: 99_000 });
    recordSellSuccess(p);
    assert.equal(p.sellFailures, 0);
    assert.equal(p.nextSellAttemptAt, 0);
    assert.equal(canAttemptSell(p, 0), true);
  });
  it('success after failures clears the backoff so the next sell is immediate', () => {
    const p = pos();
    recordSellFailure(p, 0);
    recordSellFailure(p, 5_000);
    assert.equal(p.sellFailures, 2);
    recordSellSuccess(p);
    assert.deepEqual({ sellFailures: p.sellFailures, nextSellAttemptAt: p.nextSellAttemptAt }, { sellFailures: 0, nextSellAttemptAt: 0 });
  });
});

describe('sell-guard: alert schedule', () => {
  it('alerts exactly on 3, 10, 20, 30 — never elsewhere below 35', () => {
    const expected = new Set([3, 10, 20, 30]);
    for (let f = 0; f <= 35; f++) {
      assert.equal(
        shouldAlertSellFailure(pos({ sellFailures: f })),
        expected.has(f),
        `failures=${f}`,
      );
    }
  });
  it('alert fires once per threshold (no repeat between thresholds)', () => {
    const p = pos();
    const fired: number[] = [];
    for (let i = 1; i <= 25; i++) {
      recordSellFailure(p, i * 1_000);
      if (shouldAlertSellFailure(p)) fired.push(p.sellFailures);
    }
    assert.deepEqual(fired, [3, 10, 20]);
  });
});

describe('sell-guard: isPlaceholder', () => {
  it('null token or buyResult is a placeholder', () => {
    assert.equal(isPlaceholder({ token: null, buyResult: null }), true);
    assert.equal(isPlaceholder({ token: { x: 1 }, buyResult: null }), true);
    assert.equal(isPlaceholder({ token: null, buyResult: { y: 2 } }), true);
    assert.equal(isPlaceholder({ token: undefined, buyResult: undefined }), true);
  });
  it('real position (both set) is not a placeholder', () => {
    assert.equal(isPlaceholder({ token: { x: 1 }, buyResult: { y: 2 } }), false);
  });
});
