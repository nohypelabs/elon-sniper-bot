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

const DASHBOARD_PORT = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || '3001');

export interface BotState {
  mode: 'PAPER' | 'LIVE';
  running: boolean;
  paused: boolean;
  uptime: number;
  tweetsDetected: number;
  buysExecuted: number;
  solBalance: number;
  activePositions: ActivePositionInfo[];
}

export interface ActivePositionInfo {
  tokenMint: string;
  symbol: string;
  name: string;
  entryPrice: number;
  currentPrice: number;
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
  tweetsDetected: 0, buysExecuted: 0, solBalance: 0,
  activePositions: [],
});
let sellPositionHandler:  (mint: string) => Promise<void> = async () => {};
let pauseHandler:  () => void = () => {};
let resumeHandler: () => void = () => {};

export function registerDashboardHandlers(opts: {
  getState:  () => BotState;
  onSell:    (mint: string) => Promise<void>;
  onPause:   () => void;
  onResume:  () => void;
}) {
  botStateGetter       = opts.getState;
  sellPositionHandler  = opts.onSell;
  pauseHandler         = opts.onPause;
  resumeHandler        = opts.onResume;
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
    const limit = parseInt(c.req.query('limit') || '50');
    const sells = await db.trade.findMany({
      where: { type: 'SELL' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const paired = await Promise.all(sells.map(async sell => {
      const buy = await db.trade.findFirst({
        where: { type: 'BUY', tokenMint: sell.tokenMint, createdAt: { lte: sell.createdAt } },
        orderBy: { createdAt: 'desc' },
      });
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
    }));
    return c.json(paired);
  });

  app.get('/api/pnl', async c => {
    const sells = await db.trade.findMany({
      where: { type: 'SELL', pnlSol: { not: null } },
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

  httpServer.listen(DASHBOARD_PORT, () => {
    logger.info(`Dashboard → http://localhost:${DASHBOARD_PORT}`);
  });

  return httpServer;
}
