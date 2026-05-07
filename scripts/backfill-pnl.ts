/**
 * Backfill pnlSol for SELL trades saved with pnlSol=0 due to the pre-fix bug
 * where paper trading PnL SOL was computed via the live-trade path (outputAmount=0).
 *
 * Formula: pnlSol = solAmount * (pnlPercent / 100)
 * This matches what the bot now stores correctly for paper trades.
 *
 * Run once: pnpm tsx scripts/backfill-pnl.ts
 */
import { db } from '../src/db/client';

async function main() {
  // Trades where pnlSol is 0 or null but pnlPercent is non-zero → pre-fix bug
  const trades = await db.trade.findMany({
    where: {
      type: 'SELL',
      OR: [{ pnlSol: 0 }, { pnlSol: null }],
      NOT: [{ pnlPercent: 0 }, { pnlPercent: null }],
    },
    select: { id: true, pnlPercent: true, solAmount: true },
  });

  console.log(`Found ${trades.length} SELL trades with pnlSol=0 to backfill`);
  if (trades.length === 0) { await db.$disconnect(); return; }

  let updated = 0;
  for (const t of trades) {
    if (!t.pnlPercent || !t.solAmount) continue;
    const pnlSol = t.solAmount * (t.pnlPercent / 100);
    await db.trade.update({ where: { id: t.id }, data: { pnlSol } });
    updated++;
    if (updated % 10 === 0) process.stdout.write(`\r  Updated ${updated}/${trades.length}...`);
  }

  console.log(`\nDone — backfilled ${updated} trades`);
  await db.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
