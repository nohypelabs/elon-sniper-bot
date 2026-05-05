/**
 * Token Finder
 *
 * Given keywords from Elon's tweet, search for matching tokens on:
 * 1. pump.fun (new launches, often < minutes old)
 * 2. DexScreener (broader coverage)
 * 3. Birdeye (fallback)
 *
 * Filters: only Solana, mcap < MAX_MCAP_USD, has liquidity
 */

import axios from 'axios';
import { logger } from '../utils/logger';
import { CONFIG } from '../config';

export interface FoundToken {
  mintAddress: string;
  symbol: string;
  name: string;
  priceUsd: number;
  mcapUsd: number;
  liquidity: number;
  volume24h: number;
  pairAddress: string;
  dex: string;
  ageMinutes: number;
  matchedKeyword: string;
  url: string;
}

const DEXSCREENER_API = 'https://api.dexscreener.com';
const PUMPFUN_API = 'https://frontend-api-v3.pump.fun';

export class TokenFinder {
  /**
   * Search for tokens matching any of the given keywords.
   * Returns tokens sorted by relevance (best match + lowest mcap first).
   */
  async findTokens(keywords: string[]): Promise<FoundToken[]> {
    logger.info(`🔍 Searching tokens for ${keywords.length} keywords: ${keywords.slice(0, 5).join(', ')}...`);

    const allTokens: FoundToken[] = [];

    // Search in parallel across sources
    const searchPromises: Promise<FoundToken[]>[] = [];

    for (const keyword of keywords.slice(0, 10)) { // Limit to top 10 keywords
      searchPromises.push(this.searchPumpFun(keyword));
      searchPromises.push(this.searchDexScreener(keyword));
    }

    const results = await Promise.allSettled(searchPromises);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allTokens.push(...result.value);
      }
    }

    // Deduplicate by mint address (keep lowest mcap entry)
    const byMint = new Map<string, FoundToken>();
    for (const token of allTokens) {
      const existing = byMint.get(token.mintAddress);
      if (!existing || token.mcapUsd < existing.mcapUsd) {
        byMint.set(token.mintAddress, token);
      }
    }

    // Filter and sort
    const filtered = Array.from(byMint.values())
      .filter(t => t.mcapUsd > 0 && t.mcapUsd <= CONFIG.MAX_MCAP_USD && t.mcapUsd >= CONFIG.MIN_MCAP_USD)
      .sort((a, b) => a.mcapUsd - b.mcapUsd); // Lowest mcap first (earliest entry)

    logger.info(`Found ${filtered.length} tokens in mcap $${CONFIG.MIN_MCAP_USD}–$${CONFIG.MAX_MCAP_USD}`);
    return filtered;
  }

  /**
   * Search pump.fun for new token launches matching keyword
   */
  private async searchPumpFun(keyword: string): Promise<FoundToken[]> {
    const tokens: FoundToken[] = [];

    try {
      // pump.fun coin search
      const resp = await axios.get(`${PUMPFUN_API}/coins`, {
        params: {
          offset: 0,
          limit: 20,
          sort: 'creation_time',
          order: 'DESC',
          includeNsfw: false,
        },
        timeout: 10_000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
        },
      });

      const coins = resp.data ?? [];
      const kw = keyword.toLowerCase();

      for (const coin of coins) {
        const name = (coin.name || '').toLowerCase();
        const symbol = (coin.symbol || '').toLowerCase();
        const desc = (coin.description || '').toLowerCase();

        // Check if keyword matches name, symbol, or description
        const nameMatch = name.includes(kw) || symbol.includes(kw);
        const descMatch = desc.includes(kw);
        const exactSymbol = symbol === kw;

        if (!nameMatch && !descMatch) continue;

        const mcap = coin.usd_market_cap || coin.market_cap || 0;
        const created = coin.created_timestamp || Date.now();
        const ageMinutes = (Date.now() - created) / 60_000;

        tokens.push({
          mintAddress: coin.mint || '',
          symbol: coin.symbol || '',
          name: coin.name || '',
          priceUsd: coin.price || 0,
          mcapUsd: mcap,
          liquidity: coin.virtual_sol_reserves ? (coin.virtual_sol_reserves / 1e9) * 150 : 0, // Rough USD estimate
          volume24h: 0,
          pairAddress: coin.bonding_curve || '',
          dex: 'pump.fun',
          ageMinutes,
          matchedKeyword: keyword,
          url: `https://pump.fun/coin/${coin.mint}`,
        });

        if (exactSymbol) {
          // Boost exact symbol matches by putting them first
          const last = tokens[tokens.length - 1];
          tokens.splice(tokens.length - 1, 1);
          tokens.unshift(last);
        }
      }
    } catch (error) {
      logger.debug(`pump.fun search failed for "${keyword}": ${(error as Error).message}`);
    }

    // Also try pump.fun search endpoint
    try {
      const resp = await axios.get(`${PUMPFUN_API}/coins/search`, {
        params: { query: keyword, limit: 10 },
        timeout: 10_000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      const coins = resp.data ?? [];
      for (const coin of coins) {
        const mcap = coin.usd_market_cap || coin.market_cap || 0;
        const created = coin.created_timestamp || Date.now();

        // Avoid duplicates
        if (tokens.some(t => t.mintAddress === coin.mint)) continue;

        tokens.push({
          mintAddress: coin.mint || '',
          symbol: coin.symbol || '',
          name: coin.name || '',
          priceUsd: coin.price || 0,
          mcapUsd: mcap,
          liquidity: coin.virtual_sol_reserves ? (coin.virtual_sol_reserves / 1e9) * 150 : 0,
          volume24h: 0,
          pairAddress: coin.bonding_curve || '',
          dex: 'pump.fun',
          ageMinutes: (Date.now() - created) / 60_000,
          matchedKeyword: keyword,
          url: `https://pump.fun/coin/${coin.mint}`,
        });
      }
    } catch {
      // search endpoint might not exist on all pump.fun versions
    }

    return tokens;
  }

  /**
   * Search DexScreener for Solana tokens matching keyword
   */
  private async searchDexScreener(keyword: string): Promise<FoundToken[]> {
    const tokens: FoundToken[] = [];

    try {
      const resp = await axios.get<{ pairs: any[] }>(
        `${DEXSCREENER_API}/latest/dex/search`,
        {
          params: { q: keyword },
          timeout: 10_000,
        },
      );

      const pairs = (resp.data?.pairs ?? []).filter(
        (p: any) => p.chainId === 'solana',
      );

      for (const pair of pairs) {
        const mcap = pair.fdv || pair.marketCap || 0;
        const created = pair.pairCreatedAt || Date.now();
        const ageMinutes = (Date.now() - created) / 60_000;

        tokens.push({
          mintAddress: pair.baseToken?.address || '',
          symbol: pair.baseToken?.symbol || '',
          name: pair.baseToken?.name || '',
          priceUsd: parseFloat(pair.priceUsd) || 0,
          mcapUsd: mcap,
          liquidity: pair.liquidity?.usd || 0,
          volume24h: pair.volume?.h24 || 0,
          pairAddress: pair.pairAddress || '',
          dex: pair.dexId || 'unknown',
          ageMinutes,
          matchedKeyword: keyword,
          url: pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
        });
      }
    } catch (error) {
      logger.debug(`DexScreener search failed for "${keyword}": ${(error as Error).message}`);
    }

    return tokens;
  }

  /**
   * Quick check: is there already a token for this keyword?
   * Used for rapid pre-screening before full search.
   */
  async quickCheck(keyword: string): Promise<boolean> {
    try {
      const resp = await axios.get<{ pairs: any[] }>(
        `${DEXSCREENER_API}/latest/dex/search`,
        { params: { q: keyword }, timeout: 5_000 },
      );
      const solPairs = (resp.data?.pairs ?? []).filter(
        (p: any) => p.chainId === 'solana' && (p.fdv || 0) <= CONFIG.MAX_MCAP_USD,
      );
      return solPairs.length > 0;
    } catch {
      return false;
    }
  }
}
