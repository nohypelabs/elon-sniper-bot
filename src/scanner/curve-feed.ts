/**
 * CurveFeed (Stage 10): real-time pump.fun price feed over plain Solana
 * JSON-RPC WebSocket — no PumpPortal API key needed.
 *
 * One shared socket, `accountSubscribe` per bonding-curve PDA
 * (encoding base64, commitment processed). Each accountNotification is
 * parsed with parseBondingCurve() and delivered as a CurveUpdate.
 *
 * Resilience: exponential-backoff reconnect (1s..30s, reset on success)
 * with full resubscribe, 30s keepalive ping, 90s watchdog that
 * force-reconnects a silent-but-open socket. Consecutive duplicate
 * notifications with identical reserves are dropped. Callback exceptions
 * are swallowed. Capped at 200 subscriptions. The URL query string
 * (api-key=...) is never logged.
 */

import WebSocket from 'ws';
import { logger } from '../utils/logger';
import {
  parseBondingCurve,
  curvePriceInSol,
  curveMarketCapSol,
} from './bonding-curve';

export interface CurveUpdate {
  curveKey: string;
  priceInSol: number;
  marketCapSol: number;
  virtualSolReserves: number; // SOL
  realSolReserves: number; // SOL
  complete: boolean;
  slot: number;
  receivedAt: number;
}

export interface CurveFeedStats {
  connected: boolean;
  subscriptions: number;
  lastUpdateAt: number | null;
  reconnects: number;
  updates: number;
}

export interface CurveFeedOptions {
  url: string;
  WebSocketCtor?: typeof WebSocket;
  now?: () => number;
  reconnectBaseMs?: number;
  /** Test hook: keepalive ping period. Default 30_000. */
  pingIntervalMs?: number;
  /** Test hook: silence window that triggers a force-reconnect. Default 90_000. */
  watchdogMs?: number;
  /** Test hook: how often the watchdog checks. Default min(10_000, watchdogMs). */
  watchdogCheckMs?: number;
}

const MAX_SUBSCRIPTIONS = 200;
const LAMPORTS_PER_SOL = 1e9;

/** Mask api-key / API key query params before anything is logged. */
export function maskFeedUrl(url: string): string {
  try {
    return url.replace(/([?&](api-key|api_key|apikey)=)[^&]*/gi, '$1***');
  } catch {
    return '(unloggable-url)';
  }
}

type WsLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  ping?(): void;
  on(event: string, cb: (...args: any[]) => void): void;
  removeAllListeners?(): void;
};

export class CurveFeed {
  private readonly url: string;
  private readonly WsCtor: typeof WebSocket;
  private readonly now: () => number;
  private readonly reconnectBaseMs: number;
  private readonly pingIntervalMs: number;
  private readonly watchdogMs: number;
  private readonly watchdogCheckMs: number;

  private ws: WsLike | null = null;
  private running = false;
  private nextId = 1;
  /** JSON-RPC request id -> curveKey (awaiting subscription confirmation). */
  private pending = new Map<number, string>();
  /** subscription id -> curveKey (confirmed). */
  private subIdToKey = new Map<number, string>();
  /** curveKey -> subscription id (confirmed). */
  private keyToSubId = new Map<string, number>();
  /** curveKey -> callbacks. */
  private subs = new Map<string, Set<(u: CurveUpdate) => void>>();
  /** curveKey -> last delivered reserves fingerprint (duplicate suppression). */
  private lastReserves = new Map<string, string>();

  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastActivityAt = 0;
  private lastUpdateAt: number | null = null;
  private reconnects = 0;
  private updates = 0;

  constructor(opts: CurveFeedOptions) {
    this.url = opts.url;
    this.WsCtor = opts.WebSocketCtor ?? WebSocket;
    this.now = opts.now ?? Date.now;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1000;
    this.pingIntervalMs = opts.pingIntervalMs ?? 30_000;
    this.watchdogMs = opts.watchdogMs ?? 90_000;
    this.watchdogCheckMs = opts.watchdogCheckMs ?? Math.min(10_000, this.watchdogMs);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.pingTimer = setInterval(() => this.ping(), this.pingIntervalMs);
    this.pingTimer.unref?.();
    this.watchdogTimer = setInterval(() => this.checkWatchdog(), this.watchdogCheckMs);
    this.watchdogTimer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.pending.clear();
    this.subIdToKey.clear();
    this.keyToSubId.clear();
  }

  subscribe(curveKey: string, onUpdate: (u: CurveUpdate) => void): void {
    if (!curveKey || typeof onUpdate !== 'function') return;
    let set = this.subs.get(curveKey);
    if (!set) {
      if (this.subs.size >= MAX_SUBSCRIPTIONS) {
        logger.warn(`CurveFeed: subscription cap (${MAX_SUBSCRIPTIONS}) reached — ignoring ${curveKey.slice(0, 8)}...`);
        return;
      }
      set = new Set();
      this.subs.set(curveKey, set);
    }
    set.add(onUpdate);
    // (Re)send the subscribe request when the socket is open and this key
    // has no confirmed subscription on the current connection.
    if (this.isOpen() && !this.keyToSubId.has(curveKey)) {
      this.sendSubscribe(curveKey);
    }
  }

  unsubscribe(curveKey: string): void {
    this.subs.delete(curveKey);
    this.lastReserves.delete(curveKey);
    const subId = this.keyToSubId.get(curveKey);
    this.keyToSubId.delete(curveKey);
    if (subId !== undefined) {
      this.subIdToKey.delete(subId);
      // Drop stale pending requests for this key (reconnect resends anyway).
      for (const [id, key] of this.pending) {
        if (key === curveKey) this.pending.delete(id);
      }
      if (this.isOpen()) {
        try {
          this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'accountUnsubscribe', params: [subId] }));
        } catch { /* ignore */ }
      }
    }
  }

  size(): number {
    return this.subs.size;
  }

  stats(): CurveFeedStats {
    return {
      connected: this.isOpen(),
      subscriptions: this.subs.size,
      lastUpdateAt: this.lastUpdateAt,
      reconnects: this.reconnects,
      updates: this.updates,
    };
  }

  // ─── internals ────────────────────────────────────────────────

  private isOpen(): boolean {
    try {
      return !!this.ws && this.ws.readyState === (this.WsCtor as any).OPEN;
    } catch {
      return false;
    }
  }

  private connect(): void {
    if (!this.running) return;
    let ws: WsLike;
    try {
      ws = new this.WsCtor(this.url) as unknown as WsLike;
    } catch (err) {
      logger.warn(`CurveFeed: connect failed (${maskFeedUrl(this.url)}): ${(err as Error)?.message ?? err}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('open', () => this.handleOpen());
    ws.on('message', (data: any) => this.handleRawMessage(data));
    ws.on('pong', () => { this.lastActivityAt = this.now(); });
    ws.on('close', () => this.handleClose());
    ws.on('error', (err: any) => {
      logger.warn(`CurveFeed: socket error (${maskFeedUrl(this.url)}): ${err?.message ?? err}`);
      try { ws.close(); } catch { /* ignore */ }
    });
  }

  private handleOpen(): void {
    this.lastActivityAt = this.now();
    this.reconnectAttempt = 0;
    this.pending.clear();
    this.subIdToKey.clear();
    this.keyToSubId.clear();
    // Resubscribe everything on the fresh connection.
    for (const key of this.subs.keys()) {
      this.sendSubscribe(key);
    }
  }

  private handleClose(): void {
    if (this.ws) {
      try { this.ws.removeAllListeners?.(); } catch { /* ignore */ }
    }
    if (this.ws) this.ws = null;
    this.pending.clear();
    this.subIdToKey.clear();
    this.keyToSubId.clear();
    if (this.running) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = Math.min(30_000, this.reconnectBaseMs * 2 ** this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnects++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private ping(): void {
    try {
      if (this.isOpen()) this.ws!.ping?.();
    } catch { /* ignore */ }
  }

  private checkWatchdog(): void {
    try {
      if (!this.running || !this.isOpen()) return;
      if (this.lastActivityAt <= 0) return;
      if (this.now() - this.lastActivityAt > this.watchdogMs) {
        logger.warn(`CurveFeed: no data for ${Math.round(this.watchdogMs / 1000)}s — force-reconnecting (${maskFeedUrl(this.url)})`);
        try { this.ws!.close(); } catch { /* ignore */ }
        // handleClose() will schedule the reconnect.
      }
    } catch { /* ignore */ }
  }

  private sendSubscribe(curveKey: string): void {
    const id = this.nextId++;
    this.pending.set(id, curveKey);
    try {
      this.ws!.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'accountSubscribe',
        params: [curveKey, { encoding: 'base64', commitment: 'processed' }],
      }));
    } catch {
      this.pending.delete(id);
    }
  }

  private handleRawMessage(data: any): void {
    let text: string;
    try {
      text = typeof data === 'string' ? data : data.toString();
    } catch { return; }
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch { return; } // ignore garbage
    this.handleMessage(msg);
  }

  /** Message dispatcher — public for tests (fake transports call it directly). */
  handleMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;
    this.lastActivityAt = this.now();

    // Subscription confirmation: { jsonrpc, id, result: <subscriptionId> }.
    if (typeof msg.id === 'number' && typeof msg.result === 'number') {
      const key = this.pending.get(msg.id);
      if (key !== undefined) {
        this.pending.delete(msg.id);
        // Only track keys we still care about.
        if (this.subs.has(key)) {
          this.subIdToKey.set(msg.result, key);
          this.keyToSubId.set(key, msg.result);
        }
      }
      return;
    }

    // Account notification.
    if (msg.method !== 'accountNotification' || !msg.params || typeof msg.params !== 'object') return;
    const params = msg.params;
    if (typeof params.subscription !== 'number') return;
    const curveKey = this.subIdToKey.get(params.subscription);
    if (!curveKey || !this.subs.has(curveKey)) return;
    const value = params.result?.value;
    const dataArr = value?.data;
    if (!Array.isArray(dataArr) || typeof dataArr[0] !== 'string') return;
    const slot = params.result?.context?.slot;
    if (typeof slot !== 'number') return;

    let curve;
    try {
      curve = parseBondingCurve(dataArr[0]);
    } catch {
      return;
    }
    if (!curve) return; // ignore unparsable data

    // Drop consecutive duplicates with identical reserves.
    const fingerprint = `${curve.virtualTokenReserves}:${curve.virtualSolReserves}:${curve.realTokenReserves}:${curve.realSolReserves}:${curve.tokenTotalSupply}:${curve.complete}`;
    if (this.lastReserves.get(curveKey) === fingerprint) return;
    this.lastReserves.set(curveKey, fingerprint);

    const priceInSol = curvePriceInSol(curve);
    const update: CurveUpdate = {
      curveKey,
      priceInSol,
      marketCapSol: curveMarketCapSol(curve),
      virtualSolReserves: Number(curve.virtualSolReserves) / LAMPORTS_PER_SOL,
      realSolReserves: Number(curve.realSolReserves) / LAMPORTS_PER_SOL,
      complete: curve.complete,
      slot,
      receivedAt: this.now(),
    };
    this.lastUpdateAt = update.receivedAt;
    this.updates++;

    const callbacks = this.subs.get(curveKey);
    if (!callbacks) return;
    for (const cb of [...callbacks]) {
      try {
        cb(update);
      } catch { /* swallow callback errors */ }
    }
  }
}
