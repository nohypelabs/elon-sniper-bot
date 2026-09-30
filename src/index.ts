import { Connection } from '@solana/web3.js';
import { CONFIG } from './config';
import { enforceStartupMode } from './config/live-guard';
import { logger } from './utils/logger';
import { decryptKey } from './utils/wallet.crypto';
import { TweetMonitor, Tweet } from './monitor/tweet.monitor';
import { TokenFinder, FoundToken } from './scanner/token.finder';
import { GmgnSwap } from './swap/gmgn.swap';
import { JupiterSwap, SwapResult } from './swap/jupiter.swap';
import * as telegram from './telegram/bot';
import { closeDb, initDb, logEvent } from './db/client';
import {
  deletePosition,
  findLatestBuyBefore,
  insertTrade,
  listPositions,
  listRecentSells,
  listSellSummaries,
  updatePositionState,
  upsertPosition,
  getPaperAccount,
  createPaperAccount,
  listPaperTradesForLedger,
} from './db/repo';
import { rowToActivePosition } from './strategy/position-restore';
import {
  startDashboardServer,
  stopDashboardServer,
  registerDashboardHandlers,
  broadcastState,
  BotState,
  ActivePositionInfo,
} from './dashboard/server';
import { computeBuySol } from './paper/sizing';
import { PaperLedger } from './paper/ledger';
import { PumpFunListener, NewPumpToken } from './scanner/pumpfun.listener';
import { updatePeak, evaluateExit } from './strategy/exit-rules';
import {
  canAttemptSell,
  isPlaceholder,
  recordSellFailure,
  recordSellSuccess,
  shouldAlertSellFailure,
} from './strategy/sell-guard';
import { refreshEntry } from './strategy/entry-price';
import { slippagePercent, type Trace } from './metrics/latency';
import {
  eventLoopMonitor,
  latencyStats,
  persistTrace,
  recordTraceSegments,
  traceRecorder,
} from './metrics/store';
import { renderLatency } from './telegram/latency-render';

interface ActivePosition {
  token: FoundToken;
  buyResult: SwapResult;
  entryTime: number;
  entryPriceUsd: number;
  currentPriceUsd: number;
  solSpent: number;
  remainingTokens: number; // tracks partial sells
  tp1Hit: boolean;
  tp2Hit: boolean;
  isSelling: boolean;  // prevent double-sell race condition
  sellFailures: number; // consecutive sell failures (see sell-guard.ts)
  nextSellAttemptAt: number; // epoch ms gate for the next sell attempt
  moonbag: boolean; // true once a TP2-with-moonbag sell kept a remainder
  peakPnlPercent?: number; // highest PnL seen, for trailing TP
  tweetText?: string;
}

// ─── Sell single-flight claim protocol (Stage 9a fix B) ───────────
// Exactly one seller may own a position at a time. The realtime trade
// callback and the 3s poll loop (plus manual Telegram/dashboard sells and
// the honeypot emergency sell) all funnel through runTp1Sell /
// executeTp2TakeProfit / runFullSell, which implement this protocol:
//
//  1. Synchronously verify the position is still live
//     (`activePositions.get(mint) === position`) and unclaimed
//     (`!position.isSelling`), and that the sell backoff gate has expired
//     (`canAttemptSell`). Manual sells skip only the backoff gate.
//  2. Synchronously set `position.isSelling = true` BEFORE any await.
//     Because JS runs each synchronous prefix atomically, the first
//     claimant wins and every other path sees `isSelling` and backs off —
//     the poll loop and the realtime callback can never sell the same
//     position twice, even though the poll loop awaits (DexScreener) between
//     observing a price and deciding to sell: it re-checks (1) after every
//     such await before claiming.
//  3. On success the executors (executeSell / executePartialSell) persist
//     the trade and mutate cost basis; the claimant then clears the failure
//     counters. On ANY failure or exception the claimant reverts the
//     optimistic flags it set (tp1Hit/tp2Hit), arms the backoff, sends the
//     scheduled Telegram alert, and releases `isSelling` in a `finally` —
//     so a failed sell never bricks the position.
// Optimistic `solSpent` scaling happens only after a confirmed success, by
// the fraction actually sold.

/** Exit-signal context carried into the sell executors for SELL traces. */
interface SellSignal {
  action: string;
  pnlPct: number;
  source: string;
}

let sellTraceCounter = 0;

// ── Stage 9b-A: LIVE-mode startup guard message ────────────────
// Set by main() via enforceStartupMode() before anything starts; consumed
// once inside start() after Telegram is available (single alert, then cleared).
let startupForcedMessage: string | null = null;

// ─── Latency instrumentation helpers ───────────────────────────
// O(1) in-memory recorder ops, always try/catch, never awaited on the hot
// path. Persistence (DB) is fire-and-forget AFTER the trade completes.
// These helpers never change trading behaviour.

function safeMark(id: string, stage: string): void {
  try { traceRecorder.mark(id, stage); } catch { /* ignore */ }
}

function safeNote(id: string, key: string, value: number | string): void {
  try { traceRecorder.note(id, key, value); } catch { /* ignore */ }
}

/** Finish a trace if still open, feed rolling stats, persist fire-and-forget. */
function completeTrace(id: string): void {
  let trace: Trace | null = null;
  try { trace = traceRecorder.finish(id); } catch { trace = null; }
  if (!trace) return;
  try { recordTraceSegments(trace); } catch { /* ignore */ }
  persistTrace(trace); // fire-and-forget, swallows all errors
}

function finishBuyTrace(mint: string, outcome: string): void {
  safeNote(mint, 'outcome', outcome);
  completeTrace(mint);
}

function noteSlippage(id: string, key: string, reference: unknown, actual: number): void {
  try {
    if (typeof reference !== 'number') return;
    const pct = slippagePercent(reference, actual);
    if (pct !== null) safeNote(id, key, pct);
  } catch { /* ignore */ }
}

/** 60s BUY-trace fallback (first-price-seen wins; timer is unref'd). */
function scheduleBuyTraceFallback(mint: string): void {
  try {
    const t = setTimeout(() => finishBuyTrace(mint, 'bought'), 60_000);
    const unref = (t as unknown as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(t);
  } catch { /* ignore */ }
}

/** Begin a SELL trace with exit_signal marked; returns the trace id. */
function beginSellTrace(mint: string, symbol: string, signal: SellSignal): string {
  const id = `${mint}:${++sellTraceCounter}`;
  try {
    traceRecorder.start(id, 'SELL', { symbol, mint });
    traceRecorder.note(id, 'action', signal.action);
    if (Number.isFinite(signal.pnlPct)) traceRecorder.note(id, 'pnlAtSignalPct', signal.pnlPct);
    traceRecorder.note(id, 'source', signal.source);
    traceRecorder.mark(id, 'exit_signal');
  } catch { /* ignore */ }
  return id;
}

function finishSellTrace(id: string, outcome: string): void {
  safeNote(id, 'outcome', outcome);
  completeTrace(id);
}

/** Synthesize a signal for sells that did not come from evaluateExit. */
function manualSellSignal(reason: string, pnlPct: number): SellSignal {
  let action = reason;
  if (reason.startsWith('manual')) action = 'manual';
  else if (reason.startsWith('honeypot')) action = 'honeypot';
  else if (reason.startsWith('TP1')) action = 'tp1';
  else if (reason.startsWith('TP2')) action = 'tp2';
  else if (reason.startsWith('max-hold')) action = 'max-hold';
  return { action, pnlPct, source: 'manual' };
}

function pnlOf(position: ActivePosition): number {
  try {
    if (!Number.isFinite(position.entryPriceUsd) || position.entryPriceUsd <= 0) return 0;
    if (!Number.isFinite(position.currentPriceUsd)) return 0;
    return ((position.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
  } catch { return 0; }
}

class ElonSniper {
  private connection: Connection;
  private tweetMonitor: TweetMonitor;
  private tokenFinder: TokenFinder;
  private gmgnSwap: GmgnSwap;
  private jupiterSwap: JupiterSwap;
  private pumpListener: PumpFunListener;

  private activePositions: Map<string, ActivePosition> = new Map();
  private startTime = 0;
  private tweetsDetected = 0;
  private buysExecuted = 0;
  private totalPnlSol = 0;
  private sessionRealizedPnlSol = 0;
  private consecutiveLosses = 0;
  private solBalance = 0;
  private paused = false;
  private solPriceUsd = CONFIG.PUMP_SOL_PRICE_USD; // live-updated by oracle loop
  private solPriceFetched = false; // true once the oracle loop fetched a price
  private paperLedger: PaperLedger | null = null;
  private paperAccountStartUsd = 0;
  private lastInsufficientCapitalAlert = 0;
  // Stage 9c: per-position throttle for peak/currentPrice DB syncs (30s).
  private lastPeakPersistAt = new Map<string, number>();

  constructor() {
    this.connection  = new Connection(CONFIG.RPC_URL, 'confirmed');
    this.tweetMonitor = new TweetMonitor();
    this.tokenFinder  = new TokenFinder();
    this.gmgnSwap     = new GmgnSwap(this.connection);
    this.jupiterSwap  = new JupiterSwap(this.connection);
    this.pumpListener = new PumpFunListener();
  }

  async start(): Promise<void> {
    this.startTime = Date.now();
    try { eventLoopMonitor.start(); } catch { /* ignore */ }

    // Decrypt stored wallet if available
    const encryptedKey = process.env.WALLET_PRIVATE_KEY_ENCRYPTED;
    if (encryptedKey) {
      try {
        const decrypted = decryptKey(encryptedKey);
        this.gmgnSwap.reloadWallet(decrypted);
        logger.info('🔑 Wallet loaded from encrypted storage');
      } catch {
        logger.warn('⚠️ Failed to decrypt stored wallet key');
      }
    }

    logger.info('='.repeat(50));
    logger.info('  ELON SNIPER BOT');
    logger.info(`  Mode: ${CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE'}`);
    logger.info(`  Swap: ${CONFIG.GMGN_API_KEY ? 'GMGN (Anti-MEV)' : 'Jupiter (fallback)'}`);
    logger.info(`  Tweet Snipe: ON`);
    logger.info(`  PumpFun Snipe: ${CONFIG.PUMP_SNIPE_ENABLED ? 'ON' : 'OFF'}`);
    logger.info(`  Buy Amount: ${CONFIG.BUY_AMOUNT_SOL} SOL`);
    if (CONFIG.PAPER_TRADING) {
      const buyUsd = CONFIG.BUY_AMOUNT_USD > 0
        ? CONFIG.BUY_AMOUNT_USD
        : CONFIG.BUY_AMOUNT_SOL * this.solPriceUsd;
      logger.info(`  Paper account: $${this.paperAccountStartUsd.toFixed(2)} start, buy $${buyUsd.toFixed(2)}/trade`);
    }
    logger.info(`  Max Positions: ${CONFIG.PUMP_MAX_POSITIONS}`);
    logger.info(`  Session Risk: max loss ${CONFIG.PUMP_MAX_SESSION_LOSS_SOL} SOL | max consecutive losses ${CONFIG.PUMP_MAX_CONSECUTIVE_LOSSES}`);
    logger.info(`  TP1: +${CONFIG.TP1_PERCENT}% (sell ${CONFIG.TP1_SELL_PERCENT}%) → TP2: +${CONFIG.TP2_PERCENT}% (close) | SL: -${CONFIG.STOP_LOSS_PERCENT}%`);
    logger.info(`  Moonbag: ${CONFIG.MOONBAG_ENABLED ? `ON (${CONFIG.MOONBAG_PERCENT}%)` : 'OFF'}`);
    logger.info('='.repeat(50));

    // Dashboard
    registerDashboardHandlers({
      getState:         () => this.getDashboardState(),
      onSell:           (mint) => this.executeSellFromDashboard(mint),
      onPause:          () => { this.paused = true;  logger.info('⏸ Bot paused from dashboard'); },
      onResume:         () => { this.paused = false; logger.info('▶ Bot resumed from dashboard'); },
      onWalletReload:   (key) => this.gmgnSwap.reloadWallet(key),
      getWalletAddress: () => this.gmgnSwap.getWalletAddress(),
    });
    await startDashboardServer();

    // Telegram
    telegram.registerHandlers({
      getStatus:       () => this.getStatusMessage(),
      onSell:          () => this.sellAllPositions(),
      onBuySelected:   (mint, symbol) => this.executeBuyFromTelegram(mint, symbol),
      onSellSelected:  (mint, symbol) => this.executeSellFromTelegram(mint, symbol),
      getHistory:      () => this.getHistoryMessage(),
      onPause:         () => { this.paused = true;  logger.info('⏸ Bot paused via Telegram'); },
      onResume:        () => { this.paused = false; logger.info('▶ Bot resumed via Telegram'); },
      getBalance:      () => this.getBalanceMessage(),
      getPnl:          () => this.getPnlMessage(),
      getLatency:      () => this.getLatencyMessage(),
      onSetMode:       async (paper: boolean) => {
        const oldMode = CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE';
        const newMode = paper ? 'PAPER' : 'LIVE';
        logger.info(`🔄 Mode switch: ${oldMode} → ${newMode}`);
        await logEvent('MODE_CHANGE', `Mode changed from ${oldMode} to ${newMode}`);
        CONFIG.PAPER_TRADING = paper;
      },
    });
    telegram.startPolling();

    // Stage 9b-A: single forced-paper warning after Telegram is available.
    if (startupForcedMessage) {
      const msg = startupForcedMessage;
      startupForcedMessage = null;
      await telegram.alertError(msg).catch(() => {});
    }

    await logEvent('START', `Bot started — mode: ${CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE'}`);
    await telegram.alertTweetDetected(
      `🤖 Bot started!\nMode: ${CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE'}\nMonitoring @elonmusk tweets...`,
      [],
    );

    // Tweet sniper (always on)
    this.tweetMonitor.onNewTweet((tweet) => this.handleNewTweet(tweet));

    // PumpFun new token sniper (opt-in)
    if (CONFIG.PUMP_SNIPE_ENABLED) {
      this.pumpListener.onNewToken((token) => this.handleNewPumpToken(token));
      this.pumpListener.start();
      await logEvent('START', 'PumpFun sniper enabled', {
        minDevBuy: CONFIG.PUMP_MIN_DEV_BUY_SOL,
        maxDevBuy: CONFIG.PUMP_MAX_DEV_BUY_SOL,
        maxMcapSol: CONFIG.PUMP_MAX_MCAP_SOL,
        securityCheck: CONFIG.PUMP_SECURITY_CHECK,
        fastMode: CONFIG.PUMP_FAST_MODE,
      });
    }

    this.monitorPositionsLoop();
    this.refreshSolBalanceLoop();
    this.refreshSolPriceLoop();
    await this.tweetMonitor.start();
  }

  // ─── PumpFun new token handler ────────────────────────────────

  private async handleNewPumpToken(token: NewPumpToken): Promise<void> {
    // Latency trace starts at the true WS arrival time carried on the event.
    const buyId = token.mint;
    try {
      traceRecorder.start(buyId, 'BUY', { symbol: token.symbol, mint: token.mint }, token.receivedAtMono);
      traceRecorder.note(buyId, 'signalPriceUsd', token.initialPriceSol * this.solPriceUsd);
      traceRecorder.note(buyId, 'paper', CONFIG.PAPER_TRADING ? 1 : 0);
    } catch { /* ignore */ }

    if (this.paused) { finishBuyTrace(buyId, 'paused'); return; }

    // Enforce max concurrent positions
    if (this.activePositions.size >= CONFIG.PUMP_MAX_POSITIONS) {
      logger.debug(`Max positions (${CONFIG.PUMP_MAX_POSITIONS}) reached — skipping ${token.symbol}`);
      finishBuyTrace(buyId, 'max_positions');
      return;
    }

    // Already holding this mint
    if (this.activePositions.has(token.mint)) { finishBuyTrace(buyId, 'filtered'); return; }

    // Already holding same symbol (different mint — dedup)
    const symbolHeld = [...this.activePositions.values()].some(
      p => p.token.symbol.toLowerCase() === token.symbol.toLowerCase()
    );
    if (symbolHeld) {
      logger.debug(`⏭ Symbol already held: ${token.symbol} — skipping duplicate`);
      finishBuyTrace(buyId, 'filtered');
      return;
    }

    // Mark position as pending to prevent race conditions
    this.activePositions.set(token.mint, {
      token: null as any,
      buyResult: null as any,
      entryTime: Date.now(),
      entryPriceUsd: 0,
      currentPriceUsd: 0,
      solSpent: 0,
      remainingTokens: 0,
      tp1Hit: false,
      tp2Hit: false,
      isSelling: true, // Lock while buying
      sellFailures: 0,
      nextSellAttemptAt: 0,
      moonbag: false,
      tweetText: `PumpFun snipe: ${token.name}`,
    });
    safeMark(buyId, 'filters_passed');

    // (E) Ghost-placeholder guard: every early return and every exception
    // below runs this finally. If the map entry for this mint is still the
    // buy-pending placeholder (buyResult/token never assigned because the
    // buy path bailed out — honeypot skip, rejection, pause, max-positions,
    // buy failure, or a throw), it is deleted so it can never brick the
    // mint/symbol or consume a MAX_POSITIONS slot forever. A completed buy
    // replaces the entry with a real position, which is left untouched.
    // (The approval block keeps its own cleanup; this is the outer net.)
    try {
    logger.info(`🎯 PumpFun snipe candidate: ${token.symbol} (${token.mint.slice(0, 8)}) | dev: ${token.initialBuySol} SOL | mcap: ${token.marketCapSol} SOL`);

    await logEvent('TOKEN_FOUND', `PumpFun: ${token.symbol} | dev ${token.initialBuySol} SOL | mcap ${token.marketCapSol} SOL`, {
      mint: token.mint, creator: token.creatorWallet,
      initialBuySol: token.initialBuySol, marketCapSol: token.marketCapSol,
    });

    const foundToken: FoundToken = {
      mintAddress:    token.mint,
      symbol:         token.symbol,
      name:           token.name,
      priceUsd:       token.initialPriceSol * this.solPriceUsd,
      mcapUsd:        token.marketCapSol * this.solPriceUsd,
      liquidity:      token.marketCapSol * this.solPriceUsd,
      volume24h:      0,
      pairAddress:    token.bondingCurveKey,
      dex:            'pump.fun',
      ageMinutes:     0,
      matchedKeyword: 'pump-snipe',
      url:            `https://pump.fun/coin/${token.mint}`,
    };

    if (CONFIG.BUY_APPROVAL_ENABLED) {
      // Track the live trade price during the approval wait so the entry can
      // be re-priced — the snapshot above is stale by buy time (up to
      // BUY_APPROVAL_TIMEOUT_SEC later). Temporary subscription: the listener
      // holds exactly one callback per mint; it is always removed in the
      // finally below, and the normal post-buy subscription later in this
      // function re-subscribes fresh (handover = unsubscribe temp first).
      let lastPriceSol: number | null = null;
      this.pumpListener.subscribeToTrades(token.mint, (priceInSol) => {
        lastPriceSol = priceInSol;
      });
      let proceed = false;
      try {
        const approved = await telegram.requestBuyApproval(
          `<b>${token.name}</b> (${token.symbol})\nDev buy: ${token.initialBuySol} SOL | MCap: ${token.marketCapSol} SOL\n<a href="${foundToken.url}">pump.fun</a>`,
          CONFIG.BUY_APPROVAL_TIMEOUT_SEC,
        );
        if (!approved) {
          logger.info(`⏭ Buy not approved: ${token.symbol}`);
          this.activePositions.delete(token.mint);
          finishBuyTrace(buyId, 'rejected');
          return;
        }

        // Re-check pause: the bot may have been paused during the wait.
        if (this.paused) {
          logger.info(`⏭ Bot paused during approval — skipping ${token.symbol}`);
          this.activePositions.delete(token.mint);
          finishBuyTrace(buyId, 'paused');
          return;
        }

        // Re-check max positions against OTHER positions (excluding our own placeholder).
        const otherPositions = [...this.activePositions.keys()].filter(k => k !== token.mint).length;
        if (otherPositions >= CONFIG.PUMP_MAX_POSITIONS) {
          logger.info(`⏭ Max positions (${CONFIG.PUMP_MAX_POSITIONS}) reached during approval — skipping ${token.symbol}`);
          this.activePositions.delete(token.mint);
          finishBuyTrace(buyId, 'max_positions');
          return;
        }

        // Re-price the stale snapshot from the live trade feed.
        const refreshed = refreshEntry(
          { priceUsd: foundToken.priceUsd, mcapUsd: foundToken.mcapUsd },
          lastPriceSol,
          this.solPriceUsd,
        );
        if (refreshed.refreshed) {
          logger.info(`🔄 Entry re-priced for ${token.symbol}: $${foundToken.priceUsd.toExponential(3)} → $${refreshed.priceUsd.toExponential(3)} (live trade feed)`);
          foundToken.priceUsd = refreshed.priceUsd;
          foundToken.mcapUsd = refreshed.mcapUsd;
        }

        proceed = true;
        safeMark(buyId, 'approval_done');
      } finally {
        // Always drop the temporary feed subscription; the post-buy
        // subscription below re-subscribes fresh when a buy happens.
        // On any non-buy path (rejected/expired/paused/max/exception) also
        // remove the locked placeholder so it can't stick forever.
        this.pumpListener.unsubscribeFromTrades(token.mint);
        if (!proceed) this.activePositions.delete(token.mint);
      }
    }

    if (CONFIG.PUMP_FAST_MODE) {
      // Buy immediately, security check async after
      const buyPromise = this.executeBuy(foundToken, `PumpFun snipe: ${token.name}`);
      this.asyncSecurityCheck(token.mint, token.symbol);
      await buyPromise;
    } else {
      // Security check first (with 4s timeout), then buy
      if (CONFIG.PUMP_SECURITY_CHECK) {
        const sec = await Promise.race([
          this.gmgnSwap.checkTokenSecurity(token.mint),
          this.sleep(4_000).then(() => null),
        ]);
        safeMark(buyId, 'security_done');
        if (sec === null) {
          logger.warn(`Security check timeout for ${token.symbol} — buying anyway`);
          safeNote(buyId, 'securityTimeout', 1);
        } else if (sec.isHoneypot) {
          logger.warn(`🚫 Honeypot: ${token.symbol} — skipped`);
          await logEvent('ERROR', `Honeypot detected: ${token.symbol}`, { mint: token.mint });
          finishBuyTrace(buyId, 'honeypot');
          return;
        } else if (sec.risks.length > 0) {
          logger.warn(`⚠️ ${token.symbol} risks: ${sec.risks.join(', ')}`);
        }
      }
      await this.executeBuy(foundToken, `PumpFun snipe: ${token.name}`);
    }

    // BUY trace fallback: finish 60s after the buy if no price was ever seen.
    // No-op when the trace already finished (first price / failure path).
    try {
      const boughtPos = this.activePositions.get(token.mint);
      if (boughtPos && boughtPos.buyResult) scheduleBuyTraceFallback(token.mint);
    } catch { /* ignore */ }

    // Subscribe to real-time price feed — also fires immediate SL/TP check.
    // Shared with restart-restored positions (subscribePositionFeed).
    if (this.activePositions.has(token.mint)) {
      this.subscribePositionFeed(token.mint);
    }

    // Telegram alert
    await telegram.alertTokensFound([foundToken], `🆕 PumpFun new token: ${token.name} (${token.symbol})\nDev buy: ${token.initialBuySol} SOL | MCap: ${token.marketCapSol} SOL`);
    } finally {
      const cur = this.activePositions.get(token.mint);
      if (cur && isPlaceholder(cur)) this.activePositions.delete(token.mint);
    }
  }

  /**
   * Subscribe a live position to the PumpPortal realtime trade feed.
   * Shared by freshly bought positions and restart-restored positions —
   * the exit logic lives here exactly once (no duplication).
   */
  private subscribePositionFeed(mint: string): void {
    const buyId = mint;
    let firstPriceSeen = false;
    this.pumpListener.subscribeToTrades(mint, (priceInSol) => {
      const pos = this.activePositions.get(mint);
      if (!pos || !pos.token || !pos.buyResult || pos.isSelling) return;

      // (D) NaN/Infinity safety: never store a non-finite or
      // non-positive tick — a poisoned price would corrupt PnL, peak and
      // every downstream exit decision.
      if (!Number.isFinite(priceInSol) || priceInSol <= 0) return;
      const tickUsd = priceInSol * this.solPriceUsd;
      if (!Number.isFinite(tickUsd) || tickUsd <= 0) return;
      pos.currentPriceUsd = tickUsd;
      if (!Number.isFinite(pos.entryPriceUsd) || pos.entryPriceUsd <= 0) return;

      const pnl = (pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * 100;

      // Latency: first observed post-buy price ends the BUY trace.
      if (!firstPriceSeen) {
        firstPriceSeen = true;
        try {
          safeMark(buyId, 'first_price_seen');
          noteSlippage(buyId, 'firstPricePct', traceRecorder.getNote(buyId, 'entryPriceUsd'), pos.currentPriceUsd);
        } catch { /* ignore */ }
        finishBuyTrace(buyId, 'bought');
      }

      updatePeak(pos, pnl);
      const exit = evaluateExit(pos, pnl, {
        AUTO_SELL: CONFIG.AUTO_SELL,
        TP1_PERCENT: CONFIG.TP1_PERCENT,
        TP2_PERCENT: CONFIG.TP2_PERCENT,
        STOP_LOSS_PERCENT: CONFIG.STOP_LOSS_PERCENT,
        TRAILING_TP_ENABLED: CONFIG.TRAILING_TP_ENABLED,
        TRAILING_TP_DROP_PERCENT: CONFIG.TRAILING_TP_DROP_PERCENT,
        MOONBAG_TRAIL_PERCENT: CONFIG.MOONBAG_TRAIL_PERCENT,
      });

      // Immediate TP1 check.
      // Single-flight: runTp1Sell claims isSelling synchronously and
      // re-verifies map membership; no await runs between this decision
      // and its claim, so the poll loop cannot interleave a second sell.
      if (exit.action === 'tp1') {
        logger.info(`🎯 TP1 (realtime) +${pnl.toFixed(1)}%: ${pos.token.symbol} — selling ${CONFIG.TP1_SELL_PERCENT}%`);
        this.runTp1Sell(mint, pos, pnl, 'realtime').catch(() => {});
        return;
      }

      // Immediate TP2 / full TP check
      if (exit.action === 'tp2') {
        this.executeTp2TakeProfit(mint, pos, pnl, true, { action: 'tp2', pnlPct: pnl, source: 'realtime' }).catch(() => {});
        return;
      }

      // Immediate SL check
      if (exit.action === 'sl') {
        logger.info(`🛑 SL (realtime) ${pnl.toFixed(1)}%: ${pos.token.symbol}`);
        this.runFullSell(mint, pos, `${exit.reason} (realtime)`, { action: 'sl', pnlPct: pnl, source: 'realtime' }).catch(() => {});
        return;
      }

      // Trailing SL after TP1 / trailing TP / moonbag remainder trail
      if (exit.action === 'trailing-sl' || exit.action === 'trailing-tp' || exit.action === 'moonbag-trail') {
        logger.info(`🛑 ${exit.reason} (realtime): ${pos.token.symbol} ${pnl.toFixed(1)}%`);
        this.runFullSell(mint, pos, exit.reason, { action: exit.action, pnlPct: pnl, source: 'realtime' }).catch(() => {});
      }
    });
  }

  /** Fire-and-forget security check — sell immediately if honeypot found post-buy */
  private async asyncSecurityCheck(mint: string, symbol: string): Promise<void> {
    try {
      await this.sleep(2_000); // give GMGN time to index the token
      const sec = await this.gmgnSwap.checkTokenSecurity(mint);
      safeMark(mint, 'security_done'); // no-op when the BUY trace already finished
      if (sec.isHoneypot) {
        logger.warn(`🚫 Post-buy honeypot detected: ${symbol} — emergency sell`);
        const pos = this.activePositions.get(mint);
        // Emergency path: bypasses the backoff gate but keeps the
        // single-flight claim, so a failed emergency sell retries instead
        // of bricking the position.
        if (pos && pos.token && pos.buyResult) {
          await this.runFullSell(mint, pos, 'honeypot-detected', undefined, { respectBackoff: false });
        }
      }
    } catch { /* ignore */ }
  }

  // ─── Tweet handler ─────────────────────────────────────────────

  private async handleNewTweet(tweet: Tweet): Promise<void> {
    this.tweetsDetected++;
    logger.info(`\n🐦 NEW TWEET #${this.tweetsDetected} from @${tweet.author}: ${tweet.text.slice(0, 100)}`);

    await Promise.all([
      telegram.alertTweetDetected(tweet.text, tweet.keywords, tweet.author, tweet.authorLabel),
      logEvent('TWEET', tweet.text.slice(0, 200), { keywords: tweet.keywords, author: tweet.author }),
    ]);

    const tokens = await this.tokenFinder.findTokens(tweet.keywords);

    if (tokens.length === 0) {
      await logEvent('TOKEN_FOUND', 'No tokens found', { keywords: tweet.keywords });
      const retry = async (delaySec: number) => {
        await this.sleep(delaySec * 1_000);
        const found = await this.tokenFinder.findTokens(tweet.keywords);
        if (found.length > 0) await telegram.alertTokensFound(found, tweet.text);
      };
      retry(30);
      retry(60);
      return;
    }

    await logEvent('TOKEN_FOUND', `Found ${tokens.length} token(s): ${tokens.map(t => t.symbol).join(', ')}`, {
      tokens: tokens.map(t => ({ mint: t.mintAddress, symbol: t.symbol, mcap: t.mcapUsd })),
    });
    await telegram.alertTokensFound(tokens, tweet.text);
    broadcastState();
  }

  // ─── Paper account ─────────────────────────────────────────

  /** SOL price for anchoring a fresh paper account (never throws). */
  private async resolvePaperStartPrice(): Promise<number> {
    const fallback = Number.isFinite(CONFIG.PUMP_SOL_PRICE_USD) && CONFIG.PUMP_SOL_PRICE_USD > 0
      ? CONFIG.PUMP_SOL_PRICE_USD
      : 150;
    try {
      // Prefer the oracle loop's price when it already fetched one.
      if (this.solPriceFetched && Number.isFinite(this.solPriceUsd) && this.solPriceUsd > 0) {
        return this.solPriceUsd;
      }
      // Otherwise one attempt with a 5s timeout.
      const { default: axios } = await import('axios');
      const resp = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        { timeout: 5_000, headers: { 'User-Agent': 'elon-sniper-bot/1.0' } },
      );
      const price = resp.data?.solana?.usd;
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
        this.solPriceUsd = price;
        return price;
      }
    } catch { /* ignore — fall through to fallback */ }
    if (Number.isFinite(this.solPriceUsd) && this.solPriceUsd > 0) return this.solPriceUsd;
    return fallback;
  }

  /**
   * Load (or create) the singleton paper account and rebuild the ledger
   * from persisted paper trades. No-op in LIVE mode. Never throws: on any
   * failure falls back to an in-memory ledger so startup never crashes.
   */
  async initPaperLedger(): Promise<void> {
    if (!CONFIG.PAPER_TRADING) return;
    const fallbackPrice = Number.isFinite(CONFIG.PUMP_SOL_PRICE_USD) && CONFIG.PUMP_SOL_PRICE_USD > 0
      ? CONFIG.PUMP_SOL_PRICE_USD
      : 150;
    const startUsd = Number.isFinite(CONFIG.PAPER_STARTING_CAPITAL_USD) && CONFIG.PAPER_STARTING_CAPITAL_USD > 0
      ? CONFIG.PAPER_STARTING_CAPITAL_USD
      : 100;
    try {
      const price = await this.resolvePaperStartPrice();
      let acct = await getPaperAccount();
      if (!acct) {
        const startSol = startUsd / price;
        await createPaperAccount({ startUsd, startSol, solPriceAtStart: price });
        acct = await getPaperAccount();
      }
      const startSol = acct && Number.isFinite(acct.startSol) && acct.startSol > 0
        ? acct.startSol
        : startUsd / price;
      this.paperAccountStartUsd = acct && Number.isFinite(acct.startUsd) && (acct.startUsd as number) > 0
        ? (acct.startUsd as number)
        : startUsd;
      const paperTrades = await listPaperTradesForLedger();
      this.paperLedger = PaperLedger.fromTrades(startSol, paperTrades);
      logger.info(`📝 Paper account: $${this.paperAccountStartUsd.toFixed(2)} start (${startSol.toFixed(4)} SOL @ $${price.toFixed(2)}) | cash ${this.paperLedger.cashSol.toFixed(4)} SOL`);
    } catch (err) {
      logger.warn(`Paper ledger init failed, using in-memory fallback: ${(err as Error)?.message ?? err}`);
      this.paperAccountStartUsd = startUsd;
      this.paperLedger = PaperLedger.fromTrades(startUsd / fallbackPrice, []);
    }
  }

  // ─── Buy ───────────────────────────────────────────────────────

  private async executeBuyFromTelegram(mintAddress: string, symbol: string): Promise<void> {
    const token = await this.fetchTokenInfo(mintAddress, symbol);
    await this.executeBuy(token);
  }

  private async executeBuy(token: FoundToken, tweetText?: string): Promise<void> {
    if (this.paused) {
      logger.warn(`Buy skipped while paused: ${token.symbol}`);
      // Remove pending position if exists
      if (this.activePositions.has(token.mintAddress)) {
        this.activePositions.delete(token.mintAddress);
      }
      finishBuyTrace(token.mintAddress, 'paused');
      return;
    }

    // Position size: USD sizing when BUY_AMOUNT_USD > 0, else SOL sizing.
    // Identical in LIVE and PAPER; a no-op for live when BUY_AMOUNT_USD is 0.
    const isPendingPosition = this.activePositions.has(token.mintAddress);
    const sized = computeBuySol({
      buyAmountUsd: CONFIG.BUY_AMOUNT_USD,
      buyAmountSol: CONFIG.BUY_AMOUNT_SOL,
      solPriceUsd: this.solPriceUsd,
      minSnipeUsd: CONFIG.MIN_SNIPE_USD,
    });
    if (!sized.ok) {
      logger.warn(`Buy skipped (${sized.reason}): ${token.symbol}`);
      await logEvent('SKIP', `Buy skipped ${token.symbol}: ${sized.reason}`, { mint: token.mintAddress });
      if (isPendingPosition) this.activePositions.delete(token.mintAddress);
      finishBuyTrace(token.mintAddress, sized.reason);
      return;
    }
    const solAmount = sized.sol;

    // Paper account must be able to afford the snipe.
    if (CONFIG.PAPER_TRADING) {
      if (!this.paperLedger || !this.paperLedger.canAfford(solAmount)) {
        logger.warn(`Buy skipped (insufficient_capital): ${token.symbol} needs ${solAmount} SOL, cash ${this.paperLedger?.cashSol ?? 0} SOL`);
        await logEvent('SKIP', `Buy skipped ${token.symbol}: insufficient_capital`, { mint: token.mintAddress, solAmount });
        if (isPendingPosition) this.activePositions.delete(token.mintAddress);
        finishBuyTrace(token.mintAddress, 'insufficient_capital');
        const now = Date.now();
        if (now - this.lastInsufficientCapitalAlert > 10 * 60_000) {
          this.lastInsufficientCapitalAlert = now;
          await telegram.alertError(`⚠️ Paper buy skipped: insufficient capital (need ${solAmount} SOL)`);
        }
        return;
      }
    }

    if (!CONFIG.PAPER_TRADING) {
      const sec = await this.gmgnSwap.checkTokenSecurity(token.mintAddress);
      safeMark(token.mintAddress, 'security_done');
      if (sec.isHoneypot) {
        await logEvent('ERROR', `Honeypot detected: ${token.symbol}`, { mint: token.mintAddress });
        await telegram.alertError(`🚫 Skipped ${token.symbol}: HONEYPOT`);
        if (isPendingPosition) this.activePositions.delete(token.mintAddress);
        finishBuyTrace(token.mintAddress, 'honeypot');
        return;
      }
      if (sec.risks.length > 0) {
        await telegram.alertError(`⚠️ ${token.symbol} risks: ${sec.risks.join(', ')}\nBuying anyway...`);
      }
    }

    safeMark(token.mintAddress, 'buy_sent');
    let result = CONFIG.GMGN_API_KEY
      ? await this.gmgnSwap.buyToken(token.mintAddress, solAmount)
      : { success: false, error: 'No GMGN key' } as any;

    if (!result.success) {
      logger.warn(`GMGN failed (${result.error}), trying Jupiter...`);
      result = await this.jupiterSwap.buyToken(token.mintAddress, solAmount);
    }

    if (!result.success) {
      await logEvent('ERROR', `Buy failed: ${token.symbol} — ${result.error}`);
      await telegram.alertError(`Buy ${token.symbol} failed: ${result.error}`);
      if (isPendingPosition) this.activePositions.delete(token.mintAddress);
      finishBuyTrace(token.mintAddress, 'buy_failed');
      return;
    }
    safeMark(token.mintAddress, 'buy_confirmed');
    try {
      safeNote(token.mintAddress, 'entryPriceUsd', token.priceUsd);
      noteSlippage(token.mintAddress, 'entrySlipPct', traceRecorder.getNote(token.mintAddress, 'signalPriceUsd'), token.priceUsd);
      safeNote(token.mintAddress, 'paper', CONFIG.PAPER_TRADING ? 1 : 0);
      const timings = (result as { timings?: { quoteMs: number; sendMs: number; confirmMs: number } }).timings;
      if (timings) {
        if (Number.isFinite(timings.quoteMs)) safeNote(token.mintAddress, 'swapQuoteMs', timings.quoteMs);
        if (Number.isFinite(timings.sendMs)) safeNote(token.mintAddress, 'swapSendMs', timings.sendMs);
        if (Number.isFinite(timings.confirmMs)) safeNote(token.mintAddress, 'swapConfirmMs', timings.confirmMs);
      }
    } catch { /* ignore */ }

    const source = result.txSignature?.startsWith('paper') ? 'paper' :
                   CONFIG.GMGN_API_KEY ? 'gmgn' : 'jupiter';

    // Paper ledger: debit only after the paper buy succeeded.
    if (source === 'paper' && this.paperLedger) {
      if (!this.paperLedger.debit(solAmount)) {
        logger.warn(`Paper ledger debit failed for ${token.symbol} (${solAmount} SOL) — cash ${this.paperLedger.cashSol} SOL`);
      }
    }

    const positionData: ActivePosition = {
      token,
      buyResult: result,
      entryTime: Date.now(),
      entryPriceUsd: token.priceUsd,
      currentPriceUsd: token.priceUsd,
      solSpent: solAmount,
      remainingTokens: result.outputAmount,
      tp1Hit: false,
      tp2Hit: false,
      isSelling: false,
      sellFailures: 0,
      nextSellAttemptAt: 0,
      moonbag: false,
      tweetText,
    };

    this.activePositions.set(token.mintAddress, positionData);
    this.buysExecuted++;

    // Persist to DB
    await Promise.all([
      insertTrade({
        type: 'BUY', tokenMint: token.mintAddress, symbol: token.symbol,
        name: token.name, solAmount, tokenAmount: result.outputAmount,
        priceUsd: token.priceUsd, mcapUsd: token.mcapUsd,
        txSignature: result.txSignature, source,
        reason: 'tweet', tweetText: tweetText?.slice(0, 500),
        dex: token.dex,
      }),
      upsertPosition(
        {
          tokenMint: token.mintAddress, symbol: token.symbol, name: token.name,
          entryPrice: token.priceUsd, solSpent: solAmount,
          tokenAmount: result.outputAmount, txSignature: result.txSignature,
          tweetText: tweetText?.slice(0, 500), dex: token.dex,
          mcapUsd: token.mcapUsd, tp1Hit: false, tp2Hit: false,
          moonbag: false, remainingTokens: result.outputAmount,
          peakPnlPercent: null, currentPriceUsd: token.priceUsd,
        },
        {
          entryPrice: token.priceUsd, solSpent: solAmount,
          tokenAmount: result.outputAmount, txSignature: result.txSignature,
          mcapUsd: token.mcapUsd, tp1Hit: false, tp2Hit: false,
          moonbag: false, remainingTokens: result.outputAmount,
          currentPriceUsd: token.priceUsd,
        },
      ),
      logEvent('BUY', `Bought ${token.symbol} with ${solAmount} SOL`, {
        mint: token.mintAddress, tx: result.txSignature, source,
      }),
    ]);

    await telegram.alertBuyExecuted(token, result.txSignature, solAmount);
    broadcastState();
  }

  // ─── Sell ──────────────────────────────────────────────────────

  /**
   * Sell a percentage of remaining tokens — does NOT close the position.
   * Pure executor: never touches isSelling/tp flags/solSpent/backoff — the
   * claimant (runTp1Sell / executeTp2TakeProfit) owns those. Returns true
   * only when the swap really succeeded.
   */
  private async executePartialSell(mint: string, position: ActivePosition, sellPercent: number, reason: string, sellSignal?: SellSignal): Promise<boolean> {
    // Latency: exit_signal at entry (or the evaluateExit moment passed in).
    const sellId = beginSellTrace(mint, position.token.symbol, sellSignal ?? manualSellSignal(reason, pnlOf(position)));
    const tokensToSell = Math.floor(position.remainingTokens * (sellPercent / 100));
    // Dust remainder rounds to zero tokens: report failure WITHOUT setting
    // tp1Hit (this function never sets it). The caller routes dust to a
    // full sell so the position closes instead of retrying TP1 forever.
    if (tokensToSell <= 0) { finishSellTrace(sellId, 'skipped'); return false; }

    // Fetch current price for accurate PnL calculation (especially for timeout sells)
    if (reason.startsWith('max-hold')) {
      const currentPrice = await this.fetchCurrentPriceForPnL(mint);
      if (currentPrice > 0) {
        position.currentPriceUsd = currentPrice;
        logger.info(`📊 Fetched current price for ${position.token.symbol}: $${currentPrice.toExponential(3)}`);
      }
    }

    logger.info(`💰 PARTIAL SELL ${sellPercent}%: ${position.token.symbol} | ${tokensToSell} tokens | reason: ${reason}`);

    safeMark(sellId, 'sell_sent');
    let result = CONFIG.GMGN_API_KEY
      ? await this.gmgnSwap.sellToken(mint, tokensToSell)
      : { success: false } as any;
    if (!result.success) result = await this.jupiterSwap.sellToken(mint, tokensToSell);
    if (!result.success) {
      logger.warn(`Partial sell failed for ${position.token.symbol}`);
      finishSellTrace(sellId, 'sell_failed');
      return false;
    }
    safeMark(sellId, 'sell_confirmed');

    const partialSolSpent = position.solSpent * (sellPercent / 100);
    const pnlPercent = position.entryPriceUsd > 0
      ? ((position.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100
      : 0;
    const pnlSol = CONFIG.PAPER_TRADING
      ? partialSolSpent * (pnlPercent / 100)
      : result.outputAmount > 0 ? (result.outputAmount / 1e9) - partialSolSpent : 0;
    const currentMcapUsd = position.entryPriceUsd > 0
      ? position.token.mcapUsd * (position.currentPriceUsd / position.entryPriceUsd)
      : position.token.mcapUsd;

    try {
      safeNote(sellId, 'pnlAtConfirmPct', pnlPercent);
      const sig = sellSignal ? sellSignal.pnlPct : pnlPercent;
      if (Number.isFinite(sig)) safeNote(sellId, 'exitSlipPct', pnlPercent - sig);
    } catch { /* ignore */ }
    finishSellTrace(sellId, 'sold');

    position.remainingTokens -= tokensToSell;
    // Stage 9c: persist remainder fire-and-forget (cost-basis scaling is
    // owned by the caller, which persists again after scaling).
    this.persistPositionState(mint, position);
    this.totalPnlSol += pnlSol;
    this.registerClosedTradeRisk(pnlSol);

    const source = result.txSignature?.startsWith('paper') ? 'paper' : CONFIG.GMGN_API_KEY ? 'gmgn' : 'jupiter';

    // Paper ledger: credit proceeds (cost basis sold + pnl) on every paper sell.
    if (source === 'paper' && this.paperLedger) {
      this.paperLedger.credit(partialSolSpent + pnlSol);
    }

    await Promise.all([
      insertTrade({
        type: 'SELL', tokenMint: mint, symbol: position.token.symbol,
        name: position.token.name, solAmount: position.solSpent * sellPercent / 100,
        tokenAmount: tokensToSell, priceUsd: position.currentPriceUsd,
        mcapUsd: currentMcapUsd, pnlPercent, pnlSol,
        txSignature: result.txSignature, source, reason, dex: position.token.dex,
      }),
      logEvent('SELL', `Partial ${sellPercent}% ${position.token.symbol} | PnL: ${pnlPercent.toFixed(1)}%`, { mint, reason, pnlPercent, pnlSol }),
    ]);

    await telegram.alertSellExecuted(position.token.symbol, pnlPercent, reason, pnlSol, this.solPriceUsd);
    broadcastState();
    return true;
  }

  private async fetchCurrentPriceForPnL(mint: string): Promise<number> {
    try {
      const { default: axios } = await import('axios');
      const resp = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        timeout: 5000,
        headers: { 'User-Agent': 'elon-sniper-bot/1.0' }
      });
      const pair = resp.data?.pairs?.[0];
      if (pair?.priceUsd) {
        return parseFloat(pair.priceUsd);
      }
    } catch { /* ignore */ }
    return 0;
  }

  /**
   * Full close of a position. Pure executor: never touches
   * isSelling/tp flags/backoff — the claimant (runFullSell /
   * executeTp2TakeProfit) owns those. Returns true only when the swap
   * really succeeded AND the position was removed.
   */
  private async executeSell(mint: string, position: ActivePosition, reason: string, sellSignal?: SellSignal): Promise<boolean> {
    // Latency: exit_signal at entry (or the evaluateExit moment passed in).
    const sellId = beginSellTrace(mint, position.token.symbol, sellSignal ?? manualSellSignal(reason, pnlOf(position)));
    this.pumpListener.unsubscribeFromTrades(mint);

    // Fetch current price for accurate PnL calculation
    if (reason.startsWith('max-hold')) {
      const currentPrice = await this.fetchCurrentPriceForPnL(mint);
      if (currentPrice > 0) {
        position.currentPriceUsd = currentPrice;
        logger.info(`📊 Fetched current price for ${position.token.symbol}: $${currentPrice.toExponential(3)}`);
      }
    }

    safeMark(sellId, 'sell_sent');
    let result = CONFIG.GMGN_API_KEY
      ? await this.gmgnSwap.sellToken(mint, position.remainingTokens || undefined)
      : { success: false } as any;
    if (!result.success) result = await this.jupiterSwap.sellToken(mint, position.remainingTokens || undefined);
    if (!result.success) { finishSellTrace(sellId, 'sell_failed'); return false; }
    safeMark(sellId, 'sell_confirmed');

    const pnlPercent = position.entryPriceUsd > 0
      ? ((position.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100
      : 0;
    const pnlSol = CONFIG.PAPER_TRADING
      ? position.solSpent * (pnlPercent / 100)
      : result.outputAmount > 0 ? (result.outputAmount / 1e9) - position.solSpent : 0;
    const currentMcapUsd = position.entryPriceUsd > 0
      ? position.token.mcapUsd * (position.currentPriceUsd / position.entryPriceUsd)
      : position.token.mcapUsd;

    try {
      safeNote(sellId, 'pnlAtConfirmPct', pnlPercent);
      const sig = sellSignal ? sellSignal.pnlPct : pnlPercent;
      if (Number.isFinite(sig)) safeNote(sellId, 'exitSlipPct', pnlPercent - sig);
    } catch { /* ignore */ }
    finishSellTrace(sellId, 'sold');

    this.activePositions.delete(mint);
    // Latency: close any still-open BUY trace for this mint (no-op if none).
    finishBuyTrace(mint, 'bought');
    this.totalPnlSol += pnlSol;
    this.registerClosedTradeRisk(pnlSol);

    const source = result.txSignature?.startsWith('paper') ? 'paper' :
                   CONFIG.GMGN_API_KEY ? 'gmgn' : 'jupiter';

    // Paper ledger: credit proceeds (remaining cost basis + pnl) on every paper sell.
    if (source === 'paper' && this.paperLedger) {
      this.paperLedger.credit(position.solSpent + pnlSol);
    }

    await Promise.all([
      insertTrade({
        type: 'SELL', tokenMint: mint, symbol: position.token.symbol,
        name: position.token.name, solAmount: position.solSpent,
        tokenAmount: position.buyResult.outputAmount,
        priceUsd: position.currentPriceUsd, mcapUsd: currentMcapUsd,
        pnlPercent, pnlSol,
        txSignature: result.txSignature, source, reason,
        dex: position.token.dex,
      }),
      deletePosition(mint),
      logEvent('SELL', `Sold ${position.token.symbol} — PnL: ${pnlPercent.toFixed(1)}%`, {
        mint, reason, pnlPercent, pnlSol,
      }),
    ]);

    await telegram.alertSellExecuted(position.token.symbol, pnlPercent, reason, pnlSol, this.solPriceUsd);
    broadcastState();
    return true;
  }

  // ─── Stage 9c: restart-recovery persistence ────────────────
  // Fire-and-forget Position row syncs — never awaited on the sell/buy hot
  // path, all errors swallowed, so trading never blocks on the DB.

  /** Sync flag/cost-basis state after tp1Hit/tp2Hit/moonbag/remainingTokens/solSpent change. */
  private persistPositionState(mint: string, position: ActivePosition): void {
    try {
      void updatePositionState(mint, {
        tp1Hit: position.tp1Hit,
        tp2Hit: position.tp2Hit,
        moonbag: position.moonbag,
        remainingTokens: position.remainingTokens,
        solSpent: position.solSpent,
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  /** Sync peak/currentPrice at most every 30s per position (poll loop). */
  private persistPeakThrottled(mint: string, position: ActivePosition): void {
    try {
      const now = Date.now();
      const last = this.lastPeakPersistAt.get(mint) ?? 0;
      if (now - last < 30_000) return;
      this.lastPeakPersistAt.set(mint, now);
      void updatePositionState(mint, {
        peakPnlPercent: Number.isFinite(position.peakPnlPercent)
          ? position.peakPnlPercent as number
          : null,
        currentPriceUsd: Number.isFinite(position.currentPriceUsd)
          ? position.currentPriceUsd
          : 0,
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  /**
   * Restart recovery: reload persisted Position rows into activePositions.
   * Must be called from main() after initDb (and after the paper
   * account/ledger init) and BEFORE the poll loop and listeners start.
   * Each restored position is re-subscribed to the realtime trade feed via
   * subscribePositionFeed (same path as a fresh buy). Rows that are
   * unusable are deleted from the DB and logged. Max-hold keeps counting
   * from the original openedAt (entryTime). Never throws.
   */
  async restorePositionsFromDb(): Promise<number> {
    let rows;
    try {
      rows = await listPositions();
    } catch (err) {
      logger.warn(`Position restore skipped (DB read failed): ${(err as Error)?.message ?? err}`);
      return 0;
    }
    if (rows.length === 0) return 0;
    const now = Date.now();
    let restored = 0;
    for (const row of rows) {
      let pos = null;
      try {
        pos = rowToActivePosition(row, now);
      } catch {
        pos = null;
      }
      if (!pos) {
        logger.warn(`🗑 Deleting unusable Position row: ${row.tokenMint || '(empty mint)'}`);
        try { await deletePosition(row.tokenMint); } catch { /* ignore */ }
        continue;
      }
      this.activePositions.set(pos.token.mintAddress, pos);
      this.subscribePositionFeed(pos.token.mintAddress);
      restored++;
      logger.info(`♻️ Restored position: ${pos.token.symbol} (${pos.token.mintAddress.slice(0, 8)}) entry $${pos.entryPriceUsd.toExponential(3)} tp1=${pos.tp1Hit} moonbag=${pos.moonbag}`);
    }
    if (restored > 0) {
      await telegram.alertError(`♻️ Restored ${restored} posisi setelah restart`).catch(() => {});
    }
    return restored;
  }

  /**
   * Revert optimistic flags, arm the sell backoff, send the scheduled
   * Telegram alert, and release the single-flight claim. Returns false so
   * claimants can `return this.releaseSellClaim(...)` directly.
   */
  private releaseSellClaim(mint: string, position: ActivePosition, prevTp1: boolean, prevTp2: boolean, now: number): boolean {
    position.tp1Hit = prevTp1;
    position.tp2Hit = prevTp2;
    recordSellFailure(position, now);
    if (shouldAlertSellFailure(position)) {
      const symbol = position.token?.symbol ?? mint.slice(0, 8);
      telegram.alertError(
        `SELL GAGAL x${position.sellFailures} untuk ${symbol} — perlu tindakan manual`,
      ).catch(() => {});
    }
    position.isSelling = false;
    return false;
  }

  /**
   * Guarded full close: claims isSelling synchronously, awaits the
   * executor, then reconciles. Manual/emergency callers pass
   * { respectBackoff: false } to bypass the retry gate (user override);
   * automatic paths use the default gate.
   */
  private async runFullSell(
    mint: string,
    position: ActivePosition,
    reason: string,
    sellSignal?: SellSignal,
    opts?: { respectBackoff?: boolean },
  ): Promise<boolean> {
    const now = Date.now();
    if (this.activePositions.get(mint) !== position || position.isSelling) return false;
    if ((opts?.respectBackoff ?? true) && !canAttemptSell(position, now)) return false;
    position.isSelling = true;
    const prevTp1 = position.tp1Hit;
    const prevTp2 = position.tp2Hit;
    try {
      const ok = await this.executeSell(mint, position, reason, sellSignal);
      if (!ok) return this.releaseSellClaim(mint, position, prevTp1, prevTp2, now);
      return true;
    } catch {
      return this.releaseSellClaim(mint, position, prevTp1, prevTp2, now);
    }
  }

  /**
   * Guarded TP1 partial sell. Dust (partial rounds to zero tokens) is
   * routed to a full close so the position shuts instead of retrying TP1
   * forever. solSpent is scaled only after a confirmed success.
   */
  private async runTp1Sell(mint: string, position: ActivePosition, pnlPercent: number, source: 'realtime' | 'poll'): Promise<boolean> {
    const now = Date.now();
    if (this.activePositions.get(mint) !== position || position.isSelling) return false;
    if (!canAttemptSell(position, now)) return false;
    position.isSelling = true;
    const prevTp1 = position.tp1Hit;
    const prevTp2 = position.tp2Hit;
    position.tp1Hit = true;
    const signal: SellSignal = { action: 'tp1', pnlPct: pnlPercent, source };
    try {
      if (Math.floor(position.remainingTokens * (CONFIG.TP1_SELL_PERCENT / 100)) <= 0) {
        logger.info(`🎯 TP1 dust (${source}): ${position.token.symbol} — closing remainder with full sell`);
        const ok = await this.executeSell(mint, position, `TP1 +${CONFIG.TP1_PERCENT}% (dust)`, signal);
        if (!ok) return this.releaseSellClaim(mint, position, prevTp1, prevTp2, now);
        return true;
      }
      const ok = await this.executePartialSell(mint, position, CONFIG.TP1_SELL_PERCENT, `TP1 +${CONFIG.TP1_PERCENT}%`, signal);
      if (!ok) return this.releaseSellClaim(mint, position, prevTp1, prevTp2, now);
      position.solSpent = position.solSpent * (1 - CONFIG.TP1_SELL_PERCENT / 100);
      recordSellSuccess(position);
      position.isSelling = false;
      // Stage 9c: persist TP1 state fire-and-forget.
      this.persistPositionState(mint, position);
      return true;
    } catch {
      return this.releaseSellClaim(mint, position, prevTp1, prevTp2, now);
    }
  }

  private async executeSellFromDashboard(mintAddress: string): Promise<void> {
    const pos = this.activePositions.get(mintAddress);
    if (!pos || !pos.token || !pos.buyResult) return;
    await this.runFullSell(mintAddress, pos, 'manual-dashboard', undefined, { respectBackoff: false });
  }

  private async executeSellFromTelegram(mintAddress: string, symbol: string): Promise<void> {
    const pos = this.activePositions.get(mintAddress);
    if (!pos || !pos.token || !pos.buyResult) return;
    await this.runFullSell(mintAddress, pos, 'manual-telegram', undefined, { respectBackoff: false });
  }

  private async sellAllPositions(): Promise<void> {
    if (this.activePositions.size === 0) {
      await telegram.alertError('No active positions to sell');
      return;
    }
    for (const [mint, pos] of [...this.activePositions]) {
      if (!pos.token || !pos.buyResult) continue;
      await this.runFullSell(mint, pos, 'manual-sell-all', undefined, { respectBackoff: false });
    }
  }

  // ─── Position monitor loop ─────────────────────────────────────

  private async monitorPositionsLoop(): Promise<void> {
    while (true) {
      await this.sleep(3_000);
      if (this.activePositions.size === 0) continue;

      for (const [mint, position] of this.activePositions) {
        try {
          if (position.isSelling) continue;
          // Never manage buy-pending placeholders as positions.
          if (!position.token || !position.buyResult) continue;

          const ageMs = Date.now() - position.entryTime;
          const pnlNow = pnlOf(position);

          // Loss hold cap: if still red after X minutes, force-exit early.
          // Applies to moonbag remainders too (no !tp2Hit gate) so a
          // moonbag can never ride forever.
          if (
            position.token.dex === 'pump.fun' &&
            CONFIG.AUTO_SELL &&
            pnlNow < 0 &&
            ageMs > CONFIG.PUMP_MAX_HOLD_LOSS_MINUTES * 60_000
          ) {
            logger.info(
              `⏰ LOSS HOLD CAP: ${position.token.symbol} ${pnlNow.toFixed(1)}% — selling after ${CONFIG.PUMP_MAX_HOLD_LOSS_MINUTES}min in loss`,
            );
            await this.runFullSell(mint, position, `max-hold-loss-${CONFIG.PUMP_MAX_HOLD_LOSS_MINUTES}min`, { action: 'max-hold', pnlPct: pnlNow, source: 'poll' });
            continue;
          }

          // Max hold time for pump.fun tokens.
          // Applies to moonbag remainders too (no !tp2Hit gate) so a
          // moonbag can never ride forever.
          if (
            position.token.dex === 'pump.fun' &&
            CONFIG.AUTO_SELL &&
            ageMs > CONFIG.PUMP_MAX_HOLD_MINUTES * 60_000
          ) {
            const pnl = position.entryPriceUsd > 0
              ? ((position.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd * 100).toFixed(1)
              : '?';
            logger.info(`⏰ MAX HOLD: ${position.token.symbol} ${pnl}% — selling after ${CONFIG.PUMP_MAX_HOLD_MINUTES}min`);
            await this.runFullSell(mint, position, `max-hold-${CONFIG.PUMP_MAX_HOLD_MINUTES}min`, { action: 'max-hold', pnlPct: pnlOf(position), source: 'poll' });
            continue;
          }

          // Poll DexScreener for all positions.
          // For pump.fun tokens: real-time PumpPortal subscription is primary,
          // DexScreener is fallback (kicks in once the pair is indexed, ~2-5min).
          try {
            const { default: axios } = await import('axios');
            const resp = await axios.get(
              `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
              { timeout: 5_000 },
            );
            const pair = resp.data?.pairs?.[0];
            if (pair) {
              const dexPrice = parseFloat(pair.priceUsd) || 0;
              // Use DexScreener price when:
              // 1. We have no live price yet (subscription hasn't fired)
              // 2. OR DexScreener price is meaningfully different (>1%) from our live price
              // (D) Non-finite poll prices are never stored.
              if (Number.isFinite(dexPrice) && dexPrice > 0) {
                const livePrice = position.currentPriceUsd;
                const diff = livePrice > 0 ? Math.abs(dexPrice - livePrice) / livePrice : 1;
                if (livePrice === position.entryPriceUsd || diff > 0.01) {
                  position.currentPriceUsd = dexPrice;
                }
              }
            }
          } catch { /* ignore — use live price from subscription */ }

          // (B) An await (DexScreener above) ran since the top-of-loop
          // claim check: the realtime callback may have claimed and sold
          // this position meanwhile. Re-verify liveness and claim state
          // before making any sell decision.
          if (position.isSelling || this.activePositions.get(mint) !== position) continue;
          if (!position.token || !position.buyResult) continue;

          // (D) Non-finite or non-positive prices never drive exits.
          if (!Number.isFinite(position.currentPriceUsd) || !Number.isFinite(position.entryPriceUsd)) continue;
          if (position.currentPriceUsd <= 0 || position.entryPriceUsd <= 0) continue;

          const pnlPercent = ((position.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;

          logger.info(`📈 ${position.token.symbol} | entry: $${position.entryPriceUsd.toExponential(3)} | now: $${position.currentPriceUsd.toExponential(3)} | pnl: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%`);

          updatePeak(position, pnlPercent);
          // Stage 9c: sync peak/currentPrice at most every 30s per position.
          this.persistPeakThrottled(mint, position);
          const exit = evaluateExit(position, pnlPercent, {
            AUTO_SELL: CONFIG.AUTO_SELL,
            TP1_PERCENT: CONFIG.TP1_PERCENT,
            TP2_PERCENT: CONFIG.TP2_PERCENT,
            STOP_LOSS_PERCENT: CONFIG.STOP_LOSS_PERCENT,
            TRAILING_TP_ENABLED: CONFIG.TRAILING_TP_ENABLED,
            TRAILING_TP_DROP_PERCENT: CONFIG.TRAILING_TP_DROP_PERCENT,
            MOONBAG_TRAIL_PERCENT: CONFIG.MOONBAG_TRAIL_PERCENT,
          });

          if (exit.action !== 'none') {
            // TP1: sell TP1_SELL_PERCENT% at TP1_PERCENT gain (guarded:
            // claims isSelling, reverts flags + backoff on failure, scales
            // solSpent only after success).
            if (exit.action === 'tp1') {
              logger.info(`🎯 TP1 +${pnlPercent.toFixed(1)}%: ${position.token.symbol} — selling ${CONFIG.TP1_SELL_PERCENT}%`);
              await this.runTp1Sell(mint, position, pnlPercent, 'poll');
              continue;
            }

            // TP2: sell remaining at TP2_PERCENT gain (full close),
            // incl. fallback full TP (jumped directly past TP2 without hitting TP1)
            if (exit.action === 'tp2') {
              await this.executeTp2TakeProfit(mint, position, pnlPercent, false, { action: 'tp2', pnlPct: pnlPercent, source: 'poll' });
              continue;
            }

            // Stop Loss
            if (exit.action === 'sl') {
              logger.info(`🛑 STOP LOSS ${pnlPercent.toFixed(1)}%: ${position.token.symbol}`);
              await this.runFullSell(mint, position, exit.reason, { action: 'sl', pnlPct: pnlPercent, source: 'poll' });
              continue;
            }

            // Trailing SL / trailing TP after TP1, or moonbag remainder trail
            if (exit.action === 'trailing-sl' || exit.action === 'trailing-tp' || exit.action === 'moonbag-trail') {
              logger.info(`🛑 ${exit.reason}: ${position.token.symbol} ${pnlPercent.toFixed(1)}%`);
              await this.runFullSell(mint, position, exit.reason, { action: exit.action, pnlPct: pnlPercent, source: 'poll' });
            }
          }
        } catch {
          // non-critical
        }
      }

      broadcastState();
    }
  }

  private async refreshSolBalanceLoop(): Promise<void> {
    while (true) {
      try {
        this.solBalance = await this.gmgnSwap.getSolBalance();
      } catch { /* ignore */ }
      await this.sleep(30_000);
    }
  }

  private async refreshSolPriceLoop(): Promise<void> {
    while (true) {
      try {
        const { default: axios } = await import('axios');
        const resp = await axios.get(
          'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
          { timeout: 5_000, headers: { 'User-Agent': 'elon-sniper-bot/1.0' } },
        );
        const price = resp.data?.solana?.usd;
        if (price && price > 0) {
          this.solPriceUsd = price;
          this.solPriceFetched = true;
          logger.info(`SOL price updated: $${price.toFixed(2)}`);
        }
      } catch {
        // keep last known price — no log spam
      }
      await this.sleep(60_000);
    }
  }

  // ─── State / status ────────────────────────────────────────────

  /** Open-position inputs for paper equity math (skips pending placeholders). */
  private paperOpenInputs(): { solSpent: number; pnlPercent: number }[] {
    const out: { solSpent: number; pnlPercent: number }[] = [];
    for (const [, pos] of this.activePositions) {
      if (!pos.token || !pos.buyResult) continue;
      const pnlPercent = pos.entryPriceUsd > 0
        ? ((pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100
        : 0;
      out.push({ solSpent: pos.solSpent, pnlPercent });
    }
    return out;
  }

  private getDashboardState(): BotState {
    const positions: ActivePositionInfo[] = [];

    for (const [mint, pos] of this.activePositions) {
      const pnlPercent = pos.entryPriceUsd > 0
        ? ((pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100
        : 0;
      const pnlSol = pnlPercent / 100 * pos.solSpent;

      // Skip pending positions (not yet bought)
      if (!pos.token || !pos.buyResult) continue;

      const currentMcapUsd = pos.entryPriceUsd > 0
        ? pos.token.mcapUsd * (pos.currentPriceUsd / pos.entryPriceUsd)
        : pos.token.mcapUsd;

      positions.push({
        tokenMint:      mint,
        symbol:         pos.token.symbol,
        name:           pos.token.name,
        apedAt:         new Date(pos.entryTime).toISOString(),
        entryPrice:     pos.entryPriceUsd,
        currentPrice:   pos.currentPriceUsd,
        entryMcapUsd:   pos.token.mcapUsd,
        currentMcapUsd,
        pnlPercent,
        pnlSol,
        solSpent:       pos.solSpent,
        ageMinutes:     (Date.now() - pos.entryTime) / 60_000,
        dex:            pos.token.dex,
        tweetText:      pos.tweetText,
      });
    }

    const ledger = CONFIG.PAPER_TRADING ? this.paperLedger : null;
    const state: BotState = {
      mode:             CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE',
      running:          true,
      paused:           this.paused,
      uptime:           Date.now() - this.startTime,
      tweetsDetected:   this.tweetsDetected,
      buysExecuted:     this.buysExecuted,
      solBalance:       ledger ? ledger.cashSol : this.solBalance,
      solPriceUsd:      this.solPriceUsd,
      activePositions:  positions,
    };
    if (ledger) {
      const e = ledger.equity(this.paperOpenInputs(), this.solPriceUsd);
      state.paper = {
        startUsd: this.paperAccountStartUsd,
        cashUsd: e.cashUsd,
        openValueUsd: e.openValueUsd,
        equityUsd: e.equityUsd,
        pnlUsd: e.pnlUsd,
        pnlPct: e.pnlPct,
      };
    }
    return state;
  }

  private getBalanceMessage(): string {
    if (CONFIG.PAPER_TRADING && this.paperLedger) {
      const opens = this.paperOpenInputs();
      const e = this.paperLedger.equity(opens, this.solPriceUsd);
      const sign = e.pnlUsd >= 0 ? '+' : '-';
      const cashSol = this.paperLedger.cashSol;
      return [
        `💰 <b>Paper Account</b>`,
        '',
        `Start: <b>$${e.startUsd.toFixed(2)}</b>`,
        `Cash: <b>$${e.cashUsd.toFixed(2)}</b> (${cashSol.toFixed(4)} SOL)`,
        `Open: <b>$${e.openValueUsd.toFixed(2)}</b> (${opens.length} positions)`,
        `Equity: <b>$${e.equityUsd.toFixed(2)}</b>`,
        '',
        `📈 PnL: <b>${sign}$${Math.abs(e.pnlUsd).toFixed(2)} (${sign}${Math.abs(e.pnlPct).toFixed(2)}%)</b>`,
        '',
        `💵 SOL Price: $${this.solPriceUsd.toFixed(2)}`,
        `📊 Mode: PAPER`,
      ].join('\n');
    }
    const solUsd = this.solBalance * this.solPriceUsd;
    const pnlUsd = this.totalPnlSol * this.solPriceUsd;
    const sign   = this.totalPnlSol >= 0 ? '+' : '';
    const pSign  = pnlUsd >= 0 ? '+' : '';
    return [
      `💰 <b>Saldo</b>`,
      '',
      `SOL: <b>${this.solBalance.toFixed(4)} SOL</b>`,
      this.solPriceUsd > 0 ? `USD: ≈ <b>$${solUsd.toFixed(2)}</b>` : '',
      '',
      `📈 Total PnL: <b>${sign}${this.totalPnlSol.toFixed(4)} SOL</b>`,
      this.solPriceUsd > 0 ? `         ≈ <b>${pSign}$${Math.abs(pnlUsd).toFixed(2)}</b>` : '',
      '',
      `💵 SOL Price: $${this.solPriceUsd.toFixed(2)}`,
      `📊 Mode: ${CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE'}`,
    ].filter(l => l !== '').join('\n');
  }

  private async getPnlMessage(): Promise<string> {    const sells = await listSellSummaries();

    if (sells.length === 0) return '📊 Belum ada trade yang selesai.';

    const now = Date.now();
    const since1d  = new Date(now - 86_400_000);
    const since7d  = new Date(now - 7 * 86_400_000);
    const since30d = new Date(now - 30 * 86_400_000);

    const calc = (rows: typeof sells) => {
      const total  = rows.length;
      const wins   = rows.filter(r => (r.pnlSol ?? 0) > 0).length;
      const pnlSol = rows.reduce((s, r) => s + (r.pnlSol ?? 0), 0);
      const pnlUsd = pnlSol * this.solPriceUsd;
      const wr     = total > 0 ? (wins / total * 100).toFixed(0) : '0';
      const sign   = pnlSol >= 0 ? '+' : '';
      const uSign  = pnlUsd >= 0 ? '+' : '';
      return `${sign}${pnlSol.toFixed(3)} SOL (${uSign}$${Math.abs(pnlUsd).toFixed(2)}) | ${wr}% WR | ${wins}W/${total - wins}L`;
    };

    const d1  = sells.filter(r => r.createdAt >= since1d);
    const d7  = sells.filter(r => r.createdAt >= since7d);
    const d30 = sells.filter(r => r.createdAt >= since30d);

    return [
      `📊 <b>PnL Report</b>`,
      '',
      `24h:  ${d1.length  ? calc(d1)  : 'no trades'}`,
      `7d:   ${d7.length  ? calc(d7)  : 'no trades'}`,
      `30d:  ${d30.length ? calc(d30) : 'no trades'}`,
      `All:  ${calc(sells)}`,
      '',
      `💵 SOL Price: $${this.solPriceUsd.toFixed(2)}`,
    ].join('\n');
  }

  private async getLatencyMessage(): Promise<string> {
    try {
      return renderLatency(latencyStats.summary(), eventLoopMonitor.snapshot());
    } catch {
      return '⚠️ Gagal memuat statistik latensi.';
    }
  }

  private getStatusMessage(): string {
    const upHours = ((Date.now() - this.startTime) / 3_600_000).toFixed(1);
    const lines = [
      `🤖 <b>Elon Sniper Bot</b>`,
      `Mode: <b>${CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE'}</b>`,
      `⏱ Uptime: ${upHours}h`,
      `🐦 Tweets: ${this.tweetsDetected} | 🛒 Buys: ${this.buysExecuted}`,
      `💰 SOL: ${this.solBalance.toFixed(3)} | PnL: ${this.totalPnlSol >= 0 ? '+' : ''}${this.totalPnlSol.toFixed(3)} SOL`,
      `🧯 Session: ${this.sessionRealizedPnlSol >= 0 ? '+' : ''}${this.sessionRealizedPnlSol.toFixed(3)} SOL | ${this.consecutiveLosses} consecutive losses`,
      `📊 Positions: ${this.activePositions.size}`,
    ];

    if (this.activePositions.size > 0) {
      lines.push('', '<b>Active:</b>');
      for (const [, pos] of this.activePositions) {
        if (!pos.token || !pos.buyResult) continue; // buy-pending placeholder
        const pnl = pos.entryPriceUsd > 0
          ? ((pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * 100).toFixed(1)
          : '?';
        const age = ((Date.now() - pos.entryTime) / 60_000).toFixed(0);
        lines.push(`• <b>${pos.token.symbol}</b> ${pnl}% | ${age}m | ${pos.solSpent} SOL`);
      }
    }

    return lines.join('\n');
  }

  private async getHistoryMessage(): Promise<string> {
    const sells = await listRecentSells(10);

    if (sells.length === 0) return '📋 No completed trades yet.';

    const lines = [`📋 <b>Last ${sells.length} Trades</b>`, ''];

    for (const sell of sells) {
      const buy = await findLatestBuyBefore(sell.tokenMint, sell.createdAt);

      const pnl     = sell.pnlPercent ?? 0;
      const pnlSol  = sell.pnlSol ?? 0;
      const emoji   = pnl >= 0 ? '🟢' : '🔴';
      const sign    = pnl >= 0 ? '+' : '';
      const buyMcap = buy ? `$${fmtK(buy.mcapUsd)}` : '?';
      const sellMcap = `$${fmtK(sell.mcapUsd)}`;
      const solSign = pnlSol >= 0 ? '+' : '';

      lines.push(
        `${emoji} <b>${sell.symbol}</b> ${sign}${pnl.toFixed(1)}% | ${solSign}${pnlSol.toFixed(4)} SOL`,
        `   📊 MCap: ${buyMcap} → ${sellMcap}`,
        `   📋 ${sell.reason ?? '—'} | ${new Date(sell.createdAt).toLocaleTimeString()}`,
        '',
      );
    }

    return lines.join('\n');
  }

  private async fetchTokenInfo(mintAddress: string, symbol: string): Promise<FoundToken> {
    const token: FoundToken = {
      mintAddress, symbol, name: symbol,
      priceUsd: 0, mcapUsd: 0, liquidity: 0, volume24h: 0,
      pairAddress: '', dex: 'unknown', ageMinutes: 0,
      matchedKeyword: '',
      url: `https://dexscreener.com/solana/${mintAddress}`,
    };
    try {
      const { default: axios } = await import('axios');
      const resp = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 5_000 });
      const pair = resp.data?.pairs?.[0];
      if (pair) {
        token.priceUsd   = parseFloat(pair.priceUsd) || 0;
        token.mcapUsd    = pair.fdv || 0;
        token.liquidity  = pair.liquidity?.usd || 0;
        token.pairAddress = pair.pairAddress || '';
        token.dex        = pair.dexId || 'unknown';
        token.url        = pair.url || token.url;
      }
    } catch { /* use defaults */ }
    return token;
  }

  private sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

  /**
   * Guarded TP2 take-profit. Claims isSelling synchronously; on any
   * failure or exception reverts tp2Hit/tp1Hit, arms the backoff, alerts
   * on schedule, and releases the claim — never bricks the position.
   * After a successful moonbag partial sell the remainder is marked
   * `moonbag = true` so exit-rules manage it via moonbag-trail (plus the
   * max-hold time cap) instead of leaving it unmanaged.
   */
  private async executeTp2TakeProfit(
    mint: string,
    position: ActivePosition,
    pnlPercent: number,
    realtime: boolean,
    sellSignal?: SellSignal,
  ): Promise<boolean> {
    const now = Date.now();
    if (this.activePositions.get(mint) !== position || position.isSelling) return false;
    if (!canAttemptSell(position, now)) return false;
    position.isSelling = true;
    const prevTp1 = position.tp1Hit;
    const prevTp2 = position.tp2Hit;
    position.tp2Hit = true;
    const prefix = realtime ? 'realtime' : 'poll';
    const symbol = position.token.symbol;
    const tp2Signal: SellSignal = sellSignal ?? { action: 'tp2', pnlPct: pnlPercent, source: realtime ? 'realtime' : 'poll' };

    try {
      const moonbagEnabled = CONFIG.MOONBAG_ENABLED && CONFIG.MOONBAG_PERCENT > 0 && CONFIG.MOONBAG_PERCENT < 100;
      if (moonbagEnabled) {
        const sellPct = Math.max(1, Math.min(99, 100 - CONFIG.MOONBAG_PERCENT));
        const beforeTokens = position.remainingTokens;
        logger.info(
          `🎯 TP2 (${prefix}) +${pnlPercent.toFixed(1)}%: ${symbol} — sell ${sellPct}%, keep ${CONFIG.MOONBAG_PERCENT}% moonbag`,
        );
        if (Math.floor(position.remainingTokens * (sellPct / 100)) <= 0) {
          logger.info(`🎯 TP2 dust (${prefix}): ${symbol} — closing remainder with full sell`);
          const ok = await this.executeSell(mint, position, `TP2 +${CONFIG.TP2_PERCENT}% (dust)`, tp2Signal);
          if (!ok) return this.releaseSellClaim(mint, position, prevTp1, prevTp2, now);
          return true;
        }
        const ok = await this.executePartialSell(
          mint,
          position,
          sellPct,
          `TP2 +${CONFIG.TP2_PERCENT}% (moonbag ${CONFIG.MOONBAG_PERCENT}% kept)`,
          tp2Signal,
        );
        if (!ok) return this.releaseSellClaim(mint, position, prevTp1, prevTp2, now);
        if (position.remainingTokens < beforeTokens) {
          position.solSpent = position.solSpent * (1 - sellPct / 100);
        }
        position.tp1Hit = true;
        position.moonbag = true;
        recordSellSuccess(position);
        position.isSelling = false;
        // Stage 9c: persist moonbag state fire-and-forget.
        this.persistPositionState(mint, position);
        return true;
      }

      logger.info(`🎯 TP2 (${prefix}) +${pnlPercent.toFixed(1)}%: ${symbol} — closing position`);
      const ok = await this.executeSell(mint, position, `TP2 +${CONFIG.TP2_PERCENT}%`, tp2Signal);
      if (!ok) return this.releaseSellClaim(mint, position, prevTp1, prevTp2, now);
      return true;
    } catch {
      return this.releaseSellClaim(mint, position, prevTp1, prevTp2, now);
    }
  }

  private registerClosedTradeRisk(pnlSol: number): void {
    this.sessionRealizedPnlSol += pnlSol;
    this.consecutiveLosses = pnlSol < 0 ? this.consecutiveLosses + 1 : 0;

    if (this.sessionRealizedPnlSol <= -Math.abs(CONFIG.PUMP_MAX_SESSION_LOSS_SOL)) {
      this.paused = true;
      logger.warn(`🧯 Circuit breaker: session loss ${this.sessionRealizedPnlSol.toFixed(3)} SOL reached. Bot paused.`);
      telegram.alertError(
        `🧯 Bot auto-paused: session loss cap hit (${this.sessionRealizedPnlSol.toFixed(3)} SOL).`,
      ).catch(() => {});
      return;
    }

    if (this.consecutiveLosses >= CONFIG.PUMP_MAX_CONSECUTIVE_LOSSES) {
      this.paused = true;
      logger.warn(`🧯 Circuit breaker: ${this.consecutiveLosses} consecutive losses. Bot paused.`);
      telegram.alertError(
        `🧯 Bot auto-paused: ${this.consecutiveLosses} consecutive losing exits.`,
      ).catch(() => {});
    }
  }
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

// ─── Entry point ──────────────────────────────────────────────────

async function main() {
  // Stage 9b-A: force PAPER mode at startup when LIVE is requested but not
  // unlocked — runs right after config load, before anything starts.
  const startupGuard = enforceStartupMode(CONFIG);
  if (startupGuard.forced && startupGuard.message) {
    logger.error(startupGuard.message);
    startupForcedMessage = startupGuard.message;
  }

  const sniper = new ElonSniper();

  const shutdown = async () => {
    logger.info('Shutting down...');
    try { eventLoopMonitor.stop(); } catch { /* ignore */ }
    await logEvent('STOP', 'Bot stopped');
    telegram.stopPolling();
    telegram.cancelPendingApprovals();
    sniper['pumpListener'].stop();
    await stopDashboardServer();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  await initDb();
  await sniper.initPaperLedger();
  // Stage 9c: reload persisted positions BEFORE the poll loop and listeners
  // start (those begin inside sniper.start()).
  await sniper.restorePositionsFromDb();
  await sniper.start();
}

main().catch(err => {
  logger.error(`Fatal: ${err}`);
  process.exit(1);
});
