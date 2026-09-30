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
  { id: 'features', emoji: '🛡', title: 'Fitur ON/OFF', blurb: 'Nyalakan atau matikan fitur.' },
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
    key: 'BUY_AMOUNT_USD', emoji: '💵', label: 'Beli USD', unit: '$',
    group: 'size', kind: 'number', hint: 'Jumlah beli per trade dalam USD.',
    quick: [10, 15, 20, 25], decimals: 2,
  },
  BUY_AMOUNT_SOL: {
    key: 'BUY_AMOUNT_SOL', emoji: '💰', label: 'Beli SOL', unit: 'SOL',
    group: 'size', kind: 'number', hint: 'Jumlah beli per trade dalam SOL.',
    quick: [0.05, 0.1, 0.25, 0.5], decimals: 3,
  },
  MAX_SLIPPAGE_BPS: {
    key: 'MAX_SLIPPAGE_BPS', emoji: '📉', label: 'Slippage', unit: '%',
    group: 'exec', kind: 'number', hint: 'Toleransi selisih harga saat eksekusi beli.',
    quick: [1, 2, 5, 10], displayScale: 100, decimals: 2,
  },
  STOP_LOSS_PERCENT: {
    key: 'STOP_LOSS_PERCENT', emoji: '🛑', label: 'Stop Loss', unit: '%',
    group: 'size', kind: 'number', hint: 'Batas kerugian maks sebelum jual rugi.',
    quick: [10, 15, 20, 25], decimals: 2, sign: 'minus',
  },
  TP1_PERCENT: {
    key: 'TP1_PERCENT', emoji: '🎯', label: 'TP1 Profit', unit: '%',
    group: 'size', kind: 'number', hint: 'Target profit pertama untuk jual sebagian.',
    quick: [20, 30, 40, 50], decimals: 2,
  },
  TP1_SELL_PERCENT: {
    key: 'TP1_SELL_PERCENT', emoji: '✂️', label: 'TP1 Jual', unit: '%',
    group: 'size', kind: 'number', hint: 'Porsi posisi yang dijual saat TP1 tercapai.',
    quick: [50, 70, 80, 100], decimals: 2,
  },
  TP2_PERCENT: {
    key: 'TP2_PERCENT', emoji: '🚀', label: 'TP2 Profit', unit: '%',
    group: 'size', kind: 'number', hint: 'Target profit kedua untuk tutup posisi.',
    quick: [40, 50, 80, 100], decimals: 2,
  },
  MOONBAG_PERCENT: {
    key: 'MOONBAG_PERCENT', emoji: '🌙', label: 'Porsi Moonbag', unit: '%',
    group: 'features', kind: 'number', hint: 'Sisa posisi yang dibiarkan terbang lama.',
    quick: [10, 15, 25, 30], decimals: 2,
    dependsOn: { key: 'MOONBAG_ENABLED', on: true },
  },
  MOONBAG_TRAIL_PERCENT: {
    key: 'MOONBAG_TRAIL_PERCENT', emoji: '🌠', label: 'Trail Moonbag', unit: '%',
    group: 'features', kind: 'number', hint: 'Turun berapa persen dari puncak untuk jual sisa.',
    quick: [20, 30, 40, 50], decimals: 2,
    dependsOn: { key: 'MOONBAG_ENABLED', on: true },
  },
  PRIORITY_FEE_BUY_SOL: {
    key: 'PRIORITY_FEE_BUY_SOL', emoji: '⛽', label: 'Fee Beli', unit: 'SOL',
    group: 'exec', kind: 'number', hint: 'Fee prioritas agar transaksi beli cepat.',
    quick: [0.00005, 0.0001, 0.0005, 0.001], decimals: 7,
  },
  PRIORITY_FEE_SELL_SOL: {
    key: 'PRIORITY_FEE_SELL_SOL', emoji: '🧾', label: 'Fee Jual', unit: 'SOL',
    group: 'exec', kind: 'number', hint: 'Fee prioritas agar transaksi jual cepat.',
    quick: [0.00005, 0.0001, 0.0005, 0.001], decimals: 7,
  },
  MAX_FEE_SOL: {
    key: 'MAX_FEE_SOL', emoji: '🧮', label: 'Fee Maks', unit: 'SOL',
    group: 'exec', kind: 'number', hint: 'Batas atas total fee per transaksi.',
    quick: [0.0001, 0.0005, 0.001, 0.005], decimals: 7,
  },
  PUMP_MAX_POSITIONS: {
    key: 'PUMP_MAX_POSITIONS', emoji: '📦', label: 'Maks Posisi', unit: '',
    group: 'entry', kind: 'number', hint: 'Jumlah posisi bersamaan paling banyak.',
    quick: [1, 2, 3, 5], decimals: 0,
  },
  PUMP_MAX_HOLD_MINUTES: {
    key: 'PUMP_MAX_HOLD_MINUTES', emoji: '⌛', label: 'Hold Maks', unit: 'mnt',
    group: 'entry', kind: 'number', hint: 'Lama pegang posisi sebelum jual otomatis.',
    quick: [5, 10, 15, 30], decimals: 0,
  },
  PUMP_MIN_DEV_BUY_SOL: {
    key: 'PUMP_MIN_DEV_BUY_SOL', emoji: '🟢', label: 'Dev Min', unit: 'SOL',
    group: 'entry', kind: 'number', hint: 'Batas bawah modal dev agar layak snipe.',
    quick: [0.3, 0.5, 1, 2], decimals: 3,
  },
  PUMP_MAX_DEV_BUY_SOL: {
    key: 'PUMP_MAX_DEV_BUY_SOL', emoji: '🔴', label: 'Dev Maks', unit: 'SOL',
    group: 'entry', kind: 'number', hint: 'Batas atas modal dev agar hindari paus.',
    quick: [3, 5, 10, 20], decimals: 3,
  },
  PUMP_MIN_MCAP_SOL: {
    key: 'PUMP_MIN_MCAP_SOL', emoji: '📊', label: 'MCap Min', unit: 'SOL',
    group: 'entry', kind: 'number', hint: 'Kapitalisasi pasar minimum untuk entry.',
    quick: [30, 35, 40, 50], decimals: 2,
  },
  PUMP_MAX_MCAP_SOL: {
    key: 'PUMP_MAX_MCAP_SOL', emoji: '📈', label: 'MCap Maks', unit: 'SOL',
    group: 'entry', kind: 'number', hint: 'Kapitalisasi pasar maksimum untuk entry.',
    quick: [60, 100, 150, 300], decimals: 2,
  },
  AUTO_SELL: {
    key: 'AUTO_SELL', emoji: '🤖', label: 'Auto Sell', unit: '',
    group: 'exec', kind: 'toggle', hint: 'Jual otomatis saat TP atau SL tercapai.',
    decimals: 0, confirmOff: 'Tanpa Auto Sell, TP/SL tidak akan menjual otomatis.',
  },
  ANTI_MEV: {
    key: 'ANTI_MEV', emoji: '🛡️', label: 'Anti MEV', unit: '',
    group: 'exec', kind: 'toggle', hint: 'Lindungi transaksi dari serangan MEV.',
    decimals: 0,
  },
  MOONBAG_ENABLED: {
    key: 'MOONBAG_ENABLED', emoji: '🌙', label: 'Moonbag', unit: '',
    group: 'features', kind: 'toggle', hint: 'Sisakan sebagian posisi untuk terbang jauh.',
    decimals: 0,
  },
  PUMP_SECURITY_CHECK: {
    key: 'PUMP_SECURITY_CHECK', emoji: '🔒', label: 'Security', unit: '',
    group: 'entry', kind: 'toggle', hint: 'Saring token honeypot sebelum membeli.',
    decimals: 0, confirmOff: 'Token honeypot tidak lagi disaring sebelum beli.',
  },
  TRAILING_TP_ENABLED: {
    key: 'TRAILING_TP_ENABLED', emoji: '🌊', label: 'Trailing TP', unit: '',
    group: 'features', kind: 'toggle', hint: 'Ikuti harga naik lalu kunci profit.',
    decimals: 0,
  },
  TRAILING_TP_DROP_PERCENT: {
    key: 'TRAILING_TP_DROP_PERCENT', emoji: '🔻', label: 'Trail Drop', unit: '%',
    group: 'features', kind: 'number', hint: 'Penurunan dari puncak untuk jual trailing.',
    quick: [10, 15, 20, 30], decimals: 2,
    dependsOn: { key: 'TRAILING_TP_ENABLED', on: true },
  },
  BUY_APPROVAL_ENABLED: {
    key: 'BUY_APPROVAL_ENABLED', emoji: '🕹', label: 'Approval', unit: '',
    group: 'features', kind: 'toggle', hint: 'Minta persetujuan sebelum setiap beli.',
    decimals: 0,
  },
  BUY_APPROVAL_TIMEOUT_SEC: {
    key: 'BUY_APPROVAL_TIMEOUT_SEC', emoji: '⏳', label: 'Tunggu Approve', unit: 'dtk',
    group: 'features', kind: 'number', hint: 'Batas tunggu persetujuan sebelum batal.',
    quick: [10, 20, 30, 60], decimals: 0,
    dependsOn: { key: 'BUY_APPROVAL_ENABLED', on: true },
  },
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
  for (const k of EDITABLE_CONFIG) {
    const key = k as EditableKey;
    if (SETTING_META[key]?.group !== group) continue;
    if (isVisible(key, config)) out.push(key);
  }
  return out;
}

export function hiddenNote(group: SettingGroup, config: Record<string, unknown>): string | null {
  const hidden: string[] = [];
  for (const k of EDITABLE_CONFIG) {
    const key = k as EditableKey;
    if (SETTING_META[key]?.group !== group) continue;
    if (!isVisible(key, config)) hidden.push(SETTING_META[key].label);
  }
  if (hidden.length === 0) return null;
  return `Tersembunyi karena fitur terkait OFF: ${hidden.join(', ')}`;
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
