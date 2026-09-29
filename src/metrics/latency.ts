/**
 * Latency + slippage instrumentation primitives.
 *
 * PURE module: no I/O, no DB, no network. Safe to import anywhere.
 * All methods are defensive (never throw into the trading path).
 */

import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

export type TraceKind = 'BUY' | 'SELL';

export interface Trace {
  id: string;
  kind: TraceKind;
  symbol?: string;
  mint?: string;
  startedAtWall: number;
  /** Stage name → ms offset from trace start (monotonic clock). */
  stages: Record<string, number>;
  /** Consecutive mark pairs, e.g. 'event_received->filters_passed' → delta ms. */
  segments: Record<string, number>;
  totalMs: number;
  notes: Record<string, number | string>;
}

interface OpenTrace {
  id: string;
  kind: TraceKind;
  symbol?: string;
  mint?: string;
  startMono: number;
  startedAtWall: number;
  /** Mark order of first occurrence. */
  order: string[];
  /** Stage name → absolute monotonic timestamp. */
  marks: Map<string, number>;
  notes: Record<string, number | string>;
}

const MAX_OPEN_TRACES = 500;
const OPEN_TRACE_TTL_MS = 10 * 60_000;

export class TraceRecorder {
  private open = new Map<string, OpenTrace>();
  private readonly now: () => number;
  private readonly wall: () => number;

  constructor(opts?: { now?: () => number; wall?: () => number }) {
    this.now = opts?.now ?? (() => performance.now());
    this.wall = opts?.wall ?? (() => Date.now());
  }

  start(id: string, kind: TraceKind, meta?: { symbol?: string; mint?: string }, at?: number): void {
    try {
      const now = this.now();
      this.evictStale(now);
      // Cap: drop oldest open traces first (Map preserves insertion order).
      while (this.open.size >= MAX_OPEN_TRACES) {
        const oldest = this.open.keys().next();
        if (oldest.done) break;
        this.open.delete(oldest.value);
      }
      const startMono = typeof at === 'number' && Number.isFinite(at) ? at : now;
      this.open.set(id, {
        id,
        kind,
        symbol: meta?.symbol,
        mint: meta?.mint,
        startMono,
        startedAtWall: this.wall(),
        order: [],
        marks: new Map(),
        notes: {},
      });
    } catch {
      // never throw into the trading path
    }
  }

  mark(id: string, stage: string, at?: number, overwrite?: boolean): void {
    try {
      const trace = this.open.get(id);
      if (!trace) return; // unknown ids ignored
      if (trace.marks.has(stage) && !overwrite) return; // first mark wins
      const t = typeof at === 'number' && Number.isFinite(at) ? at : this.now();
      if (!trace.marks.has(stage)) trace.order.push(stage);
      trace.marks.set(stage, t);
    } catch {
      // never throw
    }
  }

  note(id: string, key: string, value: number | string): void {
    try {
      const trace = this.open.get(id);
      if (!trace) return;
      if (typeof value === 'number' && !Number.isFinite(value)) return;
      trace.notes[key] = value;
    } catch {
      // never throw
    }
  }

  /** Read a previously stored note (used for slippage math). Unknown id → undefined. */
  getNote(id: string, key: string): number | string | undefined {
    try {
      return this.open.get(id)?.notes[key];
    } catch {
      return undefined;
    }
  }

  /** Returns true while the trace is still open (used for fallback timers). */
  isOpen(id: string): boolean {
    try {
      return this.open.has(id);
    } catch {
      return false;
    }
  }

  finish(id: string): Trace | null {
    try {
      const trace = this.open.get(id);
      if (!trace) return null;
      this.open.delete(id);

      const stages: Record<string, number> = {};
      for (const stage of trace.order) {
        stages[stage] = Math.max(0, (trace.marks.get(stage) ?? trace.startMono) - trace.startMono);
      }
      const segments: Record<string, number> = {};
      for (let i = 1; i < trace.order.length; i++) {
        const prev = trace.order[i - 1];
        const cur = trace.order[i];
        const delta = (trace.marks.get(cur) ?? 0) - (trace.marks.get(prev) ?? 0);
        segments[`${prev}->${cur}`] = Math.max(0, delta);
      }

      return {
        id: trace.id,
        kind: trace.kind,
        symbol: trace.symbol,
        mint: trace.mint,
        startedAtWall: trace.startedAtWall,
        stages,
        segments,
        totalMs: Math.max(0, this.now() - trace.startMono),
        notes: { ...trace.notes },
      };
    } catch {
      return null;
    }
  }

  openCount(): number {
    try {
      return this.open.size;
    } catch {
      return 0;
    }
  }

  private evictStale(now: number): void {
    try {
      for (const [id, trace] of this.open) {
        if (now - trace.startMono > OPEN_TRACE_TTL_MS) this.open.delete(id);
      }
    } catch {
      // never throw
    }
  }
}

// ─── RollingStats ───────────────────────────────────────────────

export interface StatSummary {
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

interface RingSlot {
  data: number[];
  head: number; // next write position once full
  count: number; // total writes ever (for wrap detection)
}

export class RollingStats {
  private readonly capacity: number;
  private slots = new Map<string, RingSlot>();

  constructor(capacity = 500) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  add(key: string, ms: number): void {
    try {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
      let slot = this.slots.get(key);
      if (!slot) {
        slot = { data: [], head: 0, count: 0 };
        this.slots.set(key, slot);
      }
      if (slot.data.length < this.capacity) {
        slot.data.push(ms);
      } else {
        slot.data[slot.head] = ms; // O(1) ring overwrite (oldest)
        slot.head = (slot.head + 1) % this.capacity;
      }
      slot.count++;
    } catch {
      // never throw
    }
  }

  /** Number of samples currently retained for a key (test helper). */
  size(key: string): number {
    try {
      return this.slots.get(key)?.data.length ?? 0;
    } catch {
      return 0;
    }
  }

  summary(): Record<string, StatSummary> {
    const out: Record<string, StatSummary> = {};
    try {
      for (const [key, slot] of this.slots) {
        if (slot.data.length === 0) continue;
        const sorted = [...slot.data].sort((a, b) => a - b);
        const n = sorted.length;
        out[key] = {
          n,
          p50: nearestRank(sorted, 50),
          p90: nearestRank(sorted, 90),
          p99: nearestRank(sorted, 99),
          max: sorted[n - 1],
        };
      }
    } catch {
      // return whatever was computed
    }
    return out;
  }
}

/** Nearest-rank percentile over an ascending-sorted array. */
function nearestRank(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const rank = Math.min(n, Math.max(1, Math.ceil((p / 100) * n)));
  return sortedAsc[rank - 1];
}

// ─── Slippage ───────────────────────────────────────────────────

/**
 * Relative price move in percent: (actual - reference) / reference * 100.
 * Positive = price moved up vs reference. Null when not computable.
 */
export function slippagePercent(reference: number, actual: number): number | null {
  try {
    if (!Number.isFinite(reference) || !Number.isFinite(actual)) return null;
    if (reference <= 0) return null;
    return ((actual - reference) / reference) * 100;
  } catch {
    return null;
  }
}

// ─── EventLoopMonitor ───────────────────────────────────────────

export interface EventLoopSnapshot {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

const NS_TO_MS = 1e6;

function toMsOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v / NS_TO_MS : 0;
}

/**
 * Wraps perf_hooks.monitorEventLoopDelay. Resolution 10ms.
 * snapshot() reads the histogram (ns → ms) and resets it.
 * Unref-safe: never keeps the process alive; stop() is idempotent.
 */
export class EventLoopMonitor {
  private hist: ReturnType<typeof monitorEventLoopDelay>;
  private running = false;

  constructor() {
    this.hist = monitorEventLoopDelay({ resolution: 10 });
  }

  start(): void {
    if (this.running) return;
    try {
      this.hist.enable();
      this.running = true;
    } catch {
      // never throw
    }
    try {
      (this.hist as unknown as { unref?: () => void }).unref?.();
    } catch {
      // histogram without unref — ignore
    }
  }

  stop(): void {
    if (!this.running) return; // idempotent
    try {
      this.hist.disable();
    } catch {
      // never throw
    } finally {
      this.running = false;
    }
  }

  snapshot(): EventLoopSnapshot {
    const zero = { p50Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
    try {
      const snap: EventLoopSnapshot = {
        p50Ms: toMsOrZero(this.hist.percentile(50)),
        p99Ms: toMsOrZero(this.hist.percentile(99)),
        maxMs: toMsOrZero(this.hist.max),
        meanMs: toMsOrZero(this.hist.mean),
      };
      try {
        this.hist.reset();
      } catch {
        // ignore reset failures
      }
      return snap;
    } catch {
      return zero;
    }
  }
}
