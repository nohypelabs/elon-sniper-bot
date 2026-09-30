/**
 * Pure USD position-sizing helper.
 *
 * No I/O, never throws: all failure modes return { ok: false, reason }.
 * Reasons: 'sol_price_unavailable' when the SOL price is missing/unusable,
 * 'below_min_snipe' when the resulting size is unusable or under the minimum.
 */

export interface ComputeBuySolOpts {
  buyAmountUsd: number;
  buyAmountSol: number;
  solPriceUsd: number;
  minSnipeUsd: number;
}

export type ComputeBuySolResult =
  | { ok: true; sol: number; usd: number }
  | { ok: false; reason: string };

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** Round UP to 6 decimals so a USD-sized buy is never a hair under the requested USD amount. */
function ceil6(n: number): number {
  return Math.ceil(n * 1_000_000 - 1e-9) / 1_000_000;
}

export function computeBuySol(opts: ComputeBuySolOpts): ComputeBuySolResult {
  const { buyAmountUsd, buyAmountSol, solPriceUsd, minSnipeUsd } = opts;

  if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) {
    return { ok: false, reason: 'sol_price_unavailable' };
  }

  const rawSol = buyAmountUsd > 0 ? buyAmountUsd / solPriceUsd : buyAmountSol;
  // USD sizing rounds up (round6 could land at 9.99997 USD and fail the 10 USD minimum ~50% of the time);
  // SOL sizing keeps plain rounding.
  const sol = Number.isFinite(rawSol) ? (buyAmountUsd > 0 ? ceil6(rawSol) : round6(rawSol)) : NaN;
  if (!Number.isFinite(sol) || sol <= 0) {
    return { ok: false, reason: 'below_min_snipe' };
  }

  const min = Number.isFinite(minSnipeUsd) && minSnipeUsd > 0 ? minSnipeUsd : 0;
  const usd = sol * solPriceUsd;
  // 1e-6 USD tolerance absorbs float error only; it is far below the 6-decimal SOL granularity.
  if (usd < min - 1e-6) {
    return { ok: false, reason: 'below_min_snipe' };
  }

  return { ok: true, sol, usd };
}
