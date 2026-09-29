/**
 * Pure exit-rule evaluation for pump-fun / tweet-sniper positions.
 *
 * No I/O, no CONFIG import — all thresholds are passed in via ExitConfig
 * so both the realtime trade callback and the 3s poll loop share one
 * implementation with identical priority order.
 *
 * Priority (matches src/index.ts):
 *  (a) none if !AUTO_SELL or isSelling
 *  (b) TP1 when !tp1Hit && pnl >= TP1
 *  (c) TP2 when (tp1Hit && !tp2Hit && !TRAILING_TP_ENABLED && pnl >= TP2)
 *       OR (!tp1Hit && pnl >= TP2)   [fallback: gapped past TP2]
 *  (d) SL when !tp1Hit && !tp2Hit && pnl <= -min(STOP_LOSS_PERCENT, 25)
 *  (e) after TP1 (tp1Hit && !tp2Hit):
 *        trailing-sl when pnl <= 0
 *        trailing-tp when TRAILING_TP_ENABLED && pnl > 0 &&
 *          pnl <= max(0, peak - TRAILING_TP_DROP_PERCENT)
 */

export interface ExitConfig {
  AUTO_SELL: boolean;
  TP1_PERCENT: number;
  TP2_PERCENT: number;
  STOP_LOSS_PERCENT: number;
  TRAILING_TP_ENABLED: boolean;
  TRAILING_TP_DROP_PERCENT: number;
}

export interface ExitState {
  tp1Hit: boolean;
  tp2Hit: boolean;
  isSelling: boolean;
  peakPnlPercent?: number;
}

export type ExitAction =
  | { action: 'none' }
  | { action: 'tp1' }
  | { action: 'tp2' }
  | { action: 'sl'; reason: string }
  | { action: 'trailing-sl'; reason: string }
  | { action: 'trailing-tp'; reason: string };

/** Record the highest PnL seen. Monotonic non-decreasing. */
export function updatePeak(state: ExitState, pnl: number): void {
  state.peakPnlPercent = Math.max(state.peakPnlPercent ?? pnl, pnl);
}

export function evaluateExit(state: ExitState, pnl: number, cfg: ExitConfig): ExitAction {
  // (a) master gates
  if (!cfg.AUTO_SELL || state.isSelling) return { action: 'none' };

  // (b) TP1
  if (!state.tp1Hit && pnl >= cfg.TP1_PERCENT) return { action: 'tp1' };

  // (c) TP2 (incl. fallback gap-jump without TP1)
  if (
    (state.tp1Hit && !state.tp2Hit && !cfg.TRAILING_TP_ENABLED && pnl >= cfg.TP2_PERCENT) ||
    (!state.tp1Hit && pnl >= cfg.TP2_PERCENT)
  ) {
    return { action: 'tp2' };
  }

  // (d) Stop loss — capped at 25% (matches Math.min(STOP_LOSS_PERCENT, 25))
  const effectiveStopLoss = Math.min(cfg.STOP_LOSS_PERCENT, 25);
  if (!state.tp1Hit && !state.tp2Hit && pnl <= -effectiveStopLoss) {
    return { action: 'sl', reason: `SL -${effectiveStopLoss}%` };
  }

  // (e) Post-TP1 trailing exits
  if (state.tp1Hit && !state.tp2Hit) {
    if (pnl <= 0) {
      return { action: 'trailing-sl', reason: 'trailing-SL after TP1' };
    }
    if (cfg.TRAILING_TP_ENABLED) {
      const peak = state.peakPnlPercent ?? pnl;
      if (pnl <= Math.max(0, peak - cfg.TRAILING_TP_DROP_PERCENT)) {
        return { action: 'trailing-tp', reason: `trailing-TP (peak +${peak.toFixed(0)}%)` };
      }
    }
  }

  return { action: 'none' };
}
