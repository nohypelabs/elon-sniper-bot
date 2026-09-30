import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../config';
import { TokenObserver, ObservationResult } from './token-observer';
import { NewPumpToken } from './pumpfun.listener';
import { CurveUpdate } from './curve-feed';

function makeToken(mint: string): NewPumpToken {
  return {
    mint,
    name: 'Test',
    symbol: 'TST',
    description: '',
    uri: '',
    creatorWallet: 'creator',
    initialBuySol: 1,
    marketCapSol: 33,
    initialPriceSol: 1e-8,
    bondingCurveKey: 'curve',
    signature: 'sig',
    timestamp: Date.now(),
  };
}

function makeUpdate(realSol: number, slot: number, complete = false): CurveUpdate {
  return {
    curveKey: 'curve',
    priceInSol: 1e-8,
    marketCapSol: 33,
    virtualSolReserves: 30 + realSol,
    realSolReserves: realSol,
    complete,
    slot,
    receivedAt: Date.now(),
  };
}

function setup(mode: 'pumpportal' | 'curve' = 'curve') {
  let nowMs = 1_000_000;
  const observer = new TokenObserver({ now: () => nowMs });
  observer.setFeedMode(mode);
  const results: { mint: string; result: ObservationResult }[] = [];
  observer.onResult((token, result) => results.push({ mint: token.mint, result }));
  return {
    observer,
    results,
    advance: (ms: number) => { nowMs += ms; },
  };
}

function minEvents(): number {
  return CONFIG.PUMP_MIN_BUY_EVENTS;
}

describe('TokenObserver curve mode', () => {
  it('passes with enough buy events, ratio and velocity (early exit)', () => {
    const { observer, results, advance } = setup('curve');
    observer.register(makeToken('mint-pass'));
    advance(1000);
    observer.onCurveUpdate('mint-pass', makeUpdate(4.0, 1)); // baseline
    advance(5000); // elapsed >= 5s so early exit may fire
    for (let i = 0; i < minEvents(); i++) {
      observer.onCurveUpdate('mint-pass', makeUpdate(4.0 + 0.5 * (i + 1), 2 + i));
    }
    assert.equal(results.length, 1);
    assert.equal(results[0].result.passed, true);
    assert.equal(results[0].result.mode, 'curve');
    assert.equal(results[0].result.uniqueBuyers, results[0].result.uniqueBuyers); // buyers == buy events
    assert.ok(results[0].result.buyRatio >= CONFIG.PUMP_MIN_BUY_RATIO);
  });

  it('fails on low buy ratio, reason states curve mode', () => {
    const { observer, results, advance } = setup('curve');
    observer.register(makeToken('mint-ratio'));
    observer.onCurveUpdate('mint-ratio', makeUpdate(4.0, 1));
    advance(1000);
    // 2 buys, 3 sells -> ratio 0.4
    observer.onCurveUpdate('mint-ratio', makeUpdate(4.5, 2));
    observer.onCurveUpdate('mint-ratio', makeUpdate(5.0, 3));
    observer.onCurveUpdate('mint-ratio', makeUpdate(4.0, 4));
    observer.onCurveUpdate('mint-ratio', makeUpdate(3.0, 5));
    observer.onCurveUpdate('mint-ratio', makeUpdate(2.0, 6));
    advance(CONFIG.PUMP_OBSERVE_SECONDS * 1000 + 1000);
    observer.evaluateNow();
    assert.equal(results.length, 1);
    assert.equal(results[0].result.passed, false);
    assert.ok(results[0].result.reason!.includes('[curve]'));
    assert.ok(results[0].result.reason!.includes('buy ratio'));
    assert.equal(results[0].result.mode, 'curve');
  });

  it('fails on low net-inflow velocity', () => {
    const { observer, results, advance } = setup('curve');
    observer.register(makeToken('mint-vel'));
    observer.onCurveUpdate('mint-vel', makeUpdate(4.0, 1));
    advance(1000);
    for (let i = 0; i < minEvents() + 1; i++) {
      observer.onCurveUpdate('mint-vel', makeUpdate(4.0 + 0.001 * (i + 1), 2 + i));
    }
    advance(CONFIG.PUMP_OBSERVE_SECONDS * 1000 + 1000);
    observer.evaluateNow();
    assert.equal(results.length, 1);
    assert.equal(results[0].result.passed, false);
    assert.ok(results[0].result.reason!.includes('SOL/s'));
  });

  it('zero updates -> no_data (distinct from 0 buyers), not a market verdict', () => {
    const { observer, results, advance } = setup('curve');
    observer.register(makeToken('mint-nodata'));
    advance(CONFIG.PUMP_OBSERVE_SECONDS * 1000 + 1000);
    observer.evaluateNow();
    assert.equal(results.length, 1);
    const r = results[0].result;
    assert.equal(r.passed, false);
    assert.equal(r.noData, true);
    assert.ok(r.reason!.startsWith('no_data'));
    assert.ok(r.reason!.includes('[curve]'));
    assert.ok(!r.reason!.includes('buyers (need'));
    // Stage 11 wording: accountSubscribe only emits on change, so zero
    // updates can mean no trades (not necessarily a feed gap).
    assert.ok(r.reason!.includes('0 curve updates in'));
    assert.ok(r.reason!.includes('(no trades, or a feed gap)'));
  });

  it('completed curve fails even with passing metrics', () => {
    const { observer, results, advance } = setup('curve');
    observer.register(makeToken('mint-done'));
    observer.onCurveUpdate('mint-done', makeUpdate(4.0, 1));
    advance(1000);
    for (let i = 0; i < minEvents() + 1; i++) {
      observer.onCurveUpdate('mint-done', makeUpdate(4.0 + 1.0 * (i + 1), 2 + i, true));
    }
    advance(CONFIG.PUMP_OBSERVE_SECONDS * 1000 + 1000);
    observer.evaluateNow();
    assert.equal(results.length, 1);
    assert.equal(results[0].result.passed, false);
    assert.ok(results[0].result.reason!.includes('completed'));
  });

  it('ignores out-of-order and duplicate updates', () => {
    const { observer, advance } = setup('curve');
    observer.register(makeToken('mint-ooo'));
    advance(1000);
    observer.onCurveUpdate('mint-ooo', makeUpdate(4.0, 5)); // baseline
    observer.onCurveUpdate('mint-ooo', makeUpdate(9.0, 3)); // out-of-order -> ignored
    observer.onCurveUpdate('mint-ooo', makeUpdate(4.0, 5)); // duplicate -> ignored
    observer.onCurveUpdate('mint-ooo', makeUpdate(4.5, 6)); // one buy
    const entry = (observer as any).observed.get('mint-ooo');
    assert.equal(entry.curveUpdates, 2);
    assert.equal(entry.buyEvents, 1);
    assert.equal(entry.sellEvents, 0);
  });
});

describe('TokenObserver pumpportal mode unchanged', () => {
  it('keeps legacy reason strings when trades were seen', () => {
    const { observer, results, advance } = setup('pumpportal');
    observer.register(makeToken('mint-legacy'));
    advance(1000);
    observer.onTrade('mint-legacy', 'buy', 'trader1', 1.0);
    advance(CONFIG.PUMP_OBSERVE_SECONDS * 1000 + 1000);
    observer.evaluateNow();
    assert.equal(results.length, 1);
    const r = results[0].result;
    assert.equal(r.passed, false);
    assert.equal(r.mode, 'pumpportal');
    assert.ok(r.reason!.includes('buyers (need'));
    assert.ok(!r.noData);
  });
});

describe('TokenObserver last-price tracking (Stage 11)', () => {
  function makePricedUpdate(realSol: number, slot: number, priceInSol: number, marketCapSol: number): CurveUpdate {
    return {
      curveKey: 'curve',
      priceInSol,
      marketCapSol,
      virtualSolReserves: 30 + realSol,
      realSolReserves: realSol,
      complete: false,
      slot,
      receivedAt: Date.now(),
    };
  }

  it('curve pass carries the latest observed price and mcap', () => {
    const { observer, results, advance } = setup('curve');
    observer.register(makeToken('mint-last'));
    advance(1000);
    observer.onCurveUpdate('mint-last', makePricedUpdate(4.0, 1, 1e-8, 33)); // baseline
    advance(5000);
    for (let i = 0; i < minEvents(); i++) {
      observer.onCurveUpdate('mint-last', makePricedUpdate(4.0 + 0.5 * (i + 1), 2 + i, 2e-8, 36));
    }
    assert.equal(results.length, 1);
    assert.equal(results[0].result.passed, true);
    assert.equal(results[0].result.lastPriceInSol, 2e-8);
    assert.equal(results[0].result.lastMarketCapSol, 36);
  });

  it('curve failure still carries the latest observed price', () => {
    const { observer, results, advance } = setup('curve');
    observer.register(makeToken('mint-lastfail'));
    observer.onCurveUpdate('mint-lastfail', makePricedUpdate(4.0, 1, 1e-8, 33));
    advance(1000);
    observer.onCurveUpdate('mint-lastfail', makePricedUpdate(4.5, 2, 1.1e-8, 34));
    observer.onCurveUpdate('mint-lastfail', makePricedUpdate(5.0, 3, 1.2e-8, 35));
    observer.onCurveUpdate('mint-lastfail', makePricedUpdate(4.0, 4, 1.0e-8, 33));
    observer.onCurveUpdate('mint-lastfail', makePricedUpdate(3.0, 5, 0.9e-8, 32));
    observer.onCurveUpdate('mint-lastfail', makePricedUpdate(2.0, 6, 0.8e-8, 31));
    advance(CONFIG.PUMP_OBSERVE_SECONDS * 1000 + 1000);
    observer.evaluateNow();
    assert.equal(results.length, 1);
    assert.equal(results[0].result.passed, false);
    assert.equal(results[0].result.lastPriceInSol, 0.8e-8);
    assert.equal(results[0].result.lastMarketCapSol, 31);
  });

  it('no-data result carries undefined last price', () => {
    const { observer, results, advance } = setup('curve');
    observer.register(makeToken('mint-nolast'));
    advance(CONFIG.PUMP_OBSERVE_SECONDS * 1000 + 1000);
    observer.evaluateNow();
    assert.equal(results.length, 1);
    assert.equal(results[0].result.lastPriceInSol, undefined);
    assert.equal(results[0].result.lastMarketCapSol, undefined);
  });

  it('pumpportal trades carry the latest trade-implied price', () => {
    const { observer, results, advance } = setup('pumpportal');
    observer.register(makeToken('mint-pplast'));
    advance(1000);
    observer.onTrade('mint-pplast', 'buy', 'trader1', 1.0, { priceInSol: 1e-8, marketCapSol: 33 });
    observer.onTrade('mint-pplast', 'buy', 'trader2', 2.0, { priceInSol: 1.5e-8, marketCapSol: 40 });
    // No price on this trade — previous price must survive.
    observer.onTrade('mint-pplast', 'sell', 'trader3', 0.5);
    advance(CONFIG.PUMP_OBSERVE_SECONDS * 1000 + 1000);
    observer.evaluateNow();
    assert.equal(results.length, 1);
    assert.equal(results[0].result.lastPriceInSol, 1.5e-8);
    assert.equal(results[0].result.lastMarketCapSol, 40);
  });

  it('pumpportal trades without any price leave last price undefined', () => {
    const { observer, results, advance } = setup('pumpportal');
    observer.register(makeToken('mint-ppnoprice'));
    advance(1000);
    observer.onTrade('mint-ppnoprice', 'buy', 'trader1', 1.0);
    advance(CONFIG.PUMP_OBSERVE_SECONDS * 1000 + 1000);
    observer.evaluateNow();
    assert.equal(results.length, 1);
    assert.equal(results[0].result.lastPriceInSol, undefined);
  });
});
