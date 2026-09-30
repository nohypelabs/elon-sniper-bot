import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { refreshEntry, repriceTokenAfterObservation, shouldSkipForDrift } from './entry-price';

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

describe('entry-price: repriceTokenAfterObservation up 100%', () => {
  it('adopts the live price, scales mcap, drift +100%', () => {
    const out = repriceTokenAfterObservation(
      { initialPriceSol: 1e-8, marketCapSol: 40 },
      { lastPriceInSol: 2e-8 },
    );
    assert.equal(out.repriced, true);
    assert.equal(out.initialPriceSol, 2e-8);
    assert.equal(out.marketCapSol, 80);
    assert.equal(out.driftPct, 100);
  });
});

describe('entry-price: repriceTokenAfterObservation down', () => {
  it('adopts the lower price and reports negative drift', () => {
    const out = repriceTokenAfterObservation(
      { initialPriceSol: 1e-8, marketCapSol: 40 },
      { lastPriceInSol: 0.5e-8 },
    );
    assert.equal(out.repriced, true);
    assert.equal(out.initialPriceSol, 0.5e-8);
    assert.equal(out.marketCapSol, 20);
    assert.equal(out.driftPct, -50);
  });
});

describe('entry-price: repriceTokenAfterObservation HIKU case', () => {
  it('drift math matches the stale-entry artefact (+85.1%)', () => {
    const out = repriceTokenAfterObservation(
      { initialPriceSol: 1e-8, marketCapSol: 33 },
      { lastPriceInSol: 1.851e-8 },
    );
    assert.equal(out.repriced, true);
    assert.ok(Math.abs((out.driftPct as number) - 85.1) < 1e-9);
  });
});

describe('entry-price: repriceTokenAfterObservation given mcap wins', () => {
  it('uses lastMarketCapSol instead of scaling', () => {
    const out = repriceTokenAfterObservation(
      { initialPriceSol: 1e-8, marketCapSol: 40 },
      { lastPriceInSol: 2e-8, lastMarketCapSol: 45 },
    );
    assert.equal(out.repriced, true);
    assert.equal(out.initialPriceSol, 2e-8);
    assert.equal(out.marketCapSol, 45);
    assert.equal(out.driftPct, 100);
  });
});

describe('entry-price: repriceTokenAfterObservation missing/bad last price', () => {
  it('returns the token unchanged with repriced=false, drift null', () => {
    const token = { initialPriceSol: 1e-8, marketCapSol: 40 };
    for (const last of [
      {},
      { lastPriceInSol: undefined },
      { lastPriceInSol: NaN },
      { lastPriceInSol: 0 },
      { lastPriceInSol: -1e-8 },
      { lastPriceInSol: Infinity },
    ] as const) {
      const out = repriceTokenAfterObservation(token, last);
      assert.deepEqual(out, { initialPriceSol: 1e-8, marketCapSol: 40, repriced: false, driftPct: null });
    }
  });
});

describe('entry-price: repriceTokenAfterObservation zero old price', () => {
  it('still re-prices, keeps mcap, drift null', () => {
    const out = repriceTokenAfterObservation(
      { initialPriceSol: 0, marketCapSol: 40 },
      { lastPriceInSol: 2e-8 },
    );
    assert.equal(out.repriced, true);
    assert.equal(out.initialPriceSol, 2e-8);
    assert.equal(out.marketCapSol, 40);
    assert.equal(out.driftPct, null);
  });
});

describe('entry-price: repriceTokenAfterObservation never NaN/Infinity', () => {
  it('repriced outputs are finite; unrepriced outputs echo the input', () => {
    const olds = [0, -1, NaN, Infinity];
    const lasts: Array<number | undefined> = [undefined, NaN, 0, -1, Infinity, 2e-8];
    for (const old of olds) {
      for (const last of lasts) {
        const out = repriceTokenAfterObservation(
          { initialPriceSol: old, marketCapSol: 40 },
          { lastPriceInSol: last },
        );
        if (out.repriced) {
          assert.ok(Number.isFinite(out.initialPriceSol), `price not finite for old=${old} last=${last}`);
          assert.ok(Number.isFinite(out.marketCapSol), `mcap not finite for old=${old} last=${last}`);
        } else {
          // Unchanged path echoes the caller's snapshot (never computes).
          assert.ok(out.initialPriceSol === old || (Number.isNaN(out.initialPriceSol) && Number.isNaN(old)));
          assert.equal(out.marketCapSol, 40);
          assert.equal(out.driftPct, null);
        }
        assert.ok(out.driftPct === null || Number.isFinite(out.driftPct as number));
      }
    }
  });
});

describe('entry-price: shouldSkipForDrift predicate', () => {
  it('disabled guard (0/negative/NaN max) never skips', () => {
    assert.equal(shouldSkipForDrift(85, 0), false);
    assert.equal(shouldSkipForDrift(85, -10), false);
    assert.equal(shouldSkipForDrift(85, NaN), false);
  });

  it('skips only when finite drift exceeds a positive max', () => {
    assert.equal(shouldSkipForDrift(85.1, 50), true);
    assert.equal(shouldSkipForDrift(50.01, 50), true);
    assert.equal(shouldSkipForDrift(50, 50), false);
    assert.equal(shouldSkipForDrift(30, 50), false);
    assert.equal(shouldSkipForDrift(-10, 50), false);
    assert.equal(shouldSkipForDrift(null, 50), false);
    assert.equal(shouldSkipForDrift(undefined, 50), false);
    assert.equal(shouldSkipForDrift(NaN, 50), false);
  });
});
