/**
 * Safe HTML helpers for Telegram messages (Stage 9b-A).
 *
 * Pure module: no axios, no I/O. Centralises escaping + allow-listed links
 * for token-controlled text (name, symbol, url, tweet text, keywords, dex).
 */

import { escapeHtml } from './config-commands';

export { escapeHtml };

const ALLOWED_LINK_HOSTS = new Set(['pump.fun', 'dexscreener.com', 'solscan.io']);

/**
 * Escape arbitrary text for Telegram HTML and truncate to 200 chars.
 * `String(v ?? '')` keeps numbers/booleans printable; null/undefined -> ''.
 */
export function safeText(v: unknown): string {
  return escapeHtml(String(v ?? '')).slice(0, 200);
}

/**
 * Allow-listed chart link. Returns `<a href="url">label</a>` (both escaped)
 * only when the URL parses as https with a host exactly in the allow-list;
 * otherwise returns just the escaped label (no clickable attacker URL).
 * Rejects userinfo (https://pump.fun@evil.com), look-alikes
 * (pump.fun.evil.com), and non-https schemes (javascript:/data:).
 */
export function safeLink(url: string, label: string): string {
  const safeLabel = escapeHtml(String(label ?? ''));
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') return safeLabel;
    // new URL() puts userinfo into username/hostname separately: userinfo
    // like pump.fun@evil.com yields hostname evil.com -> rejected.
    if (parsed.username || parsed.password) return safeLabel;
    if (!ALLOWED_LINK_HOSTS.has(parsed.hostname.toLowerCase())) return safeLabel;
    return `<a href="${escapeHtml(parsed.toString())}">${safeLabel}</a>`;
  } catch {
    return safeLabel;
  }
}
