import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EventLoopMonitor,
  RollingStats,
  TraceRecorder,
  slippagePercent,
} from './latency';

/** Controllable clock for deterministic tests. */
function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    wall: () => 1_700_000_000_000,
    advance: (ms: number) => { t += ms; },
    set: (v: number) => { t = v; },
  };
}

describe('TraceRecorder: mark order, stages and segments', () => {
  it('computes offsets from start and consecutive deltas in mark order', () => {
    const clock = fakeClock(0);
    const rec = new TraceRecorder({ now: clock.now, wall: clock.wall });
    rec.start('a', 'BUY', { symbol: 'T', mint: 'M' });
    clock.advance(10);
    rec.mark('a', 'event_received');
    clock.advance(20);
    rec.mark('a', 'filters_passed');
    clock.advance(5);
    const trace = rec.finish('a');
    assert.ok(trace);
    assert.equal(trace.id, 'a');
    assert.equal(trace.kind, 'BUY');
    assert.equal(trace.symbol, 'T');
    assert.equal(trace.mint, 'M');
    assert.deepEqual(trace.stages, { event_received: 10, filters_passed: 30 });
    assert.deepEqual(trace.segments, { 'event_received->filters_passed': 20 });
    assert.equal(trace.totalMs, 35);
  });

  it('supports an explicit start timestamp (arrival time before handling)', () => {
    const clock = fakeClock(1_000);
    const rec = new TraceRecorder({ now: clock.now, wall: clock.wall });
    rec.start('a', 'BUY', undefined, 900); // arrived 100ms before start() ran
    clock.advance(50); // now = 1050
    rec.mark('a', 'buy_sent');
    const trace = rec.finish('a');
    assert.ok(trace);
    assert.equal(trace.stages['buy_sent'], 150);
  });

  it('first mark wins unless overwrite is set', () => {
    const clock = fakeClock(0);
    const rec = new TraceRecorder({ now: clock.now, wall: clock.wall });
    rec.start('a', 'BUY');
    clock.advance(10);
    rec.mark('a', 's');
    clock.advance(10);
    rec.mark('a', 's'); // ignored
    let trace = rec.finish('a');
    assert.equal(trace?.stages['s'], 10);

    clock.set(1000);
    rec.start('b', 'SELL');
    clock.set(1100);
    rec.mark('b', 's');
    clock.set(1150);
    rec.mark('b', 's', undefined, true); // overwrite
    trace = rec.finish('b');
    assert.equal(trace?.stages['s'], 150);
  });

  it('ignores marks/notes for unknown ids', () => {
    const clock = fakeClock(0);
    const rec = new TraceRecorder({ now: clock.now, wall: clock.wall });
    rec.mark('nope', 's');
    rec.note('nope', 'k', 1);
    assert.equal(rec.finish('nope'), null);
    assert.equal(rec.openCount(), 0);
  });

  it('finish twice returns null the second time', () => {
    const rec = new TraceRecorder({ now: fakeClock(0).now });
    rec.start('a', 'BUY');
    assert.ok(rec.finish('a'));
    assert.equal(rec.finish('a'), null);
  });

  it('stores notes on the finished trace', () => {
    const rec = new TraceRecorder({ now: fakeClock(0).now });
    rec.start('a', 'BUY');
    rec.note('a', 'outcome', 'bought');
    rec.note('a', 'entrySlipPct', 1.5);
    const trace = rec.finish('a');
    assert.deepEqual(trace?.notes, { outcome: 'bought', entrySlipPct: 1.5 });
  });
});

describe('TraceRecorder: eviction', () => {
  it('evicts open traces older than 10 minutes on start', () => {
    const clock = fakeClock(0);
    const rec = new TraceRecorder({ now: clock.now, wall: clock.wall });
    rec.start('old', 'BUY');
    clock.advance(10 * 60_000 + 1);
    rec.start('new', 'BUY');
    assert.equal(rec.isOpen('old'), false);
    assert.equal(rec.isOpen('new'), true);
    assert.equal(rec.openCount(), 1);
  });

  it('caps open traces at 500 (oldest dropped)', () => {
    const clock = fakeClock(0);
    const rec = new TraceRecorder({ now: clock.now, wall: clock.wall });
    for (let i = 0; i < 505; i++) rec.start(`t${i}`, 'BUY');
    assert.equal(rec.openCount(), 500);
    assert.equal(rec.isOpen('t0'), false);
    assert.equal(rec.isOpen('t504'), true);
  });
});

describe('RollingStats', () => {
  it('percentile math: n=1', () => {
    const s = new RollingStats();
    s.add('k', 42);
    assert.deepEqual(s.summary()['k'], { n: 1, p50: 42, p90: 42, p99: 42, max: 42 });
  });

  it('percentile math: n=2 (nearest-rank)', () => {
    const s = new RollingStats();
    s.add('k', 10);
    s.add('k', 20);
    // p50: ceil(0.5*2)=1 → 10; p90/p99: rank 2 → 20
    assert.deepEqual(s.summary()['k'], { n: 2, p50: 10, p90: 20, p99: 20, max: 20 });
  });

  it('percentile math: n=100', () => {
    const s = new RollingStats(200);
    for (let i = 1; i <= 100; i++) s.add('k', i);
    const sum = s.summary()['k'];
    assert.equal(sum.n, 100);
    assert.equal(sum.p50, 50);
    assert.equal(sum.p90, 90);
    assert.equal(sum.p99, 99);
    assert.equal(sum.max, 100);
  });

  it('handles ties', () => {
    const s = new RollingStats();
    for (let i = 0; i < 10; i++) s.add('k', 7);
    assert.deepEqual(s.summary()['k'], { n: 10, p50: 7, p90: 7, p99: 7, max: 7 });
  });

  it('ignores NaN, negative and Infinity', () => {
    const s = new RollingStats();
    s.add('k', 5);
    s.add('k', NaN);
    s.add('k', -1);
    s.add('k', Infinity);
    s.add('k', -Infinity);
    assert.deepEqual(s.summary()['k'], { n: 1, p50: 5, p90: 5, p99: 5, max: 5 });
  });

  it('accepts zero and keeps keys separate', () => {
    const s = new RollingStats();
    s.add('a', 0);
    s.add('b', 3);
    assert.equal(s.summary()['a'].p50, 0);
    assert.equal(s.summary()['b'].p50, 3);
  });

  it('ring buffer wraps at capacity (keeps newest)', () => {
    const s = new RollingStats(4);
    for (let i = 1; i <= 6; i++) s.add('k', i); // retains 3,4,5,6
    assert.equal(s.size('k'), 4);
    const sum = s.summary()['k'];
    assert.equal(sum.n, 4);
    assert.deepEqual(
      [sum.p50, sum.p90, sum.p99, sum.max].sort((a, b) => a - b),
      [4, 6, 6, 6],
    );
  });
});

describe('slippagePercent', () => {
  it('computes (actual - reference) / reference * 100', () => {
    assert.equal(slippagePercent(100, 110), 10);
    assert.equal(slippagePercent(100, 90), -10);
    assert.equal(slippagePercent(200, 200), 0);
  });

  it('returns null for reference <= 0 or non-finite inputs', () => {
    assert.equal(slippagePercent(0, 100), null);
    assert.equal(slippagePercent(-5, 100), null);
    assert.equal(slippagePercent(NaN, 100), null);
    assert.equal(slippagePercent(100, NaN), null);
    assert.equal(slippagePercent(Infinity, 100), null);
    assert.equal(slippagePercent(100, Infinity), null);
  });
});

describe('EventLoopMonitor', () => {
  it('start/stop/snapshot do not throw and stop() is idempotent', () => {
    const m = new EventLoopMonitor();
    assert.doesNotThrow(() => m.start());
    assert.doesNotThrow(() => m.start()); // second start is a no-op
    const snap = m.snapshot();
    for (const v of [snap.p50Ms, snap.p99Ms, snap.maxMs, snap.meanMs]) {
      assert.equal(typeof v, 'number');
      assert.ok(Number.isFinite(v));
      assert.ok(v >= 0);
    }
    assert.doesNotThrow(() => m.stop());
    assert.doesNotThrow(() => m.stop()); // idempotent
    assert.doesNotThrow(() => m.snapshot()); // snapshot after stop is safe
  });
});
