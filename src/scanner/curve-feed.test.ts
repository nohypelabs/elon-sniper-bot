import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CurveFeed, CurveUpdate, maskFeedUrl } from './curve-feed';

const FIXTURE_B64 =
  'F7f4N2DYrGAv/dSUzksDACBJCRQIAAAAL2XCSD1NAgAgneUXAQAAAACAxqR+jQMAAGZxgmiH1SiIU649Ou5mwvTS0DjHjqu2vl1PGIkVmaq3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const CURVE = '6zmH5rF19wUui3YKLv6d488nuqhf2MyiBccRv4dGLGfZ';

/** Minimal fake WebSocket: record constructor URL + sent frames, manual events. */
class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  url: string;
  readyState = 0;
  sent: string[] = [];
  pings = 0;
  closed = false;
  private handlers = new Map<string, ((...a: any[]) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }

  on(event: string, cb: (...a: any[]) => void): void {
    const arr = this.handlers.get(event) ?? [];
    arr.push(cb);
    this.handlers.set(event, arr);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {
    this.pings++;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    for (const cb of this.handlers.get('close') ?? []) cb();
  }

  emitOpen(): void {
    this.readyState = FakeWS.OPEN;
    for (const cb of this.handlers.get('open') ?? []) cb();
  }

  emitMessage(msg: unknown): void {
    const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const cb of this.handlers.get('message') ?? []) cb(text);
  }

  emitPong(): void {
    for (const cb of this.handlers.get('pong') ?? []) cb();
  }

  static reset(): void {
    FakeWS.instances = [];
  }
}

function makeFeed(overrides: Record<string, any> = {}): CurveFeed {
  FakeWS.reset();
  return new CurveFeed({
    url: 'wss://example.invalid/?api-key=SUPERSECRET',
    WebSocketCtor: FakeWS as any,
    reconnectBaseMs: 10,
    ...overrides,
  });
}

function notify(subId: number, b64: string, slot = 42): any {
  return {
    jsonrpc: '2.0',
    method: 'accountNotification',
    params: {
      subscription: subId,
      result: {
        context: { slot },
        value: { data: [b64, 'base64'], executable: false, lamports: 1, owner: 'x', rentEpoch: 0 },
      },
    },
  };
}

function bumpedBlob(): string {
  const buf = Buffer.from(FIXTURE_B64, 'base64');
  buf.writeBigUInt64LE(buf.readBigUInt64LE(16) + 1000000000n, 16);
  return buf.toString('base64');
}

const feeds: CurveFeed[] = [];
afterEach(() => {
  for (const f of feeds.splice(0)) {
    try { f.stop(); } catch { /* ignore */ }
  }
  FakeWS.reset();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('CurveFeed subscribe/confirm/notify', () => {
  it('sends accountSubscribe, confirms, and delivers parsed updates', () => {
    const feed = makeFeed();
    feeds.push(feed);
    feed.start();
    assert.equal(FakeWS.instances.length, 1);
    FakeWS.instances[0].emitOpen();

    const updates: CurveUpdate[] = [];
    feed.subscribe(CURVE, (u) => updates.push(u));

    const sent = FakeWS.instances[0].sent.map((s) => JSON.parse(s));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'accountSubscribe');
    assert.equal(sent[0].jsonrpc, '2.0');
    assert.deepEqual(sent[0].params, [CURVE, { encoding: 'base64', commitment: 'processed' }]);

    // Confirm with subscription id 7, then notify.
    FakeWS.instances[0].emitMessage({ jsonrpc: '2.0', id: sent[0].id, result: 7 });
    FakeWS.instances[0].emitMessage(notify(7, FIXTURE_B64, 99));

    assert.equal(updates.length, 1);
    assert.equal(updates[0].curveKey, CURVE);
    assert.equal(updates[0].slot, 99);
    assert.ok(Number.isFinite(updates[0].priceInSol) && updates[0].priceInSol > 0);
    assert.ok(Number.isFinite(updates[0].marketCapSol) && updates[0].marketCapSol > 0);
    assert.ok(updates[0].virtualSolReserves > 0 && updates[0].realSolReserves > 0);
    assert.equal(updates[0].complete, false);
    assert.ok(typeof updates[0].receivedAt === 'number');

    const st = feed.stats();
    assert.equal(st.connected, true);
    assert.equal(st.subscriptions, 1);
    assert.equal(st.updates, 1);
    assert.ok(typeof st.lastUpdateAt === 'number');
  });

  it('queues subscribes made before open and sends on open', () => {
    const feed = makeFeed();
    feeds.push(feed);
    feed.start();
    feed.subscribe(CURVE, () => {});
    assert.equal(FakeWS.instances[0].sent.length, 0);
    FakeWS.instances[0].emitOpen();
    assert.equal(FakeWS.instances[0].sent.length, 1);
  });

  it('unsubscribe removes and sends accountUnsubscribe', () => {
    const feed = makeFeed();
    feeds.push(feed);
    feed.start();
    FakeWS.instances[0].emitOpen();
    feed.subscribe(CURVE, () => {});
    const id = JSON.parse(FakeWS.instances[0].sent[0]).id;
    FakeWS.instances[0].emitMessage({ jsonrpc: '2.0', id, result: 11 });
    feed.unsubscribe(CURVE);
    assert.equal(feed.size(), 0);
    const methods = FakeWS.instances[0].sent.map((s) => JSON.parse(s).method);
    assert.deepEqual(methods, ['accountSubscribe', 'accountUnsubscribe']);
    const unsub = JSON.parse(FakeWS.instances[0].sent[1]);
    assert.deepEqual(unsub.params, [11]);
  });
});

describe('CurveFeed reconnect + resubscribe', () => {
  it('reconnects with backoff and resubscribes everything', async () => {
    const feed = makeFeed({ reconnectBaseMs: 5 });
    feeds.push(feed);
    feed.start();
    FakeWS.instances[0].emitOpen();
    feed.subscribe(CURVE, () => {});
    const id = JSON.parse(FakeWS.instances[0].sent[0]).id;
    FakeWS.instances[0].emitMessage({ jsonrpc: '2.0', id, result: 3 });

    FakeWS.instances[0].close(); // triggers reconnect
    await sleep(50);
    assert.ok(FakeWS.instances.length >= 2, 'expected a reconnect attempt');
    const latest = FakeWS.instances[FakeWS.instances.length - 1];
    latest.emitOpen();
    const methods = latest.sent.map((s) => JSON.parse(s).method);
    assert.ok(methods.includes('accountSubscribe'), 'must resubscribe after reconnect');
    assert.ok(feed.stats().reconnects >= 1);
  });
});

describe('CurveFeed filtering + robustness', () => {
  function connectedFeed(): { feed: CurveFeed; ws: FakeWS } {
    const feed = makeFeed();
    feeds.push(feed);
    feed.start();
    const ws = FakeWS.instances[0];
    ws.emitOpen();
    return { feed, ws };
  }

  function confirm(feed: CurveFeed, ws: FakeWS, subId = 5): void {
    const id = JSON.parse(ws.sent[ws.sent.length - 1]).id;
    void feed;
    ws.emitMessage({ jsonrpc: '2.0', id, result: subId });
  }

  it('drops duplicate consecutive notifications, accepts changed reserves', () => {
    const { feed, ws } = connectedFeed();
    let calls = 0;
    feed.subscribe(CURVE, () => calls++);
    confirm(feed, ws);
    ws.emitMessage(notify(5, FIXTURE_B64));
    ws.emitMessage(notify(5, FIXTURE_B64)); // duplicate
    assert.equal(calls, 1);
    ws.emitMessage(notify(5, bumpedBlob())); // changed reserves
    assert.equal(calls, 2);
    assert.equal(feed.stats().updates, 2);
  });

  it('ignores garbage without throwing', () => {
    const { feed, ws } = connectedFeed();
    let calls = 0;
    feed.subscribe(CURVE, () => calls++);
    confirm(feed, ws);
    ws.emitMessage('not json{{{');
    feed.handleMessage(null);
    feed.handleMessage(42);
    feed.handleMessage({ method: 'accountNotification', params: null });
    ws.emitMessage(notify(999, FIXTURE_B64)); // unknown subscription id
    ws.emitMessage(notify(5, 'AAAA')); // unparsable data
    ws.emitMessage({ jsonrpc: '2.0', id: 12345, result: 5 }); // unknown confirm id
    assert.equal(calls, 0);
  });

  it('swallows errors thrown by callbacks', () => {
    const { feed, ws } = connectedFeed();
    let second = 0;
    feed.subscribe(CURVE, () => { throw new Error('boom'); });
    feed.subscribe(CURVE, () => second++);
    confirm(feed, ws);
    ws.emitMessage(notify(5, FIXTURE_B64));
    assert.equal(second, 1);
  });

  it('caps subscriptions at 200', () => {
    const { feed } = connectedFeed();
    for (let i = 0; i < 250; i++) feed.subscribe(`key${i}`, () => {});
    assert.equal(feed.size(), 200);
  });

  it('watchdog force-reconnects a silent open socket', async () => {
    const feed = makeFeed({ reconnectBaseMs: 5, watchdogMs: 40, watchdogCheckMs: 10 });
    feeds.push(feed);
    feed.start();
    FakeWS.instances[0].emitOpen();
    const before = feed.stats().reconnects;
    await sleep(120);
    assert.ok(FakeWS.instances.length >= 2, 'watchdog should force a reconnect');
    assert.ok(feed.stats().reconnects > before);
  });

  it('pong counts as activity for the watchdog', async () => {
    const feed = makeFeed({ reconnectBaseMs: 5, watchdogMs: 60, watchdogCheckMs: 10 });
    feeds.push(feed);
    feed.start();
    const ws = FakeWS.instances[0];
    ws.emitOpen();
    // Keep ponging so the socket never looks silent.
    for (let i = 0; i < 8; i++) {
      await sleep(20);
      FakeWS.instances[FakeWS.instances.length - 1].emitPong();
    }
    assert.equal(FakeWS.instances.length, 1, 'no reconnect while pongs arrive');
  });
});

describe('maskFeedUrl', () => {
  it('masks api-key query params', () => {
    const masked = maskFeedUrl('wss://mainnet.helius-rpc.com/?api-key=SUPERSECRET');
    assert.ok(!masked.includes('SUPERSECRET'));
    assert.ok(masked.includes('api-key=***'));
    assert.ok(masked.startsWith('wss://mainnet.helius-rpc.com/'));
  });
});
