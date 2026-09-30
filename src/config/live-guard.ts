/**
 * LIVE-mode guard (Stage 9b-A).
 *
 * Pure helpers so they can be unit-tested without touching CONFIG or .env.
 * The lead wires enforceStartupMode() into src/index.ts startup.
 */

export const LIVE_LOCK_MESSAGE =
  'Mode LIVE dikunci: set LIVE_TRADING_ALLOWED=true di .env lalu restart';

/** Null = transition allowed. String = user-facing rejection (Indonesian). */
export function liveModeBlocked(requestedPaper: boolean, allowed: boolean): string | null {
  if (requestedPaper) return null;
  if (allowed) return null;
  return LIVE_LOCK_MESSAGE;
}

/**
 * Force paper mode at startup when LIVE is requested but not unlocked.
 * Mutates `config.PAPER_TRADING = true` and reports forced:true + warning.
 */
export function enforceStartupMode(config: {
  PAPER_TRADING: boolean;
  LIVE_TRADING_ALLOWED: boolean;
}): { forced: boolean; message: string | null } {
  if (!config.PAPER_TRADING && !config.LIVE_TRADING_ALLOWED) {
    config.PAPER_TRADING = true;
    return {
      forced: true,
      message: `⚠️ ${LIVE_LOCK_MESSAGE} — tetap di PAPER.`,
    };
  }
  return { forced: false, message: null };
}
