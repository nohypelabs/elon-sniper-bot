/**
 * Quick loss-analysis: aggregate paired BUY/SELL outcomes to spot weak spots.
 * Run: pnpm tsx scripts/loss-analysis.ts
 */
import { closeDb, initDb } from '../src/db/client';
import { listAllBuys, listSells } from '../src/db/repo';
import type { Trade } from '../src/db/schema';

type TradeRow = Trade;

type LossDetail = {
  symbol: string;
  buyMcap: number;
  sellMcap: number;
  pnlPct: number;
  pnlSol: number;
  holdMin: number;
  reason: string;
  source: string;
};

type BucketStats = { w: number; l: number; pnl: number };

function pickNearestPriorBuy(sell: TradeRow, buysByToken: Map<string, TradeRow[]>): TradeRow | undefined {
  const arr = buysByToken.get(sell.tokenMint);
  if (!arr || arr.length === 0) return undefined;

  // BUY rows are sorted ascending by createdAt.
  // We pick the latest BUY whose timestamp is <= SELL timestamp.
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].createdAt <= sell.createdAt) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? arr[ans] : undefined;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function wrPct(v: BucketStats): number {
  const total = v.w + v.l;
  return total > 0 ? (v.w / total) * 100 : 0;
}

async function main() {
  await initDb();
  const sells = await listSells();

  const buys = await listAllBuys();
  const buyMap = new Map<string, TradeRow>();
  const buysByToken = new Map<string, TradeRow[]>();
  for (const b of buys) {
    const arr = buysByToken.get(b.tokenMint) ?? [];
    arr.push(b);
    buysByToken.set(b.tokenMint, arr);
    const prev = buyMap.get(b.tokenMint);
    if (!prev || b.createdAt > prev.createdAt) buyMap.set(b.tokenMint, b);
  }

  console.log(`Total SELL trades: ${sells.length}`);

  let wins = 0, losses = 0, rugs = 0;
  let pnlSol = 0, pnlWin = 0, pnlLoss = 0;
  const reasons: Record<string, { count: number; pnlSol: number; pnlPct: number[] }> = {};
  const buckets = { tp1: 0, tp2: 0, sl: 0, trail: 0, timeout: 0, manual: 0, other: 0 };
  const holdMinutes: number[] = [];
  const buyMcaps: number[] = [];
  const lossDetails: LossDetail[] = [];
  const stopLikeLosses: number[] = [];
  const topWinPercents: number[] = [];
  const topWinPnlSol: number[] = [];
  const allLossPercents: number[] = [];
  const allLossPnlSol: number[] = [];
  const byDevBuyBucket: Record<string, BucketStats> = {};
  let pairsMissingBuy = 0;

  for (const s of sells) {
    const buy = pickNearestPriorBuy(s, buysByToken);
    const pct = s.pnlPercent ?? 0;
    const sol = s.pnlSol ?? 0;
    pnlSol += sol;
    if (pct > 0) { wins++; pnlWin += sol; }
    else { losses++; pnlLoss += sol; }
    if (pct < -40) rugs++;

    const reason = s.reason ?? 'unknown';
    if (!reasons[reason]) reasons[reason] = { count: 0, pnlSol: 0, pnlPct: [] };
    reasons[reason].count++;
    reasons[reason].pnlSol += sol;
    reasons[reason].pnlPct.push(pct);

    const r = reason.toLowerCase();
    if (r.includes('tp1')) buckets.tp1++;
    else if (r.includes('tp2')) buckets.tp2++;
    else if (r.includes('trail')) buckets.trail++;
    else if (r.includes('sl') || r.includes('stop')) buckets.sl++;
    else if (r.includes('timeout') || r.includes('hold')) buckets.timeout++;
    else if (r.includes('manual')) buckets.manual++;
    else buckets.other++;

    if (pct > 0) {
      topWinPercents.push(pct);
      topWinPnlSol.push(sol);
    } else if (pct < 0) {
      allLossPercents.push(pct);
      allLossPnlSol.push(sol);
      if (r.includes('sl') || r.includes('stop')) stopLikeLosses.push(Math.abs(pct));
    }

    if (buy) {
      const mins = (s.createdAt.getTime() - buy.createdAt.getTime()) / 60000;
      holdMinutes.push(mins);
      buyMcaps.push(buy.mcapUsd);

      let devKey = '?';
      const devBuySol = buy.solAmount ?? 0;
      if (devBuySol < 0.5) devKey = '<0.5';
      else if (devBuySol < 1) devKey = '0.5-1';
      else if (devBuySol < 2) devKey = '1-2';
      else if (devBuySol < 4) devKey = '2-4';
      else devKey = '4+';
      if (!byDevBuyBucket[devKey]) byDevBuyBucket[devKey] = { w: 0, l: 0, pnl: 0 };
      byDevBuyBucket[devKey].pnl += sol;
      if (pct > 0) byDevBuyBucket[devKey].w++;
      else byDevBuyBucket[devKey].l++;

      if (pct < 0) {
        lossDetails.push({
          symbol: s.symbol,
          buyMcap: Math.round(buy.mcapUsd),
          sellMcap: Math.round(s.mcapUsd),
          pnlPct: Math.round(pct * 10) / 10,
          pnlSol: Math.round(sol * 1000) / 1000,
          holdMin: Math.round(mins * 10) / 10,
          reason,
          source: buy.source,
        });
      }
    } else {
      pairsMissingBuy++;
    }
  }

  const wr = sells.length ? (wins / sells.length) * 100 : 0;
  const pf = pnlLoss !== 0 ? Math.abs(pnlWin / pnlLoss) : Infinity;
  const avgHold = holdMinutes.length ? holdMinutes.reduce((a, b) => a + b, 0) / holdMinutes.length : 0;
  const avgBuyMcap = buyMcaps.length ? buyMcaps.reduce((a, b) => a + b, 0) / buyMcaps.length : 0;
  const suggestedSl = stopLikeLosses.length > 0
    ? Math.max(10, Math.min(25, avg(stopLikeLosses) * 0.75))
    : 15;
  const suggestedTp1 = topWinPercents.length > 0
    ? Math.max(15, Math.min(40, avg(topWinPercents) * 0.4))
    : 22;
  const suggestedTp2 = topWinPercents.length > 0
    ? Math.max(30, Math.min(90, avg(topWinPercents) * 0.8))
    : 45;
  const suggestedMaxSessionLossSol = allLossPnlSol.length > 0
    ? Math.max(0.3, Math.min(2, Math.abs(avg(allLossPnlSol)) * 3))
    : 0.8;

  console.log(`Wins: ${wins}  Losses: ${losses}  WR: ${wr.toFixed(1)}%`);
  console.log(`Rugs (<-40%): ${rugs}`);
  console.log(`Total PnL SOL: ${pnlSol.toFixed(3)}  (Wins: +${pnlWin.toFixed(3)}, Losses: ${pnlLoss.toFixed(3)})`);
  console.log(`Profit Factor: ${pf.toFixed(2)}x`);
  console.log(`Avg hold: ${avgHold.toFixed(1)} min   Avg buy mcap: $${avgBuyMcap.toFixed(0)}`);

  console.log('\n=== Exit reasons ===');
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1].count - a[1].count)) {
    const avgPct = v.pnlPct.reduce((a, b) => a + b, 0) / v.pnlPct.length;
    console.log(`  ${k.padEnd(15)} count=${v.count}  pnl=${v.pnlSol.toFixed(3)} SOL  avg%=${avgPct.toFixed(1)}%`);
  }
  console.log('\n=== Buckets ===', buckets);

  console.log('\n=== Loss distribution (sorted by worst pnl%) ===');
  lossDetails.sort((a, b) => a.pnlPct - b.pnlPct);
  for (const l of lossDetails.slice(0, 25)) {
    console.log(`  ${l.symbol.padEnd(10)}  ${String(l.pnlPct).padStart(6)}%  ${String(l.pnlSol).padStart(7)} SOL  hold=${l.holdMin}m  reason=${l.reason}  src=${l.source}  buyMC=$${l.buyMcap}`);
  }

  // by buy-mcap bucket
  console.log('\n=== WR by buy-mcap bucket ===');
  const mcapBuckets: Record<string, { w: 0|number; l: 0|number; pnl: number }> = {};
  for (const s of sells) {
    const buy = buyMap.get(s.tokenMint);
    if (!buy) continue;
    const mc = buy.mcapUsd;
    let key = '?';
    if (mc < 5000) key = '<5k';
    else if (mc < 10000) key = '5-10k';
    else if (mc < 20000) key = '10-20k';
    else if (mc < 50000) key = '20-50k';
    else key = '50k+';
    if (!mcapBuckets[key]) mcapBuckets[key] = { w: 0, l: 0, pnl: 0 };
    mcapBuckets[key].pnl += s.pnlSol ?? 0;
    if ((s.pnlPercent ?? 0) > 0) mcapBuckets[key].w++;
    else mcapBuckets[key].l++;
  }
  for (const [k, v] of Object.entries(mcapBuckets)) {
    const total = v.w + v.l;
    const wr = total ? (v.w / total) * 100 : 0;
    console.log(`  ${k.padEnd(8)} n=${total}  WR=${wr.toFixed(0)}%  pnl=${v.pnl.toFixed(3)} SOL`);
  }

  // by hold time bucket
  console.log('\n=== WR by hold-time bucket ===');
  const holdBuckets: Record<string, { w: number; l: number; pnl: number }> = {};
  for (const s of sells) {
    const buy = buyMap.get(s.tokenMint);
    if (!buy) continue;
    const mins = (s.createdAt.getTime() - buy.createdAt.getTime()) / 60000;
    let key = '?';
    if (mins < 1) key = '<1m';
    else if (mins < 5) key = '1-5m';
    else if (mins < 15) key = '5-15m';
    else if (mins < 30) key = '15-30m';
    else key = '30m+';
    if (!holdBuckets[key]) holdBuckets[key] = { w: 0, l: 0, pnl: 0 };
    holdBuckets[key].pnl += s.pnlSol ?? 0;
    if ((s.pnlPercent ?? 0) > 0) holdBuckets[key].w++;
    else holdBuckets[key].l++;
  }
  for (const [k, v] of Object.entries(holdBuckets)) {
    const total = v.w + v.l;
    const wr = total ? (v.w / total) * 100 : 0;
    console.log(`  ${k.padEnd(8)} n=${total}  WR=${wr.toFixed(0)}%  pnl=${v.pnl.toFixed(3)} SOL`);
  }

  console.log('\n=== WR by buy-size bucket (BUY solAmount) ===');
  for (const [k, v] of Object.entries(byDevBuyBucket)) {
    const total = v.w + v.l;
    const wr = total ? (v.w / total) * 100 : 0;
    console.log(`  ${k.padEnd(8)} n=${total}  WR=${wr.toFixed(0)}%  pnl=${v.pnl.toFixed(3)} SOL`);
  }

  const bestMcap = Object.entries(mcapBuckets)
    .filter(([, v]) => (v.w + v.l) >= 8)
    .sort((a, b) => (wrPct(b[1]) - wrPct(a[1])) || (b[1].pnl - a[1].pnl))[0];
  const bestHold = Object.entries(holdBuckets)
    .filter(([, v]) => (v.w + v.l) >= 8)
    .sort((a, b) => (wrPct(b[1]) - wrPct(a[1])) || (b[1].pnl - a[1].pnl))[0];
  const bestDev = Object.entries(byDevBuyBucket)
    .filter(([, v]) => (v.w + v.l) >= 8)
    .sort((a, b) => (wrPct(b[1]) - wrPct(a[1])) || (b[1].pnl - a[1].pnl))[0];

  console.log('\n=== Suggested env tuning (data-driven) ===');
  console.log(`# pair coverage: ${sells.length - pairsMissingBuy}/${sells.length} sells matched to prior BUY`);
  console.log(`STOP_LOSS_PERCENT=${suggestedSl.toFixed(0)}`);
  console.log(`TP1_PERCENT=${suggestedTp1.toFixed(0)}`);
  console.log('TP1_SELL_PERCENT=60');
  console.log(`TP2_PERCENT=${suggestedTp2.toFixed(0)}`);
  console.log(`PUMP_MAX_SESSION_LOSS_SOL=${suggestedMaxSessionLossSol.toFixed(2)}`);
  console.log('PUMP_MAX_CONSECUTIVE_LOSSES=3');
  if (bestMcap) {
    console.log(`# best mcap bucket from your data: ${bestMcap[0]} (WR ${wrPct(bestMcap[1]).toFixed(0)}%, pnl ${bestMcap[1].pnl.toFixed(3)} SOL)`);
  }
  if (bestHold) {
    console.log(`# best hold bucket from your data: ${bestHold[0]} (WR ${wrPct(bestHold[1]).toFixed(0)}%, pnl ${bestHold[1].pnl.toFixed(3)} SOL)`);
  }
  if (bestDev) {
    console.log(`# best buy-size bucket from your data: ${bestDev[0]} SOL (WR ${wrPct(bestDev[1]).toFixed(0)}%, pnl ${bestDev[1].pnl.toFixed(3)} SOL)`);
  }

  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
