/**
 * PumpFun New Token Listener
 *
 * Connects to PumpPortal WebSocket — broadcasts every new token
 * created on pump.fun in realtime (<100ms latency).
 *
 * Flow: new token event → filter → callback → buy
 */

import WebSocket from 'ws';
import { logger } from '../utils/logger';
import { CONFIG } from '../config';
import { DevWalletChecker } from './dev-wallet.checker';
import { TokenObserver, ObservationResult } from './token-observer';

const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';

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

  // Stats
  private stats = { received: 0, passed: 0, filtered: 0 };

  // Dev wallet checker (lazy-init when enabled)
  private devWalletChecker: DevWalletChecker | null = null;
  // Token observer for pre-buy trade observation
  private observer: TokenObserver | null = null;

  onNewToken(cb: TokenCallback) {
    this.callback = cb;
  }

  /** Subscribe to real-time price updates for a bought token */
  subscribeToTrades(mint: string, onPrice: (priceInSol: number) => void) {
    this.tokenSubs.set(mint, onPrice);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
    }
  }

  unsubscribeFromTrades(mint: string) {
    this.tokenSubs.delete(mint);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mint] }));
    }
  }

  start() {
    this.running = true;
    this.connect();
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
      this.observer.onResult((token, result) => this.handleObservationResult(token, result));
      this.observer.start();
      logger.info(`👁 Token observer: ON (${CONFIG.PUMP_OBSERVE_SECONDS}s window, min ${CONFIG.PUMP_MIN_UNIQUE_BUYERS} buyers, ${CONFIG.PUMP_MIN_BUY_RATIO} ratio, ${CONFIG.PUMP_MIN_SOL_VELOCITY} SOL/s)`);
    }
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.observer) this.observer.stop();
    this.ws?.close();
  }

  // ─── WebSocket ────────────────────────────────────────────────

  private connect() {
    logger.info('🔌 PumpFun listener connecting...');

    this.ws = new WebSocket(PUMPPORTAL_WS);

    this.ws.on('open', () => {
      logger.info('✅ PumpFun listener connected — subscribing to new tokens');
      this.ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));
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
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
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
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
  }

  // ─── Message handler ──────────────────────────────────────────

  private async handleMessage(msg: any) {
    // Trade event (buy/sell) handling
    if (msg.mint && (msg.txType === 'buy' || msg.txType === 'sell')) {
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
    };

    const reject = this.filter(token);
    if (reject) {
      this.stats.filtered++;
      logger.info(`⏭ [${this.stats.received}] ${token.symbol} filtered: ${reject}`);
      return;
    }

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
        // Subscribe to trade events for observed token
        if (this.ws?.readyState === WebSocket.OPEN) {
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
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [token.mint] }));
    }

    if (result.passed) {
      logger.info(`✅ Observation passed: ${token.symbol} — ${result.uniqueBuyers} buyers, ${(result.buyRatio * 100).toFixed(0)}% ratio, ${result.solVelocity.toFixed(3)} SOL/s`);
      if (this.callback) {
        await this.callback(token).catch(err =>
          logger.error(`PumpFun callback error (observer): ${err.message}`),
        );
      }
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
