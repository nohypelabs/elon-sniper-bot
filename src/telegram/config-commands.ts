/**
 * Pure Telegram config-command helpers.
 *
 * No axios, no Telegram I/O, no import of the real CONFIG or of bot.ts.
 * Everything variable comes in as parameters so unit tests never touch
 * the real config or .env.
 */

import {
  CONFIG_ALIASES,
  EDITABLE_CONFIG,
  PRESETS,
  parseValue,
  resolveKey,
} from '../config/editable';

export type ConfigApply = (
  values: Record<string, number | boolean>,
) => string | null;

export interface ConfigCommandDeps {
  config: Record<string, any>;
  apply: ConfigApply;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function fmtVal(v: unknown): string {
  return typeof v === 'boolean' ? (v ? 'ON' : 'OFF') : String(v);
}

/** Help text shown when /set is called with fewer than 2 args. */
export function renderSetHelp(config: Record<string, unknown>): string {
  const aliases = Object.entries(CONFIG_ALIASES).map(
    ([a, k]) => `• <code>${a}</code> → ${k} (${fmtVal((config as any)[k])})`,
  );
  return [
    `⚙️ <b>Cara pakai:</b> /set &lt;nama&gt; &lt;nilai&gt;`,
    `Contoh: <code>/set buy 0.25</code>, <code>/set security on</code>`,
    '',
    ...aliases,
    '',
    `Atau nama env lengkap: ${EDITABLE_CONFIG.join(', ')}`,
  ].join('\n');
}

export function handleSetCommand(
  args: string[],
  deps: ConfigCommandDeps,
): string {
  if (args.length < 2) {
    return renderSetHelp(deps.config);
  }

  const key = resolveKey(args[0]);
  if (!key) return `❌ Nama tidak dikenal: ${escapeHtml(args[0])}. Kirim /set untuk daftar.`;

  const value = parseValue(key, args[1]);
  if (typeof value === 'string') return `❌ ${escapeHtml(value)}`;

  const before = deps.config[key];
  const err = deps.apply({ [key]: value });
  if (err) return `❌ ${escapeHtml(err)}`;
  return `✅ <b>${key}</b>: ${fmtVal(before)} → ${fmtVal(value)}`;
}

export function handlePresetCommand(
  name: string | undefined,
  deps: ConfigCommandDeps,
): string {
  const preset = name ? PRESETS[name.toLowerCase()] : undefined;
  if (!preset) return `Preset tersedia: ${Object.keys(PRESETS).join(', ')}\nContoh: /preset lowrisk`;

  const lines = Object.entries(preset).map(
    ([k, v]) => `• ${k}: ${fmtVal(deps.config[k])} → ${fmtVal(v)}`,
  );
  const err = deps.apply(preset as Record<string, number | boolean>);
  if (err) return `❌ Preset ${escapeHtml(name!)} ditolak, tidak ada yang berubah: ${escapeHtml(err)}`;
  return [`✅ <b>Preset ${escapeHtml(name!)} diterapkan</b>`, ...lines].join('\n');
}

function safeNum(config: Record<string, any>, key: string, fallback: number): number {
  const v = config[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function safeBool(config: Record<string, any>, key: string): boolean {
  return config[key] === true;
}

/**
 * The /config message. Reflects the real multi-level TP/SL strategy:
 * TP1/TP2/Moonbag + stop loss capped at 25%.
 */
export function renderConfig(config: Record<string, any>): string {
  const buy = safeNum(config, 'BUY_AMOUNT_SOL', 0);
  const buyUsd = safeNum(config, 'BUY_AMOUNT_USD', 0);
  const solRef = safeNum(config, 'PUMP_SOL_PRICE_USD', 150);
  const buyLine = buyUsd > 0
    ? `💰 Buy Amount: $${buyUsd} (≈ ${(solRef > 0 ? buyUsd / solRef : buy).toFixed(4)} SOL)`
    : `💰 Buy Amount: ${buy} SOL`;
  const tp1 = safeNum(config, 'TP1_PERCENT', 0);
  const tp1sell = safeNum(config, 'TP1_SELL_PERCENT', 0);
  const tp2 = safeNum(config, 'TP2_PERCENT', 0);
  const moonbagOn = safeBool(config, 'MOONBAG_ENABLED');
  const moonbagPct = safeNum(config, 'MOONBAG_PERCENT', 0);
  const slRaw = safeNum(config, 'STOP_LOSS_PERCENT', 0);
  const slShown = Math.min(slRaw, 25);
  const slLine = slRaw > 25
    ? `🛑 Stop Loss: -${slShown}% (dibatasi 25%)`
    : `🛑 Stop Loss: -${slShown}%`;
  const slippage = safeNum(config, 'MAX_SLIPPAGE_BPS', 0) / 100;
  const autoSell = safeBool(config, 'AUTO_SELL') ? 'ON' : 'OFF';
  const mode = config['PAPER_TRADING'] ? 'PAPER' : 'LIVE';
  const pollSec = safeNum(config, 'TWEET_POLL_INTERVAL_MS', 0) / 1000;
  const maxPosisi = safeNum(config, 'PUMP_MAX_POSITIONS', 0);
  const maxHold = safeNum(config, 'PUMP_MAX_HOLD_MINUTES', 0);
  const holdLine = maxHold === 0 ? 'nonaktif' : `${maxHold} menit`;
  const minDevBuy = safeNum(config, 'PUMP_MIN_DEV_BUY_SOL', 0);
  const securityOn = safeBool(config, 'PUMP_SECURITY_CHECK');
  const trailingOn = safeBool(config, 'TRAILING_TP_ENABLED');
  const trailingDrop = safeNum(config, 'TRAILING_TP_DROP_PERCENT', 0);
  const approvalOn = safeBool(config, 'BUY_APPROVAL_ENABLED');
  const approvalTimeout = safeNum(config, 'BUY_APPROVAL_TIMEOUT_SEC', 0);

  return [
    `⚙️ <b>Sniper Config</b>`,
    '',
    buyLine,
    `🎯 TP1: +${tp1}% (jual ${tp1sell}%)`,
    `🎯 TP2: +${tp2}%`,
    `🌙 Moonbag: ${moonbagOn ? `${moonbagPct}%` : 'OFF'}`,
    slLine,
    `📉 Slippage: ${slippage}%`,
    `🤖 Auto Sell: ${autoSell}`,
    `📝 Mode: ${mode}`,
    `⏱ Poll Interval: ${pollSec}s`,
    '',
    `<b>PumpFun</b>`,
    `📦 Max Posisi: ${maxPosisi}`,
    `⌛ Max Hold: ${holdLine}`,
    `👨‍💻 Min Dev Buy: ${minDevBuy} SOL`,
    `🔒 Security Check: ${securityOn ? 'ON' : 'OFF'}`,
    `📈 Trailing TP: ${trailingOn ? `ON (drop ${trailingDrop}%)` : 'OFF'}`,
    `🕹 Approval Buy: ${approvalOn ? `ON (${approvalTimeout}s)` : 'OFF'}`,
    '',
    `Ubah: /set &lt;nama&gt; &lt;nilai&gt; atau /preset lowrisk`,
  ].join('\n');
}
