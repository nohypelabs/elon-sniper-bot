import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getRequestListener } from '@hono/node-server';
import { WebSocketServer, WebSocket } from 'ws';
import { isAuthorized } from './auth';
import { isOriginAllowed } from './origin-guard';

// NOTE: tiny app mirroring server.ts middleware order (cors -> origin-guard
// -> auth). server.ts itself is never imported (it pulls in the database layer).

const USER = 'tester';
const PASS = 's3cret';
const ALLOWED: string[] = []; // dev would add e.g. http://localhost:5173 via env

const basic = () => `Basic ${Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64')}`;

function buildApp() {
  const app = new Hono();
  app.use(
    '*',
    cors({
      origin: (o, c) => (isOriginAllowed(o, c.req.header('host'), ALLOWED) ? o : ''),
    }),
  );
  app.use('*', async (c, next) => {
    const m = c.req.method;
    if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
      if (!isOriginAllowed(c.req.header('origin'), c.req.header('host'), ALLOWED)) {
        return c.text('Forbidden origin', 403);
      }
    }
    return next();
  });
  app.use('*', async (c, next) => {
    if (isAuthorized(c.req.header('authorization'), USER, PASS)) return next();
    return c.text('Unauthorized', 401);
  });
  app.post('/api/config', async (c) => c.json({ ok: true }));
  return app;
}

let server: Server;
let wss: WebSocketServer;
let base: string;
let port = 0;

before(async () => {
  const app = buildApp();
  server = createServer(getRequestListener((req) => app.fetch(req)));
  wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ req }: { req: import('node:http').IncomingMessage }) =>
      isAuthorized(req.headers.authorization, USER, PASS) &&
      isOriginAllowed(req.headers.origin, req.headers.host, ALLOWED),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object', 'server should be listening');
  port = addr.port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function connectWs(origin: string | undefined, auth: boolean): Promise<string> {
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('rejected (timeout)'), 5000);
    const headers: Record<string, string> = {};
    if (origin !== undefined) headers.Origin = origin;
    if (auth) headers.Authorization = basic();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve('open');
    });
    ws.on('error', () => {
      clearTimeout(timer);
      resolve('rejected');
    });
  });
}

describe('origin guard integration', () => {
  it('cross-origin POST with valid creds => 403 (CSRF blocked despite cached auth)', async () => {
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: {
        origin: 'http://evil.com',
        authorization: basic(),
        'content-type': 'text/plain', // "simple" request: no preflight in browsers
      },
      body: 'a=1',
    });
    assert.equal(res.status, 403);
    assert.equal(await res.text(), 'Forbidden origin');
  });

  it('same-origin POST => 200', async () => {
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: {
        origin: base,
        authorization: basic(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
  });

  it('no-Origin POST (curl / server-to-server) => 200', async () => {
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: {
        authorization: basic(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
  });

  it('same-origin POST without creds => 401 (auth still enforced)', async () => {
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
    await res.text();
  });

  it('cross-origin preflight grants nothing (no ACAO echo for evil origin)', async () => {
    const res = await fetch(`${base}/api/config`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://evil.com',
        'access-control-request-method': 'POST',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    await res.text();
  });

  it('WS handshake with foreign Origin + valid creds => rejected (hijack blocked)', async () => {
    assert.equal(await connectWs('http://evil.com', true), 'rejected');
  });

  it('WS handshake with same Origin + valid creds => accepted', async () => {
    assert.equal(await connectWs(base, true), 'open');
  });

  it('WS handshake with same Origin but no creds => rejected (auth intact)', async () => {
    assert.equal(await connectWs(base, false), 'rejected');
  });
});
