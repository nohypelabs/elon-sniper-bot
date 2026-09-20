import { Connection, PublicKey } from '@solana/web3.js';
import TelegramBot from 'node-telegram-bot-api';
import * as fs from 'fs';
import * as path from 'path';

// Wallet list lives outside the repo (data/ is gitignored) so the alpha list
// isn't published. Point WHALE_WALLETS_FILE elsewhere to override.
// Format: see data/whale-wallets.example.json — an Axiom "tracked wallets"
// export works as-is.
const WHALE_WALLETS_FILE =
  process.env.WHALE_WALLETS_FILE || path.resolve(process.cwd(), 'data/whale-wallets.json');

export interface TrackedWallet {
  address: string;
  name: string;
  emoji?: string;
  priority?: boolean;
}

/**
 * Load tracked wallets from disk. Accepts both the Axiom export shape
 * ({ trackedWalletAddress, name, emoji }) and the plain { address, name } shape.
 * If any entry is marked `priority`, only those are returned — the full list
 * stays in the file as a reference.
 */
export function loadTrackedWallets(file: string = WHALE_WALLETS_FILE): TrackedWallet[] {
  if (!fs.existsSync(file)) {
    console.warn(`⚠️  Whale wallet list not found at ${file}`);
    console.warn('   Copy data/whale-wallets.example.json and fill in your own wallets.');
    return [];
  }

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`❌ Failed to parse whale wallet list at ${file}:`, error);
    return [];
  }

  if (!Array.isArray(raw)) {
    console.error(`❌ Whale wallet list at ${file} must be a JSON array`);
    return [];
  }

  const wallets: TrackedWallet[] = raw
    .map((entry: any) => ({
      address: entry.address || entry.trackedWalletAddress || '',
      name: (entry.name || '').trim() || 'Unnamed',
      emoji: entry.emoji,
      priority: entry.priority === true,
    }))
    .filter((w: TrackedWallet) => w.address);

  const priority = wallets.filter(w => w.priority);
  return priority.length > 0 ? priority : wallets;
}

interface WhaleTrade {
  walletAddress: string;
  walletName: string;
  tokenAddress: string;
  tokenSymbol?: string;
  entryMcapSol: number;
  timestamp: number;
}

export class WhaleTracker {
  private connection: Connection;
  private bot: TelegramBot;
  private chatId: string;
  private trackedTokens: Set<string> = new Set();
  private wallets: TrackedWallet[];

  constructor(rpcUrl: string, telegramBotToken: string, telegramChatId: string, walletsFile?: string) {
    this.connection = new Connection(rpcUrl);
    this.bot = new TelegramBot(telegramBotToken, { polling: true });
    this.chatId = telegramChatId;
    this.wallets = loadTrackedWallets(walletsFile);
  }

  async start() {
    if (this.wallets.length === 0) {
      console.error('❌ Whale Tracker has no wallets to monitor — not starting');
      return;
    }

    console.log(`🐋 Whale Tracker started monitoring ${this.wallets.length} priority wallets`);
    console.log('Press Ctrl+C to stop');

    // Poll every 10 seconds for new transactions
    setInterval(() => this.pollWallets(), 10000);
  }

  private async pollWallets() {
    for (const wallet of this.wallets) {
      try {
        const trades = await this.getRecentTrades(wallet.address);
        for (const trade of trades) {
          if (!this.trackedTokens.has(trade.tokenAddress)) {
            this.trackedTokens.add(trade.tokenAddress);
            await this.sendAlert(trade);
          }
        }
      } catch (error) {
        console.error(`Error polling wallet ${wallet.name}:`, error);
      }
    }
  }

  private async getRecentTrades(walletAddress: string): Promise<WhaleTrade[]> {
    // TODO: Implement actual transaction monitoring
    // For now, this is a placeholder
    return [];
  }

  private async sendAlert(trade: WhaleTrade) {
    const message = `
🐋 <b>WHALE ALERT</b>

<b>Wallet:</b> ${trade.walletName}
<b>Token:</b> ${trade.tokenSymbol || 'Unknown'}
<b>Entry Mcap:</b> ${trade.entryMcapSol.toLocaleString()} SOL
<b>Time:</b> ${new Date(trade.timestamp).toISOString()}

Check details: https://solscan.io/account/${trade.walletAddress}
    `.trim();

    try {
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
      console.log(`✅ Alert sent for ${trade.walletName}`);
    } catch (error) {
      console.error('Error sending alert:', error);
    }
  }
}
