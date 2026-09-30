import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../config/editable';
import {
  EXPIRED_MESSAGE,
  MenuSessions,
  keyIndex,
  sampleConfig,
  type Screen,
} from './config-menu';
import type { ConfigApply } from './config-commands';
import { createMenuController } from './menu-controller';
import type { Routed } from './update-router';

function fakeApply(config: Record<string, unknown>): ConfigApply {
  return (values) => {
    const err = validateConfig({ ...(config as Record<string, unknown>), ...values });
    if (err) return err;
    Object.assign(config, values);
    return null;
  };
}

interface Answer {
  id: string;
  text?: string;
  alert?: boolean;
}

interface Edit {
  messageId: number;
  screen: Screen;
}

function makeFakes() {
  const events: string[] = [];
  const sent: Screen[] = [];
  const edits: Edit[] = [];
  const answers: Answer[] = [];
  const texts: string[] = [];
  const ctl = { editBehavior: 'edited' as 'edited' | 'unchanged' | 'gone', throwOnEdit: false, throwOnAnswer: false };
  let nextId = 100;
  return {
    events, sent, edits, answers, texts, ctl,
    sendScreen: async (screen: Screen): Promise<number | null> => {
      events.push('send');
      sent.push(screen);
      nextId += 1;
      return nextId;
    },
    editScreen: async (messageId: number, screen: Screen): Promise<'edited' | 'unchanged' | 'gone'> => {
      events.push('edit');
      if (ctl.throwOnEdit) throw new Error('edit boom');
      edits.push({ messageId, screen });
      return ctl.editBehavior;
    },
    sendText: async (html: string): Promise<void> => {
      events.push('text');
      texts.push(html);
    },
    answer: async (id: string, text?: string, alert?: boolean): Promise<void> => {
      events.push('answer');
      if (ctl.throwOnAnswer) throw new Error('answer boom');
      answers.push({ id, text, alert });
    },
  };
}

type Fakes = ReturnType<typeof makeFakes>;

function makeController(chatId: string, config: Record<string, unknown>, sessions: MenuSessions, fx?: Fakes) {
  const f = fx ?? makeFakes();
  const logs: string[] = [];
  const c = createMenuController({
    chatId,
    getConfig: () => config,
    apply: fakeApply(config),
    sessions,
    liveAllowed: () => false,
    sendScreen: f.sendScreen,
    editScreen: f.editScreen,
    sendText: f.sendText,
    answer: f.answer,
    log: (m: string) => logs.push(m),
  });
  return { c, f, logs };
}

const cmd = (command: string, args: string[] = [], chatId = 'C1'): Routed => ({
  kind: 'command', command, args, raw: `/${command}${args.length > 0 ? ` ${args.join(' ')}` : ''}`, chatId,
});
const cb = (data: string, messageId: number, callbackId = 'cb1'): Routed => ({
  kind: 'menu-callback', data, chatId: 'C1', messageId, callbackId,
});
const txt = (text: string): Routed => ({ kind: 'text', text, chatId: 'C1' });

const USD = `cfg:k:${keyIndex('BUY_AMOUNT_USD')}`;
const ANTI_MEV = `cfg:t:${keyIndex('ANTI_MEV')}`;

function keyboardHas(undo: Screen, callbackData: string): boolean {
  return undo.keyboard.some((row) => row.some((b) => b.callback_data === callbackData));
}

describe('menu-controller full conversation', () => {
  it("'/config' sends the main screen and clears sessions", async () => {
    const config = { ...sampleConfig() };
    const sessions = new MenuSessions();
    sessions.setInput('C1', 'BUY_AMOUNT_USD', 9);
    sessions.setConfirm('C1', { kind: 'value', key: 'BUY_AMOUNT_USD', value: 100, messageId: 9 });
    const { c, f } = makeController('C1', config, sessions);
    assert.strictEqual(await c.onCommand(cmd('config')), true);
    assert.strictEqual(f.sent.length, 1);
    assert.ok(f.sent[0].text.includes('Pengaturan Sniper'));
    assert.strictEqual(sessions.getInput('C1'), null);
    assert.strictEqual(sessions.getConfirm('C1'), null);
  });

  it("'/menu' and '/settings' also open the menu", async () => {
    const config = { ...sampleConfig() };
    const { c, f } = makeController('C1', config, new MenuSessions());
    assert.strictEqual(await c.onCommand(cmd('menu')), true);
    assert.strictEqual(await c.onCommand(cmd('settings')), true);
    assert.strictEqual(f.sent.length, 2);
  });

  it('group callback answers once, before the edit', async () => {
    const config = { ...sampleConfig() };
    const { c, f } = makeController('C1', config, new MenuSessions());
    await c.onCallback(cb('cfg:g:size', 101));
    assert.deepStrictEqual(f.answers, [{ id: 'cb1', text: undefined, alert: undefined }]);
    assert.strictEqual(f.edits.length, 1);
    assert.deepStrictEqual(f.events, ['answer', 'edit']);
    assert.strictEqual(f.edits[0].messageId, 101);
    assert.ok(f.edits[0].screen.text.includes('Ukuran & Exit'));
  });

  it("select stores the prompt; '15' applies with success banner and undo row", async () => {
    const config = { ...sampleConfig() };
    const sessions = new MenuSessions();
    const { c, f } = makeController('C1', config, sessions);
    await c.onCallback(cb(USD, 101));
    assert.strictEqual(sessions.getInput('C1')?.key, 'BUY_AMOUNT_USD');
    assert.strictEqual(await c.onText(txt('15')), true);
    assert.strictEqual(config['BUY_AMOUNT_USD'], 15);
    // 12C: success goes to the bottom — one fresh send plus a stale note
    // on the old prompt, never an in-place group edit.
    assert.strictEqual(f.texts.length, 0);
    assert.strictEqual(f.sent.length, 1);
    assert.ok(f.sent[0].text.includes('✅'));
    assert.ok(f.sent[0].text.includes('Ukuran & Exit'));
    assert.ok(keyboardHas(f.sent[0], 'cfg:u'));
    assert.strictEqual(f.edits.length, 2);
    const stale = f.edits[f.edits.length - 1];
    assert.strictEqual(stale.messageId, 101);
    assert.strictEqual(stale.screen.text, '✅ Tersimpan. Menu terbaru ada di pesan di bawah.');
    assert.deepStrictEqual(stale.screen.keyboard, []);
    for (const e of f.edits) {
      assert.notStrictEqual(e.screen.text, f.sent[0].text);
    }
    assert.strictEqual(sessions.getInput('C1'), null);
    assert.deepStrictEqual(sessions.getUndo('C1')?.items, [
      { key: 'BUY_AMOUNT_USD', before: 10, after: 15 },
    ]);
  });

  it("'abc' keeps the prompt open with an error", async () => {
    const config = { ...sampleConfig(), BUY_AMOUNT_USD: 15 };
    const sessions = new MenuSessions();
    const { c, f } = makeController('C1', config, sessions);
    await c.onCallback(cb(USD, 101));
    assert.strictEqual(await c.onText(txt('abc')), true);
    assert.strictEqual(config['BUY_AMOUNT_USD'], 15);
    assert.strictEqual(sessions.getInput('C1')?.key, 'BUY_AMOUNT_USD');
    assert.ok(f.edits[f.edits.length - 1].screen.text.includes('Ketik angka saja'));
    assert.strictEqual(f.sent.length, 0);
    assert.strictEqual(f.texts.length, 1);
    assert.ok(f.texts[0].startsWith('❌'));
    assert.ok(f.texts[0].includes('Ketik angka saja'));
    assert.strictEqual(f.edits[f.edits.length - 1].messageId, 101);
  });

  it("'100' asks confirm, cfg:cy applies, cfg:u undoes", async () => {
    const config = { ...sampleConfig(), BUY_AMOUNT_USD: 15 };
    const sessions = new MenuSessions();
    const { c, f } = makeController('C1', config, sessions);
    await c.onCallback(cb(USD, 50));
    assert.strictEqual(await c.onText(txt('100')), true);
    assert.deepStrictEqual(sessions.getConfirm('C1')?.kind, 'value');
    // 12C: confirm screen goes to the bottom with its buttons intact.
    assert.strictEqual(f.sent.length, 1);
    assert.ok(f.sent[0].text.includes('Yakin'));
    assert.ok(keyboardHas(f.sent[0], 'cfg:cy'));
    const stale = f.edits[f.edits.length - 1];
    assert.strictEqual(stale.messageId, 50);
    assert.strictEqual(stale.screen.text, '⚠️ Menunggu konfirmasi di pesan di bawah.');
    assert.deepStrictEqual(stale.screen.keyboard, []);
    // Confirm from the NEW message id applies.
    await c.onCallback(cb('cfg:cy', 101, 'cb2'));
    assert.strictEqual(config['BUY_AMOUNT_USD'], 100);
    assert.strictEqual(f.edits[f.edits.length - 1].messageId, 101);
    assert.ok(f.edits[f.edits.length - 1].screen.text.includes('✅'));
    await c.onCallback(cb('cfg:u', 101, 'cb3'));
    assert.strictEqual(config['BUY_AMOUNT_USD'], 15);
    assert.ok(f.edits[f.edits.length - 1].screen.text.includes('dikembalikan'));
    assert.deepStrictEqual(f.answers.map((a) => a.id), ['cb1', 'cb2', 'cb3']);
  });

  it('toggles a feature directly', async () => {
    const config = { ...sampleConfig() };
    const { c, f } = makeController('C1', config, new MenuSessions());
    await c.onCallback(cb(ANTI_MEV, 101));
    assert.strictEqual(config['ANTI_MEV'], true);
    assert.strictEqual(f.answers.length, 1);
    assert.ok(f.edits[f.edits.length - 1].screen.text.includes('✅'));
  });

  it("'/status' while a prompt is open clears it and returns false", async () => {
    const config = { ...sampleConfig() };
    const sessions = new MenuSessions();
    const { c } = makeController('C1', config, sessions);
    await c.onCallback(cb(USD, 101));
    assert.notStrictEqual(sessions.getInput('C1'), null);
    assert.strictEqual(await c.onCommand(cmd('status')), false);
    assert.strictEqual(sessions.getInput('C1'), null);
    assert.strictEqual(sessions.getConfirm('C1'), null);
  });

  it("'/config text' returns false (legacy plain-text summary)", async () => {
    const config = { ...sampleConfig() };
    const { c, f } = makeController('C1', config, new MenuSessions());
    assert.strictEqual(await c.onCommand(cmd('config', ['text'])), false);
    assert.strictEqual(f.sent.length, 0);
  });

  it('expired/unknown callbacks answer EXPIRED_MESSAGE with alert and do not edit', async () => {
    const config = { ...sampleConfig() };
    const { c, f } = makeController('C1', config, new MenuSessions());
    const editsBefore = f.edits.length;
    await c.onCallback(cb('cfg:zzz', 101, 'cbX'));
    await c.onCallback(cb('cfg:k:999', 101, 'cbY'));
    assert.deepStrictEqual(f.answers, [
      { id: 'cbX', text: EXPIRED_MESSAGE, alert: true },
      { id: 'cbY', text: EXPIRED_MESSAGE, alert: true },
    ]);
    assert.strictEqual(f.edits.length, editsBefore);
  });

  it("'gone' edit falls back to a fresh send", async () => {
    const config = { ...sampleConfig() };
    const { c, f } = makeController('C1', config, new MenuSessions());
    f.ctl.editBehavior = 'gone';
    await c.onCallback(cb('cfg:g:entry', 101));
    assert.strictEqual(f.answers.length, 1);
    assert.strictEqual(f.edits.length, 1);
    assert.strictEqual(f.sent.length, 1);
    assert.ok(f.sent[0].text.includes('Filter Entry'));
    assert.deepStrictEqual(f.sent[0], f.edits[0].screen);
  });

  it('throwing editScreen never escapes', async () => {
    const config = { ...sampleConfig() };
    const { c, f, logs } = makeController('C1', config, new MenuSessions());
    f.ctl.throwOnEdit = true;
    await c.onCallback(cb('cfg:g:size', 101));
    assert.strictEqual(f.answers.length, 1);
    assert.ok(logs.length >= 1);
  });

  it('throwing answer never escapes and the edit still happens', async () => {
    const config = { ...sampleConfig() };
    const { c, f, logs } = makeController('C1', config, new MenuSessions());
    f.ctl.throwOnAnswer = true;
    await c.onCallback(cb('cfg:g:size', 101));
    assert.strictEqual(f.edits.length, 1);
    assert.ok(f.edits[0].screen.text.includes('Ukuran & Exit'));
    assert.ok(logs.length >= 1);
  });

  it('two chats do not share sessions', async () => {
    const config = { ...sampleConfig() };
    const sessions = new MenuSessions();
    const a = makeController('C1', config, sessions);
    const b = makeController('C2', config, sessions);
    await a.c.onCallback({ kind: 'menu-callback', data: USD, chatId: 'C1', messageId: 50, callbackId: 'cbA' });
    assert.strictEqual(sessions.getInput('C1')?.key, 'BUY_AMOUNT_USD');
    assert.strictEqual(await b.c.onText({ kind: 'text', text: '15', chatId: 'C2' }), false);
    assert.deepStrictEqual([b.f.sent.length, b.f.edits.length, b.f.answers.length, b.f.texts.length], [0, 0, 0, 0]);
    assert.strictEqual(await a.c.onText({ kind: 'text', text: '15', chatId: 'C1' }), true);
    assert.strictEqual(config['BUY_AMOUNT_USD'], 15);
  });

  it('text with nothing pending returns false and calls nothing', async () => {
    const config = { ...sampleConfig() };
    const { c, f } = makeController('C1', config, new MenuSessions());
    assert.strictEqual(await c.onText(txt('hello')), false);
    assert.deepStrictEqual([f.sent.length, f.edits.length, f.answers.length, f.texts.length], [0, 0, 0, 0]);
  });

  it('non-matching routed kinds are ignored', async () => {
    const config = { ...sampleConfig() };
    const { c, f } = makeController('C1', config, new MenuSessions());
    assert.strictEqual(await c.onCommand(txt('15')), false);
    assert.strictEqual(await c.onText(cmd('config')), false);
    await c.onCallback(txt('15'));
    assert.deepStrictEqual([f.sent.length, f.edits.length, f.answers.length, f.texts.length], [0, 0, 0, 0]);
  });
});

describe('menu-controller 12C bottom feedback', () => {
  it("'batal' edits the old prompt in place with no send", async () => {
    const config = { ...sampleConfig() };
    const sessions = new MenuSessions();
    const { c, f } = makeController('C1', config, sessions);
    await c.onCallback(cb(USD, 101));
    assert.strictEqual(await c.onText(txt('batal')), true);
    assert.strictEqual(f.sent.length, 0);
    assert.strictEqual(f.texts.length, 0);
    assert.strictEqual(f.edits.length, 2);
    const last = f.edits[f.edits.length - 1];
    assert.strictEqual(last.messageId, 101);
    assert.ok(last.screen.text.includes('Ukuran & Exit'));
  });

  it('sendScreen null falls back to in-place edit', async () => {
    const config = { ...sampleConfig() };
    const sessions = new MenuSessions();
    const fx = makeFakes();
    const origSend = fx.sendScreen;
    fx.sendScreen = async (screen: Screen): Promise<number | null> => {
      fx.events.push('send');
      fx.sent.push(screen);
      return null;
    };
    void origSend;
    const { c, f } = makeController('C1', config, sessions, fx);
    await c.onCallback(cb(USD, 101));
    assert.strictEqual(await c.onText(txt('15')), true);
    assert.strictEqual(config['BUY_AMOUNT_USD'], 15);
    assert.strictEqual(f.sent.length, 1);
    assert.strictEqual(f.edits.length, 2);
    const last = f.edits[f.edits.length - 1];
    assert.strictEqual(last.messageId, 101);
    assert.ok(last.screen.text.includes('✅'));
    assert.ok(last.screen.text.includes('Ukuran & Exit'));
  });

  it('sendScreen throwing falls back to in-place edit', async () => {
    const config = { ...sampleConfig() };
    const sessions = new MenuSessions();
    const fx = makeFakes();
    fx.sendScreen = async (_screen: Screen): Promise<number | null> => {
      fx.events.push('send');
      throw new Error('send boom');
    };
    const { c, f, logs } = makeController('C1', config, sessions, fx);
    await c.onCallback(cb(USD, 101));
    assert.strictEqual(await c.onText(txt('15')), true);
    assert.strictEqual(config['BUY_AMOUNT_USD'], 15);
    const last = f.edits[f.edits.length - 1];
    assert.strictEqual(last.messageId, 101);
    assert.ok(last.screen.text.includes('✅'));
    assert.ok(last.screen.text.includes('Ukuran & Exit'));
    assert.ok(logs.length >= 1);
  });

  it("stale-note edit returning 'gone' never escapes and sends nothing more", async () => {
    const config = { ...sampleConfig() };
    const sessions = new MenuSessions();
    const fx = makeFakes();
    let calls = 0;
    const realEdit = fx.editScreen;
    void realEdit;
    fx.editScreen = async (messageId: number, screen: Screen): Promise<'edited' | 'unchanged' | 'gone'> => {
      calls += 1;
      fx.events.push('edit');
      if (calls === 1) {
        fx.edits.push({ messageId, screen });
        return 'edited';
      }
      fx.edits.push({ messageId, screen });
      return 'gone';
    };
    const { c, f } = makeController('C1', config, sessions, fx);
    await c.onCallback(cb(USD, 101));
    assert.strictEqual(await c.onText(txt('15')), true);
    assert.strictEqual(f.sent.length, 1);
    assert.strictEqual(f.edits.length, 2);
    assert.strictEqual(f.edits[1].screen.text, '✅ Tersimpan. Menu terbaru ada di pesan di bawah.');
  });

  it('stale-note edit throwing never escapes and sends nothing more', async () => {
    const config = { ...sampleConfig() };
    const sessions = new MenuSessions();
    const fx = makeFakes();
    let calls = 0;
    fx.editScreen = async (messageId: number, screen: Screen): Promise<'edited' | 'unchanged' | 'gone'> => {
      calls += 1;
      fx.events.push('edit');
      if (calls === 1) {
        fx.edits.push({ messageId, screen });
        return 'edited';
      }
      throw new Error('stale boom');
    };
    const { c, f, logs } = makeController('C1', config, sessions, fx);
    await c.onCallback(cb(USD, 101));
    assert.strictEqual(await c.onText(txt('15')), true);
    assert.strictEqual(f.sent.length, 1);
    assert.strictEqual(f.edits.length, 1);
    assert.ok(logs.length >= 1);
  });

  it('undo on the NEW message id works and edits the new message', async () => {
    const config = { ...sampleConfig() };
    const sessions = new MenuSessions();
    const { c, f } = makeController('C1', config, sessions);
    await c.onCallback(cb(USD, 50));
    assert.strictEqual(await c.onText(txt('15')), true);
    assert.strictEqual(f.sent.length, 1);
    const stored = sessions.getUndo('C1');
    assert.ok(stored !== null);
    assert.strictEqual(stored.messageId, 50);
    await c.onCallback(cb('cfg:u', 101, 'cbU'));
    assert.strictEqual(config['BUY_AMOUNT_USD'], 10);
    assert.strictEqual(f.edits[f.edits.length - 1].messageId, 101);
    assert.ok(f.edits[f.edits.length - 1].screen.text.includes('dikembalikan'));
  });
});
