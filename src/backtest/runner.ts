/**
 * Backtest Runner
 * Monte Carlo simulation of TP/SL strategy against realistic pump.fun price paths.
 * Scenarios weighted based on real pump.fun token behavior.
 */

export interface BacktestConfig {
  tp1Percent: number;
  tp1SellPercent: number;
  tp2Percent: number;
  slPercent: number;
  maxHoldMinutes: number;
  buyAmountSol: number;
  numTokens: number;
}

export interface BacktestTrade {
  symbol: string;
  scenario: 'dead' | 'dump' | 'pump' | 'moon';
  pnlPercent: number;   // weighted avg across legs
  pnlSol: number;
  exitReason: string;
  holdMinutes: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlSol: number;
  avgPnlPercent: number;
  avgWinPercent: number;
  avgLossPercent: number;
  bestTrade: BacktestTrade;
  worstTrade: BacktestTrade;
  trades: BacktestTrade[];
  byScenario: Record<string, { count: number; wins: number; avgPnl: number }>;
  expectancy: number; // avg SOL per trade (positive = profitable)
}

// ─── Price path generator ──────────────────────────────────────────

type Scenario = 'dead' | 'dump' | 'pump' | 'moon';

// Weighted distribution based on real pump.fun behavior
const SCENARIO_WEIGHTS: [Scenario, number][] = [
  ['dead', 0.35],  // 35% die immediately / slow bleed
  ['dump', 0.40],  // 40% pump briefly then dump hard
  ['pump', 0.20],  // 20% good pump, may hit TP
  ['moon', 0.05],  // 5% moonshot
];

function pickScenario(): Scenario {
  const r = Math.random();
  let acc = 0;
  for (const [scenario, weight] of SCENARIO_WEIGHTS) {
    acc += weight;
    if (r < acc) return scenario;
  }
  return 'dead';
}

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

/**
 * Generate normalized price ticks (1.0 = entry price).
 * tickIntervalSec = 3s (matches our new 3s monitor loop).
 * maxMinutes = maxHoldMinutes.
 */
function generatePricePath(scenario: Scenario, maxMinutes: number): number[] {
  const ticksPerMin = 60 / 3; // 20 ticks per minute
  const totalTicks  = Math.floor(maxMinutes * ticksPerMin);
  const prices: number[] = [1.0];

  switch (scenario) {
    case 'dead': {
      // Immediate or slow bleed to near zero
      const dumpStart = Math.floor(rand(0, totalTicks * 0.3));
      const floor     = rand(0.02, 0.20);
      for (let i = 1; i <= totalTicks; i++) {
        const prev  = prices[i - 1];
        const decay = i > dumpStart ? rand(0.97, 0.995) : rand(0.995, 1.005);
        prices.push(Math.max(floor, prev * decay));
      }
      break;
    }

    case 'dump': {
      // Quick pump then hard dump
      const peakTick   = Math.floor(rand(5, totalTicks * 0.25));
      const peakMult   = rand(1.15, 2.5);
      const dumpFloor  = rand(0.05, 0.45);
      for (let i = 1; i <= totalTicks; i++) {
        const prev = prices[i - 1];
        if (i <= peakTick) {
          // Pump phase
          const step = (peakMult - 1.0) / peakTick;
          prices.push(prev * (1 + step + rand(-0.02, 0.02)));
        } else {
          // Dump phase
          const progress = (i - peakTick) / (totalTicks - peakTick);
          const target   = peakMult - (peakMult - dumpFloor) * progress;
          prices.push(Math.max(dumpFloor, prev * rand(0.96, 0.99) + (target - prev) * 0.1));
        }
      }
      break;
    }

    case 'pump': {
      // Healthy pump with volatility
      const peakTick  = Math.floor(rand(totalTicks * 0.2, totalTicks * 0.6));
      const peakMult  = rand(1.3, 4.0);
      const endMult   = rand(0.5, peakMult * 0.8);
      for (let i = 1; i <= totalTicks; i++) {
        const prev     = prices[i - 1];
        const progress = i / totalTicks;
        let target: number;
        if (i <= peakTick) {
          target = 1 + (peakMult - 1) * (i / peakTick);
        } else {
          const t2 = (i - peakTick) / (totalTicks - peakTick);
          target = peakMult - (peakMult - endMult) * t2;
        }
        const noise = rand(-0.04, 0.04);
        prices.push(Math.max(0.05, prev + (target - prev) * 0.15 + prev * noise));
      }
      break;
    }

    case 'moon': {
      // Sustained uptrend
      const finalMult = rand(4.0, 20.0);
      for (let i = 1; i <= totalTicks; i++) {
        const prev     = prices[i - 1];
        const progress = i / totalTicks;
        const target   = 1 + (finalMult - 1) * Math.pow(progress, 0.7);
        const noise    = rand(-0.03, 0.05);
        prices.push(Math.max(0.1, prev + (target - prev) * 0.08 + prev * noise));
      }
      break;
    }
  }

  return prices;
}

// ─── Simulate one token ────────────────────────────────────────────

function simulateToken(
  symbol: string,
  scenario: Scenario,
  cfg: BacktestConfig,
): BacktestTrade {
  const prices     = generatePricePath(scenario, cfg.maxHoldMinutes);
  const tickSec    = 3;
  const tickPerMin = 60 / tickSec;

  let tp1Hit        = false;
  let remainingPct  = 1.0; // fraction of position still open
  let realizedPnl   = 0;   // in SOL
  let exitReason    = `max-hold-${cfg.maxHoldMinutes}min`;
  let exitTick      = prices.length - 1;
  let exitPrice     = prices[exitTick];

  for (let i = 1; i < prices.length; i++) {
    const price  = prices[i];
    const pnlPct = (price - 1.0) / 1.0 * 100;

    // TP1
    if (!tp1Hit && pnlPct >= cfg.tp1Percent) {
      const sellFrac  = cfg.tp1SellPercent / 100;
      const soldSol   = cfg.buyAmountSol * sellFrac;
      realizedPnl    += soldSol * (pnlPct / 100);
      remainingPct   -= sellFrac;
      tp1Hit          = true;
      exitReason      = `TP1 +${cfg.tp1Percent}% (partial)`;
    }

    // TP2 / full close
    if (tp1Hit && pnlPct >= cfg.tp2Percent && remainingPct > 0) {
      const soldSol = cfg.buyAmountSol * remainingPct;
      realizedPnl  += soldSol * (pnlPct / 100);
      remainingPct  = 0;
      exitReason    = `TP2 +${cfg.tp2Percent}%`;
      exitTick      = i;
      exitPrice     = price;
      break;
    }

    // SL (only before TP1)
    if (!tp1Hit && pnlPct <= -cfg.slPercent) {
      const soldSol = cfg.buyAmountSol * remainingPct;
      realizedPnl  += soldSol * (pnlPct / 100);
      remainingPct  = 0;
      exitReason    = `SL -${cfg.slPercent}%`;
      exitTick      = i;
      exitPrice     = price;
      break;
    }

    // Trailing SL after TP1: exit at breakeven
    if (tp1Hit && remainingPct > 0 && pnlPct <= 0) {
      const soldSol = cfg.buyAmountSol * remainingPct;
      realizedPnl  += soldSol * (pnlPct / 100);
      remainingPct  = 0;
      exitReason    = `trailing-SL`;
      exitTick      = i;
      exitPrice     = price;
      break;
    }
  }

  // Close remaining at max-hold expiry
  if (remainingPct > 0) {
    const finalPnlPct = (exitPrice - 1.0) / 1.0 * 100;
    realizedPnl += cfg.buyAmountSol * remainingPct * (finalPnlPct / 100);
  }

  const holdMinutes = (exitTick * tickSec) / 60;
  const pnlPercent  = (realizedPnl / cfg.buyAmountSol) * 100;

  return { symbol, scenario, pnlPercent, pnlSol: realizedPnl, exitReason, holdMinutes };
}

// ─── Run backtest ──────────────────────────────────────────────────

export function runBacktest(cfg: BacktestConfig): BacktestResult {
  const trades: BacktestTrade[] = [];
  const byScenario: Record<string, { count: number; wins: number; totalPnl: number }> = {};

  for (let i = 0; i < cfg.numTokens; i++) {
    const scenario = pickScenario();
    const symbol   = `SIM${i + 1}`;
    const trade    = simulateToken(symbol, scenario, cfg);
    trades.push(trade);

    if (!byScenario[scenario]) byScenario[scenario] = { count: 0, wins: 0, totalPnl: 0 };
    byScenario[scenario].count++;
    byScenario[scenario].totalPnl += trade.pnlSol;
    if (trade.pnlSol > 0) byScenario[scenario].wins++;
  }

  const wins        = trades.filter(t => t.pnlSol > 0).length;
  const losses      = trades.length - wins;
  const totalPnlSol = trades.reduce((s, t) => s + t.pnlSol, 0);
  const avgPnlPct   = trades.reduce((s, t) => s + t.pnlPercent, 0) / trades.length;
  const winTrades   = trades.filter(t => t.pnlSol > 0);
  const lossTrades  = trades.filter(t => t.pnlSol <= 0);
  const avgWinPct   = winTrades.length  ? winTrades.reduce((s, t)  => s + t.pnlPercent, 0) / winTrades.length  : 0;
  const avgLossPct  = lossTrades.length ? lossTrades.reduce((s, t) => s + t.pnlPercent, 0) / lossTrades.length : 0;

  const sorted    = [...trades].sort((a, b) => b.pnlSol - a.pnlSol);
  const bestTrade = sorted[0];
  const worstTrade= sorted[sorted.length - 1];

  return {
    config: cfg,
    totalTrades:   trades.length,
    wins,
    losses,
    winRate:       (wins / trades.length) * 100,
    totalPnlSol,
    avgPnlPercent: avgPnlPct,
    avgWinPercent: avgWinPct,
    avgLossPercent: avgLossPct,
    bestTrade,
    worstTrade,
    trades,
    byScenario: Object.fromEntries(
      Object.entries(byScenario).map(([k, v]) => [
        k, { count: v.count, wins: v.wins, avgPnl: v.totalPnl / v.count },
      ]),
    ),
    expectancy: totalPnlSol / trades.length,
  };
}
