import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';

// No static imports from src/ — everything under src/ is loaded dynamically
// in `before` after the temp cwd + env are in place (CONFIG reads env at import).

const USER = 'admin';
const PASS = 'e2e-pass:with:colons';

const MINT_A = 'E2EMintA1111111111111111111111111111111111111';
const MINT_B = 'E2EMintB2222222222222222222222222222222222222';

const GET_ENDPOINTS = [
  '/api/status',
  '/api/positions',
  '/api/trades',
  '/api/trades/paired',
  '/api/pnl',
  '/api/stats',
  '/api/events',
  '/api/config',
  '/api/wallet',
];

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}
const GOOD_AUTH = basicAuth(USER, PASS);
const WRONG_AUTH = basicAuth(USER, 'wrong-password');

let origCwd = '';
let tempDir = '';
let port = 0;
let base = '';
let httpServer: Server | null = null;
let broadcastStateFn: () => void = () => {};
const wsClients: WebSocket[] = [];

// handler call recording
let pauseCalls = 0;
let resumeCalls = 0;
const sellCalls: string[] = [];

// original env to restore
const savedEnv: Record<string, string | undefined> = {};

function readTempEnv(): string {
  return fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
}

function authedFetch(p: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${p}`, {
    ...init,
    headers: { authorization: GOOD_AUTH, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(5000),
  });
}

function wsOnce(opts: { auth: boolean; origin?: string }): Promise<{ ws: WebSocket; status: string; first?: string }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (opts.auth) headers['Authorization'] = GOOD_AUTH;
    if (opts.origin !== undefined) headers['Origin'] = opts.origin;
    const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers });
    wsClients.push(ws);
    const timer = setTimeout(() => {
      resolve({ ws, status: 'timeout' });
    }, 5000);
    timer.unref?.();
    ws.on('message', (data) => {
      clearTimeout(timer);
      resolve({ ws, status: 'open-message', first: String(data) });
    });
    ws.on('error', () => {
      clearTimeout(timer);
      resolve({ ws, status: 'rejected' });
    });
  });
}

before(async () => {
  origCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  process.chdir(tempDir);
  fs.writeFileSync(
    path.join(tempDir, '.env'),
    'BUY_AMOUNT_SOL=0.5\nTP1_PERCENT=30\nTP2_PERCENT=50\nE2E_KEEP=hello\n',
  );

  for (const k of ['DB_PATH', 'DASHBOARD_PASSWORD', 'DASHBOARD_USER', 'PORT', 'DASHBOARD_PORT', 'PAPER_TRADING', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'DASHBOARD_ALLOWED_ORIGINS']) {
    savedEnv[k] = process.env[k];
  }
  const randomPort = Math.floor(41000 + Math.random() * 8000);
  process.env['DB_PATH'] = path.join(tempDir, 'e2e.pglite');
  process.env['DASHBOARD_PASSWORD'] = PASS;
  process.env['DASHBOARD_USER'] = USER;
  process.env['PORT'] = String(randomPort);
  process.env['DASHBOARD_PORT'] = String(randomPort);
  process.env['PAPER_TRADING'] = 'true';
  process.env['TELEGRAM_BOT_TOKEN'] = '';
  process.env['TELEGRAM_CHAT_ID'] = '';
  delete process.env['DASHBOARD_ALLOWED_ORIGINS'];

  // The broadcast interval is owned by the server module and stopped via
  // stopDashboardServer() in `after` — no test-side capture needed.

  const dbClient = await import('../db/client');
  const repo = await import('../db/repo');
  const serverMod = await import('./server');

  await dbClient.initDb();

  const now = Date.now();
  await repo.insertTrade({
    type: 'BUY',
    tokenMint: MINT_A,
    symbol: 'E2EA',
    name: 'E2E Token A',
    solAmount: 0.5,
    tokenAmount: 1000,
    priceUsd: 0.001,
    mcapUsd: 10000,
    txSignature: 'buy-sig-a',
    source: 'paper',
    reason: null,
    dex: 'pump.fun',
    createdAt: new Date(now - 3 * 60 * 1000),
  });
  await repo.insertTrade({
    type: 'SELL',
    tokenMint: MINT_A,
    symbol: 'E2EA',
    name: 'E2E Token A',
    solAmount: 0.5,
    tokenAmount: 1000,
    priceUsd: 0.0013,
    mcapUsd: 13000,
    pnlSol: 0.15,
    pnlPercent: 30,
    txSignature: 'sell-sig-a',
    source: 'paper',
    reason: 'TP1 +30%',
    dex: 'pump.fun',
    createdAt: new Date(now - 2 * 60 * 1000),
  });
  await repo.insertTrade({
    type: 'SELL',
    tokenMint: MINT_B,
    symbol: 'E2EB',
    name: 'E2E Token B',
    solAmount: 0.4,
    tokenAmount: 800,
    priceUsd: 0.0008,
    mcapUsd: 8000,
    pnlSol: -0.1,
    pnlPercent: -20,
    txSignature: 'sell-sig-b',
    source: 'gmgn',
    reason: 'SL -25%',
    dex: 'pump.fun',
    createdAt: new Date(now - 1 * 60 * 1000),
  });
  await repo.upsertPosition(
    {
      tokenMint: MINT_A,
      symbol: 'E2EA',
      name: 'E2E Token A',
      entryPrice: 0.001,
      solSpent: 0.5,
      tokenAmount: 1000,
      txSignature: 'buy-sig-a',
      dex: 'pump.fun',
    },
    { symbol: 'E2EA' },
  );
  await repo.insertEvent('test', 'e2e seed', { seed: true });

  serverMod.registerDashboardHandlers({
    getState: () => ({
      mode: 'PAPER',
      running: true,
      paused: false,
      uptime: 123,
      tweetsDetected: 1,
      buysExecuted: 1,
      solBalance: 10,
      solPriceUsd: 150,
      activePositions: [],
    }),
    onSell: async (mint: string) => {
      sellCalls.push(mint);
    },
    onPause: () => {
      pauseCalls += 1;
    },
    onResume: () => {
      resumeCalls += 1;
    },
    onWalletReload: () => {},
    getWalletAddress: () => null,
  });

  broadcastStateFn = serverMod.broadcastState;
  const srv = await serverMod.startDashboardServer();
  httpServer = srv as unknown as Server;
  const addr = httpServer.address();
  assert.ok(addr && typeof addr === 'object', 'server should be listening');
  port = (addr as { port: number }).port;
  base = `http://localhost:${port}`;
});

after(async () => {
  for (const ws of wsClients) {
    try {
      ws.terminate();
    } catch {
      // best-effort
    }
  }
  try {
    const serverMod = await import('./server');
    await serverMod.stopDashboardServer();
  } catch {
    // best-effort
  }
  if (httpServer) {
    await new Promise<void>((resolve) => {
      try {
        httpServer!.close(() => resolve());
      } catch {
        resolve();
      }
    });
    httpServer = null;
  }
  try {
    const dbClient = await import('../db/client');
    await dbClient.closeDb();
  } catch {
    // best-effort
  }
  try {
    process.chdir(origCwd);
  } catch {
    // best-effort
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe('auth on real server', () => {
  it('every GET endpoint returns 401 without credentials', async () => {
    for (const p of GET_ENDPOINTS) {
      const res = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(res.status, 401, p);
      await res.text();
    }
  });

  it('every GET endpoint returns 401 with a wrong password', async () => {
    for (const p of GET_ENDPOINTS) {
      const res = await fetch(`${base}${p}`, {
        headers: { authorization: WRONG_AUTH },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(res.status, 401, p);
      await res.text();
    }
  });

  it('every GET endpoint returns 200 with correct credentials', async () => {
    for (const p of GET_ENDPOINTS) {
      const res = await authedFetch(p);
      assert.equal(res.status, 200, p);
      await res.text();
    }
  });
});

describe('response shapes with seeded data', () => {
  it('/api/trades pagination defaults', async () => {
    const res = await authedFetch('/api/trades');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { trades: unknown[]; total: number; page: number; pages: number };
    assert.equal(body.total, 3);
    assert.equal(body.trades.length, 3);
    assert.equal(body.page, 1);
    assert.equal(body.pages, 1);
  });

  it('/api/trades page/limit, newest-first ordering, ISO dates, numeric fields', async () => {
    const resAll = await authedFetch('/api/trades');
    const all = (await resAll.json()) as {
      trades: Array<{ tokenMint: string; createdAt: string; solAmount: number; txSignature: string }>;
      total: number;
    };
    assert.equal(all.trades.length, 3);
    // newest first: MINT_B sell, then MINT_A sell, then MINT_A buy
    assert.equal(all.trades[0]?.tokenMint, MINT_B);
    assert.equal(all.trades[1]?.tokenMint, MINT_A);
    assert.equal(all.trades[2]?.tokenMint, MINT_A);
    const t0 = Date.parse(all.trades[0]?.createdAt ?? '');
    const t1 = Date.parse(all.trades[1]?.createdAt ?? '');
    const t2 = Date.parse(all.trades[2]?.createdAt ?? '');
    assert.ok(Number.isFinite(t0) && Number.isFinite(t1) && Number.isFinite(t2));
    assert.ok(t0 >= t1 && t1 >= t2);
    for (const t of all.trades) {
      assert.equal(typeof t.createdAt, 'string');
      assert.equal(typeof t.solAmount, 'number');
    }

    const resPage = await authedFetch('/api/trades?limit=1&page=2');
    assert.equal(resPage.status, 200);
    const page = (await resPage.json()) as { trades: Array<{ txSignature: string }>; total: number; page: number; pages: number };
    assert.equal(page.total, 3);
    assert.equal(page.page, 2);
    assert.equal(page.pages, 3);
    assert.equal(page.trades.length, 1);
    assert.equal(page.trades[0]?.txSignature, all.trades[1]?.txSignature);
  });

  it('/api/positions returns the seeded position', async () => {
    const res = await authedFetch('/api/positions');
    assert.equal(res.status, 200);
    const positions = (await res.json()) as Array<{ tokenMint: string; symbol: string; solSpent: number }>;
    assert.ok(Array.isArray(positions));
    const found = positions.find((p) => p.tokenMint === MINT_A);
    assert.ok(found, 'seeded position present');
    assert.equal(found.symbol, 'E2EA');
    assert.equal(typeof found.solSpent, 'number');
  });

  it('/api/events respects limit', async () => {
    const resOne = await authedFetch('/api/events?limit=1');
    assert.equal(resOne.status, 200);
    const one = (await resOne.json()) as Array<{ type: string; message: string }>;
    assert.equal(one.length, 1);
    const resAll = await authedFetch('/api/events');
    assert.equal(resAll.status, 200);
    const events = (await resAll.json()) as Array<{ type: string; message: string; createdAt: string }>;
    assert.ok(events.length >= 1);
    assert.equal(typeof events[0]?.type, 'string');
    assert.equal(typeof events[0]?.message, 'string');
    assert.ok(events.some((e) => e.message === 'e2e seed'));
  });

  it('/api/pnl default includes paper, mode=LIVE excludes it, period works', async () => {
    const resPaper = await authedFetch('/api/pnl');
    assert.equal(resPaper.status, 200);
    const paper = (await resPaper.json()) as Array<{ pnlSol: number; symbol: string; cumulative: number; date: string }>;
    assert.equal(paper.length, 2);
    assert.ok(Math.abs((paper[paper.length - 1]?.cumulative ?? 0) - 0.05) < 1e-9);

    const resLive = await authedFetch('/api/pnl?mode=LIVE');
    assert.equal(resLive.status, 200);
    const live = (await resLive.json()) as Array<{ pnlSol: number; symbol: string }>;
    assert.equal(live.length, 1);
    assert.equal(live[0]?.symbol, 'E2EB');

    const resDay = await authedFetch('/api/pnl?period=1d');
    assert.equal(resDay.status, 200);
    const day = (await resDay.json()) as unknown[];
    assert.equal(day.length, 2);

    const resDayLive = await authedFetch('/api/pnl?period=1d&mode=LIVE');
    assert.equal(resDayLive.status, 200);
    const dayLive = (await resDayLive.json()) as unknown[];
    assert.equal(dayLive.length, 1);
  });

  it('/api/stats default vs LIVE', async () => {
    const resPaper = await authedFetch('/api/stats');
    assert.equal(resPaper.status, 200);
    const paper = (await resPaper.json()) as { totalPnlSol: number; wins: number; losses: number; total: number };
    assert.equal(paper.total, 2);
    assert.equal(paper.wins, 1);
    assert.equal(paper.losses, 1);
    assert.ok(Math.abs(paper.totalPnlSol - 0.05) < 1e-9);

    const resLive = await authedFetch('/api/stats?mode=LIVE');
    assert.equal(resLive.status, 200);
    const live = (await resLive.json()) as { totalPnlSol: number; wins: number; losses: number; total: number };
    assert.equal(live.total, 1);
    assert.equal(live.wins, 0);
    assert.equal(live.losses, 1);
    assert.ok(Math.abs(live.totalPnlSol - -0.1) < 1e-9);

    const resDay = await authedFetch('/api/stats?period=1d');
    assert.equal(resDay.status, 200);
    const day = (await resDay.json()) as { total: number };
    assert.equal(day.total, 2);
  });

  it('/api/trades/paired pairs the SELL with its BUY', async () => {
    const res = await authedFetch('/api/trades/paired');
    assert.equal(res.status, 200);
    const paired = (await res.json()) as Array<{
      symbol: string;
      pnlSol: number;
      buyMcapUsd: number | null;
      sellMcapUsd: number;
      buyTime: string | null;
      sellTime: string;
    }>;
    assert.equal(paired.length, 2);
    const withBuy = paired.find((p) => p.symbol === 'E2EA');
    assert.ok(withBuy);
    assert.equal(withBuy.buyMcapUsd, 10000);
    assert.equal(withBuy.sellMcapUsd, 13000);
    assert.ok(typeof withBuy.buyTime === 'string' && Number.isFinite(Date.parse(withBuy.buyTime)));
    assert.ok(Number.isFinite(Date.parse(withBuy.sellTime)));
    const orphan = paired.find((p) => p.symbol === 'E2EB');
    assert.ok(orphan);
    assert.equal(orphan.buyMcapUsd, null);
    assert.equal(orphan.buyTime, null);
  });
});

describe('POST /api/config body regression', () => {
  before(async () => {
    // Reset to known baseline (same values as the temp .env).
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { authorization: GOOD_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ BUY_AMOUNT_SOL: 0.5, TP1_PERCENT: 30, TP2_PERCENT: 50 }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    await res.text();
  });

  it('valid update persists to GET and rewrites only its .env line', async () => {
    const beforeEnv = readTempEnv();
    assert.ok(beforeEnv.includes('E2E_KEEP=hello'));
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { authorization: GOOD_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ BUY_AMOUNT_SOL: 0.25 }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);

    const getRes = await authedFetch('/api/config');
    const cfg = (await getRes.json()) as { BUY_AMOUNT_SOL: number };
    assert.equal(cfg.BUY_AMOUNT_SOL, 0.25);

    const afterEnv = readTempEnv();
    assert.ok(afterEnv.includes('BUY_AMOUNT_SOL=0.25'));
    assert.ok(afterEnv.includes('TP1_PERCENT=30'));
    assert.ok(afterEnv.includes('TP2_PERCENT=50'));
    assert.ok(afterEnv.includes('E2E_KEEP=hello'));
  });

  it('out-of-range value returns 400 and changes nothing', async () => {
    const envBefore = readTempEnv();
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { authorization: GOOD_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ BUY_AMOUNT_SOL: 99 }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.equal(typeof body.error, 'string');

    const getRes = await authedFetch('/api/config');
    const cfg = (await getRes.json()) as { BUY_AMOUNT_SOL: number };
    assert.equal(cfg.BUY_AMOUNT_SOL, 0.25);
    assert.equal(readTempEnv(), envBefore);
  });

  it('TP1 >= TP2 returns 400', async () => {
    const envBefore = readTempEnv();
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { authorization: GOOD_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ TP1_PERCENT: 80 }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, false);
    const getRes = await authedFetch('/api/config');
    const cfg = (await getRes.json()) as { TP1_PERCENT: number };
    assert.equal(cfg.TP1_PERCENT, 30);
    assert.equal(readTempEnv(), envBefore);
  });

  it('unknown key does not crash and does not modify .env', async () => {
    const envBefore = readTempEnv();
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { authorization: GOOD_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ NOT_A_KEY: 1 }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(readTempEnv(), envBefore);
    const getRes = await authedFetch('/api/config');
    assert.equal(getRes.status, 200);
    await getRes.text();
  });

  it('malformed JSON answers 400 and does not crash the server', async () => {
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { authorization: GOOD_AUTH, 'content-type': 'application/json' },
      body: '{not-json',
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, 'invalid JSON body');
    // A JSON body that is not an object is rejected the same way.
    const resArr = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { authorization: GOOD_AUTH, 'content-type': 'application/json' },
      body: '[1,2]',
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(resArr.status, 400);
    const bodyArr = (await resArr.json()) as { ok: boolean; error: string };
    assert.equal(bodyArr.ok, false);
    assert.equal(bodyArr.error, 'invalid JSON body');
    const getRes = await authedFetch('/api/config');
    assert.equal(getRes.status, 200);
    await getRes.text();
  });
});

describe('bot actions', () => {
  it('POST /api/bot/pause calls onPause exactly once', async () => {
    pauseCalls = 0;
    const res = await fetch(`${base}/api/bot/pause`, {
      method: 'POST',
      headers: { authorization: GOOD_AUTH },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; paused: boolean };
    assert.equal(body.ok, true);
    assert.equal(pauseCalls, 1);
  });

  it('POST /api/bot/resume calls onResume exactly once', async () => {
    resumeCalls = 0;
    const res = await fetch(`${base}/api/bot/resume`, {
      method: 'POST',
      headers: { authorization: GOOD_AUTH },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; paused: boolean };
    assert.equal(body.ok, true);
    assert.equal(resumeCalls, 1);
  });

  it('POST /api/sell/:mint calls onSell with that mint', async () => {
    sellCalls.length = 0;
    const res = await fetch(`${base}/api/sell/${MINT_A}`, {
      method: 'POST',
      headers: { authorization: GOOD_AUTH },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
    assert.deepEqual(sellCalls, [MINT_A]);
  });
});

describe('origin guard on the real server', () => {
  it('POST with foreign Origin => 403 and nothing changed', async () => {
    const envBefore = readTempEnv();
    const cfgBefore = (await (await authedFetch('/api/config')).json()) as Record<string, unknown>;
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: {
        authorization: GOOD_AUTH,
        origin: 'http://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ BUY_AMOUNT_SOL: 0.25 }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 403);
    await res.text();
    assert.equal(readTempEnv(), envBefore);
    const cfgAfter = (await (await authedFetch('/api/config')).json()) as Record<string, unknown>;
    assert.deepEqual(cfgAfter, cfgBefore);
  });

  it('POST with same-origin Origin => 200', async () => {
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: {
        authorization: GOOD_AUTH,
        origin: `http://localhost:${port}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ BUY_AMOUNT_SOL: 0.25 }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    await res.text();
  });

  it('POST with no Origin => 200', async () => {
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { authorization: GOOD_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ BUY_AMOUNT_SOL: 0.25 }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    await res.text();
  });

  it('GET with foreign Origin gets no ACAO echo', async () => {
    const res = await fetch(`${base}/api/status`, {
      headers: { authorization: GOOD_AUTH, origin: 'http://evil.example' },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    assert.notEqual(res.headers.get('access-control-allow-origin'), 'http://evil.example');
    await res.text();
  });
});

describe('websocket', () => {
  it('connects with auth + same-origin and receives a state message', async () => {
    const { ws, status, first } = await wsOnce({ auth: true, origin: `http://localhost:${port}` });
    try {
      assert.equal(status, 'open-message');
      const msg = JSON.parse(first ?? '') as { type: string; data: { mode: string } };
      assert.equal(msg.type, 'state');
      assert.equal(msg.data.mode, 'PAPER');
    } finally {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  });

  it('rejects handshake without credentials', async () => {
    const { ws, status } = await wsOnce({ auth: false, origin: `http://localhost:${port}` });
    try {
      assert.equal(status, 'rejected');
    } finally {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  });

  it('rejects handshake with foreign Origin even with credentials', async () => {
    const { ws, status } = await wsOnce({ auth: true, origin: 'http://evil.example' });
    try {
      assert.equal(status, 'rejected');
    } finally {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  });

  it('broadcastState() pushes a message to a connected client', async () => {
    const headers: Record<string, string> = {
      Authorization: GOOD_AUTH,
      Origin: `http://localhost:${port}`,
    };
    const ws: WebSocket = new WebSocket(`ws://localhost:${port}/ws`, { headers });
    wsClients.push(ws);
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for first ws message')), 5000);
      timer.unref?.();
      ws.on('message', (d) => {
        received.push(String(d));
        if (received.length === 1) {
          broadcastStateFn();
        } else if (received.length >= 2) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    try {
      assert.ok(received.length >= 2);
      for (const raw of received) {
        const msg = JSON.parse(raw) as { type: string };
        assert.equal(msg.type, 'state');
      }
    } finally {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  });
});

describe('robustness', () => {
  it('20 concurrent GET /api/trades all succeed', async () => {
    const reqs = Array.from({ length: 20 }, () => authedFetch('/api/trades'));
    const responses = await Promise.all(reqs);
    for (const r of responses) {
      assert.equal(r.status, 200);
      await r.text();
    }
  });

  it('HEAD/OPTIONS do not crash the server', async () => {
    const head = await fetch(`${base}/api/status`, {
      method: 'HEAD',
      headers: { authorization: GOOD_AUTH },
      signal: AbortSignal.timeout(5000),
    });
    assert.ok(head.status < 500);
    await head.text().catch(() => {});
    const options = await fetch(`${base}/api/status`, {
      method: 'OPTIONS',
      headers: { origin: `http://localhost:${port}`, 'access-control-request-method': 'GET' },
      signal: AbortSignal.timeout(5000),
    });
    assert.ok(options.status < 500);
    await options.text().catch(() => {});
    const ping = await authedFetch('/api/status');
    assert.equal(ping.status, 200);
    await ping.text();
  });

  it('unknown /api route returns non-500', async () => {
    const res = await authedFetch('/api/nope');
    assert.ok(res.status !== 500, `got ${res.status}`);
    await res.text().catch(() => {});
    const ping = await authedFetch('/api/status');
    assert.equal(ping.status, 200);
    await ping.text();
  });
});
