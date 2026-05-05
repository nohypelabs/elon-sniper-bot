import { Connection } from '@solana/web3.js';
import { CONFIG } from './config';
import { logger } from './utils/logger';
import { TweetMonitor, Tweet } from './monitor/tweet.monitor';
import { TokenFinder, FoundToken } from './scanner/token.finder';
import { GmgnSwap } from './swap/gmgn.swap';
import { JupiterSwap, SwapResult } from './swap/jupiter.swap';
import * as telegram from './telegram/bot';
import { db, logEvent } from './db/client';
import {
  startDashboardServer,
  registerDashboardHandlers,
  broadcastState,
  BotState,
  ActivePositionInfo,
} from './dashboard/server';
import { PumpFunListener, NewPumpToken } from './scanner/pumpfun.listener';

interface ActivePosition {
  token: FoundToken;
  buyResult: SwapResult;
  entryTime: number;
  entryPriceUsd: number;
  currentPriceUsd: number;
  solSpent: number;
  remainingTokens: number; // tracks partial sells
  tp1Hit: boolean;
  tp2Hit: boolean;
  isSelling: boolean;  // prevent double-sell race condition
  tweetText?: string;
}

class ElonSniper {
  private connection: Connection;
  private tweetMonitor: TweetMonitor;
  private tokenFinder: TokenFinder;
  private gmgnSwap: GmgnSwap;
  private jupiterSwap: JupiterSwap;
  private pumpListener: PumpFunListener;

  private activePositions: Map<string, ActivePosition> = new Map();
  private startTime = 0;
  private tweetsDetected = 0;
  private buysExecuted = 0;
  private totalPnlSol = 0;
  private solBalance = 0;
  private paused = false;
  private solPriceUsd = CONFIG.PUMP_SOL_PRICE_USD; // live-updated by oracle loop

  constructor() {
    this.connection  = new Connection(CONFIG.RPC_URL, 'confirmed');
    this.tweetMonitor = new TweetMonitor();
    this.tokenFinder  = new TokenFinder();
    this.gmgnSwap     = new GmgnSwap(this.connection);
    this.jupiterSwap  = new JupiterSwap(this.connection);
    this.pumpListener = new PumpFunListener();
  }

  async start(): Promise<void> {
    this.startTime = Date.now();

    logger.info('='.repeat(50));
    logger.info('  ELON SNIPER BOT');
    logger.info(`  Mode: ${CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE'}`);
    logger.info(`  Swap: ${CONFIG.GMGN_API_KEY ? 'GMGN (Anti-MEV)' : 'Jupiter (fallback)'}`);
    logger.info(`  Tweet Snipe: ON`);
    logger.info(`  PumpFun Snipe: ${CONFIG.PUMP_SNIPE_ENABLED ? 'ON' : 'OFF'}`);
    logger.info(`  Buy Amount: ${CONFIG.BUY_AMOUNT_SOL} SOL`);
    logger.info(`  Max Positions: ${CONFIG.PUMP_MAX_POSITIONS}`);
    logger.info(`  TP1: +${CONFIG.TP1_PERCENT}% (sell ${CONFIG.TP1_SELL_PERCENT}%) → TP2: +${CONFIG.TP2_PERCENT}% (close) | SL: -${CONFIG.STOP_LOSS_PERCENT}%`);
    logger.info('='.repeat(50));

    // Dashboard
    registerDashboardHandlers({
      getState:  () => this.getDashboardState(),
      onSell:    (mint) => this.executeSellFromDashboard(mint),
      onPause:   () => { this.paused = true;  logger.info('⏸ Bot paused from dashboard'); },
      onResume:  () => { this.paused = false; logger.info('▶ Bot resumed from dashboard'); },
    });
    await startDashboardServer();

    // Telegram
    telegram.registerHandlers({
      getStatus:       () => this.getStatusMessage(),
      onSell:          () => this.sellAllPositions(),
      onBuySelected:   (mint, symbol) => this.executeBuyFromTelegram(mint, symbol),
      onSellSelected:  (mint, symbol) => this.executeSellFromTelegram(mint, symbol),
    });
    telegram.startPolling();

    await logEvent('START', `Bot started — mode: ${CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE'}`);
    await telegram.alertTweetDetected(
      `🤖 Bot started!\nMode: ${CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE'}\nMonitoring @elonmusk tweets...`,
      [],
    );

    // Tweet sniper (always on)
    this.tweetMonitor.onNewTweet((tweet) => this.handleNewTweet(tweet));

    // PumpFun new token sniper (opt-in)
    if (CONFIG.PUMP_SNIPE_ENABLED) {
      this.pumpListener.onNewToken((token) => this.handleNewPumpToken(token));
      this.pumpListener.start();
      await logEvent('START', 'PumpFun sniper enabled', {
        minDevBuy: CONFIG.PUMP_MIN_DEV_BUY_SOL,
        maxDevBuy: CONFIG.PUMP_MAX_DEV_BUY_SOL,
        maxMcapSol: CONFIG.PUMP_MAX_MCAP_SOL,
        securityCheck: CONFIG.PUMP_SECURITY_CHECK,
        fastMode: CONFIG.PUMP_FAST_MODE,
      });
    }

    this.monitorPositionsLoop();
    this.refreshSolBalanceLoop();
    this.refreshSolPriceLoop();
    await this.tweetMonitor.start();
  }

  // ─── PumpFun new token handler ────────────────────────────────

  private async handleNewPumpToken(token: NewPumpToken): Promise<void> {
    if (this.paused) return;

    // Enforce max concurrent positions
    if (this.activePositions.size >= CONFIG.PUMP_MAX_POSITIONS) {
      logger.debug(`Max positions (${CONFIG.PUMP_MAX_POSITIONS}) reached — skipping ${token.symbol}`);
      return;
    }

    // Already holding this mint
    if (this.activePositions.has(token.mint)) return;

    // Already holding same symbol (different mint — dedup)
    const symbolHeld = [...this.activePositions.values()].some(
      p => p.token.symbol.toLowerCase() === token.symbol.toLowerCase()
    );
    if (symbolHeld) {
      logger.debug(`⏭ Symbol already held: ${token.symbol} — skipping duplicate`);
      return;
    }

    logger.info(`🎯 PumpFun snipe candidate: ${token.symbol} (${token.mint.slice(0, 8)}) | dev: ${token.initialBuySol} SOL | mcap: ${token.marketCapSol} SOL`);

    await logEvent('TOKEN_FOUND', `PumpFun: ${token.symbol} | dev ${token.initialBuySol} SOL | mcap ${token.marketCapSol} SOL`, {
      mint: token.mint, creator: token.creatorWallet,
      initialBuySol: token.initialBuySol, marketCapSol: token.marketCapSol,
    });

    const foundToken: FoundToken = {
      mintAddress:    token.mint,
      symbol:         token.symbol,
      name:           token.name,
      priceUsd:       token.initialPriceSol * this.solPriceUsd,
      mcapUsd:        token.marketCapSol * this.solPriceUsd,
      liquidity:      token.marketCapSol * this.solPriceUsd,
      volume24h:      0,
      pairAddress:    token.bondingCurveKey,
      dex:            'pump.fun',
      ageMinutes:     0,
      matchedKeyword: 'pump-snipe',
      url:            `https://pump.fun/coin/${token.mint}`,
    };

    if (CONFIG.PUMP_FAST_MODE) {
      // Buy immediately, security check async after
      const buyPromise = this.executeBuy(foundToken, `PumpFun snipe: ${token.name}`);
      this.asyncSecurityCheck(token.mint, token.symbol);
      await buyPromise;
    } else {
      // Security check first (with 4s timeout), then buy
      if (CONFIG.PUMP_SECURITY_CHECK) {
        const sec = await Promise.race([
          this.gmgnSwap.checkTokenSecurity(token.mint),
          this.sleep(4_000).then(() => null),
        ]);
        if (sec === null) {
          logger.warn(`Security check timeout for ${token.symbol} — buying anyway`);
        } else if (sec.isHoneypot) {
          logger.warn(`🚫 Honeypot: ${token.symbol} — skipped`);
          await logEvent('ERROR', `Honeypot detected: ${token.symbol}`, { mint: token.mint });
          return;
        } else if (sec.risks.length > 0) {
          logger.warn(`⚠️ ${token.symbol} risks: ${sec.risks.join(', ')}`);
        }
      }
      await this.executeBuy(foundToken, `PumpFun snipe: ${token.name}`);
    }

    // Subscribe to real-time price feed — also fires immediate SL/TP check
    if (this.activePositions.has(token.mint)) {
      this.pumpListener.subscribeToTrades(token.mint, (priceInSol) => {
        const pos = this.activePositions.get(token.mint);
        if (!pos || pos.isSelling) return;

        pos.currentPriceUsd = priceInSol * this.solPriceUsd;
        if (pos.entryPriceUsd <= 0) return;

        const pnl = (pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * 100;

        // Immediate TP1 check
        if (!pos.tp1Hit && CONFIG.AUTO_SELL && pnl >= CONFIG.TP1_PERCENT) {
          pos.tp1Hit = true;
          pos.isSelling = true;
          logger.info(`🎯 TP1 (realtime) +${pnl.toFixed(1)}%: ${token.symbol} — selling ${CONFIG.TP1_SELL_PERCENT}%`);
          this.executePartialSell(token.mint, pos, CONFIG.TP1_SELL_PERCENT, `TP1 +${CONFIG.TP1_PERCENT}%`)
            .finally(() => { pos.isSelling = false; pos.solSpent *= (1 - CONFIG.TP1_SELL_PERCENT / 100); });
          return;
        }

        // Immediate TP2 / full TP check
        if (CONFIG.AUTO_SELL && (
          (pos.tp1Hit && !pos.tp2Hit && pnl >= CONFIG.TP2_PERCENT) ||
          (!pos.tp1Hit && pnl >= CONFIG.TP2_PERCENT)
        )) {
          pos.tp2Hit = true;
          pos.isSelling = true;
          logger.info(`🎯 TP2 (realtime) +${pnl.toFixed(1)}%: ${token.symbol}`);
          this.executeSell(token.mint, pos, `TP2 +${CONFIG.TP2_PERCENT}%`).catch(() => {});
          return;
        }

        // Immediate SL check
        if (!pos.tp1Hit && CONFIG.AUTO_SELL && pnl <= -CONFIG.STOP_LOSS_PERCENT) {
          pos.isSelling = true;
          logger.info(`🛑 SL (realtime) ${pnl.toFixed(1)}%: ${token.symbol}`);
          this.executeSell(token.mint, pos, `SL -${CONFIG.STOP_LOSS_PERCENT}% (realtime)`).catch(() => {});
          return;
        }

        // Trailing SL after TP1
        if (pos.tp1Hit && !pos.tp2Hit && CONFIG.AUTO_SELL && pnl <= 0) {
          pos.isSelling = true;
          logger.info(`🛑 Trailing SL (realtime): ${token.symbol} ${pnl.toFixed(1)}%`);
          this.executeSell(token.mint, pos, `trailing-SL after TP1`).catch(() => {});
        }
      });
    }

    // Telegram alert
    await telegram.alertTokensFound([foundToken], `🆕 PumpFun new token: ${token.name} (${token.symbol})\nDev buy: ${token.initialBuySol} SOL | MCap: ${token.marketCapSol} SOL`);
  }

  /** Fire-and-forget security check — sell immediately if honeypot found post-buy */
  private async asyncSecurityCheck(mint: string, symbol: string): Promise<void> {
    try {
      await this.sleep(2_000); // give GMGN time to index the token
      const sec = await this.gmgnSwap.checkTokenSecurity(mint);
      if (sec.isHoneypot) {
        logger.warn(`🚫 Post-buy honeypot detected: ${symbol} — emergency sell`);
        const pos = this.activePositions.get(mint);
        if (pos) await this.executeSell(mint, pos, 'honeypot-detected');
      }
    } catch { /* ignore */ }
  }

  // ─── Tweet handler ─────────────────────────────────────────────

  private async handleNewTweet(tweet: Tweet): Promise<void> {
    this.tweetsDetected++;
    logger.info(`\n🐦 NEW TWEET #${this.tweetsDetected}: ${tweet.text.slice(0, 100)}`);

    await Promise.all([
      telegram.alertTweetDetected(tweet.text, tweet.keywords),
      logEvent('TWEET', tweet.text.slice(0, 200), { keywords: tweet.keywords }),
    ]);

    const tokens = await this.tokenFinder.findTokens(tweet.keywords);

    if (tokens.length === 0) {
      await logEvent('TOKEN_FOUND', 'No tokens found', { keywords: tweet.keywords });
      const retry = async (delaySec: number) => {
        await this.sleep(delaySec * 1_000);
        const found = await this.tokenFinder.findTokens(tweet.keywords);
        if (found.length > 0) await telegram.alertTokensFound(found, tweet.text);
      };
      retry(30);
      retry(60);
      return;
    }

    await logEvent('TOKEN_FOUND', `Found ${tokens.length} token(s): ${tokens.map(t => t.symbol).join(', ')}`, {
      tokens: tokens.map(t => ({ mint: t.mintAddress, symbol: t.symbol, mcap: t.mcapUsd })),
    });
    await telegram.alertTokensFound(tokens, tweet.text);
    broadcastState();
  }

  // ─── Buy ───────────────────────────────────────────────────────

  private async executeBuyFromTelegram(mintAddress: string, symbol: string): Promise<void> {
    const token = await this.fetchTokenInfo(mintAddress, symbol);
    await this.executeBuy(token);
  }

  private async executeSellFromDashboard(mintAddress: string): Promise<void> {
    const pos = this.activePositions.get(mintAddress);
    if (!pos) return;
    await this.executeSell(mintAddress, pos, 'manual-dashboard');
  }

  private async executeBuy(token: FoundToken, tweetText?: string): Promise<void> {
    const solAmount = CONFIG.BUY_AMOUNT_SOL;

    if (!CONFIG.PAPER_TRADING) {
      const sec = await this.gmgnSwap.checkTokenSecurity(token.mintAddress);
      if (sec.isHoneypot) {
        await logEvent('ERROR', `Honeypot detected: ${token.symbol}`, { mint: token.mintAddress });
        await telegram.alertError(`🚫 Skipped ${token.symbol}: HONEYPOT`);
        return;
      }
      if (sec.risks.length > 0) {
        await telegram.alertError(`⚠️ ${token.symbol} risks: ${sec.risks.join(', ')}\nBuying anyway...`);
      }
    }

    let result = CONFIG.GMGN_API_KEY
      ? await this.gmgnSwap.buyToken(token.mintAddress, solAmount)
      : { success: false, error: 'No GMGN key' } as any;

    if (!result.success) {
      logger.warn(`GMGN failed (${result.error}), trying Jupiter...`);
      result = await this.jupiterSwap.buyToken(token.mintAddress, solAmount);
    }

    if (!result.success) {
      await logEvent('ERROR', `Buy failed: ${token.symbol} — ${result.error}`);
      await telegram.alertError(`Buy ${token.symbol} failed: ${result.error}`);
      return;
    }

    const source = result.txSignature?.startsWith('paper') ? 'paper' :
                   CONFIG.GMGN_API_KEY ? 'gmgn' : 'jupiter';

    this.activePositions.set(token.mintAddress, {
      token,
      buyResult: result,
      entryTime: Date.now(),
      entryPriceUsd: token.priceUsd,
      currentPriceUsd: token.priceUsd,
      solSpent: solAmount,
      remainingTokens: result.outputAmount,
      tp1Hit: false,
      tp2Hit: false,
      isSelling: false,
      tweetText,
    });
    this.buysExecuted++;

    // Persist to DB
    await Promise.all([
      db.trade.create({
        data: {
          type: 'BUY', tokenMint: token.mintAddress, symbol: token.symbol,
          name: token.name, solAmount, tokenAmount: result.outputAmount,
          priceUsd: token.priceUsd, mcapUsd: token.mcapUsd,
          txSignature: result.txSignature, source,
          reason: 'tweet', tweetText: tweetText?.slice(0, 500),
          dex: token.dex,
        },
      }),
      db.position.upsert({
        where: { tokenMint: token.mintAddress },
        create: {
          tokenMint: token.mintAddress, symbol: token.symbol, name: token.name,
          entryPrice: token.priceUsd, solSpent: solAmount,
          tokenAmount: result.outputAmount, txSignature: result.txSignature,
          tweetText: tweetText?.slice(0, 500), dex: token.dex,
        },
        update: {
          entryPrice: token.priceUsd, solSpent: solAmount,
          tokenAmount: result.outputAmount, txSignature: result.txSignature,
        },
      }),
      logEvent('BUY', `Bought ${token.symbol} with ${solAmount} SOL`, {
        mint: token.mintAddress, tx: result.txSignature, source,
      }),
    ]);

    await telegram.alertBuyExecuted(token, result.txSignature, solAmount);
    broadcastState();
  }

  // ─── Sell ──────────────────────────────────────────────────────

  /** Sell a percentage of remaining tokens — does NOT close the position */
  private async executePartialSell(mint: string, position: ActivePosition, sellPercent: number, reason: string): Promise<void> {
    const tokensToSell = Math.floor(position.remainingTokens * (sellPercent / 100));
    if (tokensToSell <= 0) return;

    logger.info(`💰 PARTIAL SELL ${sellPercent}%: ${position.token.symbol} | ${tokensToSell} tokens | reason: ${reason}`);

    let result = CONFIG.GMGN_API_KEY
      ? await this.gmgnSwap.sellToken(mint, tokensToSell)
      : { success: false } as any;
    if (!result.success) result = await this.jupiterSwap.sellToken(mint, tokensToSell);
    if (!result.success) {
      logger.warn(`Partial sell failed for ${position.token.symbol}`);
      return;
    }

    const partialSolSpent = position.solSpent * (sellPercent / 100);
    const pnlPercent = position.entryPriceUsd > 0
      ? ((position.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100
      : 0;
    const pnlSol = CONFIG.PAPER_TRADING
      ? partialSolSpent * (pnlPercent / 100)
      : result.outputAmount > 0 ? (result.outputAmount / 1e9) - partialSolSpent : 0;

    position.remainingTokens -= tokensToSell;
    this.totalPnlSol += pnlSol;

    const source = result.txSignature?.startsWith('paper') ? 'paper' : CONFIG.GMGN_API_KEY ? 'gmgn' : 'jupiter';

    await Promise.all([
      db.trade.create({
        data: {
          type: 'SELL', tokenMint: mint, symbol: position.token.symbol,
          name: position.token.name, solAmount: position.solSpent * sellPercent / 100,
          tokenAmount: tokensToSell, priceUsd: position.currentPriceUsd,
          mcapUsd: position.token.mcapUsd, pnlPercent, pnlSol,
          txSignature: result.txSignature, source, reason, dex: position.token.dex,
        },
      }),
      logEvent('SELL', `Partial ${sellPercent}% ${position.token.symbol} | PnL: ${pnlPercent.toFixed(1)}%`, { mint, reason, pnlPercent, pnlSol }),
    ]);

    await telegram.alertSellExecuted(position.token.symbol, pnlPercent, reason);
    broadcastState();
  }

  private async executeSell(mint: string, position: ActivePosition, reason: string): Promise<void> {
    this.pumpListener.unsubscribeFromTrades(mint);

    let result = CONFIG.GMGN_API_KEY
      ? await this.gmgnSwap.sellToken(mint, position.remainingTokens || undefined)
      : { success: false } as any;
    if (!result.success) result = await this.jupiterSwap.sellToken(mint, position.remainingTokens || undefined);
    if (!result.success) return;

    const pnlPercent = position.entryPriceUsd > 0
      ? ((position.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100
      : 0;
    const pnlSol = CONFIG.PAPER_TRADING
      ? position.solSpent * (pnlPercent / 100)
      : result.outputAmount > 0 ? (result.outputAmount / 1e9) - position.solSpent : 0;

    this.activePositions.delete(mint);
    this.totalPnlSol += pnlSol;

    const source = result.txSignature?.startsWith('paper') ? 'paper' :
                   CONFIG.GMGN_API_KEY ? 'gmgn' : 'jupiter';

    await Promise.all([
      db.trade.create({
        data: {
          type: 'SELL', tokenMint: mint, symbol: position.token.symbol,
          name: position.token.name, solAmount: position.solSpent,
          tokenAmount: position.buyResult.outputAmount,
          priceUsd: position.currentPriceUsd, mcapUsd: position.token.mcapUsd,
          pnlPercent, pnlSol,
          txSignature: result.txSignature, source, reason,
          dex: position.token.dex,
        },
      }),
      db.position.deleteMany({ where: { tokenMint: mint } }),
      logEvent('SELL', `Sold ${position.token.symbol} — PnL: ${pnlPercent.toFixed(1)}%`, {
        mint, reason, pnlPercent, pnlSol,
      }),
    ]);

    await telegram.alertSellExecuted(position.token.symbol, pnlPercent, reason);
    broadcastState();
  }

  private async executeSellFromTelegram(mintAddress: string, symbol: string): Promise<void> {
    const pos = this.activePositions.get(mintAddress);
    if (pos) await this.executeSell(mintAddress, pos, 'manual-telegram');
  }

  private async sellAllPositions(): Promise<void> {
    if (this.activePositions.size === 0) {
      await telegram.alertError('No active positions to sell');
      return;
    }
    for (const [mint, pos] of this.activePositions) {
      await this.executeSell(mint, pos, 'manual-sell-all');
    }
  }

  // ─── Position monitor loop ─────────────────────────────────────

  private async monitorPositionsLoop(): Promise<void> {
    while (true) {
      await this.sleep(3_000);
      if (this.activePositions.size === 0) continue;

      for (const [mint, position] of this.activePositions) {
        try {
          if (position.isSelling) continue;

          const ageMs = Date.now() - position.entryTime;

          // Max hold time for pump.fun tokens
          if (
            position.token.dex === 'pump.fun' &&
            CONFIG.AUTO_SELL &&
            ageMs > CONFIG.PUMP_MAX_HOLD_MINUTES * 60_000
          ) {
            const pnl = position.entryPriceUsd > 0
              ? ((position.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd * 100).toFixed(1)
              : '?';
            logger.info(`⏰ MAX HOLD: ${position.token.symbol} ${pnl}% — selling after ${CONFIG.PUMP_MAX_HOLD_MINUTES}min`);
            await this.executeSell(mint, position, `max-hold-${CONFIG.PUMP_MAX_HOLD_MINUTES}min`);
            continue;
          }

          // Poll DexScreener for all positions.
          // For pump.fun tokens: real-time PumpPortal subscription is primary,
          // DexScreener is fallback (kicks in once the pair is indexed, ~2-5min).
          try {
            const { default: axios } = await import('axios');
            const resp = await axios.get(
              `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
              { timeout: 5_000 },
            );
            const pair = resp.data?.pairs?.[0];
            if (pair) {
              const dexPrice = parseFloat(pair.priceUsd) || 0;
              // Use DexScreener price when:
              // 1. We have no live price yet (subscription hasn't fired)
              // 2. OR DexScreener price is meaningfully different (>1%) from our live price
              if (dexPrice > 0) {
                const livePrice = position.currentPriceUsd;
                const diff = livePrice > 0 ? Math.abs(dexPrice - livePrice) / livePrice : 1;
                if (livePrice === position.entryPriceUsd || diff > 0.01) {
                  position.currentPriceUsd = dexPrice;
                }
              }
            }
          } catch { /* ignore — use live price from subscription */ }

          if (position.currentPriceUsd <= 0 || position.entryPriceUsd <= 0) continue;

          const pnlPercent = ((position.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;

          logger.info(`📈 ${position.token.symbol} | entry: $${position.entryPriceUsd.toExponential(3)} | now: $${position.currentPriceUsd.toExponential(3)} | pnl: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%`);

          if (CONFIG.AUTO_SELL && !position.isSelling) {
            // TP1: sell TP1_SELL_PERCENT% at TP1_PERCENT gain
            if (!position.tp1Hit && pnlPercent >= CONFIG.TP1_PERCENT) {
              position.tp1Hit = true;
              position.isSelling = true;
              logger.info(`🎯 TP1 +${pnlPercent.toFixed(1)}%: ${position.token.symbol} — selling ${CONFIG.TP1_SELL_PERCENT}%`);
              await this.executePartialSell(mint, position, CONFIG.TP1_SELL_PERCENT, `TP1 +${CONFIG.TP1_PERCENT}%`);
              position.solSpent = position.solSpent * (1 - CONFIG.TP1_SELL_PERCENT / 100);
              position.isSelling = false;
              continue;
            }

            // TP2: sell remaining at TP2_PERCENT gain (full close)
            if (position.tp1Hit && !position.tp2Hit && pnlPercent >= CONFIG.TP2_PERCENT) {
              position.tp2Hit = true;
              position.isSelling = true;
              logger.info(`🎯 TP2 +${pnlPercent.toFixed(1)}%: ${position.token.symbol} — closing position`);
              await this.executeSell(mint, position, `TP2 +${CONFIG.TP2_PERCENT}%`);
              continue;
            }

            // Fallback full TP (jumped directly past TP2 without hitting TP1)
            if (!position.tp1Hit && pnlPercent >= CONFIG.TP2_PERCENT) {
              position.isSelling = true;
              logger.info(`🎯 TP FULL +${pnlPercent.toFixed(1)}%: ${position.token.symbol}`);
              await this.executeSell(mint, position, `TP full +${CONFIG.TP2_PERCENT}%`);
              continue;
            }

            // Stop Loss
            if (!position.tp1Hit && pnlPercent <= -CONFIG.STOP_LOSS_PERCENT) {
              position.isSelling = true;
              logger.info(`🛑 STOP LOSS ${pnlPercent.toFixed(1)}%: ${position.token.symbol}`);
              await this.executeSell(mint, position, `SL -${CONFIG.STOP_LOSS_PERCENT}%`);
              continue;
            }

            // Trailing SL after TP1: exit if drops back to breakeven
            if (position.tp1Hit && !position.tp2Hit && pnlPercent <= 0) {
              position.isSelling = true;
              logger.info(`🛑 TRAILING SL (TP1 secured): ${position.token.symbol} ${pnlPercent.toFixed(1)}%`);
              await this.executeSell(mint, position, `trailing-SL after TP1`);
            }
          }
        } catch {
          // non-critical
        }
      }

      broadcastState();
    }
  }

  private async refreshSolBalanceLoop(): Promise<void> {
    while (true) {
      try {
        this.solBalance = await this.gmgnSwap.getSolBalance();
      } catch { /* ignore */ }
      await this.sleep(30_000);
    }
  }

  private async refreshSolPriceLoop(): Promise<void> {
    while (true) {
      try {
        const { default: axios } = await import('axios');
        const resp = await axios.get(
          'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
          { timeout: 5_000, headers: { 'User-Agent': 'elon-sniper-bot/1.0' } },
        );
        const price = resp.data?.solana?.usd;
        if (price && price > 0) {
          this.solPriceUsd = price;
          logger.info(`SOL price updated: $${price.toFixed(2)}`);
        }
      } catch {
        // keep last known price — no log spam
      }
      await this.sleep(60_000);
    }
  }

  // ─── State / status ────────────────────────────────────────────

  private getDashboardState(): BotState {
    const positions: ActivePositionInfo[] = [];

    for (const [mint, pos] of this.activePositions) {
      const pnlPercent = pos.entryPriceUsd > 0
        ? ((pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100
        : 0;
      const pnlSol = pnlPercent / 100 * pos.solSpent;

      positions.push({
        tokenMint:    mint,
        symbol:       pos.token.symbol,
        name:         pos.token.name,
        entryPrice:   pos.entryPriceUsd,
        currentPrice: pos.currentPriceUsd,
        pnlPercent,
        pnlSol,
        solSpent:     pos.solSpent,
        ageMinutes:   (Date.now() - pos.entryTime) / 60_000,
        dex:          pos.token.dex,
        tweetText:    pos.tweetText,
      });
    }

    return {
      mode:             CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE',
      running:          true,
      paused:           this.paused,
      uptime:           Date.now() - this.startTime,
      tweetsDetected:   this.tweetsDetected,
      buysExecuted:     this.buysExecuted,
      solBalance:       this.solBalance,
      activePositions:  positions,
    };
  }

  private getStatusMessage(): string {
    const upHours = ((Date.now() - this.startTime) / 3_600_000).toFixed(1);
    const lines = [
      `🤖 <b>Elon Sniper Bot</b>`,
      `Mode: <b>${CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE'}</b>`,
      `⏱ Uptime: ${upHours}h`,
      `🐦 Tweets: ${this.tweetsDetected} | 🛒 Buys: ${this.buysExecuted}`,
      `💰 SOL: ${this.solBalance.toFixed(3)} | PnL: ${this.totalPnlSol >= 0 ? '+' : ''}${this.totalPnlSol.toFixed(3)} SOL`,
      `📊 Positions: ${this.activePositions.size}`,
    ];

    if (this.activePositions.size > 0) {
      lines.push('', '<b>Active:</b>');
      for (const [, pos] of this.activePositions) {
        const pnl = pos.entryPriceUsd > 0
          ? ((pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * 100).toFixed(1)
          : '?';
        const age = ((Date.now() - pos.entryTime) / 60_000).toFixed(0);
        lines.push(`• <b>${pos.token.symbol}</b> ${pnl}% | ${age}m | ${pos.solSpent} SOL`);
      }
    }

    return lines.join('\n');
  }

  private async fetchTokenInfo(mintAddress: string, symbol: string): Promise<FoundToken> {
    const token: FoundToken = {
      mintAddress, symbol, name: symbol,
      priceUsd: 0, mcapUsd: 0, liquidity: 0, volume24h: 0,
      pairAddress: '', dex: 'unknown', ageMinutes: 0,
      matchedKeyword: '',
      url: `https://dexscreener.com/solana/${mintAddress}`,
    };
    try {
      const { default: axios } = await import('axios');
      const resp = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 5_000 });
      const pair = resp.data?.pairs?.[0];
      if (pair) {
        token.priceUsd   = parseFloat(pair.priceUsd) || 0;
        token.mcapUsd    = pair.fdv || 0;
        token.liquidity  = pair.liquidity?.usd || 0;
        token.pairAddress = pair.pairAddress || '';
        token.dex        = pair.dexId || 'unknown';
        token.url        = pair.url || token.url;
      }
    } catch { /* use defaults */ }
    return token;
  }

  private sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
}

// ─── Entry point ──────────────────────────────────────────────────

async function main() {
  const sniper = new ElonSniper();

  const shutdown = async () => {
    logger.info('Shutting down...');
    await logEvent('STOP', 'Bot stopped');
    telegram.stopPolling();
    sniper['pumpListener'].stop();
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  await sniper.start();
}

main().catch(err => {
  logger.error(`Fatal: ${err}`);
  process.exit(1);
});
