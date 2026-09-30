import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUpdate, type Routed } from './update-router';

const AUTH = '123';

function msg(text: unknown, chatId: unknown = AUTH): unknown {
  return { update_id: 1, message: { message_id: 10, text, chat: { id: chatId } } };
}

function cb(data: unknown, chatId: unknown = AUTH, messageId: unknown = 77): unknown {
  return {
    update_id: 2,
    callback_query: {
      id: 'cb1',
      data,
      message: { message_id: messageId, chat: { id: chatId } },
    },
  };
}

const cases: { name: string; update: unknown; auth: string; want: Routed }[] = [
  { name: 'plain /config command', update: msg('/config'), auth: AUTH, want: { kind: 'command', command: 'config', args: [], raw: '/config', chatId: '123' } },
  { name: 'command with @botname suffix', update: msg('/Config@mybot'), auth: AUTH, want: { kind: 'command', command: 'config', args: [], raw: '/Config@mybot', chatId: '123' } },
  { name: 'uppercase command, args keep case', update: msg('/CONFIG Buy 0.25'), auth: AUTH, want: { kind: 'command', command: 'config', args: ['Buy', '0.25'], raw: '/CONFIG Buy 0.25', chatId: '123' } },
  { name: "'/config text' legacy variant", update: msg('/config text'), auth: AUTH, want: { kind: 'command', command: 'config', args: ['text'], raw: '/config text', chatId: '123' } },
  { name: '/set with args', update: msg('/set buy 0.25'), auth: AUTH, want: { kind: 'command', command: 'set', args: ['buy', '0.25'], raw: '/set buy 0.25', chatId: '123' } },
  { name: 'extra whitespace collapses', update: msg('/config   text  x'), auth: AUTH, want: { kind: 'command', command: 'config', args: ['text', 'x'], raw: '/config   text  x', chatId: '123' } },
  { name: 'bare slash is an empty command', update: msg('/'), auth: AUTH, want: { kind: 'command', command: '', args: [], raw: '/', chatId: '123' } },
  { name: 'plain text', update: msg('15'), auth: AUTH, want: { kind: 'text', text: '15', chatId: '123' } },
  { name: 'plain word', update: msg('batal'), auth: AUTH, want: { kind: 'text', text: 'batal', chatId: '123' } },
  // Empty/whitespace-only strings stay 'text': the router is dumb, the
  // controller (handleConfigText) decides what an empty answer means.
  { name: 'empty text stays text', update: msg(''), auth: AUTH, want: { kind: 'text', text: '', chatId: '123' } },
  { name: 'whitespace-only text stays text', update: msg('   '), auth: AUTH, want: { kind: 'text', text: '   ', chatId: '123' } },
  { name: 'leading space is not a command', update: msg(' /config'), auth: AUTH, want: { kind: 'text', text: ' /config', chatId: '123' } },
  {
    name: 'cfg: menu callback', update: cb('cfg:g:size'), auth: AUTH,
    want: { kind: 'menu-callback', data: 'cfg:g:size', chatId: '123', messageId: 77, callbackId: 'cb1' },
  },
  {
    name: 'cfg: without message_id is ignored',
    update: { update_id: 2, callback_query: { id: 'cb1', data: 'cfg:g:size', message: { chat: { id: AUTH } } } },
    auth: AUTH, want: { kind: 'ignore' },
  },
  {
    name: 'cfg: without message is ignored',
    update: { callback_query: { id: 'cb1', data: 'cfg:m' } }, auth: AUTH, want: { kind: 'ignore' },
  },
  { name: 'cfg: wrong chat is ignored', update: cb('cfg:m', '999'), auth: AUTH, want: { kind: 'ignore' } },
  { name: 'appr: approval callback', update: cb('appr:yes:abc'), auth: AUTH, want: { kind: 'approval-callback' } },
  { name: 'buy: trade callback', update: cb('buy:mint:SYM'), auth: AUTH, want: { kind: 'trade-callback' } },
  { name: 'sell: trade callback', update: cb('sell:mint:SYM'), auth: AUTH, want: { kind: 'trade-callback' } },
  { name: 'unknown prefix is other-callback', update: cb('foo:bar'), auth: AUTH, want: { kind: 'other-callback' } },
  { name: 'missing data is other-callback', update: cb(undefined), auth: AUTH, want: { kind: 'other-callback' } },
  { name: 'numeric data is other-callback', update: cb(42), auth: AUTH, want: { kind: 'other-callback' } },
  { name: 'approval wrong chat is ignored', update: cb('appr:no:abc', '999'), auth: AUTH, want: { kind: 'ignore' } },
  {
    name: 'numeric chat id matches string auth',
    update: msg('/config', 123), auth: '123',
    want: { kind: 'command', command: 'config', args: [], raw: '/config', chatId: '123' },
  },
  {
    name: 'numeric chat id normalizes to string',
    update: cb('cfg:m', 123, 5), auth: '123',
    want: { kind: 'menu-callback', data: 'cfg:m', chatId: '123', messageId: 5, callbackId: 'cb1' },
  },
  { name: 'numeric chat mismatch is ignored', update: msg('/config', 124), auth: '123', want: { kind: 'ignore' } },
  { name: 'wrong chat text is ignored', update: msg('/config', '999'), auth: AUTH, want: { kind: 'ignore' } },
  { name: 'message without text is ignored', update: { message: { chat: { id: AUTH } } }, auth: AUTH, want: { kind: 'ignore' } },
  { name: 'numeric text is ignored', update: msg(15), auth: AUTH, want: { kind: 'ignore' } },
  { name: 'missing message is ignored', update: {}, auth: AUTH, want: { kind: 'ignore' } },
  { name: 'null is ignored', update: null, auth: AUTH, want: { kind: 'ignore' } },
  { name: 'undefined is ignored', update: undefined, auth: AUTH, want: { kind: 'ignore' } },
  { name: 'number is ignored', update: 42, auth: AUTH, want: { kind: 'ignore' } },
  { name: 'string garbage is ignored', update: 'garbage', auth: AUTH, want: { kind: 'ignore' } },
  { name: 'array garbage is ignored', update: [], auth: AUTH, want: { kind: 'ignore' } },
  {
    name: 'callback wins when both present',
    update: { callback_query: { id: 'cb9', data: 'buy:a:b', message: { message_id: 3, chat: { id: AUTH } } }, message: { text: '/config', chat: { id: AUTH } } },
    auth: AUTH, want: { kind: 'trade-callback' },
  },
];

describe('classifyUpdate', () => {
  for (const c of cases) {
    it(c.name, () => {
      assert.deepStrictEqual(classifyUpdate(c.update, c.auth), c.want);
    });
  }

  it('never throws on garbage', () => {
    const garbage: unknown[] = [null, undefined, 0, NaN, '', 'x', [], {}, { callback_query: null }, { message: null }, { callback_query: 7, message: 7 }];
    for (const g of garbage) {
      assert.deepStrictEqual(classifyUpdate(g, AUTH), { kind: 'ignore' });
    }
  });
});
