import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  paperEntryPrice,
  paperExitPrice,
  clampSlippagePct,
  clampSellDelayMs,
} from './fill-model';

describe('fill-model: entry pays more', () => {
  it('adds slippage on top', () => {
    assert.equal(paperEntryPrice(100, 3), 103);
  });

  it('zero slippage is identity', () => {
    assert.equal(paperEntryPrice(100, 0), 100);
  });
});

describe('fill-model: exit gets less', () => {
  it('subtracts slippage', () => {
    assert.equal(paperExitPrice(100, 3), 97);
  });

  it('zero slippage is identity', () => {
    assert.equal(paperExitPrice(100, 0), 100);
  });
});

describe('fill-model: slippage clamping', () => {
  it('clamps to [0, 50]', () => {
    assert.equal(clampSlippagePct(100), 50);
    assert.equal(clampSlippagePct(-5), 0);
    assert.equal(clampSlippagePct(0), 0);
    assert.equal(clampSlippagePct(50), 50);
    assert.equal(paperEntryPrice(100, 100), 150);
    assert.equal(paperExitPrice(100, 100), 50);
  });

  it('non-finite slippage means no adjustment', () => {
    assert.equal(clampSlippagePct(NaN), 0);
    assert.equal(clampSlippagePct(Infinity), 0);
    assert.equal(paperEntryPrice(100, NaN), 100);
    assert.equal(paperExitPrice(100, NaN), 100);
  });
});

describe('fill-model: bad price passthrough', () => {
  it('NaN/0/negative/non-finite prices return unchanged', () => {
    assert.ok(Number.isNaN(paperEntryPrice(NaN, 3)));
    assert.ok(Number.isNaN(paperExitPrice(NaN, 3)));
    assert.equal(paperEntryPrice(0, 3), 0);
    assert.equal(paperExitPrice(0, 3), 0);
    assert.equal(paperEntryPrice(-5, 3), -5);
    assert.equal(paperExitPrice(-5, 3), -5);
    assert.equal(paperEntryPrice(Infinity, 3), Infinity);
    assert.equal(paperExitPrice(Infinity, 3), Infinity);
  });
});

describe('fill-model: round trip loses about 2*slip', () => {
  it('buy then sell at the same market price', () => {
    const slip = 3;
    const market = 100;
    // $100 buys tokens at the adverse entry, sells them at the adverse exit.
    const entry = paperEntryPrice(market, slip);
    const exit = paperExitPrice(market, slip);
    const proceeds = 100 * (exit / entry);
    const lossPct = 100 - proceeds;
    // Exact: 100*(0.97/1.03) = 94.1748 → 5.825% ≈ 2*slip.
    assert.ok(Math.abs(lossPct - 2 * slip) < 0.5, `loss ${lossPct}% not ≈ ${2 * slip}%`);
  });
});

describe('fill-model: sell delay clamp', () => {
  it('clamps to [0, 10000]', () => {
    assert.equal(clampSellDelayMs(1500), 1500);
    assert.equal(clampSellDelayMs(0), 0);
    assert.equal(clampSellDelayMs(-1), 0);
    assert.equal(clampSellDelayMs(NaN), 0);
    assert.equal(clampSellDelayMs(Infinity), 0);
    assert.equal(clampSellDelayMs(99999), 10000);
    assert.equal(clampSellDelayMs(1500.7), 1500);
  });
});
