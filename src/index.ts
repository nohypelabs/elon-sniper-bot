/**
 * Elon Sniper Bot — Main Orchestrator
 *
 * Flow:
 * 1. Monitor Elon's tweets for meme keywords
 * 2. Search pump.fun/DexScreener for matching tokens
 * 3. Alert on Telegram with BUY buttons
 * 4. User taps BUY → execute SOL→Token swap
 * 5. Monitor position → auto take-profit / stop-loss
 */

import { Connection } from '@solana/web3.js';
import { CONFIG } from './config';
import { logger } from './utils/logger';
import { TweetMonitor, Tweet } from './monitor/tweet.monitor';
import { TokenFinder, FoundToken } from './scanner/token.finder';
import { JupiterSwap, SwapResult } from './swap/jupiter.swap';
import * as telegram from './telegram/bot';

interface ActivePosition {
  token: FoundToken;
  buyResult: SwapResult;
  entryTime: number;
  entryPriceUsd: number;
  solSpent: number;
}

class ElonSniper {
  private connection: Connection;
  private tweetMonitor: TweetMonitor;
  private tokenFinder: TokenFinder;
  private jupiterSwap: JupiterSwap;

  private activePositions: Map<string, ActivePosition> = new Map();
  private startTime = 0;
  private tweetsDetected = 0;
  private buysExecuted = 0;
  private totalPnl = 0;

  constructor() {
    this.connection = new Connection(CONFIG.RPC_URL, 'confirmed');
    this.tweetMonitor = new TweetMonitor();
    this.tokenFinder = new TokenFinder();
    this.jupiterSwap = new JupiterSwap(this.connection);
  }

  async start(): Promise<void> {
    this.startTime = Date.now();

    logger.info('='.repeat(50));
    logger.info('  ELON SNIPER BOT');
    logger.info(`  Mode: ${CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE'}`);
    logger.info(`  Buy Amount: ${CONFIG.BUY_AMOUNT_SOL} SOL`);
    logger.info(`  Max MCap: $${CONFIG.MAX_MCAP_USD}`);
    logger.info(`  TP: +${CONFIG.TAKE_PROFIT_PERCENT}% | SL: -${CONFIG.STOP_LOSS_PERCENT}%`);
    logger.info('='.repeat(50));

    // Register Telegram handlers
    telegram.registerHandlers({
      getStatus: () => this.getStatusMessage(),
      onSell: () => this.sellAllPositions(),
      onBuySelected: (mint, symbol) => this.executeBuyFromTelegram(mint, symbol),
      onSellSelected: (mint, symbol) => this.executeSellFromTelegram(mint, symbol),
    });
    telegram.startPolling();

    // Send startup alert
    await telegram.alertTweetDetected(
      `🤖 Elon Sniper Bot started!\nMode: ${CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE'}\nMonitoring @elonmusk tweets...`,
      [],
    );

    // Register tweet callback
    this.tweetMonitor.onNewTweet((tweet) => this.handleNewTweet(tweet));

    // Start monitoring (this runs forever)
    // Also start position monitor loop in background
    this.monitorPositionsLoop();
    await this.tweetMonitor.start();
  }

  /**
   * Handle a new tweet from Elon
   */
  private async handleNewTweet(tweet: Tweet): Promise<void> {
    this.tweetsDetected++;
    logger.info(`\n🐦 NEW TWEET #${this.tweetsDetected}: ${tweet.text.slice(0, 100)}...`);
    logger.info(`   Keywords: ${tweet.keywords.join(', ')}`);

    // Alert on Telegram
    await telegram.alertTweetDetected(tweet.text, tweet.keywords);

    // Search for tokens
    const tokens = await this.tokenFinder.findTokens(tweet.keywords);

    if (tokens.length === 0) {
      logger.info('   No matching tokens found under max mcap');
      // Retry search after 30s (tokens might get created after tweet)
      setTimeout(async () => {
        logger.info('🔄 Retrying token search (30s delay)...');
        const retryTokens = await this.tokenFinder.findTokens(tweet.keywords);
        if (retryTokens.length > 0) {
          await telegram.alertTokensFound(retryTokens, tweet.text);
        }
      }, 30_000);

      // And again after 60s
      setTimeout(async () => {
        logger.info('🔄 Retrying token search (60s delay)...');
        const retryTokens = await this.tokenFinder.findTokens(tweet.keywords);
        if (retryTokens.length > 0) {
          await telegram.alertTokensFound(retryTokens, tweet.text);
        }
      }, 60_000);

      return;
    }

    // Show tokens on Telegram with BUY buttons
    await telegram.alertTokensFound(tokens, tweet.text);
  }

  /**
   * Execute buy from Telegram button press
   */
  private async executeBuyFromTelegram(mintAddress: string, symbol: string): Promise<void> {
    // Find token info (we might have it cached from the search)
    const token: FoundToken = {
      mintAddress,
      symbol,
      name: symbol,
      priceUsd: 0,
      mcapUsd: 0,
      liquidity: 0,
      volume24h: 0,
      pairAddress: '',
      dex: 'unknown',
      ageMinutes: 0,
      matchedKeyword: '',
      url: `https://dexscreener.com/solana/${mintAddress}`,
    };

    // Try to get current price from DexScreener
    try {
      const { default: axios } = await import('axios');
      const resp = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 5000 });
      const pair = resp.data?.pairs?.[0];
      if (pair) {
        token.priceUsd = parseFloat(pair.priceUsd) || 0;
        token.mcapUsd = pair.fdv || 0;
        token.liquidity = pair.liquidity?.usd || 0;
        token.pairAddress = pair.pairAddress || '';
        token.url = pair.url || token.url;
      }
    } catch { /* use defaults */ }

    await this.executeBuy(token);
  }

  /**
   * Execute a buy
   */
  private async executeBuy(token: FoundToken): Promise<void> {
    const solAmount = CONFIG.BUY_AMOUNT_SOL;

    logger.info(`🛒 Executing buy: ${token.symbol} with ${solAmount} SOL`);

    const result = await this.jupiterSwap.buyToken(token.mintAddress, solAmount);

    if (!result.success) {
      logger.error(`Buy failed: ${result.error}`);
      await telegram.alertError(`Buy ${token.symbol} failed: ${result.error}`);
      return;
    }

    // Track position
    const position: ActivePosition = {
      token,
      buyResult: result,
      entryTime: Date.now(),
      entryPriceUsd: token.priceUsd,
      solSpent: solAmount,
    };

    this.activePositions.set(token.mintAddress, position);
    this.buysExecuted++;

    await telegram.alertBuyExecuted(token, result.txSignature, solAmount);
    logger.info(`✅ Buy executed: ${token.symbol} | TX: ${result.txSignature}`);
  }

  /**
   * Execute sell from Telegram
   */
  private async executeSellFromTelegram(mintAddress: string, symbol: string): Promise<void> {
    const position = this.activePositions.get(mintAddress);

    const result = await this.jupiterSwap.sellToken(mintAddress);
    if (result.success) {
      this.activePositions.delete(mintAddress);
      await telegram.alertSellExecuted(symbol, 0, 'Manual sell via Telegram');
    } else {
      await telegram.alertError(`Sell ${symbol} failed: ${result.error}`);
    }
  }

  /**
   * Sell all active positions
   */
  private async sellAllPositions(): Promise<void> {
    if (this.activePositions.size === 0) {
      await telegram.alertError('No active positions to sell');
      return;
    }

    for (const [mint, pos] of this.activePositions) {
      const result = await this.jupiterSwap.sellToken(mint);
      if (result.success) {
        await telegram.alertSellExecuted(pos.token.symbol, 0, 'Manual sell all');
      }
    }
    this.activePositions.clear();
  }

  /**
   * Background loop to monitor positions for TP/SL
   */
  private async monitorPositionsLoop(): Promise<void> {
    while (true) {
      await this.sleep(15_000); // Check every 15s

      for (const [mint, position] of this.activePositions) {
        try {
          // Get current price from DexScreener
          const { default: axios } = await import('axios');
          const resp = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
            { timeout: 5000 },
          );
          const pair = resp.data?.pairs?.[0];
          if (!pair) continue;

          const currentPrice = parseFloat(pair.priceUsd) || 0;
          if (currentPrice <= 0 || position.entryPriceUsd <= 0) continue;

          const pnlPercent = ((currentPrice - position.entryPriceUsd) / position.entryPriceUsd) * 100;

          // Take profit
          if (pnlPercent >= CONFIG.TAKE_PROFIT_PERCENT && CONFIG.AUTO_SELL) {
            logger.info(`🎯 TAKE PROFIT: ${position.token.symbol} at +${pnlPercent.toFixed(1)}%`);
            const result = await this.jupiterSwap.sellToken(mint);
            if (result.success) {
              this.activePositions.delete(mint);
              this.totalPnl += pnlPercent;
              await telegram.alertSellExecuted(
                position.token.symbol,
                pnlPercent,
                `Take Profit (+${CONFIG.TAKE_PROFIT_PERCENT}% target hit)`,
              );
            }
            continue;
          }

          // Stop loss
          if (pnlPercent <= -CONFIG.STOP_LOSS_PERCENT && CONFIG.AUTO_SELL) {
            logger.info(`🛑 STOP LOSS: ${position.token.symbol} at ${pnlPercent.toFixed(1)}%`);
            const result = await this.jupiterSwap.sellToken(mint);
            if (result.success) {
              this.activePositions.delete(mint);
              this.totalPnl += pnlPercent;
              await telegram.alertSellExecuted(
                position.token.symbol,
                pnlPercent,
                `Stop Loss (-${CONFIG.STOP_LOSS_PERCENT}% limit hit)`,
              );
            }
          }
        } catch (error) {
          // Non-critical, continue monitoring
        }
      }
    }
  }

  /**
   * Get formatted status message
   */
  private getStatusMessage(): string {
    const uptime = Date.now() - this.startTime;
    const upHours = (uptime / 3_600_000).toFixed(1);

    const lines = [
      `🤖 <b>Elon Sniper Bot</b>`,
      `Mode: <b>${CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE'}</b>`,
      '',
      `⏱ Uptime: ${upHours}h`,
      `🐦 Tweets detected: ${this.tweetsDetected}`,
      `🛒 Buys executed: ${this.buysExecuted}`,
      `📊 Active positions: ${this.activePositions.size}`,
      `💰 Buy amount: ${CONFIG.BUY_AMOUNT_SOL} SOL`,
      `📈 Total PnL: ${this.totalPnl >= 0 ? '+' : ''}${this.totalPnl.toFixed(1)}%`,
    ];

    if (this.activePositions.size > 0) {
      lines.push('', '<b>Active Positions:</b>');
      for (const [, pos] of this.activePositions) {
        const duration = ((Date.now() - pos.entryTime) / 60_000).toFixed(0);
        lines.push(
          `🪙 <b>${pos.token.symbol}</b>`,
          `   Entry: $${pos.entryPriceUsd.toFixed(8)} | ${duration}m ago`,
          `   Spent: ${pos.solSpent} SOL`,
        );
      }
    } else {
      lines.push('', '📭 No active positions — waiting for Elon tweet...');
    }

    return lines.join('\n');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// ─── Entry point ──────────────────────────────────────────────────

async function main() {
  const sniper = new ElonSniper();

  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    telegram.stopPolling();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    telegram.stopPolling();
    process.exit(0);
  });

  await sniper.start();
}

main().catch(err => {
  logger.error(`Fatal: ${err}`);
  process.exit(1);
});
