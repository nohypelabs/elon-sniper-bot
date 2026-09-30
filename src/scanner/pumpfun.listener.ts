/**
 * PumpFun New Token Listener
 *
 * Connects to PumpPortal WebSocket — broadcasts every new token
 * created on pump.fun in realtime (<100ms latency).
 *
 * Flow: new token event → filter → callback → buy
 */

import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';
import { logger } from '../utils/logger';
import { CONFIG } from '../config';
import { DevWalletChecker } from './dev-wallet.checker';
import { TokenObserver, ObservationResult } from './token-observer';
import { CurveFeed, CurveUpdate } from './curve-feed';
import { deriveBondingCurve } from './bonding-curve';

const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';

/**
 * Real-time trade/price source (Stage 10). PumpPortal only answers
 * subscribeTokenTrade when connected with a funded API key, so without one
 * the bot prices tokens from Solana account state via CurveFeed instead.
 */
export type TradeSource = 'pumpportal' | 'curve';

export interface FeedHealth {
  source: TradeSource;
  connected: boolean;
  subscriptions: number;
  lastUpdateAgoSec: number | null;
  reconnects: number;
}

/** Pure selection: 'auto' uses curve unless a PumpPortal key is present. */
export function selectTradeSource(setting: string, hasPumpPortalKey: boolean): TradeSource {
  if (setting === 'pumpportal') return 'pumpportal';
  if (setting === 'curve') return 'curve';
  return hasPumpPortalKey ? 'pumpportal' : 'curve';
}

/** PumpPortal's plain-text rejection for keyless trade subscriptions. */
export function isPumpPortalKeyRejection(msg: any): boolean {
  const text = typeof msg?.message === 'string' ? msg.message : '';
  return /only available when connecting with an API key/i.test(text);
}

// ONE warning per process when auto mode falls back to the curve feed.
let feedFallbackWarned = false;

export interface NewPumpToken {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  uri: string;
  creatorWallet: string;
  initialBuySol: number;   // SOL dev spent on initial buy
  marketCapSol: number;    // initial mcap in SOL
  initialPriceSol: number; // price per token in SOL at creation
  bondingCurveKey: string;
  signature: string;
  timestamp: number;
  /**
   * Monotonic arrival stamp (performance.now()) taken when the WebSocket
   * message is parsed — the true "token event received" time for latency
   * traces. Optional so older producers/tests keep compiling.
   */
  receivedAtMono?: number;
}

type TokenCallback = (token: NewPumpToken) => Promise<void>;

export class PumpFunListener {
  private ws: WebSocket | null = null;
  private callback: TokenCallback | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private running = false;

  // Dedup: skip same mint seen within 10s
  private recentMints = new Map<string, number>();
  // Creator cooldown: skip same creator within PUMP_CREATOR_COOLDOWN_MS
  private recentCreators = new Map<string, number>();

  // Real-time price subscriptions: mint → callback(priceInSol)
  private tokenSubs = new Map<string, (priceInSol: number) => void>();

  // ── Stage 10: TradeSource abstraction ──────────────────────────
  private tradeSource: TradeSource = 'pumpportal';
  private sourceResolved = false;
  private curveFeed: CurveFeed | null = null;
  private readonly curveFeedFactory: (url: string) => CurveFeed;
  private readonly clock: () => number;
  // mint → bondingCurveKey from every create event (newest-last, cap 2000)
  private mintToCurve = new Map<string, string>();
  // curve-mode refcounting: curveKey → mints using it; mint → curveKey
  private curveMintRefs = new Map<string, Set<string>>();
  private mintCurveSub = new Map<string, string>();
  private feedProblemCb: ((text: string) => void) | null = null;
  private lastFeedUpdateAt: number | null = null;
  private pumpReconnects = 0;

  constructor(opts?: { curveFeedFactory?: (url: string) => CurveFeed; now?: () => number }) {
    this.curveFeedFactory = opts?.curveFeedFactory ?? ((url) => new CurveFeed({ url }));
    this.clock = opts?.now ?? Date.now;
  }

  // Stats
  private stats = { received: 0, passed: 0, filtered: 0 };

  // Dev wallet checker (lazy-init when enabled)
  private devWalletChecker: DevWalletChecker | null = null;
  // Token observer for pre-buy trade observation
  private observer: TokenObserver | null = null;

  onNewToken(cb: TokenCallback) {
    this.callback = cb;
  }

  /** Subscribe to real-time price updates for a bought token (cb receives priceInSol) */
  subscribeToTrades(mint: string, onPrice: (priceInSol: number) => void) {
    this.ensureSourceResolved();
    this.tokenSubs.set(mint, onPrice);
    if (this.tradeSource === 'curve') {
      this.ensureCurveSub(mint);
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
    }
  }

  unsubscribeFromTrades(mint: string) {
    this.tokenSubs.delete(mint);
    if (this.tradeSource === 'curve') {
      this.releaseCurveSub(mint);
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mint] }));
    }
  }

  /** Optional callback so index.ts can send ONE Telegram alert on feed problems. */
  onFeedProblem(cb: (text: string) => void) {
    this.feedProblemCb = cb;
  }

  getTradeSource(): TradeSource {
    this.ensureSourceResolved();
    return this.tradeSource;
  }

  getFeedHealth(): FeedHealth {
    this.ensureSourceResolved();
    const lastAgo = this.lastFeedUpdateAt === null
      ? null
      : Math.max(0, (this.clock() - this.lastFeedUpdateAt) / 1000);
    if (this.tradeSource === 'curve' && this.curveFeed) {
      const st = this.curveFeed.stats();
      return {
        source: 'curve',
        connected: st.connected,
        subscriptions: st.subscriptions,
        lastUpdateAgoSec: this.lastFeedUpdateAt === null && st.lastUpdateAt !== null
          ? Math.max(0, (this.clock() - st.lastUpdateAt) / 1000)
          : lastAgo,
        reconnects: st.reconnects,
      };
    }
    return {
      source: this.tradeSource,
      connected: this.tradeSource === 'pumpportal' && this.ws?.readyState === WebSocket.OPEN,
      subscriptions: this.tokenSubs.size,
      lastUpdateAgoSec: lastAgo,
      reconnects: this.pumpReconnects,
    };
  }

  start() {
    this.running = true;
    this.ensureSourceResolved();
    this.connect();
    if (this.tradeSource === 'curve') this.ensureCurveFeed();
    setInterval(() => this.pruneCache(), 60_000);
    // Print filter stats every 30s
    setInterval(() => {
      if (this.stats.received > 0) {
        logger.info(`📊 PumpFun stats [30s] — received: ${this.stats.received} | passed: ${this.stats.passed} | filtered: ${this.stats.filtered}`);
        this.stats = { received: 0, passed: 0, filtered: 0 };
      }
    }, 30_000);

    // Feature 1: Dev wallet history check
    if (CONFIG.PUMP_DEV_WALLET_CHECK) {
      this.devWalletChecker = new DevWalletChecker();
      logger.info(`🔍 Dev wallet check: ON (max launches 24h: ${CONFIG.PUMP_MAX_LAUNCHES_24H})`);
    }

    // Feature 2: Token observation
    if (CONFIG.PUMP_OBSERVE_ENABLED) {
      this.observer = new TokenObserver();
      this.observer.setFeedMode(this.tradeSource === 'curve' ? 'curve' : 'pumpportal');
      this.observer.onResult((token, result) => this.handleObservationResult(token, result));
      this.observer.start();
      logger.info(`👁 Token observer: ON (${CONFIG.PUMP_OBSERVE_SECONDS}s window, min ${CONFIG.PUMP_MIN_UNIQUE_BUYERS} buyers, ${CONFIG.PUMP_MIN_BUY_RATIO} ratio, ${CONFIG.PUMP_MIN_SOL_VELOCITY} SOL/s)`);
    }
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.observer) this.observer.stop();
    try { this.curveFeed?.stop(); } catch { /* ignore */ }
    this.ws?.close();
  }

  // ─── TradeSource internals ────────────────────────────────────

  private pumpPortalKey(): string {
    return (process.env.PUMPPORTAL_API_KEY || '').trim();
  }

  private pumpPortalUrl(): string {
    const key = this.pumpPortalKey();
    return key ? `${PUMPPORTAL_WS}?api-key=${encodeURIComponent(key)}` : PUMPPORTAL_WS;
  }

  private ensureSourceResolved(): void {
    if (this.sourceResolved) return;
    this.sourceResolved = true;
    const setting = (CONFIG.PUMP_TRADE_FEED || 'auto').toLowerCase();
    this.tradeSource = selectTradeSource(setting, this.pumpPortalKey().length > 0);
  }

  private ensureCurveFeed(): void {
    if (this.curveFeed) return;
    this.curveFeed = this.curveFeedFactory(CONFIG.SOLANA_WS_URL);
    try {
      this.curveFeed.start();
    } catch (err) {
      logger.warn(`CurveFeed failed to start: ${(err as Error)?.message ?? err}`);
    }
  }

  /** Remember mint → curveKey (newest-last, pruned to 2000). */
  private noteCurveMapping(mint: string, curveKey: string): void {
    if (!mint || !curveKey) return;
    if (this.mintToCurve.get(mint) === curveKey) {
      // Refresh recency.
      this.mintToCurve.delete(mint);
      this.mintToCurve.set(mint, curveKey);
      return;
    }
    this.mintToCurve.set(mint, curveKey);
    while (this.mintToCurve.size > 2000) {
      const oldest = this.mintToCurve.keys().next();
      if (oldest.done) break;
      this.mintToCurve.delete(oldest.value);
    }
  }

  /** Curve key for a mint: remembered mapping, else derived PDA (restored positions). */
  private resolveCurveKey(mint: string): string {
    return this.mintToCurve.get(mint) || deriveBondingCurve(mint);
  }

  /** Subscribe a mint to the curve feed (refcounted per curveKey). */
  private ensureCurveSub(mint: string): void {
    if (this.tradeSource !== 'curve') return;
    this.ensureCurveFeed();
    if (!this.curveFeed) return;
    const curveKey = this.resolveCurveKey(mint);
    if (!curveKey) return;
    const prev = this.mintCurveSub.get(mint);
    if (prev === curveKey) return;
    if (prev) this.releaseCurveSub(mint);
    this.mintCurveSub.set(mint, curveKey);
    let refs = this.curveMintRefs.get(curveKey);
    if (!refs) {
      refs = new Set();
      this.curveMintRefs.set(curveKey, refs);
    }
    refs.add(mint);
    if (refs.size === 1) {
      try {
        this.curveFeed.subscribe(curveKey, (u) => this.handleCurveUpdate(u));
      } catch { /* ignore */ }
    }
  }

  private releaseCurveSub(mint: string): void {
    const curveKey = this.mintCurveSub.get(mint);
    if (!curveKey) return;
    this.mintCurveSub.delete(mint);
    // Keep the feed alive while the observer still watches this mint.
    if (this.tokenSubs.has(mint)) return;
    if (this.observer?.has(mint)) return;
    const refs = this.curveMintRefs.get(curveKey);
    if (refs) {
      refs.delete(mint);
      if (refs.size === 0) {
        this.curveMintRefs.delete(curveKey);
        try { this.curveFeed?.unsubscribe(curveKey); } catch { /* ignore */ }
      }
    }
  }

  private handleCurveUpdate(update: CurveUpdate): void {
    try {
      if (!update || !Number.isFinite(update.priceInSol) || update.priceInSol <= 0) return;
      this.lastFeedUpdateAt = this.clock();
      const refs = this.curveMintRefs.get(update.curveKey);
      if (!refs) return;
      for (const mint of [...refs]) {
        const priceCb = this.tokenSubs.get(mint);
        if (priceCb) {
          try { priceCb(update.priceInSol); } catch { /* ignore */ }
        }
        if (this.observer?.has(mint)) {
          try { this.observer.onCurveUpdate(mint, update); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * PumpPortal answered a trade subscription with the keyless rejection.
   * In auto mode switch to the curve feed at runtime (once per process).
   */
  private handleFeedRejection(text: string): void {
    if (CONFIG.PUMP_TRADE_FEED !== 'auto' || this.tradeSource !== 'pumpportal') return;
    this.tradeSource = 'curve';
    this.observer?.setFeedMode('curve');
    this.ensureCurveFeed();
    // Move every live subscription (positions + observed tokens) to curve.
    for (const mint of this.tokenSubs.keys()) {
      try { this.ensureCurveSub(mint); } catch { /* ignore */ }
    }
    if (this.observer) {
      for (const mint of this.observer.getMints()) {
        try { this.ensureCurveSub(mint); } catch { /* ignore */ }
      }
    }
    if (!feedFallbackWarned) {
      feedFallbackWarned = true;
      logger.warn(
        'PumpPortal trade subscriptions need a funded API key — switched to Solana curve feed (accountSubscribe). ' +
        `Rejection was: ${text.slice(0, 160)}`,
      );
      try { this.feedProblemCb?.('⚠️ PumpPortal trade feed ditolak (butuh API key) — pindah ke curve feed Solana.'); } catch { /* ignore */ }
    }
  }

  // ─── WebSocket ────────────────────────────────────────────────

  private connect() {
    logger.info('🔌 PumpFun listener connecting...');

    this.ws = new WebSocket(this.pumpPortalUrl());

    this.ws.on('open', () => {
      logger.info('✅ PumpFun listener connected — subscribing to new tokens');
      this.ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));
      // In curve mode prices come from the Solana account feed (which
      // resubscribes itself), so never ask PumpPortal for trades there.
      if (this.tradeSource !== 'pumpportal') return;
      // Re-subscribe to any active token price feeds
      if (this.tokenSubs.size > 0) {
        const keys = [...this.tokenSubs.keys()];
        this.ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys }));
        logger.info(`📡 Re-subscribed to ${keys.length} token trade feed(s)`);
      }
      // Re-subscribe to observed tokens
      if (this.observer && this.observer.size() > 0) {
        const observedMints = this.observer.getMints();
        if (observedMints.length > 0) {
          this.ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: observedMints }));
          logger.info(`👁 Re-subscribed to ${observedMints.length} observed token(s)`);
        }
      }
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const receivedAtMono = performance.now();
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg, receivedAtMono);
      } catch { /* ignore malformed */ }
    });

    this.ws.on('close', () => {
      logger.warn('PumpFun WS disconnected — reconnecting in 5s...');
      if (this.running) this.scheduleReconnect(5_000);
    });

    this.ws.on('error', (err) => {
      logger.error(`PumpFun WS error: ${err.message}`);
      this.ws?.close();
    });
  }

  private scheduleReconnect(delayMs: number) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pumpReconnects++;
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
  }

  // ─── Message handler ──────────────────────────────────────────

  private async handleMessage(msg: any, receivedAtMono?: number) {
    // Keyless trade-subscription rejection → auto fallback to curve feed.
    if (isPumpPortalKeyRejection(msg)) {
      this.handleFeedRejection(typeof msg.message === 'string' ? msg.message : 'API key required');
      return;
    }

    // Trade event (buy/sell) handling — only meaningful in pumpportal mode
    // (in curve mode prices arrive via handleCurveUpdate).
    if (msg.mint && (msg.txType === 'buy' || msg.txType === 'sell')) {
      if (this.tradeSource !== 'pumpportal') return;
      this.lastFeedUpdateAt = this.clock();
      // Real-time price update for a subscribed (bought) token
      if (this.tokenSubs.has(msg.mint)) {
        const vSol    = parseFloat(msg.vSolInBondingCurve) || 0;
        const vTokens = parseFloat(msg.vTokensInBondingCurve) || 1;
        const priceInSol = vTokens > 0 ? vSol / vTokens : 0;
        this.tokenSubs.get(msg.mint)!(priceInSol);
      }

      // Route to observer for tokens under observation
      if (this.observer && this.observer.has(msg.mint)) {
        const solAmount = parseFloat(msg.solAmount) || 0;
        this.observer.onTrade(msg.mint, msg.txType, msg.traderPublicKey || '', solAmount);
      }

      return;
    }

    // PumpPortal sends a confirmation on subscribe — skip it
    if (!msg.mint || msg.txType !== 'create') return;

    this.stats.received++;

    // Optional hard-block for mayhem-like feeds mixed into upstream streams
    if (CONFIG.PUMP_BLOCK_MAYHEM) {
      const sourceText = [
        msg.platform,
        msg.source,
        msg.market,
        msg.dex,
        msg.protocol,
        msg.exchange,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (sourceText.includes('mayhem')) {
        this.stats.filtered++;
        logger.info(`⏭ [${this.stats.received}] ${msg.symbol || msg.mint} filtered: mayhem source (${sourceText})`);
        return;
      }
    }

    // Enforce pump.fun new-pair shape when requested
    if (CONFIG.PUMP_ONLY_NEW_PAIR && (!msg.bondingCurveKey || !msg.vSolInBondingCurve || !msg.vTokensInBondingCurve)) {
      this.stats.filtered++;
      logger.info(`⏭ [${this.stats.received}] ${msg.symbol || msg.mint} filtered: non pump.fun new-pair event shape`);
      return;
    }

    // vSolInBondingCurve starts at 30 (virtual reserves) + any real SOL dev spent
    // So real dev SOL spend = vSolInBondingCurve - 30
    const vSolInCurve    = parseFloat(msg.vSolInBondingCurve) || 30;
    const vTokensInCurve = parseFloat(msg.vTokensInBondingCurve) || 1_073_000_000;
    const devSolSpent    = Math.max(0, vSolInCurve - 30);
    // marketCapSol = vSolInBondingCurve is the standard PumpFun mcap metric
    const marketCapSol   = parseFloat(msg.marketCapSol) || vSolInCurve;
    // price per token in SOL = vSol / vTokens
    const initialPriceSol = vTokensInCurve > 0 ? vSolInCurve / vTokensInCurve : 0;

    const token: NewPumpToken = {
      mint:            msg.mint,
      name:            msg.name || '',
      symbol:          msg.symbol || '',
      description:     msg.description || '',
      uri:             msg.uri || '',
      creatorWallet:   msg.traderPublicKey || '',
      initialBuySol:   devSolSpent,
      marketCapSol,
      initialPriceSol,
      bondingCurveKey: msg.bondingCurveKey || '',
      signature:       msg.signature || '',
      timestamp:       Date.now(),
      receivedAtMono,
    };

    const reject = this.filter(token);
    if (reject) {
      this.stats.filtered++;
      logger.info(`⏭ [${this.stats.received}] ${token.symbol} filtered: ${reject}`);
      return;
    }

    // Remember mint → curveKey so price/observer subscriptions can resolve
    // the PDA later (curve mode) without depending on this event object.
    this.noteCurveMapping(token.mint, token.bondingCurveKey);

    // Feature 1: Dev wallet history check
    if (this.devWalletChecker) {
      const devCheck = await this.devWalletChecker.check(token.creatorWallet);
      if (!devCheck.isSafe) {
        this.stats.filtered++;
        logger.info(`⏭ [${this.stats.received}] ${token.symbol} filtered: dev wallet — ${devCheck.reason} (launches: ${devCheck.launchCount24h}, rugs: ${devCheck.priorRugCount})`);
        return;
      }
      if (devCheck.launchCount24h > 0) {
        logger.info(`🔍 Dev ${token.creatorWallet.slice(0, 8)}... — launches: ${devCheck.launchCount24h}, rugs: ${devCheck.priorRugCount}`);
      }
    }

    // Feature 2: Token observation instead of immediate buy
    if (this.observer) {
      const registered = this.observer.register(token);
      if (registered) {
        this.stats.passed++;
        this.recentMints.set(token.mint, Date.now());
        this.recentCreators.set(token.creatorWallet, Date.now());
        logger.info(`👁 [${this.stats.received}] ${token.symbol} → observation (${CONFIG.PUMP_OBSERVE_SECONDS}s) | dev: ${token.initialBuySol} SOL | mcap: ${token.marketCapSol} SOL`);
        // Subscribe to trade events for observed token (same source as positions)
        if (this.tradeSource === 'curve') {
          this.ensureCurveSub(token.mint);
        } else if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [token.mint] }));
        }
        return;
      }
      // Observer at capacity — fall through to immediate callback
      logger.debug(`Observer at capacity — emitting ${token.symbol} immediately`);
    }

    this.stats.passed++;

    // Mark as seen
    this.recentMints.set(token.mint, Date.now());
    this.recentCreators.set(token.creatorWallet, Date.now());

    logger.info(`🆕 NEW TOKEN #${this.stats.passed}: ${token.symbol} | dev: ${token.initialBuySol} SOL | mcap: ${token.marketCapSol} SOL | ${token.mint.slice(0, 8)}`);

    if (this.callback) {
      await this.callback(token).catch(err =>
        logger.error(`PumpFun callback error: ${err.message}`),
      );
    }
  }

  // ─── Filter logic ─────────────────────────────────────────────

  private async handleObservationResult(token: NewPumpToken, result: ObservationResult): Promise<void> {
    // Unsubscribe from trade events for this observed token
    if (this.tradeSource === 'curve') {
      this.releaseCurveSub(token.mint);
    } else if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [token.mint] }));
    }

    if (result.passed) {
      logger.info(`✅ Observation passed: ${token.symbol} — ${result.uniqueBuyers} buyers, ${(result.buyRatio * 100).toFixed(0)}% ratio, ${result.solVelocity.toFixed(3)} SOL/s`);
      if (this.callback) {
        await this.callback(token).catch(err =>
          logger.error(`PumpFun callback error (observer): ${err.message}`),
        );
      }
    } else if (result.noData) {
      // Feed gap — NOT a market verdict, so it is logged (and counted)
      // separately from failed observations.
      this.stats.filtered++;
      logger.warn(`⏭ Observation no_data: ${token.symbol} — ${result.reason}`);
    } else {
      this.stats.filtered++;
      logger.info(`⏭ Observation failed: ${token.symbol} — ${result.reason}`);
    }
  }

  private filter(token: NewPumpToken): string | null {
    const cleanName = (token.name || '').trim();
    const cleanSymbol = (token.symbol || '').trim();

    if (cleanName.length < CONFIG.PUMP_MIN_NAME_LEN) {
      return `name too short (${cleanName.length} < ${CONFIG.PUMP_MIN_NAME_LEN})`;
    }
    if (cleanSymbol.length < CONFIG.PUMP_MIN_SYMBOL_LEN) {
      return `symbol too short (${cleanSymbol.length} < ${CONFIG.PUMP_MIN_SYMBOL_LEN})`;
    }
    if (!/^[a-zA-Z0-9\s$._-]+$/.test(cleanName)) {
      return 'name contains suspicious characters';
    }
    if (!/^[a-zA-Z0-9$._-]+$/.test(cleanSymbol)) {
      return 'symbol contains suspicious characters';
    }
    if (CONFIG.PUMP_REQUIRE_SOCIALS && !token.uri) {
      return 'missing metadata uri';
    }

    // Dedup
    if (this.recentMints.has(token.mint)) return 'already seen';

    // Creator cooldown
    const lastCreator = this.recentCreators.get(token.creatorWallet);
    if (lastCreator && Date.now() - lastCreator < CONFIG.PUMP_CREATOR_COOLDOWN_MS) {
      return `creator cooldown (${Math.round((Date.now() - lastCreator) / 1000)}s ago)`;
    }

    // Dev buy range
    if (token.initialBuySol < CONFIG.PUMP_MIN_DEV_BUY_SOL) {
      return `dev buy too low (${token.initialBuySol} < ${CONFIG.PUMP_MIN_DEV_BUY_SOL} SOL)`;
    }
    if (token.initialBuySol > CONFIG.PUMP_MAX_DEV_BUY_SOL) {
      return `dev buy too high (${token.initialBuySol} > ${CONFIG.PUMP_MAX_DEV_BUY_SOL} SOL)`;
    }

    // Initial mcap range
    if (token.marketCapSol < CONFIG.PUMP_MIN_MCAP_SOL) {
      return `mcap too low (${token.marketCapSol.toFixed(2)} < ${CONFIG.PUMP_MIN_MCAP_SOL} SOL)`;
    }
    if (token.marketCapSol > CONFIG.PUMP_MAX_MCAP_SOL) {
      return `mcap too high (${token.marketCapSol.toFixed(2)} > ${CONFIG.PUMP_MAX_MCAP_SOL} SOL)`;
    }

    // Volume filter: real SOL in bonding curve = marketCapSol - 30 (virtual floor)
    // Ensures organic buyers already came in before we snipe
    if (CONFIG.PUMP_MIN_VOLUME_SOL > 0) {
      const realSolInCurve = Math.max(0, token.marketCapSol - 30);
      if (realSolInCurve < CONFIG.PUMP_MIN_VOLUME_SOL) {
        return `volume too low (${realSolInCurve.toFixed(3)} SOL < ${CONFIG.PUMP_MIN_VOLUME_SOL} SOL real in curve)`;
      }
    }

    // Blacklist words in name/symbol
    const haystack = `${token.name} ${token.symbol} ${token.description}`.toLowerCase();
    for (const word of CONFIG.PUMP_BLACKLIST_WORDS) {
      if (word && haystack.includes(word)) return `blacklist word: "${word}"`;
    }

    // Whitelist — if set, token must match at least one word
    if (CONFIG.PUMP_WHITELIST_WORDS.length > 0) {
      const match = CONFIG.PUMP_WHITELIST_WORDS.some(w => w && haystack.includes(w));
      if (!match) return `no whitelist match (${CONFIG.PUMP_WHITELIST_WORDS.join(',')})`;
    }

    return null; // passed all filters
  }

  private pruneCache() {
    const now = Date.now();
    for (const [k, t] of this.recentMints) {
      if (now - t > 30_000) this.recentMints.delete(k);
    }
    for (const [k, t] of this.recentCreators) {
      if (now - t > CONFIG.PUMP_CREATOR_COOLDOWN_MS * 2) this.recentCreators.delete(k);
    }
    if (this.devWalletChecker) {
      this.devWalletChecker.prune();
    }
  }
}
