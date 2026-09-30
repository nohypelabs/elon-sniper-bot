import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectTradeSource, isPumpPortalKeyRejection } from './pumpfun.listener';

describe('selectTradeSource', () => {
  it("explicit settings win regardless of key", () => {
    assert.equal(selectTradeSource('pumpportal', false), 'pumpportal');
    assert.equal(selectTradeSource('curve', true), 'curve');
  });

  it("auto uses curve without a key, pumpportal with one", () => {
    assert.equal(selectTradeSource('auto', false), 'curve');
    assert.equal(selectTradeSource('auto', true), 'pumpportal');
    assert.equal(selectTradeSource('weird-value', false), 'curve');
  });
});

describe('isPumpPortalKeyRejection', () => {
  it('detects the keyless rejection message', () => {
    assert.equal(
      isPumpPortalKeyRejection({ message: "'subscribeTokenTrade' and 'subscribeAccountTrade' methods are only available when connecting with an API key funded with at least 0.02 SOL." }),
      true,
    );
  });

  it('ignores anything else', () => {
    assert.equal(isPumpPortalKeyRejection({ message: 'subscribed' }), false);
    assert.equal(isPumpPortalKeyRejection({ mint: 'abc', txType: 'buy' }), false);
    assert.equal(isPumpPortalKeyRejection(null), false);
    assert.equal(isPumpPortalKeyRejection({ message: 42 }), false);
  });
});
