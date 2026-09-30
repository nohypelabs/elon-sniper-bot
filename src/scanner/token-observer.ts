import { CONFIG } from '../config';
import { logger } from '../utils/logger';
import { NewPumpToken } from './pumpfun.listener';
import { CurveUpdate } from './curve-feed';

export interface ObservedToken {
  mint: string;
  token: NewPumpToken;
  registeredAt: number;
  // PumpPortal mode: per-trade identity.
  buyers: Set<string>;
  buyCount: number;
  sellCount: number;
  totalBuySol: number;
  totalSellSol: number;
  // Curve mode (no trader identity — derived from consecutive account states):
  // realSolReserves increase => one buy of that delta (SOL), decrease => one
  // sell. Unique buyers are NOT observable from account state, so the
  // 'unique buyers' requirement becomes 'buy events' >= PUMP_MIN_BUY_EVENTS.
  feedMode: 'pumpportal' | 'curve';
  curveUpdates: number;
  buyEvents: number;
  sellEvents: number;
  netInflowSol: number;
  lastRealSol: number | null;
  lastSlot: number;
  completed: boolean;
  // Stage 11: latest observed price for entry re-pricing. Curve mode: from
  // the most recent CurveUpdate. PumpPortal mode: from the latest trade
  // message (vSol/vTokens). Undefined when nothing was ever seen.
  lastPriceInSol?: number;
  lastMarketCapSol?: number;
}

export interface ObservationResult {
  passed: boolean;
  reason: string | null;
  // In curve mode uniqueBuyers carries BUY EVENTS (approximation — trader
  // identities are not visible in account state).
  uniqueBuyers: number;
  buyRatio: number;
  solVelocity: number;
  mode: 'pumpportal' | 'curve';
  /** True when the feed delivered nothing at all (distinct from a 0-buyer market verdict). */
  noData?: boolean;
  /**
   * Stage 11: latest observed price at result time (for entry re-pricing).
   * Curve mode: most recent CurveUpdate (priceInSol/marketCapSol).
   * PumpPortal mode: latest trade message carrying vSol/vTokens reserves.
   * Undefined when nothing was ever seen. Present on passed AND failed results.
   */
  lastPriceInSol?: number;
  lastMarketCapSol?: number;
}

type ResultCallback = (token: NewPumpToken, result: ObservationResult) => void;

export class TokenObserver {
  private observed = new Map<string, ObservedToken>();
  private resultCallback: ResultCallback | null = null;
  private evalTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  /** Feed mode stamped onto newly registered tokens (listener keeps it in sync with TradeSource). */
  private feedMode: 'pumpportal' | 'curve' = 'pumpportal';

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  setFeedMode(mode: 'pumpportal' | 'curve'): void {
    this.feedMode = mode;
  }

  getFeedMode(): 'pumpportal' | 'curve' {
    return this.feedMode;
  }

  onResult(cb: ResultCallback): void {
    this.resultCallback = cb;
  }

  start(): void {
    this.evalTimer = setInterval(() => this.evaluate(), 1000);
  }

  stop(): void {
    if (this.evalTimer) {
      clearInterval(this.evalTimer);
      this.evalTimer = null;
    }
  }

  register(token: NewPumpToken): boolean {
    if (this.observed.size >= CONFIG.PUMP_MAX_OBSERVE_TOKENS) {
      return false;
    }

    this.observed.set(token.mint, {
      mint: token.mint,
      token,
      registeredAt: this.now(),
      buyers: new Set(),
      buyCount: 0,
      sellCount: 0,
      totalBuySol: 0,
      totalSellSol: 0,
      feedMode: this.feedMode,
      curveUpdates: 0,
      buyEvents: 0,
      sellEvents: 0,
      netInflowSol: 0,
      lastRealSol: null,
      lastSlot: -1,
      completed: false,
    });

    return true;
  }

  has(mint: string): boolean {
    return this.observed.has(mint);
  }

  onTrade(mint: string, txType: 'buy' | 'sell', traderPublicKey: string, solAmount: number, price?: { priceInSol?: number; marketCapSol?: number }): void {
    const entry = this.observed.get(mint);
    if (!entry) return;

    // Stage 11: remember the latest trade-implied price for entry re-pricing.
    if (price) {
      if (typeof price.priceInSol === 'number' && Number.isFinite(price.priceInSol) && price.priceInSol > 0) {
        entry.lastPriceInSol = price.priceInSol;
      }
      if (typeof price.marketCapSol === 'number' && Number.isFinite(price.marketCapSol) && price.marketCapSol > 0) {
        entry.lastMarketCapSol = price.marketCapSol;
      }
    }

    if (txType === 'buy') {
      if (traderPublicKey) entry.buyers.add(traderPublicKey);
      entry.buyCount++;
      entry.totalBuySol += solAmount;
    } else {
      entry.sellCount++;
      entry.totalSellSol += solAmount;
    }

    // Early exit: check if all thresholds met before window expires
    this.checkEarlyExit(mint, entry);
  }

  /**
   * Curve-mode feed: derive buy/sell events from consecutive bonding-curve
   * account states. First update only sets the baseline (proves the feed is
   * alive — the token is NOT 'no_data' afterwards). Out-of-order updates
   * (slot < lastSlot) and same-slot repeats with unchanged reserves are
   * ignored.
   */
  onCurveUpdate(mint: string, update: CurveUpdate): void {
    const entry = this.observed.get(mint);
    if (!entry) return;
    if (!update || typeof update.realSolReserves !== 'number' || !Number.isFinite(update.realSolReserves)) return;
    if (typeof update.slot === 'number' && update.slot < entry.lastSlot) return; // out-of-order
    if (
      typeof update.slot === 'number' && update.slot === entry.lastSlot &&
      entry.lastRealSol !== null && update.realSolReserves === entry.lastRealSol
    ) {
      return; // duplicate
    }

    if (update.complete) entry.completed = true;
    if (typeof update.slot === 'number' && update.slot > entry.lastSlot) {
      entry.lastSlot = update.slot;
    }

    // Stage 11: most recent curve price wins (baseline included — the price
    // is valid even before a delta-derived event exists).
    if (typeof update.priceInSol === 'number' && Number.isFinite(update.priceInSol) && update.priceInSol > 0) {
      entry.lastPriceInSol = update.priceInSol;
    }
    if (typeof update.marketCapSol === 'number' && Number.isFinite(update.marketCapSol) && update.marketCapSol > 0) {
      entry.lastMarketCapSol = update.marketCapSol;
    }

    if (entry.lastRealSol === null) {
      // Baseline — no event derivable yet, but the feed is alive.
      entry.lastRealSol = update.realSolReserves;
      entry.curveUpdates++;
      return;
    }

    const delta = update.realSolReserves - entry.lastRealSol;
    entry.lastRealSol = update.realSolReserves;
    entry.curveUpdates++;
    if (delta > 0) {
      entry.buyEvents++;
      entry.netInflowSol += delta;
    } else if (delta < 0) {
      entry.sellEvents++;
      entry.netInflowSol += delta; // negative — net outflow
    }

    this.checkEarlyExitCurve(mint, entry);
  }

  getMints(): string[] {
    return [...this.observed.keys()];
  }

  size(): number {
    return this.observed.size;
  }

  /** Run one evaluation pass immediately (tests; the 1s timer calls it too). */
  evaluateNow(): void {
    this.evaluate();
  }

  private checkEarlyExit(mint: string, entry: ObservedToken): void {
    const elapsedSec = (this.now() - entry.registeredAt) / 1000;
    if (elapsedSec < 5) return; // need at least 5s of data

    const totalTrades = entry.buyCount + entry.sellCount;
    if (totalTrades === 0) return;

    const uniqueBuyers = entry.buyers.size;
    const buyRatio = entry.buyCount / totalTrades;
    const solVelocity = (entry.totalBuySol + entry.totalSellSol) / elapsedSec;

    if (
      uniqueBuyers >= CONFIG.PUMP_MIN_UNIQUE_BUYERS &&
      buyRatio >= CONFIG.PUMP_MIN_BUY_RATIO &&
      solVelocity >= CONFIG.PUMP_MIN_SOL_VELOCITY
    ) {
      // All thresholds met — emit immediately
      const result: ObservationResult = { passed: true, reason: null, uniqueBuyers, buyRatio, solVelocity, mode: 'pumpportal', lastPriceInSol: entry.lastPriceInSol, lastMarketCapSol: entry.lastMarketCapSol };
      this.observed.delete(mint);
      if (this.resultCallback) {
        this.resultCallback(entry.token, result);
      }
    }
  }

  private checkEarlyExitCurve(mint: string, entry: ObservedToken): void {
    const elapsedSec = (this.now() - entry.registeredAt) / 1000;
    if (elapsedSec < 5) return;

    const totalEvents = entry.buyEvents + entry.sellEvents;
    if (totalEvents === 0) return;

    const buyRatio = entry.buyEvents / totalEvents;
    const solVelocity = entry.netInflowSol / elapsedSec;

    if (
      entry.buyEvents >= CONFIG.PUMP_MIN_BUY_EVENTS &&
      buyRatio >= CONFIG.PUMP_MIN_BUY_RATIO &&
      solVelocity >= CONFIG.PUMP_MIN_SOL_VELOCITY &&
      !entry.completed
    ) {
      const result: ObservationResult = {
        passed: true,
        reason: null,
        uniqueBuyers: entry.buyEvents,
        buyRatio,
        solVelocity,
        mode: 'curve',
        lastPriceInSol: entry.lastPriceInSol,
        lastMarketCapSol: entry.lastMarketCapSol,
      };
      this.observed.delete(mint);
      if (this.resultCallback) {
        this.resultCallback(entry.token, result);
      }
    }
  }

  private evaluate(): void {
    const now = this.now();
    const windowMs = CONFIG.PUMP_OBSERVE_SECONDS * 1000;
    const safetyMs = windowMs * 2;

    for (const [mint, entry] of this.observed) {
      const elapsed = now - entry.registeredAt;

      // Safety cleanup
      if (elapsed >= safetyMs) {
        this.observed.delete(mint);
        logger.warn(`Observer safety cleanup: ${mint.slice(0, 8)}... (exceeded ${safetyMs / 1000}s)`);
        continue;
      }

      // Evaluate when window expires
      if (elapsed >= windowMs) {
        this.observed.delete(mint);
        const result = this.evaluateToken(entry, elapsed / 1000);
        if (this.resultCallback) {
          this.resultCallback(entry.token, result);
        }
      }
    }
  }

  private evaluateToken(entry: ObservedToken, elapsedSec: number): ObservationResult {
    // Curve data present → curve semantics (unique buyers not observable;
    // the buyers threshold becomes buy EVENTS).
    if (entry.curveUpdates > 0) {
      return this.evaluateCurve(entry, elapsedSec);
    }

    // No curve data and no trades at all → the feed delivered nothing.
    // accountSubscribe only emits on change, so zero updates can also mean
    // the token simply had no trades (distinct from a 0-buyer market verdict).
    const totalTrades = entry.buyCount + entry.sellCount;
    if (totalTrades === 0) {
      const secs = Math.round(elapsedSec);
      return {
        passed: false,
        reason: `no_data [${entry.feedMode}]: 0 curve updates in ${secs}s (no trades, or a feed gap)`,
        uniqueBuyers: 0,
        buyRatio: 0,
        solVelocity: 0,
        mode: entry.feedMode,
        noData: true,
        lastPriceInSol: entry.lastPriceInSol,
        lastMarketCapSol: entry.lastMarketCapSol,
      };
    }

    // PumpPortal-mode semantics (unchanged).
    const uniqueBuyers = entry.buyers.size;
    const buyRatio = entry.buyCount / totalTrades;
    const solVelocity = elapsedSec > 0 ? (entry.totalBuySol + entry.totalSellSol) / elapsedSec : 0;

    const reasons: string[] = [];
    if (uniqueBuyers < CONFIG.PUMP_MIN_UNIQUE_BUYERS) {
      reasons.push(`${uniqueBuyers} buyers (need ${CONFIG.PUMP_MIN_UNIQUE_BUYERS})`);
    }
    if (buyRatio < CONFIG.PUMP_MIN_BUY_RATIO) {
      reasons.push(`${(buyRatio * 100).toFixed(0)}% buy ratio (need ${CONFIG.PUMP_MIN_BUY_RATIO * 100}%)`);
    }
    if (solVelocity < CONFIG.PUMP_MIN_SOL_VELOCITY) {
      reasons.push(`${solVelocity.toFixed(3)} SOL/s (need ${CONFIG.PUMP_MIN_SOL_VELOCITY})`);
    }

    return {
      passed: reasons.length === 0,
      reason: reasons.length > 0 ? reasons.join(', ') : null,
      uniqueBuyers,
      buyRatio,
      solVelocity,
      mode: 'pumpportal',
      lastPriceInSol: entry.lastPriceInSol,
      lastMarketCapSol: entry.lastMarketCapSol,
    };
  }

  private evaluateCurve(entry: ObservedToken, elapsedSec: number): ObservationResult {
    const totalEvents = entry.buyEvents + entry.sellEvents;
    const buyRatio = totalEvents > 0 ? entry.buyEvents / totalEvents : 0;
    const solVelocity = elapsedSec > 0 ? entry.netInflowSol / elapsedSec : 0;

    const reasons: string[] = [];
    if (entry.completed) {
      reasons.push('[curve] bonding curve completed (migrated — no longer tradable on the curve)');
    }
    if (entry.buyEvents < CONFIG.PUMP_MIN_BUY_EVENTS) {
      reasons.push(`[curve] ${entry.buyEvents} buy events (need ${CONFIG.PUMP_MIN_BUY_EVENTS}; unique buyers not observable from account state)`);
    }
    if (buyRatio < CONFIG.PUMP_MIN_BUY_RATIO) {
      reasons.push(`[curve] ${(buyRatio * 100).toFixed(0)}% buy ratio (need ${CONFIG.PUMP_MIN_BUY_RATIO * 100}%)`);
    }
    if (solVelocity < CONFIG.PUMP_MIN_SOL_VELOCITY) {
      reasons.push(`[curve] ${solVelocity.toFixed(3)} SOL/s net inflow (need ${CONFIG.PUMP_MIN_SOL_VELOCITY})`);
    }

    return {
      passed: reasons.length === 0,
      reason: reasons.length > 0 ? reasons.join(', ') : null,
      uniqueBuyers: entry.buyEvents,
      buyRatio,
      solVelocity,
      mode: 'curve',
      lastPriceInSol: entry.lastPriceInSol,
      lastMarketCapSol: entry.lastMarketCapSol,
    };
  }
}
