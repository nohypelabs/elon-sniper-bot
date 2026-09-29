import path from 'path';
import fs from 'fs';
import { CONFIG } from './index';
import { logger } from '../utils/logger';

export const EDITABLE_CONFIG = [
  'BUY_AMOUNT_SOL', 'BUY_AMOUNT_USD', 'MAX_SLIPPAGE_BPS', 'STOP_LOSS_PERCENT',
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

/** Inclusive numeric bounds enforced by parseValue / tryApplyConfig. */
export interface ConfigRange { min: number; max: number }

export const RANGES: Record<string, ConfigRange> = {
  BUY_AMOUNT_SOL: { min: 0.001, max: 10 },
  BUY_AMOUNT_USD: { min: 10, max: 1000 },
  MAX_SLIPPAGE_BPS: { min: 1, max: 5000 },
  STOP_LOSS_PERCENT: { min: 1, max: 99 },
  TP1_PERCENT: { min: 1, max: 1000 },
  TP1_SELL_PERCENT: { min: 1, max: 100 },
  TP2_PERCENT: { min: 1, max: 10000 },
  MOONBAG_PERCENT: { min: 0, max: 99 },
  PRIORITY_FEE_BUY_SOL: { min: 0, max: 0.01 },
  PRIORITY_FEE_SELL_SOL: { min: 0, max: 0.01 },
  MAX_FEE_SOL: { min: 0, max: 0.01 },
  PUMP_MAX_POSITIONS: { min: 1, max: 20 },
  PUMP_MAX_HOLD_MINUTES: { min: 0, max: 1440 },
  PUMP_MIN_DEV_BUY_SOL: { min: 0, max: 1000 },
  PUMP_MAX_DEV_BUY_SOL: { min: 0, max: 1000 },
  PUMP_MIN_MCAP_SOL: { min: 0, max: 1000000 },
  PUMP_MAX_MCAP_SOL: { min: 0, max: 1000000 },
  TRAILING_TP_DROP_PERCENT: { min: 1, max: 99 },
  BUY_APPROVAL_TIMEOUT_SEC: { min: 5, max: 120 },
};

// Plain decimal literals only: rejects '', whitespace, '0x10', 'Infinity', 'NaN', '1,5'.
const NUMBER_LITERAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Range/integer check shared by parseValue (raw text) and tryApplyConfig (typed values). */
function checkNumber(key: string, n: number): string | null {
  const range = RANGES[key];
  if (range) {
    if (n < range.min || n > range.max) {
      return `${key} harus antara ${range.min} dan ${range.max}`;
    }
  } else if (n < 0) {
    return `${key} harus angka >= 0`;
  }
  if (INTEGER_KEYS.has(key) && !Number.isInteger(n)) return `${key} harus bilangan bulat`;
  return null;
}

// Short names for Telegram: /set buy 0.25
export const CONFIG_ALIASES: Record<string, EditableKey> = {
  buy: 'BUY_AMOUNT_SOL',
  buyusd: 'BUY_AMOUNT_USD',
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
  const text = raw.trim();
  const n = Number(text);
  // Number('') is 0 and Number('0x10') is 16: require a plain decimal literal.
  if (text === '' || !NUMBER_LITERAL.test(text) || !Number.isFinite(n)) {
    return `${key} harus angka >= 0`;
  }
  return checkNumber(key, n) ?? n;
}

/** Cross-field check against the merged config; returns the first error or null. */
export function validateConfig(merged: Record<string, unknown>): string | null {
  const num = (key: string): number | null => {
    const v = merged[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };

  const tp1 = num('TP1_PERCENT');
  const tp2 = num('TP2_PERCENT');
  if (tp1 !== null && tp2 !== null && tp1 >= tp2) {
    return 'TP1_PERCENT harus lebih kecil dari TP2_PERCENT';
  }

  const minDev = num('PUMP_MIN_DEV_BUY_SOL');
  const maxDev = num('PUMP_MAX_DEV_BUY_SOL');
  if (minDev !== null && maxDev !== null && minDev > maxDev) {
    return 'PUMP_MIN_DEV_BUY_SOL harus <= PUMP_MAX_DEV_BUY_SOL';
  }

  const minMcap = num('PUMP_MIN_MCAP_SOL');
  const maxMcap = num('PUMP_MAX_MCAP_SOL');
  if (minMcap !== null && maxMcap !== null && maxMcap > 0 && minMcap > maxMcap) {
    return 'PUMP_MIN_MCAP_SOL harus <= PUMP_MAX_MCAP_SOL';
  }

  return null;
}

export interface TryApplyOptions {
  config?: Record<string, any>;
  envPath?: string;
}

const ALLOWED_KEYS = new Set<string>([...EDITABLE_CONFIG, 'PAPER_TRADING']);

// Escapes regex specials; keys are interpolated into a RegExp below.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Apply values to `config` and atomically persist them to `envPath`.
 * On any validation error nothing changes and the error string is returned.
 * Returns null on success.
 */
export function tryApplyConfig(
  values: Record<string, number | boolean>,
  opts?: TryApplyOptions,
): string | null {
  const config = opts?.config ?? (CONFIG as Record<string, any>);
  const envPath = opts?.envPath ?? path.join(process.cwd(), '.env');

  // (a) only EDITABLE_CONFIG plus PAPER_TRADING can be changed.
  for (const key of Object.keys(values)) {
    if (!ALLOWED_KEYS.has(key)) return `Key tidak dikenal: ${key}`;
  }

  // (b) re-validate every value: callers may bypass parseValue.
  for (const [key, val] of Object.entries(values)) {
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof val !== 'boolean') return `${key} harus on/off`;
      continue;
    }
    if (typeof val !== 'number' || !Number.isFinite(val)) return `${key} harus angka >= 0`;
    const rangeErr = checkNumber(key, val);
    if (rangeErr) return rangeErr;
  }

  // (c) cross-field rules on the merged config.
  const crossErr = validateConfig({ ...config, ...values });
  if (crossErr) return crossErr;

  // (d) .env is written first and atomically (temp file + rename).
  const tmpPath = `${envPath}.tmp-${process.pid}`;
  try {
    let content = '';
    let mode = 0o600;
    try {
      const st = fs.statSync(envPath);
      mode = st.mode & 0o777;
      content = fs.readFileSync(envPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    for (const [rawKey, val] of Object.entries(values)) {
      const key = escapeRegExp(rawKey);
      const re = new RegExp(`^(${key}\\s*=)[^\\n]*`, 'm');
      if (re.test(content)) {
        // Function replacer: the value is never interpreted as a $-pattern.
        content = content.replace(re, (_match, prefix: string) => prefix + String(val));
      } else {
        const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
        content += `${sep}${rawKey}=${val}\n`;
      }
    }
    fs.writeFileSync(tmpPath, content, { mode });
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, envPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
    logger.warn('Could not write .env: ' + e);
    return `Gagal menulis .env: ${e instanceof Error ? e.message : String(e)}`;
  }

  // (e) memory is mutated only after the .env write succeeded.
  for (const [key, val] of Object.entries(values)) config[key] = val;

  logger.info(`⚙ Config updated: ${Object.keys(values).join(', ')}`);
  return null;
}

/** Apply values to in-memory CONFIG and persist them to .env. Throws on invalid input. */
export function applyConfig(values: Record<string, number | boolean>): void {
  const err = tryApplyConfig(values);
  if (err) throw new Error(err);
}
