/**
 * Pure in-memory PAPER trading ledger, denominated in SOL.
 *
 * No I/O, never throws, never NaN, cash can never go negative.
 * Realized history is rebuilt from persisted Trade rows via fromTrades();
 * open (unrealized) positions are folded in by equity().
 */

export interface LedgerTradeRow {
  type: string;
  source: string;
  solAmount: number;
  pnlSol: number | null;
}

export interface OpenPositionInput {
  solSpent: number;
  pnlPercent: number;
}

export interface PaperEquity {
  startUsd: number;
  cashUsd: number;
  openValueUsd: number;
  equityUsd: number;
  pnlUsd: number;
  pnlPct: number;
}

/** Finite non-negative number or 0. */
function amt(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Finite number or 0 (sign preserved — for PnL). */
function num(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

export class PaperLedger {
  readonly startSol: number;
  private cash: number;

  constructor(startSol: number, cashSol?: number) {
    this.startSol = amt(startSol);
    this.cash = cashSol === undefined ? this.startSol : amt(cashSol);
  }

  get cashSol(): number {
    return this.cash;
  }

  canAfford(sol: number): boolean {
    if (!Number.isFinite(sol) || sol <= 0) return false;
    return sol <= this.cash;
  }

  /** Subtract `sol` when affordable; returns false (no change) otherwise. */
  debit(sol: number): boolean {
    if (!this.canAfford(sol)) return false;
    const next = this.cash - sol;
    this.cash = next < 0 ? 0 : next;
    return true;
  }

  /** Add `sol`; ignores non-finite or negative amounts. */
  credit(sol: number): void {
    if (!Number.isFinite(sol) || sol < 0) return;
    this.cash += sol;
  }

  /**
   * Rebuild a ledger from persisted Trade rows.
   * SELL rows store the cost basis sold in solAmount and the profit in
   * pnlSol, so proceeds = solAmount + pnlSol.
   * Only rows with source === 'paper' are counted.
   */
  static fromTrades(startSol: number, trades: LedgerTradeRow[]): PaperLedger {
    let cash = amt(startSol);
    for (const t of trades) {
      if (t?.source !== 'paper') continue;
      if (t.type === 'BUY') {
        cash -= amt(t.solAmount);
      } else if (t.type === 'SELL') {
        const proceeds = amt(t.solAmount) + num(t.pnlSol);
        cash += Math.max(0, proceeds);
      }
    }
    return new PaperLedger(startSol, Math.max(0, cash));
  }

  /** Equity snapshot in USD using this ledger's cash and start. */
  equity(openPositions: OpenPositionInput[], solPriceUsd: number): PaperEquity {
    return equity(this.cash, openPositions, solPriceUsd, this.startSol);
  }
}

/**
 * Pure equity math in USD.
 * - cashUsd      = cashSol * price
 * - openValueUsd = Σ solSpent * (1 + pnlPercent/100) * price
 * - equityUsd    = cashUsd + openValueUsd
 * - pnlUsd       = equityUsd - startUsd (startUsd = startSol * price)
 * - pnlPct       = pnlUsd / startUsd * 100 (0 when startUsd <= 0)
 */
export function equity(
  cashSol: number,
  openPositions: OpenPositionInput[],
  solPriceUsd: number,
  startSol: number,
): PaperEquity {
  const price = amt(solPriceUsd);
  const cash = amt(cashSol);
  const start = amt(startSol);
  let openValueSol = 0;
  if (Array.isArray(openPositions)) {
    for (const p of openPositions) {
      const spent = amt(p?.solSpent);
      const pct = num(p?.pnlPercent);
      openValueSol += spent * (1 + pct / 100);
    }
  }
  if (!(openValueSol >= 0)) openValueSol = 0;
  const startUsd = start * price;
  const cashUsd = cash * price;
  const openValueUsd = openValueSol * price;
  const equityUsd = cashUsd + openValueUsd;
  const pnlUsd = equityUsd - startUsd;
  const pnlPct = startUsd > 0 ? (pnlUsd / startUsd) * 100 : 0;
  return {
    startUsd: Number.isFinite(startUsd) ? startUsd : 0,
    cashUsd: Number.isFinite(cashUsd) ? cashUsd : 0,
    openValueUsd: Number.isFinite(openValueUsd) ? openValueUsd : 0,
    equityUsd: Number.isFinite(equityUsd) ? equityUsd : 0,
    pnlUsd: Number.isFinite(pnlUsd) ? pnlUsd : 0,
    pnlPct: Number.isFinite(pnlPct) ? pnlPct : 0,
  };
}
