/**
 * Setting metadata for the Telegram settings menu (Stage 12A).
 *
 * Pure module: no Telegram imports, reusable by the web dashboard.
 * Display-vs-stored scaling: display = stored / displayScale.
 * Only MAX_SLIPPAGE_BPS uses a scale (stored bps, shown in %).
 */

import { EDITABLE_CONFIG, type EditableKey } from './editable';

export type SettingGroup = 'size' | 'exec' | 'entry' | 'features';

export interface SettingGroupInfo {
  id: SettingGroup;
  emoji: string;
  title: string;
  blurb: string;
}

export const GROUPS: SettingGroupInfo[] = [
  { id: 'size', emoji: '💰', title: 'Ukuran & Exit', blurb: 'Atur modal dan target keluar.' },
  { id: 'exec', emoji: '⛽', title: 'Eksekusi & Biaya', blurb: 'Biaya, slippage, dan eksekusi.' },
  { id: 'entry', emoji: '🔎', title: 'Filter Entry', blurb: 'Saring token sebelum dibeli.' },
  { id: 'features', emoji: '🛡', title: 'Fitur & Opsinya', blurb: 'Nyalakan atau matikan fitur.' },
];

export type SettingUnit = '$' | 'SOL' | '%' | 'mnt' | 'dtk' | '';

export interface SettingMeta {
  key: EditableKey;
  emoji: string;
  label: string;
  unit: SettingUnit;
  group: SettingGroup;
  kind: 'number' | 'toggle';
  hint: string;
  quick?: number[];
  comfort?: [number, number];
  displayScale?: number;
  /** Stored-units lower bound for runtime edits shown in the prompt (overrides RANGES.min display). */
  runtimeMin?: number;
  decimals: number;
  sign?: 'minus';
  confirmOff?: string;
  dependsOn?: { key: EditableKey; on: boolean };
}

const INTEGER_META_KEYS = new Set<string>([
  'MAX_SLIPPAGE_BPS',
  'PUMP_MAX_POSITIONS',
  'PUMP_MAX_HOLD_MINUTES',
  'BUY_APPROVAL_TIMEOUT_SEC',
]);

export const SETTING_META: Record<EditableKey, SettingMeta> = {
  BUY_AMOUNT_USD: {
    key: 'BUY_AMOUNT_USD', emoji: '💵', label: 'Ukuran beli', unit: '$',
    group: 'size', kind: 'number', hint: 'Nilai dolar tiap snipe (minimum $10).',
    quick: [10, 15, 20, 25], decimals: 2,
  },
  BUY_AMOUNT_SOL: {
    key: 'BUY_AMOUNT_SOL', emoji: '💰', label: 'Ukuran beli (SOL)', unit: 'SOL',
    group: 'size', kind: 'number', hint: 'Jumlah beli per trade dalam SOL.',
    quick: [0.05, 0.1, 0.25, 0.5], decimals: 3,
  },
  MAX_SLIPPAGE_BPS: {
    key: 'MAX_SLIPPAGE_BPS', emoji: '📉', label: 'Slippage', unit: '%',
    group: 'exec', kind: 'number', hint: 'Toleransi selisih harga saat beli dan jual.',
    quick: [1, 2, 5, 10], displayScale: 100, decimals: 2,
  },
  STOP_LOSS_PERCENT: {
    key: 'STOP_LOSS_PERCENT', emoji: '🛑', label: 'Stop loss', unit: '%',
    group: 'size', kind: 'number', hint: 'Jual semua jika rugi sebesar ini (maksimal 25%).',
    quick: [10, 15, 20, 25], decimals: 2, sign: 'minus',
  },
  TP1_PERCENT: {
    key: 'TP1_PERCENT', emoji: '🎯', label: 'Target TP1', unit: '%',
    group: 'size', kind: 'number', hint: 'Target profit pertama untuk jual sebagian.',
    quick: [20, 30, 40, 50], decimals: 2,
  },
  TP1_SELL_PERCENT: {
    key: 'TP1_SELL_PERCENT', emoji: '✂️', label: 'Jual di TP1', unit: '%',
    group: 'size', kind: 'number', hint: 'Persen posisi yang dijual saat TP1 tercapai.',
    quick: [50, 70, 80, 100], decimals: 2,
  },
  TP2_PERCENT: {
    key: 'TP2_PERCENT', emoji: '🚀', label: 'Target TP2', unit: '%',
    group: 'size', kind: 'number', hint: 'Target profit kedua untuk tutup posisi.',
    quick: [40, 50, 80, 100], decimals: 2,
  },
  MOONBAG_PERCENT: {
    key: 'MOONBAG_PERCENT', emoji: '🌕', label: 'Sisa moonbag', unit: '%',
    group: 'features', kind: 'number', hint: 'Persen dari SISA token setelah TP1 yang ditahan saat TP2.',
    quick: [10, 15, 25, 30], decimals: 2,
    dependsOn: { key: 'MOONBAG_ENABLED', on: true },
  },
  MOONBAG_TRAIL_PERCENT: {
    key: 'MOONBAG_TRAIL_PERCENT', emoji: '🌠', label: 'Trail moonbag', unit: '%',
    group: 'features', kind: 'number', hint: 'Turun berapa persen dari puncak untuk jual sisa.',
    quick: [20, 30, 40, 50], decimals: 2,
    dependsOn: { key: 'MOONBAG_ENABLED', on: true },
  },
  PRIORITY_FEE_BUY_SOL: {
    key: 'PRIORITY_FEE_BUY_SOL', emoji: '⛽', label: 'Fee prioritas beli', unit: 'SOL',
    group: 'exec', kind: 'number', hint: 'Fee prioritas agar transaksi beli cepat.',
    quick: [0.00005, 0.0001, 0.0005, 0.001], decimals: 7,
  },
  PRIORITY_FEE_SELL_SOL: {
    key: 'PRIORITY_FEE_SELL_SOL', emoji: '🧾', label: 'Fee prioritas jual', unit: 'SOL',
    group: 'exec', kind: 'number', hint: 'Fee prioritas agar transaksi jual cepat.',
    quick: [0.00005, 0.0001, 0.0005, 0.001], decimals: 7,
  },
  MAX_FEE_SOL: {
    key: 'MAX_FEE_SOL', emoji: '🧮', label: 'Batas fee maks', unit: 'SOL',
    group: 'exec', kind: 'number', hint: 'Batas atas total fee per transaksi.',
    quick: [0.0001, 0.0005, 0.001, 0.005], decimals: 7,
  },
  PUMP_MAX_POSITIONS: {
    key: 'PUMP_MAX_POSITIONS', emoji: '📦', label: 'Maks posisi', unit: '',
    group: 'entry', kind: 'number', hint: 'Jumlah posisi bersamaan paling banyak.',
    quick: [1, 2, 3, 5], decimals: 0,
  },
  PUMP_MAX_HOLD_MINUTES: {
    key: 'PUMP_MAX_HOLD_MINUTES', emoji: '⌛', label: 'Hold maksimum', unit: 'mnt',
    group: 'entry', kind: 'number', hint: 'Lama pegang posisi sebelum jual otomatis.',
    quick: [5, 10, 15, 30], decimals: 0, runtimeMin: 1,
  },
  PUMP_MIN_DEV_BUY_SOL: {
    key: 'PUMP_MIN_DEV_BUY_SOL', emoji: '🟢', label: 'Dev buy minimum', unit: 'SOL',
    group: 'entry', kind: 'number', hint: 'Batas bawah modal dev agar layak snipe.',
    quick: [0.3, 0.5, 1, 2], decimals: 3,
  },
  PUMP_MAX_DEV_BUY_SOL: {
    key: 'PUMP_MAX_DEV_BUY_SOL', emoji: '🔴', label: 'Dev buy maksimum', unit: 'SOL',
    group: 'entry', kind: 'number', hint: 'Batas atas modal dev agar hindari paus.',
    quick: [3, 5, 10, 20], decimals: 3,
  },
  PUMP_MIN_MCAP_SOL: {
    key: 'PUMP_MIN_MCAP_SOL', emoji: '📊', label: 'MCap minimum', unit: 'SOL',
    group: 'entry', kind: 'number', hint: 'Kapitalisasi pasar minimum untuk entry.',
    quick: [30, 35, 40, 50], decimals: 2,
  },
  PUMP_MAX_MCAP_SOL: {
    key: 'PUMP_MAX_MCAP_SOL', emoji: '📈', label: 'MCap maksimum', unit: 'SOL',
    group: 'entry', kind: 'number', hint: 'Kapitalisasi pasar maksimum untuk entry.',
    quick: [60, 100, 150, 300], decimals: 2,
  },
  AUTO_SELL: {
    key: 'AUTO_SELL', emoji: '🤖', label: 'Auto sell', unit: '',
    group: 'features', kind: 'toggle', hint: 'Jual otomatis saat TP atau SL tercapai.',
    decimals: 0, confirmOff: 'Tanpa Auto Sell, TP/SL tidak akan menjual otomatis.',
  },
  ANTI_MEV: {
    key: 'ANTI_MEV', emoji: '🛡️', label: 'Anti MEV', unit: '',
    group: 'features', kind: 'toggle', hint: 'Lindungi transaksi dari serangan MEV.',
    decimals: 0,
  },
  MOONBAG_ENABLED: {
    key: 'MOONBAG_ENABLED', emoji: '🌙', label: 'Moonbag', unit: '',
    group: 'features', kind: 'toggle', hint: 'Sisakan sebagian posisi untuk terbang jauh.',
    decimals: 0,
  },
  PUMP_SECURITY_CHECK: {
    key: 'PUMP_SECURITY_CHECK', emoji: '🔒', label: 'Security check', unit: '',
    group: 'features', kind: 'toggle', hint: 'Saring token honeypot sebelum membeli.',
    decimals: 0, confirmOff: 'Token honeypot tidak lagi disaring sebelum beli.',
  },
  TRAILING_TP_ENABLED: {
    key: 'TRAILING_TP_ENABLED', emoji: '🌊', label: 'Trailing TP', unit: '',
    group: 'features', kind: 'toggle', hint: 'Ikuti harga naik lalu kunci profit.',
    decimals: 0,
  },
  TRAILING_TP_DROP_PERCENT: {
    key: 'TRAILING_TP_DROP_PERCENT', emoji: '🔻', label: 'Turun dari puncak', unit: '%',
    group: 'features', kind: 'number', hint: 'Jual sisa posisi bila harga turun sebesar ini dari puncaknya.',
    quick: [10, 15, 20, 30], decimals: 2,
    dependsOn: { key: 'TRAILING_TP_ENABLED', on: true },
  },
  BUY_APPROVAL_ENABLED: {
    key: 'BUY_APPROVAL_ENABLED', emoji: '🕹', label: 'Approval beli', unit: '',
    group: 'features', kind: 'toggle', hint: 'Minta persetujuan sebelum setiap beli.',
    decimals: 0,
  },
  BUY_APPROVAL_TIMEOUT_SEC: {
    key: 'BUY_APPROVAL_TIMEOUT_SEC', emoji: '⏳', label: 'Batas waktu approve', unit: 'dtk',
    group: 'features', kind: 'number', hint: 'Batas tunggu persetujuan sebelum batal.',
    quick: [10, 20, 30, 60], decimals: 0,
    dependsOn: { key: 'BUY_APPROVAL_ENABLED', on: true },
  },
};

/** Display order per group (callback indexes still follow EDITABLE_CONFIG). */
export const GROUP_ORDER: Record<SettingGroup, EditableKey[]> = {
  size: ['BUY_AMOUNT_USD', 'BUY_AMOUNT_SOL', 'STOP_LOSS_PERCENT', 'TP1_PERCENT', 'TP1_SELL_PERCENT', 'TP2_PERCENT'],
  exec: ['MAX_SLIPPAGE_BPS', 'PRIORITY_FEE_BUY_SOL', 'PRIORITY_FEE_SELL_SOL', 'MAX_FEE_SOL'],
  entry: ['PUMP_MAX_POSITIONS', 'PUMP_MAX_HOLD_MINUTES', 'PUMP_MIN_DEV_BUY_SOL', 'PUMP_MAX_DEV_BUY_SOL', 'PUMP_MIN_MCAP_SOL', 'PUMP_MAX_MCAP_SOL'],
  features: [
    'AUTO_SELL', 'PUMP_SECURITY_CHECK', 'ANTI_MEV',
    'MOONBAG_ENABLED', 'MOONBAG_PERCENT', 'MOONBAG_TRAIL_PERCENT',
    'TRAILING_TP_ENABLED', 'TRAILING_TP_DROP_PERCENT',
    'BUY_APPROVAL_ENABLED', 'BUY_APPROVAL_TIMEOUT_SEC',
  ],
};

/** Comfort zone in DISPLAY units; defaults to [min(quick), max(quick)]. */
export function comfortRange(key: EditableKey): [number, number] | null {
  const meta = SETTING_META[key];
  if (!meta || meta.kind !== 'number') return null;
  if (meta.comfort) return meta.comfort;
  if (meta.quick && meta.quick.length > 0) {
    return [Math.min(...meta.quick), Math.max(...meta.quick)];
  }
  return null;
}

export function isVisible(key: EditableKey, config: Record<string, unknown>): boolean {
  if (key === 'BUY_AMOUNT_SOL') {
    const usd = (config as Record<string, unknown>)['BUY_AMOUNT_USD'];
    if (typeof usd === 'number' && usd > 0) return false;
  }
  const meta = SETTING_META[key];
  if (meta?.dependsOn) {
    return (config as Record<string, unknown>)[meta.dependsOn.key] === meta.dependsOn.on;
  }
  return true;
}

export function visibleKeys(group: SettingGroup, config: Record<string, unknown>): EditableKey[] {
  const out: EditableKey[] = [];
  for (const key of GROUP_ORDER[group] ?? []) {
    if (!isVisible(key, config)) continue;
    out.push(key);
  }
  return out;
}

export function hiddenNote(group: SettingGroup, config: Record<string, unknown>): string | null {
  if (group !== 'size') return null;
  const hidden: string[] = [];
  for (const key of GROUP_ORDER[group] ?? []) {
    if (!isVisible(key, config)) hidden.push(SETTING_META[key].label);
  }
  if (hidden.length === 0) return null;
  return `Disembunyikan (tidak dipakai saat ini): ${hidden.join(', ')}`;
}

export function toDisplay(key: string, stored: number): number {
  const meta = (SETTING_META as Record<string, SettingMeta>)[key];
  const scale = meta?.displayScale ?? 1;
  return stored / scale;
}

export function toStored(key: string, displayValue: number): number {
  const meta = (SETTING_META as Record<string, SettingMeta>)[key];
  const scale = meta?.displayScale ?? 1;
  const raw = displayValue * scale;
  if (INTEGER_META_KEYS.has(key)) return Math.round(raw);
  return raw;
}

/** Indonesian number format: decimal comma, thousands dot, no trailing zeros. */
export function fmtNumber(n: number, maxDecimals: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '-';
  const d = Math.max(0, Math.min(10, Math.floor(maxDecimals)));
  let v: number = n;
  if (Object.is(v, -0)) v = 0;
  const fixed = v.toFixed(d);
  const parts = fixed.split('.');
  let intPart = parts[0];
  let fracPart = parts.length > 1 ? parts[1] : '';
  let neg = false;
  if (intPart.startsWith('-')) {
    neg = true;
    intPart = intPart.slice(1);
  }
  intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  let out = (neg ? '-' : '') + intPart;
  fracPart = fracPart.replace(/0+$/, '');
  if (fracPart.length > 0) out += ',' + fracPart;
  return out;
}

/** Format a stored config value with its unit. Missing/non-finite renders as "-". */
export function fmtValue(key: string, stored: unknown, _config?: Record<string, unknown>): string {
  const meta = (SETTING_META as Record<string, SettingMeta>)[key];
  if (typeof stored === 'boolean') return stored ? 'ON' : 'OFF';
  if (meta?.kind === 'toggle') {
    if (stored === true) return 'ON';
    if (stored === false) return 'OFF';
    return '-';
  }
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return '-';
  if (key === 'BUY_AMOUNT_USD' && stored === 0) return 'nonaktif';
  const display = toDisplay(key, stored);
  const decimals = meta?.decimals ?? 2;
  const num = fmtNumber(display, decimals);
  const unit = meta?.unit ?? '';
  if (unit === '$') return `$${num}`;
  if (unit === 'SOL') return `${num} SOL`;
  if (unit === '%') {
    if (key === 'TP1_PERCENT' || key === 'TP2_PERCENT') return `+${num}%`;
    if (key === 'STOP_LOSS_PERCENT') return `−${num}%`;
    return `${num}%`;
  }
  if (unit === 'mnt') return `${num} mnt`;
  if (unit === 'dtk') return `${num} dtk`;
  return num;
}
