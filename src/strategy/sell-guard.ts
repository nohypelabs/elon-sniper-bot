/**
 * Pure sell retry/backoff helpers (Stage 9a trade-safety fixes).
 *
 * No I/O, no CONFIG import — the caller (src/index.ts) owns the
 * ActivePosition objects and passes them in. All functions are pure
 * with respect to their arguments (they only mutate the passed-in
 * position state, never global state).
 *
 * Retry policy: exponential backoff 5s, 10s, 20s, 40s, … capped at 60s.
 * A Telegram alert is due exactly on the 3rd consecutive failure and
 * then on every 10th failure (10, 20, 30, …).
 */

export interface SellGuardState {
  sellFailures: number;
  nextSellAttemptAt: number; // epoch ms; 0 = may attempt immediately
}

export const SELL_BACKOFF_BASE_MS = 5_000;
export const SELL_BACKOFF_CAP_MS = 60_000;

/** Backoff delay for `failures` consecutive failures (0 when failures <= 0). */
export function backoffMs(failures: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  const n = Math.floor(failures);
  return Math.min(SELL_BACKOFF_CAP_MS, SELL_BACKOFF_BASE_MS * 2 ** (n - 1));
}

/** True when a sell may be attempted right now (backoff has expired). */
export function canAttemptSell(pos: SellGuardState, now: number): boolean {
  return now >= (pos.nextSellAttemptAt ?? 0);
}

/** Record a failed sell: increment the counter and arm the next attempt time. */
export function recordSellFailure(pos: SellGuardState, now: number): void {
  const failures = (pos.sellFailures ?? 0) + 1;
  pos.sellFailures = failures;
  pos.nextSellAttemptAt = now + backoffMs(failures);
}

/** Record a successful sell: clear the failure counter and the backoff gate. */
export function recordSellSuccess(pos: SellGuardState): void {
  pos.sellFailures = 0;
  pos.nextSellAttemptAt = 0;
}

/**
 * True exactly when a Telegram "SELL GAGAL" alert is due: on the 3rd
 * consecutive failure, then on every 10th failure (10, 20, 30, …).
 */
export function shouldAlertSellFailure(pos: SellGuardState): boolean {
  const f = pos.sellFailures ?? 0;
  if (f === 3) return true;
  return f >= 10 && f % 10 === 0;
}

/**
 * True when the map entry is still a buy-pending placeholder, i.e. the
 * position was reserved in ActivePosition before the buy completed
 * (token/buyResult not yet assigned). Such entries must never be treated
 * as real positions and must be deleted if the buy path bails out early
 * (honeypot skip, rejection, exception) so they cannot brick the
 * mint/symbol or consume a MAX_POSITIONS slot forever.
 */
export function isPlaceholder(pos: { token: unknown; buyResult: unknown }): boolean {
  return !pos.token || !pos.buyResult;
}
