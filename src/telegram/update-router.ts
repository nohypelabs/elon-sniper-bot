/**
 * Pure Telegram update classifier (Stage 12B).
 *
 * No axios, no CONFIG, no I/O. classifyUpdate() never throws, even on
 * null / garbage / mistyped input. The chat gate lives here; bot.ts keeps
 * its own gate as defence in depth.
 */

export type Routed =
  | { kind: 'ignore' }
  | { kind: 'menu-callback'; data: string; chatId: string; messageId: number; callbackId: string }
  | { kind: 'approval-callback' }
  | { kind: 'trade-callback' }
  | { kind: 'other-callback' }
  | { kind: 'text'; text: string; chatId: string }
  | {
      kind: 'command';
      command: string;
      args: string[];
      raw: string;
      chatId: string;
    };

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function chatIdOf(message: unknown): string {
  const msg = asRecord(message);
  const chat = msg ? asRecord(msg['chat']) : null;
  return String(chat?.['id'] ?? '');
}

/**
 * Classify one getUpdates entry. Pure; never throws.
 *
 * - Wrong chat (String() compared against authorizedChatId) => 'ignore'.
 * - callback_query data 'cfg:' => menu-callback, but only when message_id
 *   is a finite number (else 'ignore'); 'appr:' => approval-callback;
 *   'buy:'/'sell:' => trade-callback; anything else => other-callback.
 * - message.text starting with '/' => command (lowercased name, @botname
 *   suffix stripped, split on whitespace); any other string text => text.
 * - Empty/whitespace-only strings stay 'text' (the controller decides);
 *   non-string text, missing message, null/garbage => 'ignore'.
 */
export function classifyUpdate(update: unknown, authorizedChatId: string): Routed {
  try {
    const u = asRecord(update);
    if (!u) return { kind: 'ignore' };

    const cb = asRecord(u['callback_query']);
    if (cb) {
      const chatId = chatIdOf(cb['message']);
      if (chatId !== authorizedChatId) return { kind: 'ignore' };
      const data = typeof cb['data'] === 'string' ? cb['data'] : '';
      if (data.startsWith('cfg:')) {
        const msg = asRecord(cb['message']);
        const mid = msg?.['message_id'];
        if (typeof mid !== 'number' || !Number.isFinite(mid)) return { kind: 'ignore' };
        const rawId = cb['id'];
        const callbackId = typeof rawId === 'string' ? rawId : String(rawId ?? '');
        return { kind: 'menu-callback', data, chatId, messageId: mid, callbackId };
      }
      if (data.startsWith('appr:')) return { kind: 'approval-callback' };
      if (data.startsWith('buy:') || data.startsWith('sell:')) return { kind: 'trade-callback' };
      return { kind: 'other-callback' };
    }

    const msg = asRecord(u['message']);
    if (msg) {
      const chatId = chatIdOf(msg);
      if (chatId !== authorizedChatId) return { kind: 'ignore' };
      const text = msg['text'];
      if (typeof text !== 'string') return { kind: 'ignore' };
      if (text.startsWith('/')) {
        const parts = text.slice(1).split(/\s+/).filter((p) => p.length > 0);
        const head = parts.length > 0 ? parts[0] : '';
        const at = head.indexOf('@');
        const command = (at >= 0 ? head.slice(0, at) : head).toLowerCase();
        return { kind: 'command', command, args: parts.slice(1), raw: text, chatId };
      }
      return { kind: 'text', text, chatId };
    }

    return { kind: 'ignore' };
  } catch {
    return { kind: 'ignore' };
  }
}
