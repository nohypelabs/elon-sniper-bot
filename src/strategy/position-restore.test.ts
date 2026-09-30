import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Position } from '../db/schema';
import { rowToActivePosition } from './position-restore';
import { evaluateExit, type ExitConfig } from './exit-rules';
import { isPlaceholder } from './sell-guard';

const EXIT_CFG: ExitConfig = {
  AUTO_SELL: true,
  TP1_PERCENT: 30,
  TP2_PERCENT: 50,
  STOP_LOSS_PERCENT: 25,
  TRAILING_TP_ENABLED: false,
  TRAILING_TP_DROP_PERCENT: 15,
  MOONBAG_TRAIL_PERCENT: 30,
};

function row(over: Partial<Position> = {}): Position {
  return {
    id: 'id-1',
    tokenMint: 'Mint111111111111111111111111111111111111111',
    symbol: 'REST',
    name: 'Restored Token',
    entryPrice: 0.00001,
    solSpent: 0.5,
    tokenAmount: 1_000_000,
    txSignature: 'sig-abc',
    tweetText: null,
    dex: 'pump.fun',
    openedAt: new Date(Date.now() - 10 * 60_000),
    mcapUsd: 5000,
    tp1Hit: false,
    tp2Hit: false,
    moonbag: false,
    remainingTokens: 1_000_000,
    peakPnlPercent: null,
    currentPriceUsd: 0,
    ...over,
  };
}

describe('rowToActivePosition: rebuild', () => {
  it('rebuilds a full ActivePosition from a row', () => {
    const now = Date.now();
    const pos = rowToActivePosition(row(), now);
    assert.ok(pos);
    assert.equal(pos.token.mintAddress, 'Mint111111111111111111111111111111111111111');
    assert.equal(pos.token.symbol, 'REST');
    assert.equal(pos.token.name, 'Restored Token');
    // currentPriceUsd=0 falls back to entryPrice
    assert.equal(pos.token.priceUsd, 0.00001);
    assert.equal(pos.currentPriceUsd, 0.00001);
    assert.equal(pos.token.mcapUsd, 5000);
    assert.equal(pos.token.dex, 'pump.fun');
    assert.equal(pos.token.url, 'https://pump.fun/coin/Mint111111111111111111111111111111111111111');
    assert.equal(pos.token.pairAddress, '');
    assert.equal(pos.token.liquidity, 0);
    assert.equal(pos.token.volume24h, 0);
    assert.equal(pos.token.matchedKeyword, 'restored');
    assert.ok(pos.token.ageMinutes >= 9 && pos.token.ageMinutes <= 11);
    assert.equal(pos.buyResult.success, true);
    assert.equal(pos.buyResult.txSignature, 'sig-abc');
    assert.equal(pos.buyResult.inputAmount, 0.5);
    assert.equal(pos.buyResult.outputAmount, 1_000_000);
    assert.equal(pos.buyResult.pricePerToken, 0);
    assert.ok(Math.abs(pos.entryTime - (now - 10 * 60_000)) < 60_000);
    assert.equal(pos.entryPriceUsd, 0.00001);
    assert.equal(pos.solSpent, 0.5);
    assert.equal(pos.remainingTokens, 1_000_000);
    assert.equal(pos.tp1Hit, false);
    assert.equal(pos.tp2Hit, false);
    assert.equal(pos.moonbag, false);
    assert.equal(pos.isSelling, false);
    assert.equal(pos.sellFailures, 0);
    assert.equal(pos.nextSellAttemptAt, 0);
    assert.equal(pos.peakPnlPercent, undefined);
  });

  it('uses currentPriceUsd when present and keeps stored peak', () => {
    const pos = rowToActivePosition(
      row({ currentPriceUsd: 0.00002, peakPnlPercent: 100, tweetText: 'hello' }),
      Date.now(),
    );
    assert.ok(pos);
    assert.equal(pos.currentPriceUsd, 0.00002);
    assert.equal(pos.token.priceUsd, 0.00002);
    assert.equal(pos.peakPnlPercent, 100);
    assert.equal(pos.tweetText, 'hello');
  });

  it('falls back to tokenAmount when remainingTokens is 0 (pre-9c rows)', () => {
    const pos = rowToActivePosition(row({ remainingTokens: 0 }), Date.now());
    assert.ok(pos);
    assert.equal(pos.remainingTokens, 1_000_000);
    assert.equal(pos.buyResult.outputAmount, 1_000_000);
  });
});

describe('rowToActivePosition: unusable rows', () => {
  it('returns null for empty mint, bad entryPrice or bad solSpent', () => {
    const now = Date.now();
    assert.equal(rowToActivePosition(row({ tokenMint: '' }), now), null);
    assert.equal(rowToActivePosition(row({ tokenMint: '   ' }), now), null);
    assert.equal(rowToActivePosition(row({ entryPrice: 0 }), now), null);
    assert.equal(rowToActivePosition(row({ entryPrice: -1 }), now), null);
    assert.equal(rowToActivePosition(row({ entryPrice: Number.NaN }), now), null);
    assert.equal(rowToActivePosition(row({ solSpent: 0 }), now), null);
    assert.equal(rowToActivePosition(row({ solSpent: -0.5 }), now), null);
    assert.equal(rowToActivePosition(row({ solSpent: Number.NaN }), now), null);
  });
});

describe('restore-then-exit: moonbag remainder keeps its rules', () => {
  it('restored position with tp1Hit=true and moonbag=true keeps flags and gets moonbag rules', () => {
    const pos = rowToActivePosition(
      row({ tp1Hit: true, tp2Hit: true, moonbag: true, peakPnlPercent: 50, remainingTokens: 150_000 }),
      Date.now(),
    );
    assert.ok(pos);
    assert.equal(pos.tp1Hit, true);
    assert.equal(pos.tp2Hit, true);
    assert.equal(pos.moonbag, true);
    assert.equal(pos.peakPnlPercent, 50);
    assert.equal(pos.remainingTokens, 150_000);
    // Not a placeholder: managed by the poll loop and realtime feed.
    assert.equal(isPlaceholder(pos), false);

    // At the peak the moonbag rides: no exit, and even a +100% pump never
    // re-fires tp1/tp2/sl on a moonbag remainder.
    assert.deepEqual(evaluateExit(pos, 50, EXIT_CFG), { action: 'none' });
    assert.deepEqual(evaluateExit(pos, 100, EXIT_CFG), { action: 'none' });
    // A deep give-back (-20% is far past the trail line) exits via the trail.
    assert.equal(evaluateExit(pos, -20, EXIT_CFG).action, 'moonbag-trail');

    // Trail: (1 + pnl/100) <= (1 + 50/100) * (1 - 30/100) = 1.05 → pnl <= 5.
    assert.deepEqual(evaluateExit(pos, 6, EXIT_CFG), { action: 'none' });
    const exit = evaluateExit(pos, 0, EXIT_CFG);
    assert.equal(exit.action, 'moonbag-trail');
  });
});
