/**
 * Restart recovery (Stage 9c): rebuild a live ActivePosition from a
 * persisted Position row.
 *
 * Pure module — no I/O, no CONFIG import. The caller (src/index.ts) loads
 * Position rows after initDb, maps each through rowToActivePosition(), puts
 * usable ones into activePositions BEFORE the poll loop and listeners start,
 * and deletes unusable rows from the DB.
 *
 * Position.entryPrice stores priceUsd at buy time (see the upsertPosition
 * call in executeBuy), so it is reused directly as entryPriceUsd.
 */

import type { Position } from '../db/schema';
import type { FoundToken } from '../scanner/token.finder';
import type { SwapResult } from '../swap/jupiter.swap';

/**
 * Structural copy of the ActivePosition interface in src/index.ts.
 * Kept local (instead of importing from index) so this module stays pure
 * and import-cycle free; assignable to ActivePosition by structure.
 */
export interface RestoredActivePosition {
  token: FoundToken;
  buyResult: SwapResult;
  entryTime: number;
  entryPriceUsd: number;
  currentPriceUsd: number;
  solSpent: number;
  remainingTokens: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  isSelling: boolean;
  sellFailures: number;
  nextSellAttemptAt: number;
  moonbag: boolean;
  peakPnlPercent?: number;
  tweetText?: string;
  // Stage 10: stale-price watchdog (set to restore time; the live feed
  // refreshes it via the same subscribePositionFeed path as fresh buys).
  lastPriceUpdateAt: number;
  staleAlertSent: boolean;
}

/**
 * Rebuild a full ActivePosition from a DB row. Returns null for rows that
 * are unusable: empty mint, or non-finite / <= 0 entryPrice / solSpent.
 * Max-hold keeps counting from the original openedAt via entryTime.
 */
export function rowToActivePosition(row: Position, now: number): RestoredActivePosition | null {
  const mint = (row.tokenMint ?? '').trim();
  if (!mint) return null;
  if (!Number.isFinite(row.entryPrice) || (row.entryPrice as number) <= 0) return null;
  if (!Number.isFinite(row.solSpent) || (row.solSpent as number) <= 0) return null;

  const entryPriceUsd = row.entryPrice as number;
  const currentPriceUsd =
    Number.isFinite(row.currentPriceUsd) && (row.currentPriceUsd as number) > 0
      ? (row.currentPriceUsd as number)
      : entryPriceUsd;
  // Prefer the tracked remainder; fall back to the initial tokenAmount for
  // rows written before remainingTokens existed (or a zero remainder).
  const remaining =
    Number.isFinite(row.remainingTokens) && (row.remainingTokens as number) > 0
      ? (row.remainingTokens as number)
      : Number.isFinite(row.tokenAmount) && (row.tokenAmount as number) > 0
        ? (row.tokenAmount as number)
        : 0;

  const openedAtMs = row.openedAt instanceof Date ? row.openedAt.getTime() : Number(row.openedAt);
  const entryTime = Number.isFinite(openedAtMs) ? openedAtMs : now;
  const ageMinutes = Math.max(0, (now - entryTime) / 60_000);

  const token: FoundToken = {
    mintAddress: mint,
    symbol: row.symbol ?? '',
    name: row.name ?? '',
    priceUsd: currentPriceUsd,
    mcapUsd: Number.isFinite(row.mcapUsd) ? (row.mcapUsd as number) : 0,
    dex: row.dex ?? 'pump.fun',
    url: `https://pump.fun/coin/${mint}`,
    pairAddress: '',
    liquidity: 0,
    volume24h: 0,
    ageMinutes,
    matchedKeyword: 'restored',
  };

  const buyResult: SwapResult = {
    success: true,
    txSignature: row.txSignature ?? '',
    inputAmount: row.solSpent as number,
    outputAmount: remaining,
    pricePerToken: 0,
  };

  const pos: RestoredActivePosition = {
    token,
    buyResult,
    entryTime,
    entryPriceUsd,
    currentPriceUsd,
    solSpent: row.solSpent as number,
    remainingTokens: remaining,
    tp1Hit: row.tp1Hit === true,
    tp2Hit: row.tp2Hit === true,
    isSelling: false,
    sellFailures: 0,
    nextSellAttemptAt: 0,
    moonbag: row.moonbag === true,
    lastPriceUpdateAt: now,
    staleAlertSent: false,
  };
  if (typeof row.peakPnlPercent === 'number' && Number.isFinite(row.peakPnlPercent)) {
    pos.peakPnlPercent = row.peakPnlPercent;
  }
  if (row.tweetText) pos.tweetText = row.tweetText;
  return pos;
}
