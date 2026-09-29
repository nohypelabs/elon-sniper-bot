import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { refreshEntry } from './entry-price';

describe('entry-price: refresh up', () => {
  it('re-prices higher and scales mcap', () => {
    const out = refreshEntry({ priceUsd: 100, mcapUsd: 1000 }, 2, 100);
    assert.equal(out.refreshed, true);
    assert.equal(out.priceUsd, 200);
    assert.equal(out.mcapUsd, 2000);
  });
});

describe('entry-price: refresh down', () => {
  it('re-prices lower and scales mcap', () => {
    const out = refreshEntry({ priceUsd: 100, mcapUsd: 1000 }, 0.5, 100);
    assert.equal(out.refreshed, true);
    assert.equal(out.priceUsd, 50);
    assert.equal(out.mcapUsd, 500);
  });
});

describe('entry-price: mcap scaling exact', () => {
  it('mcap scales by newPrice / snapshot.priceUsd', () => {
    const out = refreshEntry({ priceUsd: 10, mcapUsd: 500 }, 0.25, 100);
    // newPrice = 25, ratio = 2.5, mcap = 1250
    assert.equal(out.refreshed, true);
    assert.equal(out.priceUsd, 25);
    assert.equal(out.mcapUsd, 1250);
  });
});

describe('entry-price: invalid live price returns snapshot', () => {
  const snap = { priceUsd: 100, mcapUsd: 1000 };
  for (const bad of [null, undefined, NaN, 0, -1, -0.5, Infinity, -Infinity] as const) {
    it(`latestPriceSol=${String(bad)}`, () => {
      const out = refreshEntry(snap, bad, 150);
      assert.deepEqual(out, { priceUsd: 100, mcapUsd: 1000, refreshed: false });
    });
  }
});

describe('entry-price: invalid SOL price returns snapshot', () => {
  const snap = { priceUsd: 100, mcapUsd: 1000 };
  for (const bad of [NaN, 0, -150, Infinity, -Infinity] as const) {
    it(`solPriceUsd=${String(bad)}`, () => {
      const out = refreshEntry(snap, 2, bad);
      assert.deepEqual(out, { priceUsd: 100, mcapUsd: 1000, refreshed: false });
    });
  }
});

describe('entry-price: zero snapshot price returns snapshot', () => {
  it('does not divide by zero', () => {
    const out = refreshEntry({ priceUsd: 0, mcapUsd: 1000 }, 2, 150);
    assert.deepEqual(out, { priceUsd: 0, mcapUsd: 1000, refreshed: false });
  });

  it('negative snapshot price returns snapshot', () => {
    const out = refreshEntry({ priceUsd: -5, mcapUsd: 1000 }, 2, 150);
    assert.deepEqual(out, { priceUsd: -5, mcapUsd: 1000, refreshed: false });
  });
});

describe('entry-price: never NaN/Infinity/negative', () => {
  it('garbage inputs yield finite non-negative outputs', () => {
    const cases: Array<[number | null | undefined, number]> = [
      [null, 150],
      [NaN, 150],
      [0, 150],
      [-2, 150],
      [Infinity, 150],
      [2, NaN],
      [2, 0],
      [2, -1],
      [2, Infinity],
    ];
    for (const [live, sol] of cases) {
      const out = refreshEntry({ priceUsd: 100, mcapUsd: 1000 }, live, sol);
      assert.equal(out.refreshed, false);
      assert.ok(Number.isFinite(out.priceUsd), `priceUsd not finite for ${String(live)}/${sol}`);
      assert.ok(Number.isFinite(out.mcapUsd), `mcapUsd not finite for ${String(live)}/${sol}`);
      assert.ok(out.mcapUsd >= 0, `mcapUsd negative for ${String(live)}/${sol}`);
    }
  });

  it('huge but finite values stay finite', () => {
    const out = refreshEntry({ priceUsd: 1e-9, mcapUsd: 1e9 }, 1e6, 1e3);
    assert.equal(out.refreshed, true);
    assert.ok(Number.isFinite(out.priceUsd));
    assert.ok(Number.isFinite(out.mcapUsd));
    assert.ok(out.priceUsd > 0 && out.mcapUsd >= 0);
  });
});
