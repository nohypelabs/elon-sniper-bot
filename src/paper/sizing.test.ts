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

  it('rounds SOL UP to 6 decimals in USD mode so the spend is never below the requested USD', () => {
    // 10 / 3 = 3.3333333...: plain rounding gave 3.333333 (= 9.999999 USD), which is the bug that made
    // ~50% of 10 USD buys fail the 10 USD minimum. Rounding up gives 3.333334 (= 10.000002 USD).
    const r = computeBuySol({ buyAmountUsd: 10, buyAmountSol: 0.5, solPriceUsd: 3, minSnipeUsd: 1, });
    assert.equal(r.ok, true);
    if (r.ok) { assert.equal(r.sol, 3.333334); assert.ok(r.usd >= 10); }
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

// Regression: round6 used to make ~50% of $10 USD-sized buys fall a hair under the $10 minimum
// (e.g. 9.99997) and be skipped as below_min_snipe, including strong tokens that passed observation.
describe('computeBuySol: USD sizing never fails the minimum because of rounding', () => {
  it('accepts a 10 USD buy at every SOL price from 40 to 400', () => {
    let rejected = 0;
    let worstUnder = 0;
    let worstOver = 0;
    let n = 0;
    for (let p = 40; p <= 400; p += 0.0137) {
      n++;
      const r = computeBuySol({ buyAmountUsd: 10, buyAmountSol: 0.05, solPriceUsd: p, minSnipeUsd: 10 });
      if (!r.ok) { rejected++; continue; }
      worstUnder = Math.min(worstUnder, r.usd - 10);
      worstOver = Math.max(worstOver, r.usd - 10);
    }
    assert.equal(rejected, 0, `rejected ${rejected} of ${n} prices`);
    assert.ok(worstUnder >= -1e-6, `spent less than requested: ${worstUnder}`);
    assert.ok(worstOver <= 0.0005 * 1.0, `overshoot too large: ${worstOver}`);
  });

  it('still rejects a genuinely too-small size', () => {
    const r = computeBuySol({ buyAmountUsd: 9, buyAmountSol: 0.05, solPriceUsd: 120, minSnipeUsd: 10 });
    assert.equal(r.ok, false);
  });

  it('SOL sizing keeps plain rounding and the minimum check', () => {
    const ok = computeBuySol({ buyAmountUsd: 0, buyAmountSol: 0.1, solPriceUsd: 120, minSnipeUsd: 10 });
    assert.equal(ok.ok, true);
    const small = computeBuySol({ buyAmountUsd: 0, buyAmountSol: 0.05, solPriceUsd: 120, minSnipeUsd: 10 });
    assert.equal(small.ok, false);
  });
});
