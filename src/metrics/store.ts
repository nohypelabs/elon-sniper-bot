/**
 * Shared latency-instrumentation singletons.
 *
 * Module-level TraceRecorder + RollingStats + EventLoopMonitor so the
 * trading path (src/index.ts), the dashboard (/api/latency) and Telegram
 * (/latency) all observe the same data.
 *
 * Persistence is ALWAYS fire-and-forget: persistTrace() never awaits and
 * never throws, so it can never block or break a buy/sell.
 */

import { insertLatencyTrace } from '../db/repo';
import {
  EventLoopMonitor,
  RollingStats,
  TraceRecorder,
  type Trace,
} from './latency';

export const traceRecorder = new TraceRecorder();
export const latencyStats = new RollingStats(500);
export const eventLoopMonitor = new EventLoopMonitor();

/** Feed every segment delta of a finished trace into the rolling stats. */
export function recordTraceSegments(trace: Trace): void {
  try {
    for (const [segment, ms] of Object.entries(trace.segments)) {
      latencyStats.add(`${trace.kind}:${segment}`, ms);
    }
  } catch {
    // never throw into the trading path
  }
}

/**
 * Fire-and-forget persistence. Returns void (not a promise) by design:
 * callers must not await it on the hot path.
 */
export function persistTrace(trace: Trace): void {
  try {
    void insertLatencyTrace(trace).catch(() => {});
  } catch {
    // swallow everything
  }
}
