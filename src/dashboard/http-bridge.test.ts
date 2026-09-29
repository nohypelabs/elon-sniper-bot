import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getRequestListener } from '@hono/node-server';
import { isAuthorized, unauthorizedResponseHeaders } from './auth';

// NOTE: this test builds its own tiny Hono app and never imports server.ts,
// because server.ts pulls in Prisma (database) at module load.

// Same middleware ordering as server.ts: cors first, then auth.
const USER = 'tester';
const PASS = 'hunter2:with:colon';

function buildApp() {
  const app = new Hono();
  app.use('*', cors({ origin: '*' }));
  app.use('*', async (c, next) => {
    if (isAuthorized(c.req.header('authorization'), USER, PASS)) return next();
    return c.text('Unauthorized', 401, unauthorizedResponseHeaders);
  });
  app.post('/echo', async (c) => {
    const body = await c.req.json();
    return c.json({ youSent: body });
  });
  app.get('/bin', (c) => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    return c.body(bytes, 200, { 'Content-Type': 'application/octet-stream' });
  });
  app.get('/hello', (c) => c.text('hi'));
  return app;
}

const authHeader = () =>
  `Basic ${Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64')}`;

let server: Server;
let base: string;

before(async () => {
  const app = buildApp();
  server = createServer(getRequestListener((req) => app.fetch(req)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object', 'server should be listening');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('http bridge (getRequestListener)', () => {
  it('401 + WWW-Authenticate without Authorization header', async () => {
    const res = await fetch(`${base}/hello`);
    assert.equal(res.status, 401);
    assert.equal(
      res.headers.get('www-authenticate'),
      unauthorizedResponseHeaders['WWW-Authenticate'],
    );
    await res.text();
  });

  it('401 with wrong credentials', async () => {
    const res = await fetch(`${base}/hello`, {
      headers: { authorization: 'Basic d3Jvbmc6d3Jvbmc=' }, // wrong:wrong
    });
    assert.equal(res.status, 401);
    await res.text();
  });

  it('200 with valid Authorization header', async () => {
    const res = await fetch(`${base}/hello`, {
      headers: { authorization: authHeader() },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hi');
  });

  it('POST JSON body arrives intact (regression: old bridge dropped bodies)', async () => {
    const payload = {
      s: 'hello ✓ unicode',
      n: 42,
      f: 1.5,
      b: true,
      nil: null,
      arr: [1, 'two', { three: 3 }],
      nested: { a: { b: { c: 'deep' } } },
      big: 'x'.repeat(50_000),
    };
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: {
        authorization: authHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { youSent: unknown };
    assert.deepEqual(data.youSent, payload);
  });

  it('POST without auth is rejected before the body is read', async () => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(res.status, 401);
    await res.text();
  });

  it('binary response is byte-identical (regression: res.end(text) corrupted binary)', async () => {
    const expected = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const res = await fetch(`${base}/bin`, {
      headers: { authorization: authHeader() },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    const actual = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(actual, expected);
  });

  it('OPTIONS behaviour: cors preflight short-circuits before auth (204, no auth needed)', async () => {
    // Documented behaviour with the cors-then-auth ordering (same as server.ts):
    // Hono's cors middleware answers ALL OPTIONS requests with 204 itself and
    // never calls next(), so the auth middleware is skipped for preflights.
    // This is the desired behaviour — browsers never send credentials on
    // preflights — but it means OPTIONS is intentionally unauthenticated.
    const res = await fetch(`${base}/echo`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://example.com',
        'access-control-request-method': 'POST',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    await res.text();
  });
});
