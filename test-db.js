const { PrismaClient } = require('@prisma/client');
console.log('Testing DB connection...');
console.log('DB URL:', process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':****@'));
(async () => {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    console.log('Connected!');
    const count = await prisma.trade.count();
    console.log('Total trades:', count);

    const trades = await prisma.trade.findMany({
      orderBy: { timestamp: 'desc' },
      take: 30,
      select: {
        type: true,
        tokenSymbol: true,
        pnlSol: true,
        pnlPercent: true,
        reason: true,
        timestamp: true,
        buyMcapSol: true,
        sellMcapSol: true
      }
    });
    console.log('\n=== RECENT TRADES ===');
    let wins = 0, losses = 0, totalPnl = 0;
    trades.forEach((t, i) => {
      const pnl = t.pnlSol !== null ? t.pnlSol.toFixed(4) : 'N/A';
      const pnlPct = t.pnlPercent !== null ? t.pnlPercent.toFixed(1) : 'N/A';
      const type = (t.type || '?').padEnd(4);
      const sym = (t.tokenSymbol || '?').padEnd(10);
      console.log(`${i+1}. [${type}] ${sym} PnL: ${pnl} SOL (${pnlPct}%) Reason: ${t.reason || '-'}`);
      if (t.pnlSol !== null) {
        totalPnl += t.pnlSol;
        if (t.pnlSol > 0) wins++; else if (t.pnlSol < 0) losses++;
      }
    });
    console.log(`\n=== SUMMARY (last 30 trades) ===`);
    console.log(`Wins: ${wins}, Losses: ${losses}, Win Rate: ${(wins/(wins+losses)*100).toFixed(1)}%`);
    console.log(`Total PnL: ${totalPnl.toFixed(4)} SOL`);
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await prisma.$disconnect();
  }
})();
