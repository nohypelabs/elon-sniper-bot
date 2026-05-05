/**
 * GMGN Swap Executor
 *
 * Replaces Jupiter for faster execution with Anti-MEV (JITO) support.
 * Flow: get_swap_route → sign locally → send_transaction → poll status
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

const GMGN_BASE   = 'https://gmgn.ai/defi/router/v1/sol';
const GMGN_PROXY  = 'https://gmgn.ai/txproxy/v1';

export interface SwapResult {
  success: boolean;
  txSignature: string;
  inputAmount: number;
  outputAmount: number;
  pricePerToken: number;
  error?: string;
}

export interface TokenSecurity {
  isSafe: boolean;
  isHoneypot: boolean;
  isMintable: boolean;
  isFreezable: boolean;
  top10HolderPercent: number;
  creatorPercent: number;
  risks: string[];
}

export class GmgnSwap {
  private connection: Connection;
  private wallet: Keypair | null = null;

  constructor(connection: Connection) {
    this.connection = connection;

    if (CONFIG.WALLET_PRIVATE_KEY) {
      try {
        this.wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.WALLET_PRIVATE_KEY));
        logger.info(`GMGN wallet loaded: ${this.wallet.publicKey.toBase58()}${CONFIG.PAPER_TRADING ? ' (paper — balance only)' : ''}`);
      } catch {
        logger.error('Invalid wallet private key');
      }
    }
  }

  getWalletAddress(): string | null {
    return this.wallet?.publicKey.toBase58() ?? null;
  }

  reloadWallet(privateKey: string): void {
    if (!privateKey) {
      this.wallet = null;
      logger.info('Wallet disconnected');
      return;
    }
    try {
      this.wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
      logger.info(`Wallet loaded: ${this.wallet.publicKey.toBase58()}`);
    } catch {
      logger.error('reloadWallet: invalid private key');
    }
  }

  /**
   * Buy token with SOL
   */
  async buyToken(tokenMint: string, solAmount: number): Promise<SwapResult> {
    logger.info(`🛒 [GMGN] Buying ${tokenMint.slice(0, 8)}... with ${solAmount} SOL`);

    if (CONFIG.PAPER_TRADING) return this.paperBuy(tokenMint, solAmount);

    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
    return this.executeSwap(SOL_MINT, tokenMint, lamports);
  }

  /**
   * Sell token for SOL
   */
  async sellToken(tokenMint: string, tokenAmount?: number): Promise<SwapResult> {
    logger.info(`💰 [GMGN] Selling ${tokenMint.slice(0, 8)}...`);

    if (CONFIG.PAPER_TRADING) return this.paperSell(tokenMint);

    if (!tokenAmount) {
      tokenAmount = await this.getTokenBalance(tokenMint);
      if (tokenAmount <= 0) {
        return { success: false, txSignature: '', inputAmount: 0, outputAmount: 0, pricePerToken: 0, error: 'No tokens to sell' };
      }
    }

    const decimals = await this.getTokenDecimals(tokenMint);
    const rawAmount = Math.floor(tokenAmount * (10 ** decimals));
    return this.executeSwap(tokenMint, SOL_MINT, rawAmount);
  }

  /**
   * Check token security before buying — honeypot / rug detection
   */
  async checkTokenSecurity(tokenMint: string): Promise<TokenSecurity> {
    try {
      const resp = await axios.get(`${GMGN_BASE}/token_security/${tokenMint}`, {
        headers: { 'x-route-key': CONFIG.GMGN_API_KEY },
        timeout: 8_000,
      });

      const d = resp.data?.data ?? {};
      const risks: string[] = [];

      if (d.is_honeypot)           risks.push('HONEYPOT');
      if (d.renounced === false)    risks.push('NOT_RENOUNCED');
      if (d.is_mintable)           risks.push('MINTABLE');
      if (d.is_freeze_authority)   risks.push('FREEZABLE');
      if ((d.top_10_holder_rate ?? 0) > 0.8) risks.push(`TOP10_HOLD_${Math.round((d.top_10_holder_rate ?? 0) * 100)}%`);
      if ((d.creator_percentage ?? 0) > 0.1) risks.push(`CREATOR_${Math.round((d.creator_percentage ?? 0) * 100)}%`);

      return {
        isSafe:             risks.length === 0,
        isHoneypot:         !!d.is_honeypot,
        isMintable:         !!d.is_mintable,
        isFreezable:        !!d.is_freeze_authority,
        top10HolderPercent: d.top_10_holder_rate ?? 0,
        creatorPercent:     d.creator_percentage ?? 0,
        risks,
      };
    } catch (err) {
      logger.debug(`Security check failed for ${tokenMint}: ${(err as Error).message}`);
      // Fail open — don't block buy if check is unavailable
      return { isSafe: true, isHoneypot: false, isMintable: false, isFreezable: false, top10HolderPercent: 0, creatorPercent: 0, risks: [] };
    }
  }

  // ─── Core Swap ───────────────────────────────────────────────────

  private async executeSwap(
    tokenIn: string,
    tokenOut: string,
    amount: number,
    priorityFeeSol?: number,
  ): Promise<SwapResult> {
    if (!this.wallet) {
      return { success: false, txSignature: '', inputAmount: 0, outputAmount: 0, pricePerToken: 0, error: 'No wallet configured' };
    }

    try {
      // Step 1: Get swap route
      const slippagePct = CONFIG.MAX_SLIPPAGE_BPS / 100; // BPS → percent
      const isBuySwap   = tokenIn === SOL_MINT;
      const fee         = priorityFeeSol ?? (isBuySwap ? CONFIG.PRIORITY_FEE_BUY_SOL : CONFIG.PRIORITY_FEE_SELL_SOL);
      const routeResp = await axios.get(`${GMGN_BASE}/tx/get_swap_route`, {
        params: {
          token_in_address:  tokenIn,
          token_out_address: tokenOut,
          in_amount:         amount.toString(),
          from_address:      this.wallet.publicKey.toBase58(),
          slippage:          slippagePct,
          swap_mode:         'ExactIn',
          fee,
          max_fee:           CONFIG.MAX_FEE_SOL,
          is_anti_mev:       CONFIG.ANTI_MEV,
        },
        headers: { 'x-route-key': CONFIG.GMGN_API_KEY },
        timeout: 10_000,
      });

      const route = routeResp.data?.data;
      if (!route?.raw_tx?.swapTransaction) {
        return { success: false, txSignature: '', inputAmount: 0, outputAmount: 0, pricePerToken: 0, error: 'No route found' };
      }

      logger.info(`[GMGN] Route found — impact: ${route.quote?.priceImpactPct ?? '?'}%`);

      // Step 2: Decode, sign, encode
      const txBuf = Buffer.from(route.raw_tx.swapTransaction, 'base64');
      const tx    = VersionedTransaction.deserialize(txBuf);
      tx.sign([this.wallet]);
      const signedBase64 = Buffer.from(tx.serialize()).toString('base64');

      // Step 3: Submit
      const sendResp = await axios.post(
        `${GMGN_PROXY}/send_transaction`,
        { chain: 'sol', signedTx: signedBase64, isAntiMev: CONFIG.ANTI_MEV },
        { headers: { 'x-route-key': CONFIG.GMGN_API_KEY, 'Content-Type': 'application/json' }, timeout: 15_000 },
      );

      const signature = sendResp.data?.data?.hash || sendResp.data?.hash;
      if (!signature) {
        return { success: false, txSignature: '', inputAmount: 0, outputAmount: 0, pricePerToken: 0, error: 'No tx hash returned' };
      }

      logger.info(`⚡ [GMGN] TX sent: ${signature}`);

      // Step 4: Poll status
      const confirmed = await this.pollStatus(signature);
      if (!confirmed) {
        return { success: false, txSignature: signature, inputAmount: 0, outputAmount: 0, pricePerToken: 0, error: 'TX not confirmed in time' };
      }

      const inAmt  = amount;
      const outAmt = parseFloat(route.quote?.outAmount ?? '0');
      const isBuy  = tokenIn === SOL_MINT;
      const pricePerToken = isBuy
        ? (inAmt / LAMPORTS_PER_SOL) / outAmt
        : (outAmt / LAMPORTS_PER_SOL) / inAmt;

      return { success: true, txSignature: signature, inputAmount: inAmt, outputAmount: outAmt, pricePerToken };

    } catch (error) {
      const msg = (error as Error).message;
      logger.error(`[GMGN] Swap failed: ${msg}`);
      return { success: false, txSignature: '', inputAmount: 0, outputAmount: 0, pricePerToken: 0, error: msg };
    }
  }

  /**
   * Poll GMGN for tx confirmation (max 30s)
   */
  private async pollStatus(signature: string, maxAttempts = 15): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 2_000));
      try {
        const resp = await axios.get(`${GMGN_BASE}/tx/get_transaction_status`, {
          params: { hash: signature, last_valid_height: 0 },
          headers: { 'x-route-key': CONFIG.GMGN_API_KEY },
          timeout: 5_000,
        });
        const status = resp.data?.data?.status;
        if (status === 'success') return true;
        if (status === 'failed')  return false;
      } catch {
        // keep polling
      }
    }
    return false;
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  async getTokenBalance(mintAddress: string): Promise<number> {
    if (!this.wallet) return 0;
    try {
      const ata = await getAssociatedTokenAddress(new PublicKey(mintAddress), this.wallet.publicKey);
      const account = await getAccount(this.connection, ata);
      const decimals = await this.getTokenDecimals(mintAddress);
      return Number(account.amount) / (10 ** decimals);
    } catch {
      return 0;
    }
  }

  async getSolBalance(): Promise<number> {
    if (!this.wallet) return 0;
    try {
      return (await this.connection.getBalance(this.wallet.publicKey)) / LAMPORTS_PER_SOL;
    } catch {
      return 0;
    }
  }

  private async getTokenDecimals(mintAddress: string): Promise<number> {
    try {
      const info = await this.connection.getParsedAccountInfo(new PublicKey(mintAddress));
      const data = info.value?.data;
      if (data && 'parsed' in data) return data.parsed?.info?.decimals ?? 9;
      return 9;
    } catch {
      return 9;
    }
  }

  // ─── Paper Trading ───────────────────────────────────────────────

  private paperBuy(tokenMint: string, solAmount: number): SwapResult {
    const fakePrice     = 0.000001;
    const tokensReceived = solAmount * 150 / fakePrice;
    logger.info(`[PAPER/GMGN] Bought ~${tokensReceived.toExponential(2)} tokens for ${solAmount} SOL`);
    return { success: true, txSignature: `paper_gmgn_buy_${Date.now()}`, inputAmount: solAmount * LAMPORTS_PER_SOL, outputAmount: tokensReceived, pricePerToken: fakePrice };
  }

  private paperSell(tokenMint: string): SwapResult {
    logger.info(`[PAPER/GMGN] Sold all ${tokenMint.slice(0, 8)}...`);
    return { success: true, txSignature: `paper_gmgn_sell_${Date.now()}`, inputAmount: 0, outputAmount: 0, pricePerToken: 0 };
  }
}
