import axios from 'axios';
import { CONFIG } from '../config';
import { logger } from '../utils/logger';

export interface DevWalletResult {
  isSafe: boolean;
  reason: string | null;
  launchCount24h: number;
  priorRugCount: number;
}

interface CacheEntry {
  result: DevWalletResult;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RUG_WINDOW_SEC = 60; // sell within 60s of launch = rug

export class DevWalletChecker {
  private cache = new Map<string, CacheEntry>();

  async check(wallet: string): Promise<DevWalletResult> {
    // Check cache
    const cached = this.cache.get(wallet);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.result;
    }

    const result = await this.queryHelius(wallet);

    this.cache.set(wallet, {
      result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return result;
  }

  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now >= entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  private async queryHelius(wallet: string): Promise<DevWalletResult> {
    const fallback: DevWalletResult = { isSafe: true, reason: null, launchCount24h: 0, priorRugCount: 0 };

    if (!CONFIG.HELIUS_API_KEY) {
      logger.warn('Dev wallet check skipped: HELIUS_API_KEY not set');
      return fallback;
    }

    try {
      const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions`;
      const { data } = await axios.get(url, {
        params: { 'api-key': CONFIG.HELIUS_API_KEY, limit: 20 },
        timeout: CONFIG.PUMP_DEV_CHECK_TIMEOUT_MS,
      });

      if (!Array.isArray(data)) {
        logger.warn(`Dev wallet check: unexpected response for ${wallet.slice(0, 8)}...`);
        return fallback;
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const cutoff24h = nowSec - 86400;

      // Find create transactions in last 24h
      const creates = data.filter((tx: any) => {
        const ts = tx.timestamp || 0;
        if (ts < cutoff24h) return false;
        // Helius enhanced tx has `type` field; also check for pump.fun create
        if (tx.type === 'CREATE' || tx.type === 'create') return true;
        // Check instructions for pump.fun program
        const instructions = tx.instructions || [];
        return instructions.some((ix: any) =>
          ix.programId === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' ||
          ix.program === 'pump-fun' ||
          ix.program === 'pump'
        );
      });

      const launchCount24h = creates.length;

      // Detect rug pattern: sell within 60s of any create
      let priorRugCount = 0;
      for (const createTx of creates) {
        const createTs = createTx.timestamp || 0;
        // Find sells by same wallet within 60s after this create
        const rugWindowEnd = createTs + RUG_WINDOW_SEC;

        // Get the mint from the create tx
        const createMint = this.extractMint(createTx);
        if (!createMint) continue;

        const hasQuickSell = data.some((tx: any) => {
          if (tx === createTx) return false;
          const ts = tx.timestamp || 0;
          if (ts < createTs || ts > rugWindowEnd) return false;
          // Check if this tx involves selling/transferring the same mint
          const tokenTransfers = tx.tokenTransfers || [];
          return tokenTransfers.some((t: any) =>
            t.mint === createMint && t.fromUserAccount === wallet
          );
        });

        if (hasQuickSell) priorRugCount++;
      }

      const isSafe = launchCount24h <= CONFIG.PUMP_MAX_LAUNCHES_24H && priorRugCount === 0;
      const reason = !isSafe
        ? priorRugCount > 0
          ? `prior rug detected (${priorRugCount}x sold within 60s of launch)`
          : `serial launcher (${launchCount24h} launches in 24h, max ${CONFIG.PUMP_MAX_LAUNCHES_24H})`
        : null;

      return { isSafe, reason, launchCount24h, priorRugCount };
    } catch (err: any) {
      logger.warn(`Dev wallet check failed for ${wallet.slice(0, 8)}...: ${err.message}`);
      return fallback;
    }
  }

  private extractMint(tx: any): string | null {
    // Try tokenTransfers first
    const transfers = tx.tokenTransfers || [];
    if (transfers.length > 0) {
      return transfers[0].mint || null;
    }
    // Try nativeTransfers or accountData
    const accountData = tx.accountData || [];
    for (const acc of accountData) {
      if (acc.tokenBalanceChanges?.length > 0) {
        return acc.tokenBalanceChanges[0].mint || null;
      }
    }
    return null;
  }
}
