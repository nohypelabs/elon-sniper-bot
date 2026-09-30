import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buyReasonFor } from './buy-reason';

describe('buy-reason: mapping', () => {
  it('observer path wins over everything', () => {
    assert.equal(buyReasonFor('PumpFun snipe: Foo', 85.1), 'pump-observed');
    assert.equal(buyReasonFor('PumpFun snipe: Foo', 0), 'pump-observed');
    assert.equal(buyReasonFor(undefined, 0), 'pump-observed');
    assert.equal(buyReasonFor('some tweet', -12.5), 'pump-observed');
  });

  it('immediate pump snipe without observer drift', () => {
    assert.equal(buyReasonFor('PumpFun snipe: Foo', undefined), 'pump-snipe');
    assert.equal(buyReasonFor('PumpFun snipe: Foo', null), 'pump-snipe');
    assert.equal(buyReasonFor('PumpFun snipe: Foo', NaN), 'pump-snipe');
  });

  it('tweet-driven and manual buys stay tweet', () => {
    assert.equal(buyReasonFor(undefined, undefined), 'tweet');
    assert.equal(buyReasonFor('ELON tweet text', undefined), 'tweet');
    assert.equal(buyReasonFor('', undefined), 'tweet');
  });
});
