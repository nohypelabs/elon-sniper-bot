/**
 * Paper fill model (Stage 11) — PURE module, no I/O.
 *
 * Paper fills used to execute exactly at the signal price, which ignores the
 * pump.fun fee, price impact and landing variance a real swap suffers. These
 * helpers apply an adverse fill each way:
 * - entry (buy):  pay MORE  — price * (1 + slip/100)
 * - exit (sell):  get LESS  — price * (1 - slip/100)
 *
 * Applied ONLY when the swap source is 'paper'; live mode is untouched.
 * Never throws, never NaN/Infinity: non-finite or <= 0 prices pass through
 * unchanged, slippage is clamped to [0, 50].
 */

export const MAX_FILL_SLIPPAGE_PCT = 50;
export const MAX_SELL_DELAY_MS = 10_000;

/** Clamp raw slippage to [0, 50]; non-finite/negative → 0. */
export function clampSlippagePct(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, MAX_FILL_SLIPPAGE_PCT);
}

/** Clamp raw sell delay to [0, 10000] ms; non-finite/negative → 0. */
export function clampSellDelayMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.floor(raw), MAX_SELL_DELAY_MS);
}

/**
 * Adverse paper entry fill: price * (1 + slip/100).
 * Returns the input unchanged for non-finite/<=0 prices.
 */
export function paperEntryPrice(price: number, slippagePct: number): number {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return price;
  const slip = clampSlippagePct(slippagePct);
  const out = price * (1 + slip / 100);
  return Number.isFinite(out) && out > 0 ? out : price;
}

/**
 * Adverse paper exit fill: price * (1 - slip/100).
 * Returns the input unchanged for non-finite/<=0 prices.
 */
export function paperExitPrice(price: number, slippagePct: number): number {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return price;
  const slip = clampSlippagePct(slippagePct);
  const out = price * (1 - slip / 100);
  return Number.isFinite(out) && out > 0 ? out : price;
}
