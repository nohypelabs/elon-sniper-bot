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
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
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
    // Real-time price update for a subscribed token
    if (msg.mint && (msg.txType === 'buy' || msg.txType === 'sell') && this.tokenSubs.has(msg.mint)) {
      const vSol    = parseFloat(msg.vSolInBondingCurve) || 0;
      const vTokens = parseFloat(msg.vTokensInBondingCurve) || 1;
      const priceInSol = vTokens > 0 ? vSol / vTokens : 0;
      this.tokenSubs.get(msg.mint)!(priceInSol);
      return;
    }

    // PumpPortal sends a confirmation on subscribe — skip it
    if (!msg.mint || msg.txType !== 'create') return;

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

    this.stats.received++;

    const reject = this.filter(token);
    if (reject) {
      this.stats.filtered++;
      logger.info(`⏭ [${this.stats.received}] ${token.symbol} filtered: ${reject}`);
      return;
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

  private filter(token: NewPumpToken): string | null {
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
  }
}
