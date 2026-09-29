import path from 'path';
import fs from 'fs';
import { CONFIG } from './index';
import { logger } from '../utils/logger';

export const EDITABLE_CONFIG = [
  'BUY_AMOUNT_SOL', 'MAX_SLIPPAGE_BPS', 'STOP_LOSS_PERCENT',
  'TP1_PERCENT', 'TP1_SELL_PERCENT', 'TP2_PERCENT',
  'MOONBAG_PERCENT',
  'PRIORITY_FEE_BUY_SOL', 'PRIORITY_FEE_SELL_SOL', 'MAX_FEE_SOL',
  'PUMP_MAX_POSITIONS', 'PUMP_MAX_HOLD_MINUTES',
  'PUMP_MIN_DEV_BUY_SOL', 'PUMP_MAX_DEV_BUY_SOL',
  'PUMP_MIN_MCAP_SOL', 'PUMP_MAX_MCAP_SOL',
  'AUTO_SELL', 'ANTI_MEV', 'MOONBAG_ENABLED', 'PUMP_SECURITY_CHECK',
  'TRAILING_TP_ENABLED', 'TRAILING_TP_DROP_PERCENT',
  'BUY_APPROVAL_ENABLED', 'BUY_APPROVAL_TIMEOUT_SEC',
] as const;

export type EditableKey = typeof EDITABLE_CONFIG[number];

const BOOLEAN_KEYS = new Set<string>(['AUTO_SELL', 'ANTI_MEV', 'MOONBAG_ENABLED', 'PUMP_SECURITY_CHECK', 'TRAILING_TP_ENABLED', 'BUY_APPROVAL_ENABLED', 'PAPER_TRADING']);
const INTEGER_KEYS = new Set<string>(['MAX_SLIPPAGE_BPS', 'PUMP_MAX_POSITIONS', 'PUMP_MAX_HOLD_MINUTES', 'BUY_APPROVAL_TIMEOUT_SEC']);

// Short names for Telegram: /set buy 0.25
export const CONFIG_ALIASES: Record<string, EditableKey> = {
  buy: 'BUY_AMOUNT_SOL',
  posisi: 'PUMP_MAX_POSITIONS',
  hold: 'PUMP_MAX_HOLD_MINUTES',
  devbuy: 'PUMP_MIN_DEV_BUY_SOL',
  security: 'PUMP_SECURITY_CHECK',
  sl: 'STOP_LOSS_PERCENT',
  tp1: 'TP1_PERCENT',
  tp1sell: 'TP1_SELL_PERCENT',
  tp2: 'TP2_PERCENT',
  slippage: 'MAX_SLIPPAGE_BPS',
  trail: 'TRAILING_TP_ENABLED',
  traildrop: 'TRAILING_TP_DROP_PERCENT',
  approval: 'BUY_APPROVAL_ENABLED',
  approvaltimeout: 'BUY_APPROVAL_TIMEOUT_SEC',
};

export const PRESETS: Record<string, Partial<Record<EditableKey, number | boolean>>> = {
  lowrisk: {
    BUY_AMOUNT_SOL: 0.25,
    PUMP_MAX_POSITIONS: 3,
    PUMP_MAX_HOLD_MINUTES: 5,
    PUMP_MIN_DEV_BUY_SOL: 0.5,
    PUMP_SECURITY_CHECK: true,
  },
};

export function resolveKey(input: string): EditableKey | null {
  const lower = input.toLowerCase();
  if (lower in CONFIG_ALIASES) return CONFIG_ALIASES[lower];
  const upper = input.toUpperCase();
  return (EDITABLE_CONFIG as readonly string[]).includes(upper) ? (upper as EditableKey) : null;
}

/** Parse raw text into the right type for `key`, or return an error string. */
export function parseValue(key: string, raw: string): number | boolean | string {
  if (BOOLEAN_KEYS.has(key)) {
    const v = raw.toLowerCase();
    if (['true', 'on', '1', 'ya'].includes(v)) return true;
    if (['false', 'off', '0', 'tidak'].includes(v)) return false;
    return `${key} harus on/off`;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return `${key} harus angka >= 0`;
  if (INTEGER_KEYS.has(key) && !Number.isInteger(n)) return `${key} harus bilangan bulat`;
  return n;
}

/** Apply values to in-memory CONFIG and persist them to .env. */
export function applyConfig(values: Record<string, number | boolean>): void {
  for (const [key, val] of Object.entries(values)) (CONFIG as any)[key] = val;

  try {
    const envPath = path.join(process.cwd(), '.env');
    let content = fs.readFileSync(envPath, 'utf8');
    for (const [key, val] of Object.entries(values)) {
      const re = new RegExp(`^(${key}\\s*=)[^\\n]*`, 'm');
      if (re.test(content)) {
        content = content.replace(re, `$1${val}`);
      } else {
        content += `\n${key}=${val}`;
      }
    }
    fs.writeFileSync(envPath, content);
  } catch (e) {
    logger.warn('Could not write .env: ' + e);
  }

  logger.info(`⚙ Config updated: ${Object.keys(values).join(', ')}`);
}
