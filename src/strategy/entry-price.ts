/**
 * Entry-price refresh — pure helper.
 *
 * With BUY_APPROVAL_ENABLED the buy happens up to BUY_APPROVAL_TIMEOUT_SEC
 * after the token snapshot, so entryPriceUsd/mcap taken at token creation
 * are stale. SwapResult.pricePerToken/outputAmount must NOT be used as the
 * entry price (ambiguous units; fake constant in PAPER mode). Instead the
 * caller re-prices from the live trade feed (price in SOL) observed during
 * the approval wait and converts with the current SOL/USD price.
 */

export interface EntrySnapshot {
  priceUsd: number;
  mcapUsd: number;
}

export interface RefreshedEntry {
  priceUsd: number;
  mcapUsd: number;
  refreshed: boolean;
}

/**
 * Re-price a token snapshot from the latest live trade price.
 *
 * Returns a refreshed entry (mcap scaled by newPrice / snapshot.priceUsd)
 * when latestPriceSol and solPriceUsd are both finite numbers > 0 and the
 * snapshot price is > 0. Otherwise returns the snapshot unchanged with
 * refreshed = false. Never returns NaN / Infinity / negative values from
 * the refreshed path.
 */
export function refreshEntry(
  snapshot: EntrySnapshot,
  latestPriceSol: number | null | undefined,
  solPriceUsd: number,
): RefreshedEntry {
  const fallback: RefreshedEntry = {
    priceUsd: snapshot.priceUsd,
    mcapUsd: snapshot.mcapUsd,
    refreshed: false,
  };

  if (typeof latestPriceSol !== 'number' || !Number.isFinite(latestPriceSol) || latestPriceSol <= 0) {
    return fallback;
  }
  if (typeof solPriceUsd !== 'number' || !Number.isFinite(solPriceUsd) || solPriceUsd <= 0) {
    return fallback;
  }
  if (typeof snapshot.priceUsd !== 'number' || !Number.isFinite(snapshot.priceUsd) || snapshot.priceUsd <= 0) {
    return fallback;
  }

  const newPrice = latestPriceSol * solPriceUsd;
  if (!Number.isFinite(newPrice) || newPrice <= 0) {
    return fallback;
  }
  const ratio = newPrice / snapshot.priceUsd;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return fallback;
  }

  let newMcap = snapshot.mcapUsd * ratio;
  if (typeof snapshot.mcapUsd !== 'number' || !Number.isFinite(newMcap) || newMcap < 0) {
    // Snapshot mcap unusable — keep the snapshot mcap but still re-price.
    // Never emit NaN/Infinity/negative.
    newMcap = Number.isFinite(snapshot.mcapUsd) && snapshot.mcapUsd >= 0 ? snapshot.mcapUsd : 0;
  }

  return { priceUsd: newPrice, mcapUsd: newMcap, refreshed: true };
}
