/**
 * Design-grade Telegram settings menu (Stage 12A, pure logic, no wiring).
 *
 * No axios, no fs, no real CONFIG. `apply` and `config` are injected.
 */

import {
  EDITABLE_CONFIG,
  PRESETS,
  RANGES,
  parseValue,
  type EditableKey,
} from '../config/editable';
import { escapeHtml } from './config-commands';
import {
  GROUPS,
  SETTING_META,
  comfortRange,
  fmtNumber,
  fmtValue,
  hiddenNote,
  toDisplay,
  toStored,
  visibleKeys,
  type SettingGroup,
  type SettingMeta,
} from '../config/setting-meta';
import type { ConfigApply } from './config-commands';

export type Keyboard = { text: string; callback_data: string }[][];
export interface Screen {
  text: string;
  keyboard: Keyboard;
}

export const EXPIRED_MESSAGE = 'Menu kedaluwarsa, kirim /config lagi';
export const PARSE_FAIL_MSG = 'Ketik angka saja, mis. 15';

// ── Callback scheme ──────────────────────────────────────────────

export type ParsedCallback =
  | { kind: 'main' }
  | { kind: 'refresh' }
  | { kind: 'help' }
  | { kind: 'group'; group: SettingGroup }
  | { kind: 'select'; index: number; key: EditableKey }
  | { kind: 'toggle'; index: number; key: EditableKey }
  | { kind: 'quick'; index: number; key: EditableKey; quickIndex: number; display: number }
  | { kind: 'confirmYes' }
  | { kind: 'confirmRetype' }
  | { kind: 'cancel' }
  | { kind: 'undo' }
  | { kind: 'presets' }
  | { kind: 'presetPreview'; index: number; name: string }
  | { kind: 'presetApply'; index: number; name: string };

const GROUP_IDS = new Set<string>(['size', 'exec', 'entry', 'features']);

export function presetNames(): string[] {
  return Object.keys(PRESETS);
}

export function keyIndex(key: string): number {
  return (EDITABLE_CONFIG as readonly string[]).indexOf(key);
}

function isIntStr(s: string): boolean {
  return /^(0|[1-9]\d*)$/.test(s);
}

/** Parse callback_data; null for anything malformed or out of range. Never throws. */
export function parseCallback(data: string): ParsedCallback | null {
  try {
    if (typeof data !== 'string' || !data.startsWith('cfg:')) return null;
    const rest = data.slice(4);
    if (rest === 'm') return { kind: 'main' };
    if (rest === 'r') return { kind: 'refresh' };
    if (rest === 'h') return { kind: 'help' };
    if (rest === 'cy') return { kind: 'confirmYes' };
    if (rest === 'cr') return { kind: 'confirmRetype' };
    if (rest === 'x') return { kind: 'cancel' };
    if (rest === 'u') return { kind: 'undo' };
    if (rest === 'p') return { kind: 'presets' };
    const parts = rest.split(':');
    if (parts[0] === 'g' && parts.length === 2) {
      if (!GROUP_IDS.has(parts[1])) return null;
      return { kind: 'group', group: parts[1] as SettingGroup };
    }
    if ((parts[0] === 'k' || parts[0] === 't') && parts.length === 2) {
      if (!isIntStr(parts[1])) return null;
      const i = Number(parts[1]);
      if (i < 0 || i >= EDITABLE_CONFIG.length) return null;
      const key = EDITABLE_CONFIG[i] as EditableKey;
      return parts[0] === 'k'
        ? { kind: 'select', index: i, key }
        : { kind: 'toggle', index: i, key };
    }
    if (parts[0] === 'q' && parts.length === 3) {
      if (!isIntStr(parts[1]) || !isIntStr(parts[2])) return null;
      const i = Number(parts[1]);
      const n = Number(parts[2]);
      if (i < 0 || i >= EDITABLE_CONFIG.length) return null;
      const key = EDITABLE_CONFIG[i] as EditableKey;
      const quick = SETTING_META[key]?.quick;
      if (!quick || n < 0 || n >= quick.length) return null;
      return { kind: 'quick', index: i, key, quickIndex: n, display: quick[n] };
    }
    if ((parts[0] === 'pp' || parts[0] === 'pa') && parts.length === 2) {
      if (!isIntStr(parts[1])) return null;
      const names = presetNames();
      const i = Number(parts[1]);
      if (i < 0 || i >= names.length) return null;
      return parts[0] === 'pp'
        ? { kind: 'presetPreview', index: i, name: names[i] }
        : { kind: 'presetApply', index: i, name: names[i] };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Formatting helpers ───────────────────────────────────────────

function boolIcon(v: unknown): string {
  return v === true ? '✅' : '⬜';
}

function groupInfo(id: SettingGroup) {
  const g = GROUPS.find((x) => x.id === id);
  if (!g) throw new Error(`Unknown group: ${id}`);
  return g;
}

/** Plain (no HTML) range text in display units with unit, e.g. "$10 – $1.000". */
export function rangeText(key: string): string {
  const meta = (SETTING_META as Record<string, (typeof SETTING_META)[EditableKey] | undefined>)[key];
  const range = RANGES[key];
  if (!range) return '-';
  const loD = toDisplay(key, range.min);
  const hiD = toDisplay(key, range.max);
  const lo = fmtNumber(loD, meta?.decimals ?? 2);
  const hi = fmtNumber(hiD, meta?.decimals ?? 2);
  const unit = meta?.unit ?? '';
  if (unit === '$') return `$${lo} – $${hi}`;
  if (unit === 'SOL') return `${lo} SOL – ${hi} SOL`;
  if (unit === '%') return `${lo}% – ${hi}%`;
  if (unit === 'mnt') return `${lo} mnt – ${hi} mnt`;
  if (unit === 'dtk') return `${lo} dtk – ${hi} dtk`;
  return `${lo} – ${hi}`;
}

/** Plain comfort-zone text in display units with unit. */
export function comfortText(key: EditableKey): string {
  const meta = SETTING_META[key];
  const c = comfortRange(key);
  if (!c) return '-';
  const lo = fmtNumber(c[0], meta.decimals);
  const hi = fmtNumber(c[1], meta.decimals);
  const unit = meta.unit;
  if (unit === '$') return `$${lo} – $${hi}`;
  if (unit === 'SOL') return `${lo} SOL – ${hi} SOL`;
  if (unit === '%') return `${lo}% – ${hi}%`;
  if (unit === 'mnt') return `${lo} mnt – ${hi} mnt`;
  if (unit === 'dtk') return `${lo} dtk – ${hi} dtk`;
  return `${lo} – ${hi}`;
}

function withUndoRow(kb: Keyboard, banner: string | undefined): Keyboard {
  if (banner && banner.startsWith('✅')) {
    return [...kb, [{ text: '↩️ Urungkan', callback_data: 'cfg:u' }]];
  }
  return kb;
}

// ── Banners ──────────────────────────────────────────────────────

export function successBannerSingle(key: EditableKey, before: unknown, after: unknown): string {
  const label = SETTING_META[key].label;
  return `✅ <b>${escapeHtml(label)}</b>: ${escapeHtml(fmtValue(key, before))} → <b>${escapeHtml(fmtValue(key, after))}</b>`;
}

export function undoneBannerSingle(key: EditableKey, before: unknown): string {
  const label = SETTING_META[key].label;
  return `↩️ <b>${escapeHtml(label)}</b> dikembalikan ke <b>${escapeHtml(fmtValue(key, before))}</b>`;
}

export function presetAppliedBanner(name: string, n: number): string {
  return `✅ <b>Preset ${escapeHtml(name)}</b> diterapkan (${n} setelan)`;
}

export function presetUndoneBanner(name: string, n: number): string {
  return `↩️ <b>Preset ${escapeHtml(name)}</b> dibatalkan (${n} setelan)`;
}

// ── Screens ──────────────────────────────────────────────────────

export function renderMain(config: Record<string, unknown>, banner?: string): Screen {
  const lines: string[] = [];
  if (banner) lines.push(banner);
  lines.push('⚙️ <b>Pengaturan Sniper</b>');
  const isLive = config['PAPER_TRADING'] === false;
  const modePart = isLive ? '🔴 Mode <b>LIVE</b>' : '📝 Mode <b>PAPER</b>';
  const usd = config['BUY_AMOUNT_USD'];
  const buyStr =
    typeof usd === 'number' && usd > 0
      ? fmtValue('BUY_AMOUNT_USD', usd)
      : fmtValue('BUY_AMOUNT_SOL', config['BUY_AMOUNT_SOL']);
  lines.push(`${modePart} · 💵 Beli <b>${escapeHtml(buyStr)}</b> / trade`);
  lines.push('');
  const tp1 = fmtValue('TP1_PERCENT', config['TP1_PERCENT']);
  const tp1sellRaw = config['TP1_SELL_PERCENT'];
  const tp1sell = typeof tp1sellRaw === 'number' && Number.isFinite(tp1sellRaw) ? fmtNumber(tp1sellRaw, 2) : '-';
  const tp2 = fmtValue('TP2_PERCENT', config['TP2_PERCENT']);
  const sl = fmtValue('STOP_LOSS_PERCENT', config['STOP_LOSS_PERCENT']);
  lines.push(`🎯 Exit  TP1 <b>${escapeHtml(tp1)}</b> (jual ${escapeHtml(tp1sell)}%) · TP2 <b>${escapeHtml(tp2)}</b> · SL <b>${escapeHtml(sl)}</b>`);
  if (config['MOONBAG_ENABLED'] === true) {
    const mb = fmtValue('MOONBAG_PERCENT', config['MOONBAG_PERCENT']);
    const tr = fmtValue('MOONBAG_TRAIL_PERCENT', config['MOONBAG_TRAIL_PERCENT']);
    lines.push(`🌙 Moonbag <b>${escapeHtml(mb)}</b> · trail <b>${escapeHtml(tr)}</b>`);
  } else {
    lines.push('🌙 Moonbag <b>OFF</b>');
  }
  const posRaw = config['PUMP_MAX_POSITIONS'];
  const holdRaw = config['PUMP_MAX_HOLD_MINUTES'];
  const devMinRaw = config['PUMP_MIN_DEV_BUY_SOL'];
  const devMaxRaw = config['PUMP_MAX_DEV_BUY_SOL'];
  const pos = typeof posRaw === 'number' && Number.isFinite(posRaw) ? fmtNumber(posRaw, 0) : '-';
  const hold = typeof holdRaw === 'number' && Number.isFinite(holdRaw) ? fmtNumber(holdRaw, 0) : '-';
  const devMin = typeof devMinRaw === 'number' && Number.isFinite(devMinRaw) ? fmtNumber(devMinRaw, 3) : '-';
  const devMax = typeof devMaxRaw === 'number' && Number.isFinite(devMaxRaw) ? fmtNumber(devMaxRaw, 3) : '-';
  lines.push(`🔎 Entry  maks <b>${escapeHtml(pos)}</b> posisi · hold maks <b>${escapeHtml(hold)}</b> mnt · dev buy <b>${escapeHtml(devMin)}</b>–<b>${escapeHtml(devMax)}</b> SOL`);
  lines.push(
    `🛡 Fitur  Security ${boolIcon(config['PUMP_SECURITY_CHECK'])} · Trailing TP ${boolIcon(config['TRAILING_TP_ENABLED'])} · Approval ${boolIcon(config['BUY_APPROVAL_ENABLED'])} · Auto sell ${boolIcon(config['AUTO_SELL'])}`,
  );
  lines.push('');
  lines.push('<i>Pilih kategori, lalu ketuk setelan yang mau diubah.</i>');
  const kb: Keyboard = [
    [
      { text: '💰 Ukuran & Exit', callback_data: 'cfg:g:size' },
      { text: '⛽ Eksekusi & Biaya', callback_data: 'cfg:g:exec' },
    ],
    [
      { text: '🔎 Filter Entry', callback_data: 'cfg:g:entry' },
      { text: '🛡 Fitur ON/OFF', callback_data: 'cfg:g:features' },
    ],
    [
      { text: '📦 Preset', callback_data: 'cfg:p' },
      { text: '❓ Bantuan', callback_data: 'cfg:h' },
    ],
    [{ text: '🔄 Segarkan', callback_data: 'cfg:r' }],
  ];
  return { text: lines.join('\n'), keyboard: withUndoRow(kb, banner) };
}

export function renderGroup(group: SettingGroup, config: Record<string, unknown>, banner?: string): Screen {
  const info = groupInfo(group);
  const lines: string[] = [];
  if (banner) lines.push(banner);
  lines.push(`${info.emoji} <b>${info.title}</b>`);
  lines.push(info.blurb);
  const note = hiddenNote(group, config);
  if (note) lines.push(`<i>${escapeHtml(note)}</i>`);
  const kb: Keyboard = [];
  const keys = visibleKeys(group, config);
  for (let i = 0; i < keys.length; i += 2) {
    const row: { text: string; callback_data: string }[] = [];
    for (const key of keys.slice(i, i + 2)) {
      const meta = SETTING_META[key];
      const idx = keyIndex(key);
      if (meta.kind === 'toggle') {
        const on = config[key] === true;
        row.push({ text: `${on ? '✅' : '⬜'} ${meta.label}`, callback_data: `cfg:t:${idx}` });
      } else {
        row.push({
          text: `${meta.emoji} ${meta.label} · ${fmtValue(key, config[key])}`,
          callback_data: `cfg:k:${idx}`,
        });
      }
    }
    kb.push(row);
  }
  kb.push([{ text: '⬅️ Menu', callback_data: 'cfg:m' }]);
  return { text: lines.join('\n'), keyboard: withUndoRow(kb, banner) };
}

export function renderPrompt(key: EditableKey, config: Record<string, unknown>, opts?: { error?: string }): Screen {
  const meta = SETTING_META[key];
  const current = fmtValue(key, config[key]);
  const lines: string[] = [];
  if (opts?.error) lines.push(`❌ ${escapeHtml(opts.error)}`);
  lines.push(`${meta.emoji} <b>${escapeHtml(meta.label)}</b>`);
  lines.push(`Sekarang: <b>${escapeHtml(current)}</b>`);
  lines.push(`Rentang: <b>${escapeHtml(rangeText(key))}</b>`);
  lines.push(`<i>${escapeHtml(meta.hint)}</i>`);
  lines.push('');
  const quick = meta.quick ?? [];
  const example = quick.length > 0 ? fmtNumber(quick[Math.floor(quick.length / 2)], meta.decimals) : '15';
  lines.push(`✏️ Ketik angkanya saja (mis. <code>${escapeHtml(example)}</code>) atau pilih cepat.`);
  lines.push('⏱ Berlaku 2 menit · ketik <code>batal</code> untuk keluar');
  const kb: Keyboard = [];
  if (quick.length > 0) {
    const idx = keyIndex(key);
    const row = quick.map((q, n) => {
      const stored = toStored(key, q);
      const label = fmtValue(key, stored);
      const isCurrent = (config[key] as unknown) === stored;
      return { text: `${isCurrent ? '✓ ' : ''}${label}`, callback_data: `cfg:q:${idx}:${n}` };
    });
    kb.push(row);
  }
  kb.push([{ text: '⬅️ Kembali', callback_data: `cfg:g:${meta.group}` }]);
  return { text: lines.join('\n'), keyboard: kb };
}

export function renderConfirmValue(key: EditableKey, before: unknown, after: unknown): Screen {
  const meta = SETTING_META[key];
  const text = [
    '⚠️ <b>Nilai di luar kebiasaan</b>',
    `${meta.emoji} ${escapeHtml(meta.label)}: ${escapeHtml(fmtValue(key, before))} → <b>${escapeHtml(fmtValue(key, after))}</b>`,
    `Kisaran yang biasa dipakai: ${escapeHtml(comfortText(key))}.`,
    'Yakin menerapkannya?',
  ].join('\n');
  return {
    text,
    keyboard: [
      [
        { text: '✅ Ya, terapkan', callback_data: 'cfg:cy' },
        { text: '✏️ Ketik ulang', callback_data: 'cfg:cr' },
      ],
      [{ text: '↩️ Batal', callback_data: 'cfg:x' }],
    ],
  };
}

export function renderConfirmToggle(key: EditableKey): Screen {
  const meta = SETTING_META[key];
  const text = [
    `⚠️ <b>Matikan ${escapeHtml(meta.label)}?</b>`,
    escapeHtml(meta.confirmOff ?? ''),
  ].join('\n');
  return {
    text,
    keyboard: [
      [{ text: '✅ Ya, matikan', callback_data: 'cfg:cy' }],
      [{ text: '↩️ Batal', callback_data: 'cfg:x' }],
    ],
  };
}

export function renderConfirm(
  kind: 'value' | 'toggle',
  key: EditableKey,
  before?: unknown,
  after?: unknown,
): Screen {
  if (kind === 'toggle') return renderConfirmToggle(key);
  return renderConfirmValue(key, before, after);
}

export function renderPresets(config: Record<string, unknown>, banner?: string): Screen {
  void config;
  const lines = ['📦 <b>Preset</b>', '<i>Pilih preset untuk pratinjau sebelum diterapkan.</i>'];
  if (banner) lines.unshift(banner);
  const names = presetNames();
  const kb: Keyboard = names.map((name, i) => [{ text: `📦 ${name}`, callback_data: `cfg:pp:${i}` }]);
  kb.push([{ text: '⬅️ Menu', callback_data: 'cfg:m' }]);
  return { text: lines.join('\n'), keyboard: withUndoRow(kb, banner) };
}

export function renderPresetPreview(presetName: string, config: Record<string, unknown>, banner?: string): Screen {
  const preset = PRESETS[presetName] as Record<string, number | boolean> | undefined;
  const names = presetNames();
  const idx = names.indexOf(presetName);
  const lines: string[] = [];
  if (banner) lines.push(banner);
  lines.push(`📦 <b>Preset ${escapeHtml(presetName)}</b>`);
  if (!preset) {
    lines.push('Preset tidak ditemukan.');
    return { text: lines.join('\n'), keyboard: [[{ text: '↩️ Kembali', callback_data: 'cfg:p' }]] };
  }
  const changed: string[] = [];
  for (const [k, v] of Object.entries(preset)) {
    if ((config as Record<string, unknown>)[k] === v) continue;
    const meta = (SETTING_META as Record<string, SettingMeta | undefined>)[k];
    const emoji = meta?.emoji ?? '•';
    const label = meta?.label ?? k;
    changed.push(`${emoji} ${escapeHtml(label)}: ${escapeHtml(fmtValue(k, (config as Record<string, unknown>)[k]))} → <b>${escapeHtml(fmtValue(k, v))}</b>`);
  }
  if (changed.length === 0) {
    lines.push('Tidak ada yang berubah (sudah sesuai preset).');
    return { text: lines.join('\n'), keyboard: [[{ text: '↩️ Kembali', callback_data: 'cfg:p' }]] };
  }
  lines.push(...changed);
  return {
    text: lines.join('\n'),
    keyboard: [
      [
        { text: '✅ Terapkan', callback_data: `cfg:pa:${idx}` },
        { text: '↩️ Batal', callback_data: 'cfg:p' },
      ],
    ],
  };
}

export function renderHelp(): Screen {
  const text = [
    '❓ <b>Bantuan Pengaturan</b>',
    '1️⃣ Ketuk setelan, lalu ketik angkanya saja.',
    '🔀 Ketuk tombol ✅/⬜ untuk nyala/mati.',
    '↩️ Perubahan bisa diurungkan 5 menit.',
    '⚠️ Nilai tak biasa minta konfirmasi dulu.',
    '⌨️ Ketik <code>batal</code> untuk keluar.',
    '🔧 <code>/set</code> dan <code>/preset</code> tetap bisa dipakai.',
  ].join('\n');
  return { text, keyboard: [[{ text: '⬅️ Menu', callback_data: 'cfg:m' }]] };
}

// ── Session store ────────────────────────────────────────────────

export interface PendingInput {
  key: EditableKey;
  messageId: number;
  expiresAt: number;
}

export interface PendingConfirm {
  kind: 'value' | 'toggle' | 'preset';
  key?: EditableKey;
  value?: number | boolean;
  presetName?: string;
  messageId: number;
  expiresAt: number;
}

export interface UndoItem {
  key: EditableKey;
  before: unknown;
  after: unknown;
}

export interface LastChange {
  items: UndoItem[];
  messageId: number;
  expiresAt: number;
  presetName?: string;
}

export interface MenuSessionsOptions {
  now?: () => number;
  inputTtlMs?: number;
  undoTtlMs?: number;
}

export class MenuSessions {
  private store = new Map<string, { input?: PendingInput; confirm?: PendingConfirm; undo?: LastChange }>();
  private now: () => number;
  private inputTtlMs: number;
  private undoTtlMs: number;

  constructor(opts?: MenuSessionsOptions) {
    this.now = opts?.now ?? Date.now;
    this.inputTtlMs = opts?.inputTtlMs ?? 120000;
    this.undoTtlMs = opts?.undoTtlMs ?? 300000;
  }

  private entry(chatId: string) {
    let e = this.store.get(chatId);
    if (!e) {
      e = {};
      this.store.set(chatId, e);
    }
    return e;
  }

  private purgeEntry(chatId: string): boolean {
    const e = this.store.get(chatId);
    if (!e) return false;
    const t = this.now();
    if (e.input && e.input.expiresAt <= t) delete e.input;
    if (e.confirm && e.confirm.expiresAt <= t) delete e.confirm;
    if (e.undo && e.undo.expiresAt <= t) delete e.undo;
    if (!e.input && !e.confirm && !e.undo) {
      this.store.delete(chatId);
      return false;
    }
    return true;
  }

  setInput(chatId: string, key: EditableKey, messageId: number): void {
    this.entry(chatId).input = { key, messageId, expiresAt: this.now() + this.inputTtlMs };
  }

  getInput(chatId: string): PendingInput | null {
    this.purgeEntry(chatId);
    return this.store.get(chatId)?.input ?? null;
  }

  clearInput(chatId: string): void {
    const e = this.store.get(chatId);
    if (e) {
      delete e.input;
      if (!e.input && !e.confirm && !e.undo) this.store.delete(chatId);
    }
  }

  setConfirm(chatId: string, c: Omit<PendingConfirm, 'expiresAt'>): void {
    this.entry(chatId).confirm = { ...c, expiresAt: this.now() + this.inputTtlMs };
  }

  getConfirm(chatId: string): PendingConfirm | null {
    this.purgeEntry(chatId);
    return this.store.get(chatId)?.confirm ?? null;
  }

  clearConfirm(chatId: string): void {
    const e = this.store.get(chatId);
    if (e) {
      delete e.confirm;
      if (!e.input && !e.confirm && !e.undo) this.store.delete(chatId);
    }
  }

  setUndo(chatId: string, items: UndoItem[], messageId: number, presetName?: string): void {
    this.entry(chatId).undo = { items, messageId, expiresAt: this.now() + this.undoTtlMs, presetName };
  }

  getUndo(chatId: string): LastChange | null {
    this.purgeEntry(chatId);
    return this.store.get(chatId)?.undo ?? null;
  }

  clearUndo(chatId: string): void {
    const e = this.store.get(chatId);
    if (e) {
      delete e.undo;
      if (!e.input && !e.confirm && !e.undo) this.store.delete(chatId);
    }
  }

  clearAll(chatId: string): void {
    this.store.delete(chatId);
  }

  size(): number {
    for (const k of [...this.store.keys()]) this.purgeEntry(k);
    return this.store.size;
  }
}

// ── Numeric input ────────────────────────────────────────────────

const NUMBER_LITERAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const TRAILING_UNIT = /\s*(%|sol|mnt|menit|dtk|detik|bps|x)\s*$/i;

export type NumericParse =
  | { ok: true; stored: number; display: number }
  | { ok: false; error: string };

export function parseNumericInput(key: string, raw: string): NumericParse {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: PARSE_FAIL_MSG };
  let s = trimmed;
  if (s.startsWith('$')) {
    s = s.slice(1).trim();
    if (s === '') return { ok: false, error: PARSE_FAIL_MSG };
  }
  s = s.replace(TRAILING_UNIT, '').trim();
  if (s === '') return { ok: false, error: PARSE_FAIL_MSG };
  s = s.replace(/,/g, '.');
  if (!NUMBER_LITERAL.test(s)) return { ok: false, error: PARSE_FAIL_MSG };
  const display = Number(s);
  if (typeof display !== 'number' || Number.isNaN(display)) {
    return { ok: false, error: PARSE_FAIL_MSG };
  }
  const stored = toStored(key, display);
  const check = parseValue(key, String(stored));
  if (typeof check === 'string') {
    return { ok: false, error: `${check}\nRentang: ${rangeText(key)}` };
  }
  return { ok: true, stored, display };
}

// ── Handlers ─────────────────────────────────────────────────────

export interface MenuCtx {
  chatId: string;
  messageId?: number;
  config: Record<string, unknown>;
  apply: ConfigApply;
  sessions: MenuSessions;
  liveAllowed?: boolean;
}

export interface CallbackResult {
  answer?: string;
  alert?: boolean;
  edit?: Screen;
}

function expired(): CallbackResult {
  return { answer: EXPIRED_MESSAGE, alert: true };
}

function groupOf(key: EditableKey): SettingGroup {
  return SETTING_META[key].group;
}

function errorBanner(err: string): string {
  return `❌ ${escapeHtml(err)}`;
}

export function handleConfigCallback(data: string, ctx: MenuCtx): CallbackResult {
  const parsed = parseCallback(data);
  if (!parsed) return expired();
  const { config, sessions, chatId } = ctx;
  const msgId = ctx.messageId ?? 0;

  switch (parsed.kind) {
    case 'main':
      return { edit: renderMain(config) };
    case 'refresh':
      return { edit: renderMain(config) };
    case 'help':
      return { edit: renderHelp() };
    case 'group':
      return { edit: renderGroup(parsed.group, config) };
    case 'select': {
      sessions.setInput(chatId, parsed.key, msgId);
      return { edit: renderPrompt(parsed.key, config) };
    }
    case 'toggle': {
      const key = parsed.key;
      const meta = SETTING_META[key];
      const before: unknown = config[key];
      const after = before === true ? false : true;
      if (meta.confirmOff && after === false) {
        sessions.setConfirm(chatId, { kind: 'toggle', key, value: after, messageId: msgId });
        return { edit: renderConfirm('toggle', key) };
      }
      const err = ctx.apply({ [key]: after });
      if (err) return { edit: renderGroup(groupOf(key), config, errorBanner(err)) };
      sessions.setUndo(chatId, [{ key, before, after }], msgId);
      return { edit: renderGroup(groupOf(key), config, successBannerSingle(key, before, after)) };
    }
    case 'quick': {
      const key = parsed.key;
      const before: unknown = config[key];
      const stored = toStored(key, parsed.display);
      const err = ctx.apply({ [key]: stored });
      if (err) return { edit: renderGroup(groupOf(key), config, errorBanner(err)) };
      sessions.setUndo(chatId, [{ key, before, after: stored }], msgId);
      return { edit: renderGroup(groupOf(key), config, successBannerSingle(key, before, stored)) };
    }
    case 'confirmYes': {
      const c = sessions.getConfirm(chatId);
      if (!c) return expired();
      if (c.kind === 'value' && c.key !== undefined && typeof c.value === 'number') {
        const key = c.key;
        const before: unknown = config[key];
        const err = ctx.apply({ [key]: c.value });
        if (err) {
          sessions.clearConfirm(chatId);
          sessions.setInput(chatId, key, c.messageId);
          return { edit: renderPrompt(key, config, { error: err }) };
        }
        sessions.clearConfirm(chatId);
        sessions.setUndo(chatId, [{ key, before, after: c.value }], c.messageId);
        return { edit: renderGroup(groupOf(key), config, successBannerSingle(key, before, c.value)) };
      }
      if (c.kind === 'toggle' && c.key !== undefined && typeof c.value === 'boolean') {
        const key = c.key;
        const before: unknown = config[key];
        const err = ctx.apply({ [key]: c.value });
        if (err) {
          sessions.clearConfirm(chatId);
          return { edit: renderGroup(groupOf(key), config, errorBanner(err)) };
        }
        sessions.clearConfirm(chatId);
        sessions.setUndo(chatId, [{ key, before, after: c.value }], c.messageId);
        return { edit: renderGroup(groupOf(key), config, successBannerSingle(key, before, c.value)) };
      }
      if (c.kind === 'preset' && c.presetName) {
        return applyPreset(c.presetName, ctx, c.messageId);
      }
      return expired();
    }
    case 'confirmRetype': {
      const c = sessions.getConfirm(chatId);
      if (!c || c.kind !== 'value' || !c.key) return expired();
      sessions.clearConfirm(chatId);
      sessions.setInput(chatId, c.key, c.messageId);
      return { edit: renderPrompt(c.key, config) };
    }
    case 'cancel': {
      const c = sessions.getConfirm(chatId);
      if (!c) return expired();
      sessions.clearConfirm(chatId);
      sessions.clearInput(chatId);
      if (c.kind === 'preset') return { edit: renderPresets(config) };
      if (c.key) return { edit: renderGroup(groupOf(c.key), config) };
      return { edit: renderMain(config) };
    }
    case 'undo': {
      const u = sessions.getUndo(chatId);
      if (!u) return expired();
      const restore: Record<string, number | boolean> = {};
      for (const it of u.items) restore[it.key] = it.before as number | boolean;
      const err = ctx.apply(restore);
      if (err) {
        sessions.clearUndo(chatId);
        return { edit: renderMain(config, errorBanner(err)) };
      }
      sessions.clearUndo(chatId);
      if (u.presetName) {
        const banner = presetUndoneBanner(u.presetName, u.items.length);
        return { edit: renderPresets(config, banner) };
      }
      if (u.items.length === 1) {
        const it = u.items[0];
        return { edit: renderGroup(groupOf(it.key), config, undoneBannerSingle(it.key, it.before)) };
      }
      const firstGroup = groupOf(u.items[0].key);
      const same = u.items.every((it) => groupOf(it.key) === firstGroup);
      const banner = undoneBannerSingle(u.items[0].key, u.items[0].before);
      if (same) return { edit: renderGroup(firstGroup, config, banner) };
      return { edit: renderMain(config, banner) };
    }
    case 'presets':
      return { edit: renderPresets(config) };
    case 'presetPreview':
      return { edit: renderPresetPreview(parsed.name, config) };
    case 'presetApply':
      return applyPreset(parsed.name, ctx, msgId);
    default:
      return expired();
  }
}

function applyPreset(name: string, ctx: MenuCtx, msgId: number): CallbackResult {
  const { config, sessions, chatId } = ctx;
  const preset = PRESETS[name] as Record<string, number | boolean> | undefined;
  if (!preset) return expired();
  const before: UndoItem[] = [];
  for (const [k, v] of Object.entries(preset)) {
    if ((config as Record<string, unknown>)[k] !== v) {
      before.push({ key: k as EditableKey, before: (config as Record<string, unknown>)[k], after: v });
    }
  }
  if (before.length === 0) return { edit: renderPresetPreview(name, config) };
  const err = ctx.apply({ ...preset });
  if (err) return { edit: renderPresetPreview(name, config, errorBanner(err)) };
  sessions.clearConfirm(chatId);
  sessions.setUndo(chatId, before, msgId, name);
  return { edit: renderPresets(config, presetAppliedBanner(name, before.length)) };
}

export interface TextResult {
  consumed: boolean;
  replies: string[];
  edit?: { messageId: number; screen: Screen };
}

const CANCEL_RE = /^(batal|cancel)$/i;

export function handleConfigText(text: string, ctx: MenuCtx): TextResult {
  const { sessions, chatId, config } = ctx;
  if (text.startsWith('/')) {
    sessions.clearInput(chatId);
    return { consumed: false, replies: [] };
  }
  const pending = sessions.getInput(chatId);
  if (!pending) return { consumed: false, replies: [] };
  const key = pending.key;
  const trimmed = text.trim();
  if (CANCEL_RE.test(trimmed)) {
    sessions.clearInput(chatId);
    return { consumed: true, replies: [], edit: { messageId: pending.messageId, screen: renderGroup(groupOf(key), config) } };
  }
  const parsed = parseNumericInput(key, trimmed);
  if (!parsed.ok) {
    sessions.setInput(chatId, key, pending.messageId);
    return { consumed: true, replies: [], edit: { messageId: pending.messageId, screen: renderPrompt(key, config, { error: parsed.error }) } };
  }
  const comfort = comfortRange(key);
  if (comfort && (parsed.display < comfort[0] || parsed.display > comfort[1])) {
    sessions.clearInput(chatId);
    sessions.setConfirm(chatId, { kind: 'value', key, value: parsed.stored, messageId: pending.messageId });
    return { consumed: true, replies: [], edit: { messageId: pending.messageId, screen: renderConfirmValue(key, config[key], parsed.stored) } };
  }
  const before: unknown = config[key];
  const err = ctx.apply({ [key]: parsed.stored });
  if (err) {
    sessions.setInput(chatId, key, pending.messageId);
    return { consumed: true, replies: [], edit: { messageId: pending.messageId, screen: renderPrompt(key, config, { error: err }) } };
  }
  sessions.clearInput(chatId);
  sessions.setUndo(chatId, [{ key, before, after: parsed.stored }], pending.messageId);
  return {
    consumed: true,
    replies: [],
    edit: { messageId: pending.messageId, screen: renderGroup(groupOf(key), config, successBannerSingle(key, before, parsed.stored)) },
  };
}

// ── Golden screens ───────────────────────────────────────────────

export function sampleConfig(): Record<string, unknown> {
  return {
    PAPER_TRADING: true,
    BUY_AMOUNT_USD: 10,
    BUY_AMOUNT_SOL: 0.05,
    STOP_LOSS_PERCENT: 25,
    TP1_PERCENT: 30,
    TP1_SELL_PERCENT: 80,
    TP2_PERCENT: 50,
    MOONBAG_ENABLED: true,
    MOONBAG_PERCENT: 25,
    MOONBAG_TRAIL_PERCENT: 30,
    MAX_SLIPPAGE_BPS: 200,
    PRIORITY_FEE_BUY_SOL: 0.0000712,
    PRIORITY_FEE_SELL_SOL: 0.0000712,
    MAX_FEE_SOL: 0.00009,
    PUMP_MAX_POSITIONS: 3,
    PUMP_MAX_HOLD_MINUTES: 30,
    PUMP_MIN_DEV_BUY_SOL: 0.5,
    PUMP_MAX_DEV_BUY_SOL: 3,
    PUMP_MIN_MCAP_SOL: 30,
    PUMP_MAX_MCAP_SOL: 100,
    AUTO_SELL: true,
    ANTI_MEV: false,
    PUMP_SECURITY_CHECK: true,
    TRAILING_TP_ENABLED: false,
    TRAILING_TP_DROP_PERCENT: 15,
    BUY_APPROVAL_ENABLED: false,
    BUY_APPROVAL_TIMEOUT_SEC: 20,
  };
}

export interface NamedScreen {
  name: string;
  screen: Screen;
}

export function buildGoldenScreens(sample: Record<string, unknown>): NamedScreen[] {
  const noChange = { ...(sample as Record<string, unknown>), ...(PRESETS['lowrisk'] as Record<string, number | boolean>) };
  const bannerUndo = successBannerSingle('BUY_AMOUNT_USD', 10, 15);
  return [
    { name: 'main', screen: renderMain(sample) },
    { name: 'main-moonbag-off', screen: renderMain({ ...sample, MOONBAG_ENABLED: false }) },
    { name: 'main-live', screen: renderMain({ ...sample, PAPER_TRADING: false }) },
    { name: 'group-size', screen: renderGroup('size', sample) },
    { name: 'group-exec', screen: renderGroup('exec', sample) },
    { name: 'group-entry', screen: renderGroup('entry', sample) },
    { name: 'group-features', screen: renderGroup('features', sample) },
    { name: 'group-size-usd-off', screen: renderGroup('size', { ...sample, BUY_AMOUNT_USD: 0 }) },
    { name: 'prompt-buy-usd', screen: renderPrompt('BUY_AMOUNT_USD', sample) },
    { name: 'prompt-slippage', screen: renderPrompt('MAX_SLIPPAGE_BPS', sample) },
    { name: 'prompt-hold', screen: renderPrompt('PUMP_MAX_HOLD_MINUTES', sample) },
    { name: 'prompt-with-error', screen: renderPrompt('BUY_AMOUNT_USD', sample, { error: PARSE_FAIL_MSG }) },
    { name: 'confirm-value', screen: renderConfirmValue('BUY_AMOUNT_USD', 10, 100) },
    { name: 'confirm-toggle-off', screen: renderConfirmToggle('PUMP_SECURITY_CHECK') },
    { name: 'presets', screen: renderPresets(sample) },
    { name: 'preset-preview', screen: renderPresetPreview('lowrisk', sample) },
    { name: 'preset-preview-nochange', screen: renderPresetPreview('lowrisk', noChange) },
    { name: 'help', screen: renderHelp() },
    {
      name: 'group-size-with-banner-and-undo',
      screen: renderGroup('size', { ...sample, BUY_AMOUNT_USD: 15 }, bannerUndo),
    },
  ];
}

export function formatGolden(screens: NamedScreen[]): string {
  const parts: string[] = [];
  for (const { name, screen } of screens) {
    const rows = screen.keyboard.map((row) => row.map((b) => `[${b.text}]`).join(' ')).join('\n');
    const cbs = screen.keyboard.flatMap((row) => row.map((b) => b.callback_data)).join(' | ');
    parts.push(`=== ${name} ===\n${screen.text}\n---\n${rows}\ncallbacks: ${cbs}`);
  }
  return parts.join('\n\n') + '\n';
}
