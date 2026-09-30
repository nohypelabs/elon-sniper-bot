/**
 * Telegram Bot
 *
 * Commands:
 *   /sniper    - Show sniper status & active positions
 *   /sell      - Sell current position
 *   /config    - Settings menu (tap buttons, type the number)
 *   /config text - Show current config (plain-text summary)
 *   /set       - Change config at runtime (persists to .env)
 *   /preset    - Apply a config preset (e.g. lowrisk)
 *   Buy approval: BUY_APPROVAL_ENABLED=true asks Approve/Reject before each snipe
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
import { tryApplyConfig } from '../config/editable';
import { liveModeBlocked } from '../config/live-guard';
import { safeLink, safeText } from './safe-html';
import {
  escapeHtml,
  handlePresetCommand,
  handleSetCommand,
  renderConfig,
} from './config-commands';
import { FoundToken } from '../scanner/token.finder';
import { ApprovalGate } from './approval-gate';
import { classifyUpdate } from './update-router';
import { createMenuController } from './menu-controller';
import { MenuSessions, type Screen } from './config-menu';

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
type LatencyCallback = () => Promise<string>;
type SetModeCallback = (paper: boolean) => Promise<void>;

let onSellCommand: SellCallback | null = null;
let onStatusCommand: StatusCallback | null = null;
let onHistoryCommand: HistoryCallback | null = null;
let onPauseCommand: PauseCallback | null = null;
let onResumeCommand: ResumeCallback | null = null;
let onBalanceCommand: BalanceCallback | null = null;
let onPnlCommand: PnlCallback | null = null;
let onLatencyCommand: LatencyCallback | null = null;
let onSetModeCommand: SetModeCallback | null = null;
let pollingOffset = 0;
let pollingActive = false;

// ─── Cloudflare Tunnel ────────────────────────────────────────────

let tunnelProcess: ChildProcess | null = null;

async function startTunnel(): Promise<string> {
  if (tunnelProcess) {
    return '⚠️ Tunnel sudah berjalan. Kirim /tunnel stop dulu.';
  }

  if (!CONFIG.DASHBOARD_PASSWORD) {
    return '🔒 Tunnel ditolak: <code>DASHBOARD_PASSWORD</code> belum diset di .env. Dashboard bisa ganti wallet dan config, jadi jangan dibuka ke internet tanpa password.';
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
): Promise<number | null> {
  if (!ENABLED) return null;
  try {
    const resp = await axios.post(`${API}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buttons },
    });
    const messageId = resp.data?.result?.message_id;
    return typeof messageId === 'number' ? messageId : null;
  } catch (error) {
    logger.error(`Telegram sendWithButtons failed`);
    return null;
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

// ─── Settings menu (Stage 12B) ────────────────────────────────────
// Pure menu core lives in config-menu.ts; update-router.ts classifies
// updates and menu-controller.ts owns the menu flows. bot.ts only injects
// the real Telegram I/O below.

const menuSessions = new MenuSessions();

type MenuController = ReturnType<typeof createMenuController>;
let menuController: MenuController | null = null;

function getMenuController(): MenuController {
  if (!menuController) {
    menuController = createMenuController({
      chatId: CONFIG.TELEGRAM_CHAT_ID,
      getConfig: () => CONFIG as unknown as Record<string, unknown>,
      apply: tryApplyConfig,
      sessions: menuSessions,
      liveAllowed: () => CONFIG.LIVE_TRADING_ALLOWED === true,
      sendScreen: (screen: Screen) => sendWithButtons(screen.text, screen.keyboard),
      editScreen: (messageId: number, screen: Screen) => editScreen(messageId, screen),
      sendText: async (html: string) => { await send(html); },
      answer: (id: string, text?: string, alert?: boolean) => answerCb(id, text, alert),
      log: (msg: string) => logger.warn(msg),
    });
  }
  return menuController;
}

/**
 * Edit the menu message in place. Never throws; maps Telegram's edit
 * errors: identical content => 'unchanged', dead message => 'gone'
 * (the controller then sends a fresh message), anything else => log a
 * warning and report 'unchanged'.
 */
async function editScreen(messageId: number, screen: Screen): Promise<'edited' | 'unchanged' | 'gone'> {
  if (!ENABLED) return 'unchanged';
  try {
    await axios.post(`${API}/editMessageText`, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      message_id: messageId,
      text: screen.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: screen.keyboard },
    });
    return 'edited';
  } catch (error) {
    const resp = (error as AxiosError)?.response;
    const data = resp?.data as { description?: unknown } | undefined;
    const desc = typeof data?.description === 'string' ? data.description : '';
    if (resp?.status === 400 && desc.includes('message is not modified')) return 'unchanged';
    if (resp?.status === 400 && (desc.includes('message to edit not found') || desc.includes("can't be edited"))) {
      return 'gone';
    }
    logger.warn(`Telegram editMessageText failed: ${resp?.status ?? 'network'}`);
    return 'unchanged';
  }
}

// ─── Alert functions ──────────────────────────────────────────────

export async function alertTweetDetected(text: string, keywords: string[], author?: string, authorLabel?: string): Promise<void> {
  // ── Stage 9b-A: author/label/text/keywords are tweet-controlled -> escape.
  const who = authorLabel ? `${safeText(authorLabel)} (@${safeText(author ?? '')})` : 'Elon Musk (@elonmusk)';
  const msg = [
    `🐦 <b>TWEET DETECTED!</b>`,
    `👤 <b>${who}</b>`,
    '',
    `📝 ${safeText(text.slice(0, 500))}`,
    '',
    `🔑 <b>Keywords:</b> ${keywords.map(k => `<code>${safeText(k)}</code>`).join(', ')}`,
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

    // ── Stage 9b-A: symbol/name/dex/keyword/url are token-controlled.
    lines.push(
      `${i === 0 ? '⭐' : `${i + 1}.`} <b>${safeText(t.symbol)}</b> — ${safeText(t.name)}`,
      `   💰 MCap: $${formatNum(t.mcapUsd)}`,
      `   💧 Liq: $${formatNum(t.liquidity)}`,
      `   📊 Vol: $${formatNum(t.volume24h)}`,
      `   📅 Age: ${ageStr}`,
      `   🔗 ${safeText(t.dex)} | Keyword: <code>${safeText(t.matchedKeyword)}</code>`,
      `   ${safeLink(t.url, 'View Chart')}`,
      '',
    );

    buttons.push([{
      text: `${i === 0 ? '⭐ ' : ''}BUY ${t.symbol} (${CONFIG.BUY_AMOUNT_SOL} SOL)`,
      callback_data: `buy:${t.mintAddress}:${t.symbol}`,
    }]);
  });

  if (tokens.length > 0) {
    lines.push(
      // ── Stage 9b-A: token symbol is token-controlled.
      `💡 <b>Lowest mcap: ${safeText(tokens[0].symbol)} ($${formatNum(tokens[0].mcapUsd)})</b>`,
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
    // ── Stage 9b-A: symbol/name/url are token-controlled; txSig is hex-ish
    // but escaped anyway so a malformed RPC value cannot break HTML.
    `🪙 <b>${safeText(token.symbol)}</b> (${safeText(token.name)})`,
    `💰 Spent: ${solSpent} SOL`,
    `📊 MCap at entry: $${formatNum(token.mcapUsd)}`,
    `🎯 Take Profit: +${CONFIG.TAKE_PROFIT_PERCENT}%`,
    `🛑 Stop Loss: -${CONFIG.STOP_LOSS_PERCENT}%`,
    '',
    `🔗 TX: <code>${escapeHtml(txSig.slice(0, 20))}...</code>`,
    `📈 ${safeLink(token.url, 'View Chart')}`,
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
    // ── Stage 9b-A: symbol/reason are token-controlled -> escape.
    `${emoji} <b>SOLD ${safeText(symbol)}</b>`,
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

  lines.push(`📋 Reason: ${safeText(reason)}`);
  await send(lines.join('\n'));
}

export async function alertError(message: string): Promise<void> {
  await send(`❌ <b>Error:</b> ${escapeHtml(message)}`);
}

// ─── Buy approval (Approve/Reject before auto-snipe) ──────────────

// Testable approval state machine — no axios/Telegram in here.
// bot.ts only: creates the entry, sends the buttons, resolves on callback.
const approvalGate = new ApprovalGate();

/** Best-effort removal of the Approve/Reject keyboard. Never throws. */
async function clearApprovalKeyboard(messageId: number): Promise<void> {
  if (!ENABLED) return;
  try {
    await axios.post(`${API}/editMessageReplyMarkup`, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  } catch { /* non-critical */ }
}

/**
 * Ask on Telegram whether to buy. Resolves true only on an explicit Approve;
 * Reject, timeout, or a failed send all resolve false (fail closed).
 */
export async function requestBuyApproval(summary: string, timeoutSec: number): Promise<boolean> {
  // Create the gate entry FIRST so a fast tap can't arrive before we listen.
  const { id, decision } = approvalGate.open(timeoutSec * 1000);

  const messageId = await sendWithButtons(
    [`🕹 <b>Approve buy?</b>`, summary, '', `⏳ Auto-reject dalam ${timeoutSec}s`].join('\n'),
    [[
      { text: `✅ BUY ${CONFIG.BUY_AMOUNT_SOL} SOL`, callback_data: `appr:yes:${id}` },
      { text: '❌ Reject', callback_data: `appr:no:${id}` },
    ]],
  );
  if (messageId === null) {
    // Send failed (or Telegram disabled) — resolve as rejected, fail closed.
    approvalGate.resolve(id, false);
    logger.warn('Buy approval requested but Telegram send failed — rejecting');
    return false;
  }

  const outcome = await decision;

  // After a decision or expiry, remove the keyboard (best-effort, never throw).
  try {
    await clearApprovalKeyboard(messageId);
  } catch { /* non-critical */ }

  return outcome === 'approved';
}

/** Resolve every pending approval as expired (used on shutdown). */
export function cancelPendingApprovals(): void {
  approvalGate.cancelAll();
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
  getLatency: LatencyCallback;
  onSetMode: SetModeCallback;
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
  onLatencyCommand = handlers.getLatency;
  onSetModeCommand = handlers.onSetMode;
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

        // ── Stage 12B routing order (exactly): menu-callback =>
        // controller.onCallback; approval/trade/other callbacks => existing
        // handleCallback; command => controller.onCommand first, else the
        // existing chain; plain text => controller.onText first, else ignore.
        // classifyUpdate() is the first gate; the old String() comparisons
        // below stay as a second check (defence in depth).
        const routed = classifyUpdate(update, CONFIG.TELEGRAM_CHAT_ID);

        if (routed.kind === 'menu-callback') {
          const cbChatId = String(update.callback_query.message?.chat?.id ?? '');
          if (cbChatId !== CONFIG.TELEGRAM_CHAT_ID) continue;
          await getMenuController().onCallback(routed);
          continue;
        }

        if (
          routed.kind === 'approval-callback' ||
          routed.kind === 'trade-callback' ||
          routed.kind === 'other-callback'
        ) {
          if (update.callback_query) {
            const cbChatId = String(update.callback_query.message?.chat?.id ?? '');
            if (cbChatId !== CONFIG.TELEGRAM_CHAT_ID) continue;
            await handleCallback(update.callback_query);
          }
          continue;
        }

        if (routed.kind === 'command') {
          const text: string = update.message?.text ?? '';
          const chatId = String(update.message?.chat?.id ?? '');
          if (chatId !== CONFIG.TELEGRAM_CHAT_ID) continue;
          if (await getMenuController().onCommand(routed)) continue;

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
        } else if (text === '/latency') {
          if (onLatencyCommand) await send(await onLatencyCommand());
        } else if (text === '/live') {
          // ── Stage 9b-A: LIVE-mode guard (separate branch; do not switch
          // without the env unlock).
          const blocked = liveModeBlocked(false, (CONFIG as any).LIVE_TRADING_ALLOWED === true);
          if (blocked) {
            await send(`🔒 ${blocked}`);
          } else if (onSetModeCommand) {
            await onSetModeCommand(false);
            await send('✅ Mode diubah ke LIVE. Bot akan gunakan saldo nyata saat buka posisi.');
          }
        } else if (text === '/paper') {
          if (onSetModeCommand) {
            await onSetModeCommand(true);
            await send('✅ Mode diubah ke PAPER. Bot akan gunakan simulasi untuk open posisi.');
          }
        } else if (text === '/tunnel') {
          await send('⏳ Starting tunnel...');
          await send(await startTunnel());
        } else if (text === '/tunnel stop') {
          await send(stopTunnel());
        } else if (text === '/config text') {
          await send(renderConfig(CONFIG as any));
        } else if (text === '/set' || text.startsWith('/set ')) {
          await send(handleSetCommand(text.split(/\s+/).slice(1), { config: CONFIG as any, apply: tryApplyConfig }));
        } else if (text === '/preset' || text.startsWith('/preset ')) {
          await send(handlePresetCommand(text.split(/\s+/)[1], { config: CONFIG as any, apply: tryApplyConfig }));
        } else if (text === '/help') {
          await send([
            `🤖 <b>Elon Sniper Bot</b>`,
            '',
            `⚙️ /config - Menu pengaturan (ketuk tombol, ketik angkanya saja)`,
            `/sniper - Status & posisi aktif`,
            `/saldo - Cek saldo SOL`,
            `/pnl - Statistik profit/loss`,
            `/latency - Statistik latensi & slippage`,
            `/history - 10 trade terakhir`,
            `/sell - Jual semua posisi`,
            `/pause - Jeda bot (stop buka posisi baru)`,
            `/resume - Lanjutkan bot`,
            `/live - Switch ke LIVE mode`,
            `/paper - Switch ke PAPER mode`,
            `/tunnel - Start dashboard tunnel`,
            `/tunnel stop - Stop tunnel`,
            `/config text - Ringkasan konfigurasi (teks)`,
            `/set &lt;nama&gt; &lt;nilai&gt; - Ubah konfigurasi (tanpa buka .env)`,
            `/preset lowrisk - Terapkan mode low risk`,
            `/help - Pesan ini`,
          ].join('\n'));
        }
        }

        if (routed.kind === 'text') {
          const chatId = String(update.message?.chat?.id ?? '');
          if (chatId !== CONFIG.TELEGRAM_CHAT_ID) continue;
          if (await getMenuController().onText(routed)) continue;
          // No legacy behaviour for plain text: ignore.
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

  if (data.startsWith('appr:')) {
    const [, choice, id] = data.split(':');
    const status = approvalGate.resolve(id, choice === 'yes');
    if (status === 'unknown') {
      await answerCb(cbId, 'Kadaluarsa — sudah di-reject otomatis');
      return;
    }
    await answerCb(cbId, choice === 'yes' ? 'Buying...' : 'Rejected');
    return;
  }

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

async function answerCb(id: string, text?: string, alert?: boolean): Promise<void> {
  try {
    await axios.post(`${API}/answerCallbackQuery`, {
      callback_query_id: id,
      text: text ?? '',
      show_alert: alert === true,
    });
  } catch { /* non-critical */ }
}

// ─── Utilities ────────────────────────────────────────────────────

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}
