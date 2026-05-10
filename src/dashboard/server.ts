import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import { runBacktest } from '../backtest/runner';
import { CONFIG } from '../config';
import path from 'path';
import fs from 'fs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { encryptKey, decryptKey } from '../utils/wallet.crypto';

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

  app.use('*', cors({ origin: '*' }));

  app.get('/api/status', c => c.json(botStateGetter()));

  app.get('/api/positions', async c => {
    const positions = await db.position.findMany({ orderBy: { openedAt: 'desc' } });
    return c.json(positions);
  });

  app.get('/api/trades', async c => {
    const page  = parseInt(c.req.query('page')  || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const [trades, total] = await Promise.all([
      db.trade.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      db.trade.count(),
    ]);
    return c.json({ trades, total, page, pages: Math.ceil(total / limit) });
  });

  app.get('/api/trades/paired', async c => {
    // Fetch all sells + all buys in 2 queries, join in-memory (avoids N+1)
    const [sells, buys] = await Promise.all([
      db.trade.findMany({
        where: { type: 'SELL' },
        orderBy: { createdAt: 'desc' },
      }),
      db.trade.findMany({
        where: { type: 'BUY' },
        select: { tokenMint: true, createdAt: true, mcapUsd: true },
        orderBy: { createdAt: 'asc' },
      }),
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
    const where = { 
      type: 'SELL', 
      pnlSol: { not: null }, 
      ...(since ? { createdAt: { gte: since } } : {}),
      ...(mode === 'LIVE' ? { source: { not: "paper" } } : {})
    };
    const sells = await db.trade.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, pnlSol: true, pnlPercent: true, symbol: true },
    });
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
    const sellWhere = { 
      type: 'SELL', 
      ...(since ? { createdAt: { gte: since } } : {}),
      ...(mode === 'LIVE' ? { source: { not: "paper" } } : {})
    };

    const [sells, buys] = await Promise.all([
      db.trade.findMany({
        where: sellWhere,
        select: { pnlSol: true, pnlPercent: true, solAmount: true, tokenMint: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      db.trade.findMany({
        where: { type: 'BUY' },
        select: { id: true, tokenMint: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
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

  const EDITABLE_CONFIG = [
    'BUY_AMOUNT_SOL', 'MAX_SLIPPAGE_BPS', 'STOP_LOSS_PERCENT',
    'TP1_PERCENT', 'TP1_SELL_PERCENT', 'TP2_PERCENT',
    'MOONBAG_PERCENT',
    'PRIORITY_FEE_BUY_SOL', 'PRIORITY_FEE_SELL_SOL', 'MAX_FEE_SOL',
    'PUMP_MAX_POSITIONS', 'PUMP_MAX_HOLD_MINUTES',
    'PUMP_MIN_DEV_BUY_SOL', 'PUMP_MAX_DEV_BUY_SOL',
    'PUMP_MIN_MCAP_SOL', 'PUMP_MAX_MCAP_SOL',
    'AUTO_SELL', 'ANTI_MEV', 'MOONBAG_ENABLED',
  ] as const;

  app.get('/api/config', c => {
    const out: Record<string, unknown> = {};
    for (const k of EDITABLE_CONFIG) out[k] = (CONFIG as any)[k];
    out['PAPER_TRADING'] = CONFIG.PAPER_TRADING;
    return c.json(out);
  });

  app.post('/api/config', async c => {
    const body = await c.req.json().catch(() => ({}));
    const updated: Record<string, string> = {};

    for (const key of [...EDITABLE_CONFIG, 'PAPER_TRADING'] as string[]) {
      if (!(key in body)) continue;
      const val = body[key];
      // Update in-memory CONFIG
      if (typeof val === 'boolean') {
        (CONFIG as any)[key] = val;
        updated[key] = String(val);
      } else if (typeof val === 'number') {
        (CONFIG as any)[key] = val;
        updated[key] = String(val);
      }
    }

    // Patch .env file for persistence
    try {
      const envPath = path.join(process.cwd(), '.env');
      let content = fs.readFileSync(envPath, 'utf8');
      for (const [key, val] of Object.entries(updated)) {
        const re = new RegExp(`^(${key}\\s*=)[^\\n]*`, 'm');
        if (re.test(content)) {
          content = content.replace(re, `$1${val}`);
        } else {
          content += `\n${key}=${val}`;
        }
      }
      fs.writeFileSync(envPath, content);
    } catch (e) {
      logger.warn('Could not write .env: ' + e);
    }

    logger.info(`⚙ Config updated: ${Object.keys(updated).join(', ')}`);
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
    const events = await db.botEvent.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
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

  // Create raw http server for WebSocket co-hosting
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const honoRes = await (app.fetch(new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
      })) as Promise<Response>);
      res.writeHead(honoRes.status, Object.fromEntries(honoRes.headers.entries()));
      res.end(await honoRes.text());
    } catch {
      res.writeHead(500);
      res.end();
    }
  });

  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
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
