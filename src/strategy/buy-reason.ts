/**
 * BUY reason mapping (Stage 11) — PURE module, no I/O.
 *
 * executeBuy's Trade insert used to hardcode reason 'tweet' for every buy,
 * including pump snipes. The real reason:
 * - 'pump-observed' — token came through the pre-buy observer
 *   (observeDriftPct is defined on the observer handoff path)
 * - 'pump-snipe'    — immediate pump snipe (tweetText 'PumpFun snipe: ...',
 *   e.g. observer at capacity or observation disabled)
 * - 'tweet'         — tweet-driven / manual buys (anything else)
 */

export type BuyReason = 'pump-observed' | 'pump-snipe' | 'tweet';

export function buyReasonFor(
  tweetText: string | undefined,
  observeDriftPct: number | null | undefined,
): BuyReason {
  if (typeof observeDriftPct === 'number' && Number.isFinite(observeDriftPct)) {
    return 'pump-observed';
  }
  if (typeof tweetText === 'string' && tweetText.startsWith('PumpFun snipe:')) {
    return 'pump-snipe';
  }
  return 'tweet';
}
