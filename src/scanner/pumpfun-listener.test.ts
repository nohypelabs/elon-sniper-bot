import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PumpFunListener, NewPumpToken, applyObservationReprice } from './pumpfun.listener';
import { ObservationResult } from './token-observer';

function makeToken(): NewPumpToken {
  return {
    mint: 'mint-handoff',
    name: 'Handoff',
    symbol: 'HAND',
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

function makePassedResult(): ObservationResult {
  return {
    passed: true,
    reason: null,
    uniqueBuyers: 6,
    buyRatio: 0.9,
    solVelocity: 0.5,
    mode: 'curve',
    lastPriceInSol: 1.851e-8, // HIKU-style +85.1% run during observation
    lastMarketCapSol: 45,
  };
}

describe('observation handoff: callback gets the re-priced copy', () => {
  it('initialPriceSol equals the last observed price; original untouched', async () => {
    const listener = new PumpFunListener();
    const token = makeToken();
    const originalPrice = token.initialPriceSol;
    const originalMcap = token.marketCapSol;
    const received: NewPumpToken[] = [];
    (listener as any).callback = async (t: NewPumpToken) => { received.push(t); };
    await (listener as any).handleObservationResult(token, makePassedResult());

    assert.equal(received.length, 1);
    const handed = received[0];
    assert.equal(handed.initialPriceSol, 1.851e-8);
    assert.equal(handed.marketCapSol, 45);
    assert.equal(handed.creationPriceSol, originalPrice);
    assert.ok(Math.abs((handed.observeDriftPct as number) - 85.1) < 1e-9);
    // The observer's object must not be mutated.
    assert.equal(token.initialPriceSol, originalPrice);
    assert.equal(token.marketCapSol, originalMcap);
    assert.equal(token.observeDriftPct, undefined);
    assert.equal(token.creationPriceSol, undefined);
    assert.notEqual(handed, token);
  });

  it('no live price: copy keeps creation price, drift 0', async () => {
    const listener = new PumpFunListener();
    const token = makeToken();
    const received: NewPumpToken[] = [];
    (listener as any).callback = async (t: NewPumpToken) => { received.push(t); };
    await (listener as any).handleObservationResult(token, {
      passed: true, reason: null, uniqueBuyers: 6, buyRatio: 0.9, solVelocity: 0.5, mode: 'curve',
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].initialPriceSol, token.initialPriceSol);
    assert.equal(received[0].observeDriftPct, 0);
    assert.equal(received[0].creationPriceSol, token.initialPriceSol);
  });
});

describe('applyObservationReprice: pure helper', () => {
  it('scales mcap when the result carries no mcap', () => {
    const out = applyObservationReprice(makeToken(), { ...makePassedResult(), lastMarketCapSol: undefined });
    assert.equal(out.initialPriceSol, 1.851e-8);
    assert.ok(Math.abs(out.marketCapSol - 33 * 1.851) < 1e-9);
    assert.ok(Math.abs((out.observeDriftPct as number) - 85.1) < 1e-9);
  });
});
