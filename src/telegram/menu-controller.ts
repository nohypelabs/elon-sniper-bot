/**
 * Telegram settings-menu controller (Stage 12B).
 *
 * Pure logic over injected I/O: the controller never touches axios, CONFIG,
 * or Telegram directly. All side effects go through MenuControllerDeps so
 * tests can record every call with fakes.
 */

import type { ConfigApply } from './config-commands';
import {
  MenuSessions,
  handleConfigCallback,
  handleConfigText,
  renderMain,
  type CallbackResult,
  type Screen,
} from './config-menu';
import type { Routed } from './update-router';

export interface MenuControllerDeps {
  chatId: string;
  getConfig: () => Record<string, unknown>;
  apply: ConfigApply;
  sessions: MenuSessions;
  liveAllowed: () => boolean;
  sendScreen: (screen: Screen) => Promise<number | null>;
  editScreen: (messageId: number, screen: Screen) => Promise<'edited' | 'unchanged' | 'gone'>;
  sendText: (html: string) => Promise<void>;
  answer: (callbackId: string, text?: string, alert?: boolean) => Promise<void>;
  log?: (msg: string) => void;
}

export function createMenuController(deps: MenuControllerDeps): {
  onCommand: (routed: Routed) => Promise<boolean>;
  onCallback: (routed: Routed) => Promise<void>;
  onText: (routed: Routed) => Promise<boolean>;
} {
  // Logging goes through deps.log only. Never include user-typed text here:
  // only static messages (callers may add key names, never values).
  const log = (msg: string): void => {
    try {
      deps.log?.(msg);
    } catch {
      /* logging must never break the loop */
    }
  };

  function menuCtx(messageId: number | undefined): {
    chatId: string;
    messageId?: number;
    config: Record<string, unknown>;
    apply: ConfigApply;
    sessions: MenuSessions;
    liveAllowed: boolean;
  } {
    return {
      chatId: deps.chatId,
      messageId,
      config: deps.getConfig(),
      apply: deps.apply,
      sessions: deps.sessions,
      liveAllowed: deps.liveAllowed(),
    };
  }

  async function onCommand(routed: Routed): Promise<boolean> {
    if (routed.kind !== 'command') return false;
    const isMenu =
      (routed.command === 'config' && routed.args.length === 0) ||
      routed.command === 'menu' ||
      routed.command === 'settings';
    if (!isMenu) {
      // A slash command abandons a pending prompt/confirm (mirrors the
      // handleConfigText slash branch, which clears the pending input).
      // '/config text' also lands here and returns false so the bot keeps
      // serving the legacy plain-text summary.
      deps.sessions.clearInput(deps.chatId);
      deps.sessions.clearConfirm(deps.chatId);
      return false;
    }
    deps.sessions.clearAll(deps.chatId);
    try {
      await deps.sendScreen(renderMain(deps.getConfig()));
    } catch {
      log('menu onCommand send failed');
    }
    return true;
  }

  async function onCallback(routed: Routed): Promise<void> {
    if (routed.kind !== 'menu-callback') return;
    let result: CallbackResult | undefined;
    try {
      result = handleConfigCallback(
        routed.data,
        menuCtx(routed.messageId),
      );
    } catch {
      log('menu onCallback handle failed');
      result = undefined;
    }
    // ALWAYS answer exactly once, BEFORE any edit. When the result carries
    // no answer text, answer with no text (clears the client spinner).
    try {
      await deps.answer(routed.callbackId, result?.answer, result?.alert);
    } catch {
      log('menu onCallback answer failed');
    }
    const edit = result?.edit;
    if (edit) {
      try {
        const status = await deps.editScreen(routed.messageId, edit);
        if (status === 'gone') {
          // Message can no longer be edited: send a fresh one so the user
          // is never stuck on a dead menu.
          try {
            await deps.sendScreen(edit);
          } catch {
            log('menu onCallback resend failed');
          }
        }
      } catch {
        log('menu onCallback edit failed');
      }
    }
  }

  async function onText(routed: Routed): Promise<boolean> {
    if (routed.kind !== 'text') return false;
    let result;
    try {
      result = handleConfigText(routed.text, menuCtx(undefined));
    } catch {
      log('menu onText handle failed');
      return false;
    }
    if (!result.consumed) return false;
    for (const reply of result.replies) {
      try {
        await deps.sendText(reply);
      } catch {
        log('menu onText reply failed');
      }
    }
    if (result.edit) {
      const edit = result.edit;
      if (result.feedback === 'bottom') {
        let newId: number | null = null;
        try {
          newId = await deps.sendScreen(edit.screen);
        } catch {
          log('menu onText send failed');
          newId = null;
        }
        if (typeof newId === 'number') {
          try {
            await deps.editScreen(edit.messageId, {
              text: result.staleNote ?? '✅ Selesai.',
              keyboard: [],
            });
          } catch {
            log('menu onText stale edit failed');
          }
        } else {
          try {
            const status = await deps.editScreen(edit.messageId, edit.screen);
            if (status === 'gone') {
              try {
                await deps.sendScreen(edit.screen);
              } catch {
                log('menu onText resend failed');
              }
            }
          } catch {
            log('menu onText edit failed');
          }
        }
      } else {
        try {
          const status = await deps.editScreen(edit.messageId, edit.screen);
          if (status === 'gone') {
            try {
              await deps.sendScreen(edit.screen);
            } catch {
              log('menu onText resend failed');
            }
          }
        } catch {
          log('menu onText edit failed');
        }
      }
    }
    return true;
  }

  return { onCommand, onCallback, onText };
}
