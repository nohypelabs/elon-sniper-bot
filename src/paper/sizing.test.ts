import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBuySol } from './sizing';

describe('computeBuySol: usd mode', () => {
  it('converts USD to SOL at the given price', () => {
    const r = computeBuySol({ buyAmountUsd: 10, buyAmountSol: 0.5, solPriceUsd: 100, minSnipeUsd: 10 });
    assert.deepEqual(r, { ok: true, sol: 0.1, usd: 10 });
  });

  it('prefers USD over SOL when both are set', () => {
    const r = computeBuySol({ buyAmountUsd: 20, buyAmountSol: 0.5, solPriceUsd: 100, minSnipeUsd: 10 });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.sol, 0.2);
      assert.equal(r.usd, 20);
    }
  });

  it('accepts a trade exactly at the minimum', () => {
    const r = computeBuySol({ buyAmountUsd: 10, buyAmountSol: 0.5, solPriceUsd: 200, minSnipeUsd: 10 });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.sol, 0.05);
      assert.equal(r.usd, 10);
    }
  });

  it('rounds SOL to 6 decimals', () => {
    const r = computeBuySol({ buyAmountUsd: 10, buyAmountSol: 0.5, solPriceUsd: 3, minSnipeUsd: 1, });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.sol, 3.333333);
  });
});

describe('computeBuySol: sol mode', () => {
  it('uses BUY_AMOUNT_SOL when BUY_AMOUNT_USD is 0', () => {
    const r = computeBuySol({ buyAmountUsd: 0, buyAmountSol: 0.5, solPriceUsd: 200, minSnipeUsd: 10 });
    assert.deepEqual(r, { ok: true, sol: 0.5, usd: 100 });
  });

  it('treats negative buyAmountUsd as sol mode', () => {
    const r = computeBuySol({ buyAmountUsd: -5, buyAmountSol: 0.5, solPriceUsd: 200, minSnipeUsd: 10 });
    assert.deepEqual(r, { ok: true, sol: 0.5, usd: 100 });
  });

  it('accepts sol mode exactly at the minimum', () => {
    const r = computeBuySol({ buyAmountUsd: 0, buyAmountSol: 0.05, solPriceUsd: 200, minSnipeUsd: 10 });
    assert.equal(r.ok, true);
  });
});

describe('computeBuySol: failures (never throws)', () => {
  for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    it(`sol_price_unavailable for price=${String(price)}`, () => {
      const r = computeBuySol({ buyAmountUsd: 10, buyAmountSol: 0.5, solPriceUsd: price, minSnipeUsd: 10 });
      assert.deepEqual(r, { ok: false, reason: 'sol_price_unavailable' });
    });
  }

  it('below_min_snipe in usd mode', () => {
    const r = computeBuySol({ buyAmountUsd: 5, buyAmountSol: 0.5, solPriceUsd: 100, minSnipeUsd: 10 });
    assert.deepEqual(r, { ok: false, reason: 'below_min_snipe' });
  });

  it('below_min_snipe in sol mode', () => {
    const r = computeBuySol({ buyAmountUsd: 0, buyAmountSol: 0.01, solPriceUsd: 100, minSnipeUsd: 10 });
    assert.deepEqual(r, { ok: false, reason: 'below_min_snipe' });
  });

  it('fails for zero/negative/NaN sol size', () => {
    for (const sol of [0, -0.5, Number.NaN]) {
      const r = computeBuySol({ buyAmountUsd: 0, buyAmountSol: sol, solPriceUsd: 100, minSnipeUsd: 10 });
      assert.equal(r.ok, false);
    }
  });

  it('fails for non-finite usd amount', () => {
    const r = computeBuySol({ buyAmountUsd: Number.POSITIVE_INFINITY, buyAmountSol: 0.5, solPriceUsd: 100, minSnipeUsd: 10 });
    assert.equal(r.ok, false);
  });
});
