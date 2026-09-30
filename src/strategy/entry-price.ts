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

// ─── Stage 11: observation re-price ─────────────────────────────
// Tokens that pass the pre-buy observation window pumped (or dumped)
// during it, so the creation-event price is stale by buy time. The
// observer attaches the latest seen price to its result; this pure helper
// folds it back into the token snapshot before the buy.

export interface ObservationPrice {
  lastPriceInSol?: number;
  lastMarketCapSol?: number;
}

export interface RepricedToken {
  initialPriceSol: number;
  marketCapSol: number;
  repriced: boolean;
  /** Slippage of the new price vs the creation price, in percent. Null when unmeasurable. */
  driftPct: number | null;
}

/**
 * Re-price a creation-event token snapshot from the latest observed price.
 *
 * Returns the token's values unchanged with repriced=false and driftPct=null
 * when the last price is missing/non-finite/<=0. Otherwise returns the new
 * price, the new mcap (lastMarketCapSol when finite > 0, else the old mcap
 * scaled by newPrice/oldPrice), repriced=true and driftPct = (new-old)/old
 * in percent (null when the old price is not usable). Never NaN/Infinity.
 */
export function repriceTokenAfterObservation(
  token: { initialPriceSol: number; marketCapSol: number },
  last: ObservationPrice,
): RepricedToken {
  const unchanged: RepricedToken = {
    initialPriceSol: token.initialPriceSol,
    marketCapSol: token.marketCapSol,
    repriced: false,
    driftPct: null,
  };

  const newPrice = last?.lastPriceInSol;
  if (typeof newPrice !== 'number' || !Number.isFinite(newPrice) || newPrice <= 0) {
    return unchanged;
  }

  const oldPrice = token.initialPriceSol;
  const oldUsable = typeof oldPrice === 'number' && Number.isFinite(oldPrice) && oldPrice > 0;

  let newMcap: number;
  const lastMcap = last?.lastMarketCapSol;
  if (typeof lastMcap === 'number' && Number.isFinite(lastMcap) && lastMcap > 0) {
    newMcap = lastMcap;
  } else if (oldUsable) {
    const ratio = newPrice / (oldPrice as number);
    if (!Number.isFinite(ratio) || ratio <= 0) return unchanged;
    const oldMcap = token.marketCapSol;
    newMcap = typeof oldMcap === 'number' && Number.isFinite(oldMcap) && oldMcap >= 0
      ? oldMcap * ratio
      : 0;
    if (!Number.isFinite(newMcap) || newMcap < 0) newMcap = 0;
  } else {
    // Old price unusable and no live mcap — keep a sane mcap, still re-price.
    const oldMcap = token.marketCapSol;
    newMcap = typeof oldMcap === 'number' && Number.isFinite(oldMcap) && oldMcap >= 0 ? oldMcap : 0;
  }

  let drift: number | null = null;
  if (oldUsable) {
    const d = ((newPrice - (oldPrice as number)) / (oldPrice as number)) * 100;
    drift = Number.isFinite(d) ? d : null;
  }

  return { initialPriceSol: newPrice, marketCapSol: newMcap, repriced: true, driftPct: drift };
}

/**
 * Pure drift-guard predicate for PUMP_MAX_ENTRY_DRIFT_PERCENT.
 * Returns true only when the guard is enabled (maxPct > 0) and a finite
 * measured drift exceeds it. Unknown drift (null/undefined/NaN) never skips.
 */
export function shouldSkipForDrift(
  driftPct: number | null | undefined,
  maxPct: number,
): boolean {
  if (typeof maxPct !== 'number' || !Number.isFinite(maxPct) || maxPct <= 0) return false;
  if (typeof driftPct !== 'number' || !Number.isFinite(driftPct)) return false;
  return driftPct > maxPct;
}
