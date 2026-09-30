import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { EDITABLE_CONFIG, PRESETS, validateConfig } from '../config/editable';
import { SETTING_META, visibleKeys } from '../config/setting-meta';
import {
  EXPIRED_MESSAGE,
  MenuSessions,
  buildGoldenScreens,
  formatGolden,
  handleConfigCallback,
  handleConfigText,
  keyIndex,
  parseCallback,
  parseNumericInput,
  presetMeta,
  rangeText,
  renderConfirmToggle,
  renderConfirmValue,
  renderGroup,
  renderHelp,
  renderMain,
  renderPresetPreview,
  renderPresets,
  renderPrompt,
  sampleConfig,
  type MenuCtx,
  type Screen,
} from './config-menu';
import type { ConfigApply } from './config-commands';

function fakeApply(config: Record<string, unknown>): ConfigApply {
  return (values) => {
    const err = validateConfig({ ...(config as Record<string, unknown>), ...values });
    if (err) return err;
    Object.assign(config, values);
    return null;
  };
}

/**
 * Flow-test config: exact sampleConfig() violates the
 * TP1_SELL+MOONBAG<=100 rule (80+25=105), so every apply would reject.
 * Flows use MOONBAG_PERCENT 15; golden tests keep the exact sample (the old TP1_SELL+MOONBAG<=100 rule that forced this was removed, both are valid now).
 */
function flowConfig(): Record<string, unknown> {
  return { ...sampleConfig(), MOONBAG_PERCENT: 15 };
}

function ctxWith(config: Record<string, unknown>, sessions?: MenuSessions, messageId = 7): { ctx: MenuCtx; config: Record<string, unknown>; sessions: MenuSessions } {
  const s = sessions ?? new MenuSessions();
  const ctx: MenuCtx = { chatId: 'c1', messageId, config: config as Record<string, unknown>, apply: fakeApply(config), sessions: s };
  return { ctx, config, sessions: s };
}

function allScreensFor(cfg: Record<string, unknown>): { name: string; screen: Screen }[] {
  const out: { name: string; screen: Screen }[] = [
    { name: 'main', screen: renderMain(cfg) },
    { name: 'help', screen: renderHelp() },
    { name: 'presets', screen: renderPresets(cfg) },
    { name: 'preview', screen: renderPresetPreview('lowrisk', cfg) },
  ];
  for (const g of ['size', 'exec', 'entry', 'features'] as const) {
    out.push({ name: `group-${g}`, screen: renderGroup(g, cfg) });
  }
  for (const k of EDITABLE_CONFIG) {
    const meta = SETTING_META[k];
    if (meta.kind === 'number') out.push({ name: `prompt-${k}`, screen: renderPrompt(k, cfg) });
  }
  out.push({ name: 'confirm-value', screen: renderConfirmValue('BUY_AMOUNT_USD', 10, 100) });
  out.push({ name: 'confirm-toggle', screen: renderConfirmToggle('PUMP_SECURITY_CHECK') });
  return out;
}

describe('callback_data size, uniqueness, round-trip', () => {
  for (const sparse of [false, true]) {
    it(`every button round-trips (${sparse ? 'sparse' : 'sample'})`, () => {
      const cfg: Record<string, unknown> = sparse ? {} : sampleConfig();
      for (const { name, screen } of allScreensFor(cfg)) {
        const seen = new Set<string>();
        for (const row of screen.keyboard) {
          for (const b of row) {
            const bytes = Buffer.byteLength(b.callback_data, 'utf8');
            assert.ok(bytes <= 64, `${name} callback too long: ${b.callback_data}`);
            assert.ok(!seen.has(b.callback_data), `${name} duplicate callback: ${b.callback_data}`);
            seen.add(b.callback_data);
            assert.ok(parseCallback(b.callback_data) !== null, `${name} no round-trip: ${b.callback_data}`);
          }
        }
      }
    });
  }
});

describe('parseCallback rejects garbage', () => {
  for (const bad of ['cfg:k:999', 'cfg:q:1:99', 'cfg:zzz', '', 'buy:1', 'cfg:g:nope', 'cfg:pp:99']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.equal(parseCallback(bad), null);
    });
  }
});

describe('renderers safety', () => {
  it('HTML-escape preset names and errors', () => {
    const evil = '<b>&"';
    const s = renderPresetPreview(evil, sampleConfig());
    assert.ok(!s.text.includes('<b>&"'));
    assert.ok(s.text.includes('&lt;b&gt;'));
    const p = renderPrompt('BUY_AMOUNT_USD', sampleConfig(), { error: '<script>&"' });
    assert.ok(!p.text.includes('<script>'));
    assert.ok(p.text.includes('&lt;script&gt;'));
  });

  it('never prints NaN/undefined/null and stays under 4096 chars with allowed tags only', () => {
    const cfgs: Record<string, unknown>[] = [sampleConfig(), {}];
    const screens: Screen[] = [];
    for (const c of cfgs) {
      for (const { screen } of allScreensFor(c)) screens.push(screen);
    }
    const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
    const allowed = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a']);
    for (const s of screens) {
      assert.ok(!s.text.includes('NaN'), s.text.slice(0, 120));
      assert.ok(!s.text.includes('undefined'));
      assert.ok(!s.text.includes('null'));
      assert.ok(s.text.length <= 4096);
      for (const m of s.text.matchAll(tagRe)) {
        assert.ok(allowed.has(m[1]), `disallowed tag <${m[1]}>`);
      }
    }
  });
});

describe('parseNumericInput table', () => {
  it('accepts variants', () => {
    assert.deepEqual(parseNumericInput('BUY_AMOUNT_SOL', '0,25'), { ok: true, stored: 0.25, display: 0.25 });
    assert.deepEqual(parseNumericInput('BUY_AMOUNT_SOL', '0.25'), { ok: true, stored: 0.25, display: 0.25 });
    const usd = parseNumericInput('BUY_AMOUNT_USD', ' $10 ');
    assert.equal(usd.ok, true);
    if (usd.ok) assert.equal(usd.stored, 10);
    const pct = parseNumericInput('TP1_PERCENT', '30%');
    assert.equal(pct.ok, true);
    const slip = parseNumericInput('MAX_SLIPPAGE_BPS', '2,5 %');
    assert.equal(slip.ok, true);
    if (slip.ok) assert.equal(slip.stored, 250);
    const hold = parseNumericInput('PUMP_MAX_HOLD_MINUTES', '5 menit');
    assert.equal(hold.ok, true);
    if (hold.ok) assert.equal(hold.stored, 5);
  });

  it('rejects garbage with parse-fail message', () => {
    for (const bad of ['0x10', '', 'abc', '1 2', '٣']) {
      const r = parseNumericInput('BUY_AMOUNT_SOL', bad);
      assert.equal(r.ok, false, bad);
      if (!r.ok) assert.equal(r.error, 'Ketik angka saja, mis. 15');
    }
  });

  it('1e999 and -5 give range errors with Rentang line', () => {
    const big = parseNumericInput('BUY_AMOUNT_SOL', '1e999');
    assert.equal(big.ok, false);
    if (!big.ok) assert.ok(big.error.includes('Rentang:'));
    const neg = parseNumericInput('BUY_AMOUNT_SOL', '-5');
    assert.equal(neg.ok, false);
    if (!neg.ok) assert.ok(neg.error.includes('Rentang:'));
  });
});

describe('MenuSessions TTL', () => {
  it('input/confirm expire after 120s, undo after 300s', () => {
    let t = 0;
    const s = new MenuSessions({ now: () => t });
    s.setInput('c', 'BUY_AMOUNT_USD', 1);
    s.setConfirm('c', { kind: 'value', key: 'BUY_AMOUNT_USD', value: 15, messageId: 1 });
    s.setUndo('c', [{ key: 'BUY_AMOUNT_USD', before: 10, after: 15 }], 1);
    assert.equal(s.size(), 1);
    t = 119999;
    assert.ok(s.getInput('c') !== null);
    assert.ok(s.getConfirm('c') !== null);
    assert.ok(s.getUndo('c') !== null);
    t = 120000;
    assert.equal(s.getInput('c'), null);
    assert.equal(s.getConfirm('c'), null);
    assert.ok(s.getUndo('c') !== null);
    t = 300000;
    assert.equal(s.getUndo('c'), null);
    assert.equal(s.size(), 0);
  });
});

describe('flows', () => {
  it('tap numeric stores prompt input', () => {
    const { ctx, sessions } = ctxWith(flowConfig());
    const idx = keyIndex('BUY_AMOUNT_USD');
    const r = handleConfigCallback(`cfg:k:${idx}`, ctx);
    assert.ok(r.edit);
    assert.ok(r.edit.text.includes('Ukuran beli'));
    assert.ok(sessions.getInput('c1') !== null);
  });

  it('valid number applies, clears input, banners with undo row', () => {
    const { ctx, sessions, config } = ctxWith(flowConfig());
    const idx = keyIndex('BUY_AMOUNT_USD');
    handleConfigCallback(`cfg:k:${idx}`, ctx);
    const r = handleConfigText('15', ctx);
    assert.equal(r.consumed, true);
    assert.equal(config['BUY_AMOUNT_USD'], 15);
    assert.equal(sessions.getInput('c1'), null);
    assert.ok(r.edit);
    assert.ok(r.edit.screen.text.includes('✅'));
    assert.ok(r.edit.screen.keyboard.flat().some((b) => b.callback_data === 'cfg:u'));
  });

  it('invalid text re-prompts with error and KEEPS input', () => {
    const { ctx, sessions, config } = ctxWith(flowConfig());
    handleConfigCallback(`cfg:k:${keyIndex('BUY_AMOUNT_USD')}`, ctx);
    const r = handleConfigText('abc', ctx);
    assert.equal(r.consumed, true);
    assert.ok(r.edit?.screen.text.startsWith('❌'));
    assert.ok(r.edit?.screen.text.includes('Ketik angka saja'));
    assert.ok(sessions.getInput('c1') !== null);
    assert.equal(config['BUY_AMOUNT_USD'], 10);
  });

  it('out-of-range keeps input with range line', () => {
    const { ctx, sessions } = ctxWith(flowConfig());
    handleConfigCallback(`cfg:k:${keyIndex('BUY_AMOUNT_USD')}`, ctx);
    const r = handleConfigText('9999', ctx);
    assert.equal(r.consumed, true);
    assert.ok(r.edit?.screen.text.includes('Rentang:'));
    assert.ok(sessions.getInput('c1') !== null);
  });

  it('cross-field rejection keeps prompt (TP1 above TP2)', () => {
    const cfg = { ...flowConfig(), TP1_PERCENT: 30, TP2_PERCENT: 50 };
    const { ctx, sessions } = ctxWith(cfg);
    handleConfigCallback(`cfg:k:${keyIndex('TP1_PERCENT')}`, ctx);
    const r = handleConfigText('50', ctx);
    assert.equal(r.consumed, true);
    assert.ok(r.edit?.screen.text.includes('TP1_PERCENT harus lebih kecil dari TP2_PERCENT'));
    assert.ok(sessions.getInput('c1') !== null);
    assert.equal(cfg['TP1_PERCENT'], 30);
  });

  it('unusual value goes to confirm; yes applies, retype returns, cancel drops', () => {
    const first = ctxWith(flowConfig());
    handleConfigCallback(`cfg:k:${keyIndex('BUY_AMOUNT_USD')}`, first.ctx);
    const c = handleConfigText('100', first.ctx);
    assert.ok(c.edit?.screen.text.includes('Nilai di luar kebiasaan'));
    const yes = handleConfigCallback('cfg:cy', first.ctx);
    assert.equal(first.config['BUY_AMOUNT_USD'], 100);
    assert.ok(yes.edit?.text.includes('✅'));

    const second = ctxWith(flowConfig());
    handleConfigCallback(`cfg:k:${keyIndex('BUY_AMOUNT_USD')}`, second.ctx);
    handleConfigText('100', second.ctx);
    const re = handleConfigCallback('cfg:cr', second.ctx);
    assert.ok(re.edit?.text.includes('Ukuran beli'));
    assert.equal(second.config['BUY_AMOUNT_USD'], 10);

    const third = ctxWith(flowConfig());
    handleConfigCallback(`cfg:k:${keyIndex('BUY_AMOUNT_USD')}`, third.ctx);
    handleConfigText('100', third.ctx);
    const x = handleConfigCallback('cfg:x', third.ctx);
    assert.ok(x.edit);
    assert.equal(third.config['BUY_AMOUNT_USD'], 10);
  });

  it('expired input is NOT consumed', () => {
    let t = 0;
    const sessions = new MenuSessions({ now: () => t });
    const config = flowConfig();
    const ctx: MenuCtx = { chatId: 'c1', messageId: 7, config, apply: fakeApply(config), sessions };
    handleConfigCallback(`cfg:k:${keyIndex('BUY_AMOUNT_USD')}`, ctx);
    t = 120001;
    const r = handleConfigText('15', ctx);
    assert.equal(r.consumed, false);
  });

  it('slash line NOT consumed and clears input', () => {
    const { ctx, sessions } = ctxWith(flowConfig());
    handleConfigCallback(`cfg:k:${keyIndex('BUY_AMOUNT_USD')}`, ctx);
    const r = handleConfigText('/set buy 1', ctx);
    assert.equal(r.consumed, false);
    assert.equal(sessions.getInput('c1'), null);
  });

  it('batal variants cancel', () => {
    for (const w of ['batal', 'Batal', 'CANCEL']) {
      const { ctx, sessions } = ctxWith(flowConfig());
      handleConfigCallback(`cfg:k:${keyIndex('BUY_AMOUNT_USD')}`, ctx);
      const r = handleConfigText(w, ctx);
      assert.equal(r.consumed, true, w);
      assert.equal(sessions.getInput('c1'), null);
      assert.ok(r.edit);
    }
  });

  it('toggle flips with banner', () => {
    const { ctx, config } = ctxWith(flowConfig());
    const r = handleConfigCallback(`cfg:t:${keyIndex('ANTI_MEV')}`, ctx);
    assert.equal(config['ANTI_MEV'], true);
    assert.ok(r.edit?.text.includes('✅'));
  });

  it('AUTO_SELL OFF goes through confirm', () => {
    const { ctx, config } = ctxWith(flowConfig());
    const r = handleConfigCallback(`cfg:t:${keyIndex('AUTO_SELL')}`, ctx);
    assert.ok(r.edit?.text.includes('Matikan'));
    assert.equal(config['AUTO_SELL'], true);
    const yes = handleConfigCallback('cfg:cy', ctx);
    assert.equal(config['AUTO_SELL'], false);
    assert.ok(yes.edit?.text.includes('✅'));
  });

  it('quick value applies', () => {
    const { ctx, config } = ctxWith(flowConfig());
    const r = handleConfigCallback(`cfg:q:${keyIndex('BUY_AMOUNT_USD')}:1`, ctx);
    assert.equal(config['BUY_AMOUNT_USD'], 15);
    assert.ok(r.edit?.text.includes('✅'));
  });

  it('undo restores value; second undo refused; expiry refused', () => {
    const { ctx, config } = ctxWith(flowConfig());
    handleConfigCallback(`cfg:k:${keyIndex('BUY_AMOUNT_USD')}`, ctx);
    handleConfigText('15', ctx);
    assert.equal(config['BUY_AMOUNT_USD'], 15);
    const u = handleConfigCallback('cfg:u', ctx);
    assert.equal(config['BUY_AMOUNT_USD'], 10);
    assert.ok(u.edit?.text.includes('dikembalikan'));
    const again = handleConfigCallback('cfg:u', ctx);
    assert.equal(again.answer, EXPIRED_MESSAGE);
    assert.equal(again.alert, true);
  });

  it('undo refused after 300s', () => {
    let t = 0;
    const sessions = new MenuSessions({ now: () => t });
    const config = flowConfig();
    const ctx: MenuCtx = { chatId: 'c1', messageId: 7, config, apply: fakeApply(config), sessions };
    handleConfigCallback(`cfg:k:${keyIndex('BUY_AMOUNT_USD')}`, ctx);
    handleConfigText('15', ctx);
    t = 300001;
    const u = handleConfigCallback('cfg:u', ctx);
    assert.equal(u.answer, EXPIRED_MESSAGE);
  });

  it('second change replaces undo slot', () => {
    const { ctx, config } = ctxWith(flowConfig());
    handleConfigCallback(`cfg:k:${keyIndex('BUY_AMOUNT_USD')}`, ctx);
    handleConfigText('15', ctx);
    handleConfigCallback(`cfg:k:${keyIndex('BUY_AMOUNT_USD')}`, ctx);
    handleConfigText('20', ctx);
    assert.equal(config['BUY_AMOUNT_USD'], 20);
    handleConfigCallback('cfg:u', ctx);
    assert.equal(config['BUY_AMOUNT_USD'], 15);
  });

  it('preset preview lists only changed keys', () => {
    const s = renderPresetPreview('lowrisk', sampleConfig());
    assert.ok(s.text.includes('Hold maksimum'));
    assert.ok(!s.text.includes('Ukuran beli'));
  });

  it('preset apply all-or-nothing and undo restores every key', () => {
    const config = flowConfig();
    const before = { ...(config as Record<string, unknown>) };
    const { ctx } = ctxWith(config);
    const r = handleConfigCallback('cfg:pa:0', ctx);
    assert.ok(r.edit?.text.includes('diterapkan'));
    assert.equal(config['PUMP_MAX_HOLD_MINUTES'], 5);
    handleConfigCallback('cfg:u', ctx);
    assert.equal(config['PUMP_MAX_HOLD_MINUTES'], before['PUMP_MAX_HOLD_MINUTES']);

    const config2 = sampleConfig();
    const bad: MenuCtx = {
      chatId: 'c1',
      messageId: 7,
      config: config2,
      apply: () => 'TP1_PERCENT harus lebih kecil dari TP2_PERCENT',
      sessions: new MenuSessions(),
    };
    const snap = { ...(config2 as Record<string, unknown>) };
    const rej = handleConfigCallback('cfg:pa:0', bad);
    assert.ok(rej.edit?.text.includes('TP1_PERCENT'));
    assert.deepEqual(config2, snap);
  });

  it('unknown/expired callbacks answer expired with alert', () => {
    const { ctx } = ctxWith(flowConfig());
    for (const bad of ['nope', 'cfg:zzz', 'cfg:k:999']) {
      const r = handleConfigCallback(bad, ctx);
      assert.equal(r.answer, EXPIRED_MESSAGE);
      assert.equal(r.alert, true);
    }
    const u = handleConfigCallback('cfg:u', ctx);
    assert.equal(u.answer, EXPIRED_MESSAGE);
  });

  it('slippage typed as 2,5 stores 250', () => {
    const { ctx, config } = ctxWith(flowConfig());
    handleConfigCallback(`cfg:k:${keyIndex('MAX_SLIPPAGE_BPS')}`, ctx);
    const r = handleConfigText('2,5', ctx);
    assert.equal(r.consumed, true);
    assert.equal(config['MAX_SLIPPAGE_BPS'], 250);
  });
});

describe('golden snapshot', () => {
  it('matches src/telegram/__golden__/config-menu-screens.txt byte-for-byte', () => {
    const goldenPath = path.join(process.cwd(), 'src', 'telegram', '__golden__', 'config-menu-screens.txt');
    const expected = fs.readFileSync(goldenPath, 'utf8');
    const actual = formatGolden(buildGoldenScreens(sampleConfig()));
    if (actual !== expected) {
      const a = actual.split('\n');
      const b = expected.split('\n');
      let line = 0;
      while (line < Math.max(a.length, b.length) && a[line] === b[line]) line++;
      assert.fail(`golden differs at line ${line + 1}:\nactual:   ${JSON.stringify(a[line])}\nexpected: ${JSON.stringify(b[line])}`);
    }
  });
});

describe('lowrisk preset fix', () => {
  it('uses BUY_AMOUNT_USD not BUY_AMOUNT_SOL', () => {
    assert.equal(PRESETS['lowrisk']['BUY_AMOUNT_USD'], 10);
    assert.ok(!('BUY_AMOUNT_SOL' in (PRESETS['lowrisk'] as Record<string, unknown>)));
  });
});

const TOGGLE_ORDER = [
  'AUTO_SELL', 'PUMP_SECURITY_CHECK', 'ANTI_MEV',
  'MOONBAG_ENABLED', 'TRAILING_TP_ENABLED', 'BUY_APPROVAL_ENABLED',
] as const;

function allToggles(cfg: Record<string, unknown>, on: boolean): Record<string, unknown> {
  return { ...cfg, AUTO_SELL: on, PUMP_SECURITY_CHECK: on, ANTI_MEV: on, MOONBAG_ENABLED: on, TRAILING_TP_ENABLED: on, BUY_APPROVAL_ENABLED: on };
}

describe('12A-R (a) features screen and main Fitur line list the same toggles in order', () => {
  it('toggle buttons in R1 order; Fitur line matches', () => {
    const feat = renderGroup('features', allToggles(sampleConfig(), true));
    const toggleTexts = feat.keyboard.flat()
      .filter((b) => b.callback_data.startsWith('cfg:t:'))
      .map((b) => b.text);
    assert.deepEqual(toggleTexts, TOGGLE_ORDER.map((k) => `✅ ${SETTING_META[k].label}`));
    const main = renderMain(allToggles(sampleConfig(), true));
    const line = main.text.split('\n').find((l) => l.startsWith('🛡 Fitur'));
    assert.ok(line);
    const names = ['Auto sell', 'Security', 'Anti MEV', 'Moonbag', 'Trailing TP', 'Approval'];
    let pos = -1;
    for (const n of names) {
      const p = line!.indexOf(n);
      assert.ok(p > pos, `${n} out of order in: ${line}`);
      pos = p;
    }
  });
});

describe('12A-R (b) dependents only while their toggle is ON, never in other groups', () => {
  const deps: Array<[string, string]> = [
    ['MOONBAG_PERCENT', 'MOONBAG_ENABLED'],
    ['MOONBAG_TRAIL_PERCENT', 'MOONBAG_ENABLED'],
    ['TRAILING_TP_DROP_PERCENT', 'TRAILING_TP_ENABLED'],
    ['BUY_APPROVAL_TIMEOUT_SEC', 'BUY_APPROVAL_ENABLED'],
  ];
  for (const [dep, toggle] of deps) {
    it(`${dep} visible iff ${toggle} ON, absent from size/exec/entry`, () => {
      const has = (s: Screen, k: string): boolean =>
        s.keyboard.flat().some((b) => b.callback_data === `cfg:k:${keyIndex(k)}`);
      assert.ok(has(renderGroup('features', { ...sampleConfig(), [toggle]: true }), dep));
      assert.ok(!has(renderGroup('features', { ...sampleConfig(), [toggle]: false }), dep));
      for (const g of ['size', 'exec', 'entry'] as const) {
        assert.ok(!has(renderGroup(g, { ...sampleConfig(), [toggle]: true }), dep), `${dep} leaked into ${g}`);
        assert.ok(!has(renderGroup(g, { ...sampleConfig(), [toggle]: false }), dep), `${dep} leaked into ${g}`);
      }
    });
  }
});

describe('12A-R (c) every key reachable exactly once, never duplicated', () => {
  it('over USD on/off x moonbag/trailing/approval on/off', () => {
    const combos: Record<string, unknown>[] = [];
    for (const usd of [10, 0]) {
      for (const mb of [true, false]) {
        for (const tr of [true, false]) {
          for (const ap of [true, false]) {
            combos.push({
              ...sampleConfig(),
              BUY_AMOUNT_USD: usd,
              MOONBAG_ENABLED: mb,
              TRAILING_TP_ENABLED: tr,
              BUY_APPROVAL_ENABLED: ap,
            });
          }
        }
      }
    }
    assert.equal(combos.length, 16);
    const seen = new Map<string, string>();
    for (const cfg of combos) {
      const perCombo = new Set<string>();
      for (const g of ['size', 'exec', 'entry', 'features'] as const) {
        const keys = visibleKeys(g, cfg);
        assert.equal(new Set(keys).size, keys.length, `dup inside ${g}`);
        for (const k of keys) {
          assert.ok(!perCombo.has(k), `${k} in two groups at once`);
          perCombo.add(k);
          if (!seen.has(k)) seen.set(k, g);
          assert.equal(seen.get(k), g, `${k} in multiple groups`);
        }
      }
    }
    assert.deepEqual([...seen.keys()].sort(), [...EDITABLE_CONFIG].sort());
  });
});

describe('12A-R (e) hold range text', () => {
  it("range is '1 mnt – 1.440 mnt' and prompt shows '1 mnt'", () => {
    assert.equal(rangeText('PUMP_MAX_HOLD_MINUTES'), '1 mnt – 1.440 mnt');
    const p = renderPrompt('PUMP_MAX_HOLD_MINUTES', sampleConfig());
    assert.ok(p.text.includes('1 mnt – 1.440 mnt'));
  });
});

describe('12A-R (f) USD nonaktif rendering', () => {
  it('button shows nonaktif, SOL shown, prompt explains', () => {
    const g = renderGroup('size', { ...sampleConfig(), BUY_AMOUNT_USD: 0 });
    const texts = g.keyboard.flat().map((b) => b.text);
    assert.ok(texts.includes('💵 Ukuran beli · nonaktif'));
    assert.ok(texts.some((t) => t.includes('Ukuran beli (SOL)')));
    const pr = renderPrompt('BUY_AMOUNT_USD', { ...sampleConfig(), BUY_AMOUNT_USD: 0 });
    assert.ok(pr.text.includes('nonaktif (pakai SOL)'));
  });
});

describe('12A-R (g) PRESET_META fallback', () => {
  it('unknown preset with <b>& falls back safely', () => {
    const evil = '<b>&x';
    const m = presetMeta(evil);
    assert.equal(m.emoji, '📦');
    assert.equal(m.title, evil);
    assert.equal(m.blurb, '');
    const pv = renderPresetPreview(evil, sampleConfig());
    assert.ok(!pv.text.includes(evil));
    assert.ok(pv.text.includes('&lt;b&gt;'));
  });

  it('lowrisk has friendly name and blurb', () => {
    const m = presetMeta('lowrisk');
    assert.equal(m.emoji, '🐢');
    assert.equal(m.title, 'Low risk');
    assert.ok(m.blurb.length > 0);
    const list = renderPresets(sampleConfig());
    assert.ok(list.keyboard.flat().some((b) => b.text === '🐢 Low risk'));
    assert.ok(list.text.includes(m.blurb));
    const pv = renderPresetPreview('lowrisk', sampleConfig());
    assert.ok(pv.text.includes('Low risk'));
  });
});

describe('12A-R (h) undo shares the back row', () => {
  it('group merges undo with Menu; main keeps undo alone', () => {
    const banner = '✅ <b>Ukuran beli</b>: $10 → <b>$15</b>';
    const g = renderGroup('size', sampleConfig(), banner);
    const last = g.keyboard[g.keyboard.length - 1];
    assert.deepEqual(last.map((b) => b.text), ['⬅️ Menu', '↩️ Urungkan']);
    assert.ok(!g.keyboard.slice(0, -1).some((row) => row.some((b) => b.callback_data === 'cfg:u')));
    const main = renderMain(sampleConfig(), banner);
    const mlast = main.keyboard[main.keyboard.length - 1];
    assert.deepEqual(mlast.map((b) => b.text), ['↩️ Urungkan']);
  });
});
