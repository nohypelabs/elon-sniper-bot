/**
 * Jupiter Swap Executor
 *
 * Fast SOL → Token swap via Jupiter Aggregator V6.
 * Also handles Token → SOL for take-profit/stop-loss sells.
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import axios from 'axios';
import { logger } from '../utils/logger';
import { CONFIG, SOL_MINT } from '../config';

const JUPITER_API = 'https://quote-api.jup.ag/v6';

export interface SwapResult {
  success: boolean;
  txSignature: string;
  inputAmount: number;
  outputAmount: number;
  pricePerToken: number;
  error?: string;
}

export class JupiterSwap {
  private connection: Connection;
  private wallet: Keypair | null = null;

  constructor(connection: Connection) {
    this.connection = connection;

    if (CONFIG.WALLET_PRIVATE_KEY && !CONFIG.PAPER_TRADING) {
      try {
        this.wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.WALLET_PRIVATE_KEY));
        logger.info(`Swap wallet loaded: ${this.wallet.publicKey.toBase58()}`);
      } catch {
        logger.error('Invalid wallet private key for swaps');
      }
    }
  }

  /**
   * Buy token with SOL (SOL → Token)
   */
  async buyToken(tokenMint: string, solAmount: number): Promise<SwapResult> {
    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
    logger.info(`🛒 Buying ${tokenMint.slice(0, 8)}... with ${solAmount} SOL`);

    if (CONFIG.PAPER_TRADING) {
      return this.paperBuy(tokenMint, solAmount);
    }

    return this.executeSwap(SOL_MINT, tokenMint, lamports);
  }

  /**
   * Sell token for SOL (Token → SOL)
   */
  async sellToken(tokenMint: string, tokenAmount?: number): Promise<SwapResult> {
    logger.info(`💰 Selling ${tokenMint.slice(0, 8)}...${tokenAmount ? ` (${tokenAmount} tokens)` : ' (all)'}`);

    if (CONFIG.PAPER_TRADING) {
      return this.paperSell(tokenMint);
    }

    // If no amount specified, sell all
    if (!tokenAmount) {
      tokenAmount = await this.getTokenBalance(tokenMint);
      if (tokenAmount <= 0) {
        return { success: false, txSignature: '', inputAmount: 0, outputAmount: 0, pricePerToken: 0, error: 'No tokens to sell' };
      }
    }

    // Get token decimals
    const decimals = await this.getTokenDecimals(tokenMint);
    const rawAmount = Math.floor(tokenAmount * (10 ** decimals));

    return this.executeSwap(tokenMint, SOL_MINT, rawAmount);
  }

  /**
   * Execute a swap via Jupiter
   */
  private async executeSwap(
    inputMint: string,
    outputMint: string,
    amount: number,
  ): Promise<SwapResult> {
    if (!this.wallet) {
      return { success: false, txSignature: '', inputAmount: 0, outputAmount: 0, pricePerToken: 0, error: 'No wallet configured' };
    }

    try {
      // Step 1: Get quote
      const quoteResp = await axios.get(`${JUPITER_API}/quote`, {
        params: {
          inputMint,
          outputMint,
          amount: amount.toString(),
          slippageBps: CONFIG.MAX_SLIPPAGE_BPS,
          onlyDirectRoutes: false,
        },
        timeout: 10_000,
      });

      const quote = quoteResp.data;
      if (!quote || !quote.outAmount) {
        return { success: false, txSignature: '', inputAmount: 0, outputAmount: 0, pricePerToken: 0, error: 'No route found' };
      }

      logger.info(`Jupiter quote: ${quote.inAmount} → ${quote.outAmount} (impact: ${quote.priceImpactPct}%)`);

      // Step 2: Get swap transaction
      const swapResp = await axios.post(`${JUPITER_API}/swap`, {
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }, { timeout: 15_000 });

      const { swapTransaction } = swapResp.data;
      if (!swapTransaction) {
        return { success: false, txSignature: '', inputAmount: 0, outputAmount: 0, pricePerToken: 0, error: 'Failed to build swap tx' };
      }

      // Step 3: Sign and send
      const txBuf = Buffer.from(swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([this.wallet]);

      const signature = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true, // Speed over safety
        maxRetries: 3,
      });

      logger.info(`⚡ Swap TX sent: ${signature}`);

      // Step 4: Confirm
      const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
      if (confirmation.value.err) {
        return {
          success: false,
          txSignature: signature,
          inputAmount: parseFloat(quote.inAmount),
          outputAmount: 0,
          pricePerToken: 0,
          error: `TX failed: ${JSON.stringify(confirmation.value.err)}`,
        };
      }

      const inAmt = parseFloat(quote.inAmount);
      const outAmt = parseFloat(quote.outAmount);
      const isBuy = inputMint === SOL_MINT;
      const pricePerToken = isBuy ? (inAmt / LAMPORTS_PER_SOL) / outAmt : outAmt / LAMPORTS_PER_SOL / inAmt;

      return {
        success: true,
        txSignature: signature,
        inputAmount: inAmt,
        outputAmount: outAmt,
        pricePerToken,
      };
    } catch (error) {
      const msg = (error as Error).message;
      logger.error(`Swap failed: ${msg}`);
      return { success: false, txSignature: '', inputAmount: 0, outputAmount: 0, pricePerToken: 0, error: msg };
    }
  }

  /**
   * Get token balance for the wallet
   */
  async getTokenBalance(mintAddress: string): Promise<number> {
    if (!this.wallet) return 0;
    try {
      const ata = await getAssociatedTokenAddress(
        new PublicKey(mintAddress),
        this.wallet.publicKey,
      );
      const account = await getAccount(this.connection, ata);
      const decimals = await this.getTokenDecimals(mintAddress);
      return Number(account.amount) / (10 ** decimals);
    } catch {
      return 0;
    }
  }

  /**
   * Get SOL balance
   */
  async getSolBalance(): Promise<number> {
    if (!this.wallet) return 0;
    try {
      const balance = await this.connection.getBalance(this.wallet.publicKey);
      return balance / LAMPORTS_PER_SOL;
    } catch {
      return 0;
    }
  }

  private async getTokenDecimals(mintAddress: string): Promise<number> {
    try {
      const info = await this.connection.getParsedAccountInfo(new PublicKey(mintAddress));
      const data = info.value?.data;
      if (data && 'parsed' in data) {
        return data.parsed?.info?.decimals ?? 9;
      }
      return 9;
    } catch {
      return 9;
    }
  }

  // ─── Paper Trading ──────────────────────────────────────────────

  private paperBuy(tokenMint: string, solAmount: number): SwapResult {
    // Simulate a buy with a rough price estimate
    const fakePrice = 0.000001; // Very low price for new memecoin
    const tokensReceived = solAmount * 150 / fakePrice; // SOL price ~$150

    logger.info(`[PAPER] Bought ~${tokensReceived.toExponential(2)} tokens for ${solAmount} SOL`);

    return {
      success: true,
      txSignature: `paper_buy_${Date.now()}`,
      inputAmount: solAmount * LAMPORTS_PER_SOL,
      outputAmount: tokensReceived,
      pricePerToken: fakePrice,
    };
  }

  private paperSell(tokenMint: string): SwapResult {
    logger.info(`[PAPER] Sold all ${tokenMint.slice(0, 8)}...`);
    return {
      success: true,
      txSignature: `paper_sell_${Date.now()}`,
      inputAmount: 0,
      outputAmount: 0,
      pricePerToken: 0,
    };
  }
}
