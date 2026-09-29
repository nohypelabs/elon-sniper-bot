import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderLatency } from './latency-render';
import type { EventLoopSnapshot } from '../metrics/latency';

const LOOP_OK: EventLoopSnapshot = { p50Ms: 1.2, p99Ms: 5.5, maxMs: 12.0, meanMs: 1.5 };

describe('renderLatency: empty summary', () => {
  it('renders a no-data message without NaN/undefined', () => {
    const msg = renderLatency({}, LOOP_OK);
    assert.ok(msg.includes('Belum ada data'));
    assert.ok(!msg.includes('NaN'));
    assert.ok(!msg.includes('undefined'));
  });
});

describe('renderLatency: normal summary', () => {
  it('shows per-segment p50/p90/p99, counts and the ok verdict', () => {
    const msg = renderLatency(
      {
        'BUY:event_received->filters_passed': { n: 12, p50: 3.1, p90: 8.4, p99: 9.9, max: 11.2 },
        'SELL:exit_signal->sell_sent': { n: 4, p50: 50, p90: 60, p99: 70, max: 75 },
      },
      LOOP_OK,
    );
    assert.ok(msg.includes('BUY:event_received-&gt;filters_passed') || msg.includes('BUY:event_received->filters_passed'));
    assert.ok(msg.includes('n=12'));
    assert.ok(msg.includes('p50=3.1ms'));
    assert.ok(msg.includes('SELL:exit_signal->sell_sent'));
    assert.ok(msg.includes('bukan bottleneck'));
    assert.ok(!msg.includes('NaN'));
    assert.ok(!msg.includes('undefined'));
  });
});

describe('renderLatency: high event-loop p99', () => {
  it('renders a warning verdict instead of the ok line', () => {
    const msg = renderLatency(
      { 'BUY:buy_sent->buy_confirmed': { n: 2, p50: 100, p90: 120, p99: 120, max: 120 } },
      { p50Ms: 10, p99Ms: 45.678, maxMs: 90, meanMs: 12 },
    );
    assert.ok(msg.includes('WASPADA'));
    assert.ok(!msg.includes('bukan bottleneck'));
    assert.ok(!msg.includes('NaN'));
    assert.ok(!msg.includes('undefined'));
  });
});

describe('renderLatency: robustness', () => {
  it('never prints NaN/undefined for non-finite inputs', () => {
    const msg = renderLatency(
      { 'BUY:x': { n: NaN, p50: NaN, p90: Infinity, p99: -Infinity, max: NaN } },
      { p50Ms: NaN, p99Ms: NaN, maxMs: NaN, meanMs: NaN },
    );
    assert.ok(!msg.includes('NaN'));
    assert.ok(!msg.includes('undefined'));
    assert.ok(!msg.includes('Infinity'));
  });
});
