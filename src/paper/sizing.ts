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

export function computeBuySol(opts: ComputeBuySolOpts): ComputeBuySolResult {
  const { buyAmountUsd, buyAmountSol, solPriceUsd, minSnipeUsd } = opts;

  if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) {
    return { ok: false, reason: 'sol_price_unavailable' };
  }

  const rawSol = buyAmountUsd > 0 ? buyAmountUsd / solPriceUsd : buyAmountSol;
  const sol = Number.isFinite(rawSol) ? round6(rawSol) : NaN;
  if (!Number.isFinite(sol) || sol <= 0) {
    return { ok: false, reason: 'below_min_snipe' };
  }

  const min = Number.isFinite(minSnipeUsd) && minSnipeUsd > 0 ? minSnipeUsd : 0;
  const usd = sol * solPriceUsd;
  if (usd < min - 1e-9) {
    return { ok: false, reason: 'below_min_snipe' };
  }

  return { ok: true, sol, usd };
}
