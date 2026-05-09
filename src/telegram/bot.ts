/**
 * Telegram Bot
 *
 * Commands:
 *   /sniper    - Show sniper status & active positions
 *   /sell      - Sell current position
 *   /config    - Show current config
 *   /help      - Show commands
 *
 * Alerts:
 *   - New Elon tweet detected with meme keywords
 *   - Token found matching keywords
 *   - Swap executed (buy/sell)
 *   - Take profit / stop loss hit
 */

import axios, { AxiosError } from 'axios';
import { spawn, ChildProcess } from 'child_process';
import { logger } from '../utils/logger';
import { CONFIG } from '../config';
import { FoundToken } from '../scanner/token.finder';

const API = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}`;
const ENABLED = !!(CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID);

// Callbacks for commands
type SellCallback = () => Promise<void>;
type StatusCallback = () => string;
type HistoryCallback = () => Promise<string>;
type PauseCallback = () => void;
type ResumeCallback = () => void;
type BalanceCallback = () => string;
type PnlCallback = () => Promise<string>;

let onSellCommand: SellCallback | null = null;
let onStatusCommand: StatusCallback | null = null;
let onHistoryCommand: HistoryCallback | null = null;
let onPauseCommand: PauseCallback | null = null;
let onResumeCommand: ResumeCallback | null = null;
let onBalanceCommand: BalanceCallback | null = null;
let onPnlCommand: PnlCallback | null = null;
let pollingOffset = 0;
let pollingActive = false;

// ─── Cloudflare Tunnel ────────────────────────────────────────────

let tunnelProcess: ChildProcess | null = null;

async function startTunnel(): Promise<string> {
  if (tunnelProcess) {
    return '⚠️ Tunnel sudah berjalan. Kirim /tunnel stop dulu.';
  }

  const dashboardPort = process.env.DASHBOARD_PORT || process.env.PORT || '3001';
  const dashboardUrl = `http://localhost:${dashboardPort}`;

  return new Promise(resolve => {
    tunnelProcess = spawn('cloudflared', ['tunnel', '--url', dashboardUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve('❌ Tunnel timeout — cloudflared tidak respond dalam 20 detik.');
      }
    }, 20_000);

    const onData = (data: Buffer) => {
      const line = data.toString();
      const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(`🌐 <b>Dashboard aktif!</b>\n\n🔗 <a href="${match[0]}">${match[0]}</a>\n\n🏠 Local: <code>${dashboardUrl}</code>\n⚠️ URL berubah kalau tunnel di-restart.`);
      }
    };

    tunnelProcess.stdout?.on('data', onData);
    tunnelProcess.stderr?.on('data', onData);

    tunnelProcess.on('exit', () => {
      tunnelProcess = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve('❌ Tunnel process keluar lebih awal.');
      }
      logger.info('Cloudflare tunnel stopped');
    });

    logger.info('Starting Cloudflare tunnel...');
  });
}

function stopTunnel(): string {
  if (!tunnelProcess) return '⚠️ Tidak ada tunnel yang berjalan.';
  tunnelProcess.kill();
  tunnelProcess = null;
  return '🛑 Tunnel dihentikan.';
}

// ─── Send helpers ─────────────────────────────────────────────────

async function send(message: string): Promise<boolean> {
  if (!ENABLED) return false;
  try {
    await axios.post(`${API}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return true;
  } catch (error) {
    logger.error(`Telegram send failed: ${(error as AxiosError).response?.status}`);
    return false;
  }
}

async function sendWithButtons(
  message: string,
  buttons: { text: string; callback_data: string }[][],
): Promise<boolean> {
  if (!ENABLED) return false;
  try {
    await axios.post(`${API}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buttons },
    });
    return true;
  } catch (error) {
    logger.error(`Telegram sendWithButtons failed`);
    return false;
  }
}

async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await axios.post(`${API}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text: text ?? '',
    });
  } catch { /* non-critical */ }
}

// ─── Alert functions ──────────────────────────────────────────────

export async function alertTweetDetected(text: string, keywords: string[], author?: string, authorLabel?: string): Promise<void> {
  const who = authorLabel ? `${authorLabel} (@${author})` : 'Elon Musk (@elonmusk)';
  const msg = [
    `🐦 <b>TWEET DETECTED!</b>`,
    `👤 <b>${escapeHtml(who)}</b>`,
    '',
    `📝 ${escapeHtml(text.slice(0, 500))}`,
    '',
    `🔑 <b>Keywords:</b> ${keywords.map(k => `<code>${k}</code>`).join(', ')}`,
    '',
    `🔍 Searching for matching tokens...`,
  ].join('\n');

  await send(msg);
}

export async function alertTokensFound(tokens: FoundToken[], tweetText: string): Promise<void> {
  if (tokens.length === 0) {
    await send(`😕 No tokens found under $${CONFIG.MAX_MCAP_USD} mcap matching tweet keywords.`);
    return;
  }

  const lines: string[] = [
    `🎯 <b>${tokens.length} TOKEN(S) FOUND!</b>`,
    '',
  ];

  const buttons: { text: string; callback_data: string }[][] = [];

  tokens.slice(0, 5).forEach((t, i) => {
    const ageStr = t.ageMinutes < 60
      ? `${t.ageMinutes.toFixed(0)}m`
      : `${(t.ageMinutes / 60).toFixed(1)}h`;

    lines.push(
      `${i === 0 ? '⭐' : `${i + 1}.`} <b>${t.symbol}</b> — ${t.name}`,
      `   💰 MCap: $${formatNum(t.mcapUsd)}`,
      `   💧 Liq: $${formatNum(t.liquidity)}`,
      `   📊 Vol: $${formatNum(t.volume24h)}`,
      `   📅 Age: ${ageStr}`,
      `   🔗 ${t.dex} | Keyword: <code>${t.matchedKeyword}</code>`,
      `   <a href="${t.url}">View Chart</a>`,
      '',
    );

    buttons.push([{
      text: `${i === 0 ? '⭐ ' : ''}BUY ${t.symbol} (${CONFIG.BUY_AMOUNT_SOL} SOL)`,
      callback_data: `buy:${t.mintAddress}:${t.symbol}`,
    }]);
  });

  if (tokens.length > 0) {
    lines.push(
      `💡 <b>Lowest mcap: ${tokens[0].symbol} ($${formatNum(tokens[0].mcapUsd)})</b>`,
      `⚠️ Buy amount: ${CONFIG.BUY_AMOUNT_SOL} SOL | Mode: ${CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE'}`,
    );
  }

  buttons.push([{ text: '❌ Skip All', callback_data: 'buy:skip' }]);

  await sendWithButtons(lines.join('\n'), buttons);
}

export async function alertBuyExecuted(
  token: FoundToken,
  txSig: string,
  solSpent: number,
): Promise<void> {
  const mode = CONFIG.PAPER_TRADING ? '📝 PAPER' : '🟢 LIVE';
  const msg = [
    `${mode} <b>BUY EXECUTED!</b>`,
    '',
    `🪙 <b>${token.symbol}</b> (${token.name})`,
    `💰 Spent: ${solSpent} SOL`,
    `📊 MCap at entry: $${formatNum(token.mcapUsd)}`,
    `🎯 Take Profit: +${CONFIG.TAKE_PROFIT_PERCENT}%`,
    `🛑 Stop Loss: -${CONFIG.STOP_LOSS_PERCENT}%`,
    '',
    `🔗 TX: <code>${txSig.slice(0, 20)}...</code>`,
    `📈 <a href="${token.url}">View Chart</a>`,
  ].join('\n');

  await sendWithButtons(msg, [
    [{ text: `💰 SELL ${token.symbol} NOW`, callback_data: `sell:${token.mintAddress}:${token.symbol}` }],
  ]);
}

export async function alertSellExecuted(
  symbol: string,
  pnlPercent: number,
  reason: string,
  pnlSol?: number,
  solPriceUsd?: number,
): Promise<void> {
  const emoji = pnlPercent >= 0 ? '🟢' : '🔴';
  const sign  = pnlPercent >= 0 ? '+' : '';

  const lines = [
    `${emoji} <b>SOLD ${symbol}</b>`,
    '',
    `📈 PnL: ${sign}${pnlPercent.toFixed(1)}%`,
  ];

  if (pnlSol !== undefined && pnlSol !== 0) {
    const solSign = pnlSol >= 0 ? '+' : '';
    lines.push(`💰 SOL: ${solSign}${pnlSol.toFixed(4)} SOL`);
    if (solPriceUsd && solPriceUsd > 0) {
      const usd = pnlSol * solPriceUsd;
      const usdSign = usd >= 0 ? '+' : '';
      lines.push(`💵 USD: ${usdSign}$${Math.abs(usd).toFixed(2)}`);
    }
  }

  lines.push(`📋 Reason: ${reason}`);
  await send(lines.join('\n'));
}

export async function alertError(message: string): Promise<void> {
  await send(`❌ <b>Error:</b> ${escapeHtml(message)}`);
}

// ─── Command handlers ──────────────────────────────────────────────

type BuyCallback = (mintAddress: string, symbol: string) => Promise<void>;
type SellByMintCallback = (mintAddress: string, symbol: string) => Promise<void>;

let onBuySelected: BuyCallback | null = null;
let onSellSelected: SellByMintCallback | null = null;

export function registerHandlers(handlers: {
  getStatus: StatusCallback;
  onSell: SellCallback;
  onBuySelected: BuyCallback;
  onSellSelected: SellByMintCallback;
  getHistory: HistoryCallback;
  onPause: PauseCallback;
  onResume: ResumeCallback;
  getBalance: BalanceCallback;
  getPnl: PnlCallback;
}): void {
  onStatusCommand  = handlers.getStatus;
  onSellCommand    = handlers.onSell;
  onBuySelected    = handlers.onBuySelected;
  onSellSelected   = handlers.onSellSelected;
  onHistoryCommand = handlers.getHistory;
  onPauseCommand   = handlers.onPause;
  onResumeCommand  = handlers.onResume;
  onBalanceCommand = handlers.getBalance;
  onPnlCommand     = handlers.getPnl;
}

export function startPolling(): void {
  if (!ENABLED || pollingActive) return;
  pollingActive = true;
  logger.info('Telegram command polling started');
  pollLoop();
}

export function stopPolling(): void {
  pollingActive = false;
}

async function pollLoop(): Promise<void> {
  while (pollingActive) {
    try {
      const resp = await axios.get(`${API}/getUpdates`, {
        params: {
          offset: pollingOffset,
          timeout: 30,
          allowed_updates: JSON.stringify(['message', 'callback_query']),
        },
        timeout: 35_000,
      });

      for (const update of resp.data?.result ?? []) {
        pollingOffset = update.update_id + 1;

        if (update.callback_query) {
          const cbChatId = String(update.callback_query.message?.chat?.id ?? '');
          if (cbChatId !== CONFIG.TELEGRAM_CHAT_ID) continue;
          await handleCallback(update.callback_query);
          continue;
        }

        const text: string = update.message?.text ?? '';
        const chatId = String(update.message?.chat?.id ?? '');
        if (chatId !== CONFIG.TELEGRAM_CHAT_ID) continue;

        if (text === '/sniper' || text === '/status') {
          if (onStatusCommand) await send(onStatusCommand());
        } else if (text === '/sell') {
          if (onSellCommand) await onSellCommand();
        } else if (text === '/history') {
          if (onHistoryCommand) await send(await onHistoryCommand());
        } else if (text === '/pause' || text === '/stop') {
          if (onPauseCommand) {
            onPauseCommand();
            await send('⏸ <b>Bot dijeda.</b> Tidak akan buka posisi baru.\nKirim /resume untuk lanjutkan.');
          }
        } else if (text === '/resume' || text === '/start_bot') {
          if (onResumeCommand) {
            onResumeCommand();
            await send('▶️ <b>Bot dilanjutkan.</b> Siap snipe token baru!');
          }
        } else if (text === '/saldo' || text === '/balance') {
          if (onBalanceCommand) await send(onBalanceCommand());
        } else if (text === '/pnl') {
          if (onPnlCommand) await send(await onPnlCommand());
        } else if (text === '/tunnel') {
          await send('⏳ Starting tunnel...');
          await send(await startTunnel());
        } else if (text === '/tunnel stop') {
          await send(stopTunnel());
        } else if (text === '/config') {
          await send([
            `⚙️ <b>Sniper Config</b>`,
            '',
            `💰 Buy Amount: ${CONFIG.BUY_AMOUNT_SOL} SOL`,
            `📊 Max MCap: $${formatNum(CONFIG.MAX_MCAP_USD)}`,
            `🎯 Take Profit: +${CONFIG.TAKE_PROFIT_PERCENT}%`,
            `🛑 Stop Loss: -${CONFIG.STOP_LOSS_PERCENT}%`,
            `📉 Slippage: ${CONFIG.MAX_SLIPPAGE_BPS / 100}%`,
            `🤖 Auto Sell: ${CONFIG.AUTO_SELL ? 'ON' : 'OFF'}`,
            `📝 Mode: ${CONFIG.PAPER_TRADING ? 'PAPER' : 'LIVE'}`,
            `⏱ Poll Interval: ${CONFIG.TWEET_POLL_INTERVAL_MS / 1000}s`,
          ].join('\n'));
        } else if (text === '/help') {
          await send([
            `🤖 <b>Elon Sniper Bot</b>`,
            '',
            `/sniper - Status & posisi aktif`,
            `/saldo - Cek saldo SOL`,
            `/pnl - Statistik profit/loss`,
            `/history - 10 trade terakhir`,
            `/sell - Jual semua posisi`,
            `/pause - Jeda bot (stop buka posisi baru)`,
            `/resume - Lanjutkan bot`,
            `/tunnel - Start dashboard tunnel`,
            `/tunnel stop - Stop tunnel`,
            `/config - Konfigurasi`,
            `/help - Pesan ini`,
          ].join('\n'));
        }
      }
    } catch {
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function handleCallback(cbQuery: any): Promise<void> {
  const data: string = cbQuery.data ?? '';
  const cbId: string = cbQuery.id;

  if (data.startsWith('buy:')) {
    const parts = data.split(':');
    if (parts[1] === 'skip') {
      await answerCb(cbId, 'Skipped');
      return;
    }
    await answerCb(cbId, `Buying ${parts[2] || ''}...`);
    if (onBuySelected) await onBuySelected(parts[1], parts[2] || '');
    return;
  }

  if (data.startsWith('sell:')) {
    const parts = data.split(':');
    await answerCb(cbId, `Selling ${parts[2] || ''}...`);
    if (onSellSelected) await onSellSelected(parts[1], parts[2] || '');
    return;
  }

  await answerCb(cbId);
}

async function answerCb(id: string, text?: string): Promise<void> {
  try {
    await axios.post(`${API}/answerCallbackQuery`, { callback_query_id: id, text: text ?? '' });
  } catch { /* non-critical */ }
}

// ─── Utilities ────────────────────────────────────────────────────

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
