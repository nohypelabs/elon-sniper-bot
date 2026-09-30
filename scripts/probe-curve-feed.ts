/**
 * Probe the keyless Solana curve feed (Stage 10).
 *
 * Subscribes to the fixture bonding curve
 * (6zmH5rF19wUui3YKLv6d488nuqhf2MyiBccRv4dGLGfZ), prints each update
 * (price, mcap, slot) for 30s, then exits 0 if at least the connection was
 * confirmed (update received or socket opened). Never prints the WS URL
 * query string (it may contain an API key).
 *
 * Run: SOLANA_WS_URL="wss://..." node --import tsx scripts/probe-curve-feed.ts
 * (falls back to HELIUS_API_KEY / public mainnet like the bot config).
 */
import { CurveFeed } from '../src/scanner/curve-feed';
import { CONFIG } from '../src/config';

const CURVE = '6zmH5rF19wUui3YKLv6d488nuqhf2MyiBccRv4dGLGfZ';

async function main(): Promise<void> {
  const feed = new CurveFeed({ url: CONFIG.SOLANA_WS_URL });
  let updates = 0;
  let opened = false;

  feed.start();
  feed.subscribe(CURVE, (u) => {
    updates++;
    console.log(
      `update #${updates} price=${u.priceInSol.toExponential(4)} SOL ` +
      `mcap=${u.marketCapSol.toFixed(4)} SOL slot=${u.slot} complete=${u.complete}`,
    );
  });

  // Poll connection state (CurveFeed.stats is the only signal; the URL is
  // never printed so the api-key query param cannot leak).
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    await new Promise<void>((r) => setTimeout(r, 1000));
    const st = feed.stats();
    if (st.connected) opened = true;
    if (updates > 0 && Date.now() - t0 > 5000) break;
  }

  const st = feed.stats();
  console.log(
    `done: connected=${st.connected} subscriptions=${st.subscriptions} ` +
    `updates=${st.updates} reconnects=${st.reconnects}`,
  );
  try { feed.stop(); } catch { /* ignore */ }
  await new Promise<void>((r) => setTimeout(r, 200));
  // Exit 0 when at least the connection was confirmed (socket opened or an
  // update arrived); exit 2 otherwise so the lead can tell feed-down apart.
  process.exit(opened || updates > 0 ? 0 : 2);
}

main().catch((err) => {
  console.error(`probe failed: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
