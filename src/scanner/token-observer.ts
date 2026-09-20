import { CONFIG } from '../config';
import { logger } from '../utils/logger';
import { NewPumpToken } from './pumpfun.listener';

export interface ObservedToken {
  mint: string;
  token: NewPumpToken;
  registeredAt: number;
  buyers: Set<string>;
  buyCount: number;
  sellCount: number;
  totalBuySol: number;
  totalSellSol: number;
}

export interface ObservationResult {
  passed: boolean;
  reason: string | null;
  uniqueBuyers: number;
  buyRatio: number;
  solVelocity: number;
}

type ResultCallback = (token: NewPumpToken, result: ObservationResult) => void;

export class TokenObserver {
  private observed = new Map<string, ObservedToken>();
  private resultCallback: ResultCallback | null = null;
  private evalTimer: NodeJS.Timeout | null = null;

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
      registeredAt: Date.now(),
      buyers: new Set(),
      buyCount: 0,
      sellCount: 0,
      totalBuySol: 0,
      totalSellSol: 0,
    });

    return true;
  }

  has(mint: string): boolean {
    return this.observed.has(mint);
  }

  onTrade(mint: string, txType: 'buy' | 'sell', traderPublicKey: string, solAmount: number): void {
    const entry = this.observed.get(mint);
    if (!entry) return;

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

  getMints(): string[] {
    return [...this.observed.keys()];
  }

  size(): number {
    return this.observed.size;
  }

  private checkEarlyExit(mint: string, entry: ObservedToken): void {
    const elapsedSec = (Date.now() - entry.registeredAt) / 1000;
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
      const result: ObservationResult = { passed: true, reason: null, uniqueBuyers, buyRatio, solVelocity };
      this.observed.delete(mint);
      if (this.resultCallback) {
        this.resultCallback(entry.token, result);
      }
    }
  }

  private evaluate(): void {
    const now = Date.now();
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
    const totalTrades = entry.buyCount + entry.sellCount;
    const uniqueBuyers = entry.buyers.size;
    const buyRatio = totalTrades > 0 ? entry.buyCount / totalTrades : 0;
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
    };
  }
}
