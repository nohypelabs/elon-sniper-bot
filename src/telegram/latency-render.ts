/**
 * Pure renderer for the Telegram /latency message (HTML, like other messages).
 * No I/O — takes a RollingStats-style summary plus an event-loop snapshot.
 */

import type { EventLoopSnapshot, StatSummary } from '../metrics/latency';

function fmtMs(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '—';
}

function fmtInt(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : '—';
}

export function renderLatency(
  summary: Record<string, StatSummary>,
  eventLoop: EventLoopSnapshot,
): string {
  const lines = [`⏱ <b>Latency &amp; Slippage</b>`, ''];

  const keys = Object.keys(summary).sort();
  if (keys.length === 0) {
    lines.push('Belum ada data latensi — bot belum menyelesaikan trade yang terinstrumentasi.');
  } else {
    for (const key of keys) {
      const s = summary[key];
      if (!s || typeof s !== 'object') continue;
      lines.push(
        `<code>${key}</code>`,
        `  n=${fmtInt(s.n)} p50=${fmtMs(s.p50)}ms p90=${fmtMs(s.p90)}ms p99=${fmtMs(s.p99)}ms max=${fmtMs(s.max)}ms`,
      );
    }
  }

  lines.push(
    '',
    `🔁 Event loop: p50=${fmtMs(eventLoop?.p50Ms)}ms p99=${fmtMs(eventLoop?.p99Ms)}ms max=${fmtMs(eventLoop?.maxMs)}ms`,
  );

  const p99 = eventLoop?.p99Ms;
  if (typeof p99 === 'number' && Number.isFinite(p99)) {
    if (p99 < 20) {
      lines.push(`✅ Event loop p99 ${p99.toFixed(1)} ms: bahasa/GC bukan bottleneck.`);
    } else {
      lines.push(`⚠️ Event loop p99 ${p99.toFixed(1)} ms: WASPADA — event loop jenuh, pindahkan workload berat keluar hot path.`);
    }
  } else {
    lines.push('ℹ️ Event loop belum ada sampel.');
  }

  return lines.join('\n');
}
