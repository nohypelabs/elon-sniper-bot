import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  countTrades,
  listBuysForPairing,
  listBuysForStats,
  listEvents,
  listPositions,
  listSells,
  listSellsForPnl,
  listSellsForStats,
  listTrades,
} from '../db/repo';
import { logger } from '../utils/logger';
import { runBacktest } from '../backtest/runner';
import { CONFIG } from '../config';
import { EDITABLE_CONFIG, applyConfig } from '../config/editable';
import path from 'path';
import fs from 'fs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { encryptKey, decryptKey } from '../utils/wallet.crypto';
import { isAuthorized, unauthorizedResponseHeaders } from './auth';
import { isOriginAllowed, parseAllowedOrigins } from './origin-guard';

const DASHBOARD_PORT = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || '3001');

export interface BotState {
  mode: 'PAPER' | 'LIVE';
  running: boolean;
  paused: boolean;
  uptime: number;
  tweetsDetected: number;
  buysExecuted: number;
  solBalance: number;
  solPriceUsd: number;
  activePositions: ActivePositionInfo[];
}

function periodToDate(period: string): Date | null {
  const now = new Date();
  if (period === '1d')  { now.setDate(now.getDate() - 1);   return now; }
  if (period === '7d')  { now.setDate(now.getDate() - 7);   return now; }
  if (period === '30d') { now.setDate(now.getDate() - 30);  return now; }
  return null;
}

export interface ActivePositionInfo {
  tokenMint: string;
  symbol: string;
  name: string;
  apedAt: string;
  entryPrice: number;
  currentPrice: number;
  entryMcapUsd: number;
  currentMcapUsd: number;
  pnlPercent: number;
  pnlSol: number;
  solSpent: number;
  ageMinutes: number;
  dex: string;
  tweetText?: string;
}

let wss: WebSocketServer | null = null;
let botStateGetter: () => BotState = () => ({
  mode: 'PAPER', running: false, paused: false, uptime: 0,
  tweetsDetected: 0, buysExecuted: 0, solBalance: 0, solPriceUsd: 0,
  activePositions: [],
});
let sellPositionHandler:  (mint: string) => Promise<void> = async () => {};
let pauseHandler:  () => void = () => {};
let resumeHandler: () => void = () => {};
let walletReloadHandler: (key: string) => void = () => {};
let walletAddressGetter: () => string | null = () => null;

export function registerDashboardHandlers(opts: {
  getState:       () => BotState;
  onSell:         (mint: string) => Promise<void>;
  onPause:        () => void;
  onResume:       () => void;
  onWalletReload: (key: string) => void;
  getWalletAddress: () => string | null;
}) {
  botStateGetter       = opts.getState;
  sellPositionHandler  = opts.onSell;
  pauseHandler         = opts.onPause;
  resumeHandler        = opts.onResume;
  walletReloadHandler  = opts.onWalletReload;
  walletAddressGetter  = opts.getWalletAddress;
}

export function broadcastState() {
  if (!wss) return;
  const msg = JSON.stringify({ type: 'state', data: botStateGetter() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

export async function startDashboardServer() {
  const app = new Hono();

  // Explicitly allowed cross-site origins (e.g. Vite dev server). Read from
  // process.env directly (NOT via CONFIG) so it stays a transport concern.
  const allowedOrigins = parseAllowedOrigins(process.env.DASHBOARD_ALLOWED_ORIGINS);

  // Echo back the request Origin only when it is same-host or explicitly
  // allowed; otherwise omit Access-Control-Allow-Origin so browsers block
  // cross-site reads. (The cors origin callback receives the context, so the
  // Host header IS visible here — no need to drop the middleware.)
  app.use('*', cors({
    origin: (o, c) => (isOriginAllowed(o, c.req.header('host'), allowedOrigins) ? o : ''),
  }));

  // CSRF guard, BEFORE auth: browsers attach cached Basic credentials to
  // cross-site form/simple POSTs, so state-changing requests must carry a
  // same-host (or explicitly allowed) Origin. No-Origin clients (curl,
  // server-to-server) are unaffected.
  app.use('*', async (c, next) => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      if (!isOriginAllowed(c.req.header('origin'), c.req.header('host'), allowedOrigins)) {
        return c.text('Forbidden origin', 403);
      }
    }
    return next();
  });

  app.use('*', async (c, next) => {
    if (isAuthorized(c.req.header('authorization'), CONFIG.DASHBOARD_USER, CONFIG.DASHBOARD_PASSWORD)) return next();
    return c.text('Unauthorized', 401, unauthorizedResponseHeaders);
  });

  app.get('/api/status', c => c.json(botStateGetter()));

  app.get('/api/positions', async c => {
    const positions = await listPositions();
    return c.json(positions);
  });

  app.get('/api/trades', async c => {
    const page  = parseInt(c.req.query('page')  || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const [trades, total] = await Promise.all([
      listTrades({ page, limit }),
      countTrades(),
    ]);
    return c.json({ trades, total, page, pages: Math.ceil(total / limit) });
  });

  app.get('/api/trades/paired', async c => {
    // Fetch all sells + all buys in 2 queries, join in-memory (avoids N+1)
    const [sells, buys] = await Promise.all([
      listSells(),
      listBuysForPairing(),
    ]);
    const paired = sells.map(sell => {
      const matchingBuys = buys.filter(b => b.tokenMint === sell.tokenMint && b.createdAt <= sell.createdAt);
      const buy = matchingBuys[matchingBuys.length - 1];
      return {
        id:          sell.id,
        symbol:      sell.symbol,
        name:        sell.name,
        dex:         sell.dex,
        reason:      sell.reason,
        pnlPercent:  sell.pnlPercent,
        pnlSol:      sell.pnlSol,
        solAmount:   sell.solAmount,
        buyMcapUsd:  buy?.mcapUsd ?? null,
        sellMcapUsd: sell.mcapUsd,
        buyTime:     buy?.createdAt ?? null,
        sellTime:    sell.createdAt,
        txSignature: sell.txSignature,
        source:      sell.source,
      };
    });
    return c.json(paired);
  });

  app.get('/api/pnl', async c => {
    const period = c.req.query('period') || 'all';
    const mode = c.req.query('mode') || 'PAPER';
    const since  = periodToDate(period);
    const sells = await listSellsForPnl({ since, excludePaper: mode === 'LIVE' });
    let cumulative = 0;
    const points = sells.map(s => {
      cumulative += s.pnlSol ?? 0;
      return { date: s.createdAt, pnlSol: s.pnlSol, pnlPercent: s.pnlPercent, cumulative: parseFloat(cumulative.toFixed(4)), symbol: s.symbol };
    });
    return c.json(points);
  });

  app.get('/api/stats', async c => {
    const period = c.req.query('period') || 'all';
    const mode = c.req.query('mode') || 'PAPER';
    const since  = periodToDate(period);

    const [sells, buys] = await Promise.all([
      listSellsForStats({ since, excludePaper: mode === 'LIVE' }),
      listBuysForStats(),
    ]);

    const totalPnlSol = sells.reduce((s, t) => s + (t.pnlSol ?? 0), 0);

    // Group sells by position: each (tokenMint, most-recent-buy-before-sell) = 1 position
    const positionMap = new Map<string, { pnlSol: number; solAmount: number }>();
    for (const sell of sells) {
      const matchingBuys = buys.filter(b => b.tokenMint === sell.tokenMint && b.createdAt <= sell.createdAt);
      const latestBuy    = matchingBuys[matchingBuys.length - 1];
      const key          = latestBuy ? `${sell.tokenMint}_${latestBuy.id}` : `${sell.tokenMint}_orphan`;
      const prev         = positionMap.get(key) ?? { pnlSol: 0, solAmount: 0 };
      positionMap.set(key, {
        pnlSol:    prev.pnlSol    + (sell.pnlSol    ?? 0),
        solAmount: prev.solAmount + (sell.solAmount  ?? 0),
      });
    }

    const positions = Array.from(positionMap.values());
    const wins      = positions.filter(p => p.pnlSol > 0).length;
    const total     = positions.length;
    const winRate   = total > 0 ? (wins / total) * 100 : 0;
    const avgPnl    = total > 0
      ? positions.reduce((s, p) => s + (p.solAmount > 0 ? (p.pnlSol / p.solAmount) * 100 : 0), 0) / total
      : 0;

    return c.json({ totalPnlSol: parseFloat(totalPnlSol.toFixed(4)), wins, losses: total - wins, total, winRate: parseFloat(winRate.toFixed(1)), avgPnlPercent: parseFloat(avgPnl.toFixed(1)) });
  });

  // ─── Config endpoints ─────────────────────────────────────────────

  app.get('/api/config', c => {
    const out: Record<string, unknown> = {};
    for (const k of EDITABLE_CONFIG) out[k] = (CONFIG as any)[k];
    out['PAPER_TRADING'] = CONFIG.PAPER_TRADING;
    return c.json(out);
  });

  app.post('/api/config', async c => {
    const body = await c.req.json().catch(() => ({}));
    const updated: Record<string, number | boolean> = {};

    for (const key of [...EDITABLE_CONFIG, 'PAPER_TRADING'] as string[]) {
      if (!(key in body)) continue;
      const val = body[key];
      if (typeof val === 'boolean' || typeof val === 'number') updated[key] = val;
    }

    applyConfig(updated);
    return c.json({ ok: true, updated });
  });

  // ─── Wallet endpoints ─────────────────────────────────────────────

  app.get('/api/wallet', c => {
    const address = walletAddressGetter();
    const encryptedKey = process.env.WALLET_PRIVATE_KEY_ENCRYPTED || '';
    return c.json({ connected: !!address, address, hasStoredKey: !!encryptedKey });
  });

  app.post('/api/wallet/connect', async c => {
    const { privateKey } = await c.req.json().catch(() => ({}));
    if (!privateKey) return c.json({ ok: false, error: 'No private key provided' }, 400);

    try {
      const keypair = Keypair.fromSecretKey(bs58.decode(privateKey.trim()));
      const address = keypair.publicKey.toBase58();

      // Encrypt and persist to .env
      const encrypted = encryptKey(privateKey.trim());
      const envPath = path.join(process.cwd(), '.env');
      let content = fs.readFileSync(envPath, 'utf8');
      const re = /^WALLET_PRIVATE_KEY_ENCRYPTED=.*$/m;
      const line = `WALLET_PRIVATE_KEY_ENCRYPTED=${encrypted}`;
      content = re.test(content) ? content.replace(re, line) : content + `\n${line}`;
      // Clear plaintext key for safety
      content = content.replace(/^WALLET_PRIVATE_KEY=.+$/m, 'WALLET_PRIVATE_KEY=');
      fs.writeFileSync(envPath, content);
      process.env.WALLET_PRIVATE_KEY_ENCRYPTED = encrypted;

      // Reload in-memory wallet
      walletReloadHandler(privateKey.trim());
      logger.info(`🔑 Wallet connected via dashboard: ${address}`);
      return c.json({ ok: true, address });
    } catch {
      return c.json({ ok: false, error: 'Private key tidak valid. Pastikan format base58.' }, 400);
    }
  });

  app.post('/api/wallet/disconnect', c => {
    const envPath = path.join(process.cwd(), '.env');
    let content = fs.readFileSync(envPath, 'utf8');
    content = content.replace(/^WALLET_PRIVATE_KEY_ENCRYPTED=.*$/m, 'WALLET_PRIVATE_KEY_ENCRYPTED=');
    content = content.replace(/^WALLET_PRIVATE_KEY=.+$/m, 'WALLET_PRIVATE_KEY=');
    fs.writeFileSync(envPath, content);
    process.env.WALLET_PRIVATE_KEY_ENCRYPTED = '';
    walletReloadHandler('');
    logger.info('🔑 Wallet disconnected');
    return c.json({ ok: true });
  });

  app.get('/api/events', async c => {
    const limit = parseInt(c.req.query('limit') || '100');
    const events = await listEvents(limit);
    return c.json(events);
  });

  app.post('/api/sell/:mint', async c => {
    const mint = c.req.param('mint');
    await sellPositionHandler(mint);
    return c.json({ ok: true });
  });

  app.post('/api/bot/pause', c => {
    pauseHandler();
    broadcastState();
    return c.json({ ok: true, paused: true });
  });

  app.post('/api/bot/resume', c => {
    resumeHandler();
    broadcastState();
    return c.json({ ok: true, paused: false });
  });

  app.post('/api/backtest', async c => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = {
      tp1Percent:      body.tp1Percent      ?? CONFIG.TP1_PERCENT,
      tp1SellPercent:  body.tp1SellPercent  ?? CONFIG.TP1_SELL_PERCENT,
      tp2Percent:      body.tp2Percent      ?? CONFIG.TP2_PERCENT,
      slPercent:       body.slPercent       ?? CONFIG.STOP_LOSS_PERCENT,
      maxHoldMinutes:  body.maxHoldMinutes  ?? CONFIG.PUMP_MAX_HOLD_MINUTES,
      buyAmountSol:    body.buyAmountSol    ?? CONFIG.BUY_AMOUNT_SOL,
      numTokens:       Math.min(body.numTokens ?? 500, 2000),
    };
    const result = runBacktest(cfg);
    return c.json(result);
  });

  // Serve React build
  const staticRoot = path.join(process.cwd(), 'dashboard', 'dist');
  app.use('/*', serveStatic({ root: staticRoot }));
  app.get('*', serveStatic({ path: path.join(staticRoot, 'index.html') }));

  // HTTP handled by @hono/node-server (streams bodies, preserves binary);
  // raw http server kept for WebSocket co-hosting on the same port.
  const httpServer = createServer(getRequestListener((req) => app.fetch(req)));

  wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    // Browsers send Origin + cached Basic creds on the WS handshake, so an
    // attacker page could otherwise hijack the live feed. Require both.
    verifyClient: ({ req }: { req: IncomingMessage }) =>
      isAuthorized(req.headers.authorization, CONFIG.DASHBOARD_USER, CONFIG.DASHBOARD_PASSWORD) &&
      isOriginAllowed(req.headers.origin, req.headers.host, allowedOrigins),
  });
  if (!CONFIG.DASHBOARD_PASSWORD) logger.warn('DASHBOARD_PASSWORD not set — dashboard is open (tunnel will be refused)');
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'state', data: botStateGetter() }));
    ws.on('error', () => {});
  });

  // Push state every 5s
  setInterval(broadcastState, 5_000);

  const bindPort = async (startPort: number, maxAttempts = 10): Promise<number> => {
    for (let i = 0; i < maxAttempts; i++) {
      const port = startPort + i;
      const ok = await new Promise<boolean>((resolve) => {
        const onError = (err: NodeJS.ErrnoException) => {
          httpServer.off('listening', onListening);
          if (err.code === 'EADDRINUSE') resolve(false);
          else throw err;
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve(true);
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port);
      });
      if (ok) return port;
    }
    throw new Error(`No free dashboard port in range ${startPort}-${startPort + maxAttempts - 1}`);
  };

  const actualPort = await bindPort(DASHBOARD_PORT, 12);
  process.env.DASHBOARD_PORT = String(actualPort);
  if (actualPort !== DASHBOARD_PORT) {
    logger.warn(`Dashboard port ${DASHBOARD_PORT} busy, switched to ${actualPort}`);
  }
  logger.info(`Dashboard → http://localhost:${actualPort}`);

  return httpServer;
}
