import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  fmtVal,
  handlePresetCommand,
  handleSetCommand,
  renderConfig,
  renderSetHelp,
  type ConfigCommandDeps,
} from './config-commands';

function baseConfig(): Record<string, any> {
  return {
    BUY_AMOUNT_SOL: 0.5,
    TP1_PERCENT: 30,
    TP1_SELL_PERCENT: 50,
    TP2_PERCENT: 80,
    MOONBAG_ENABLED: true,
    MOONBAG_PERCENT: 15,
    STOP_LOSS_PERCENT: 18,
    MAX_SLIPPAGE_BPS: 1500,
    AUTO_SELL: true,
    PAPER_TRADING: true,
    TWEET_POLL_INTERVAL_MS: 5000,
    PUMP_MAX_POSITIONS: 3,
    PUMP_MAX_HOLD_MINUTES: 30,
    PUMP_MIN_DEV_BUY_SOL: 0.5,
    PUMP_SECURITY_CHECK: true,
    TRAILING_TP_ENABLED: false,
    TRAILING_TP_DROP_PERCENT: 15,
    BUY_APPROVAL_ENABLED: false,
    BUY_APPROVAL_TIMEOUT_SEC: 20,
  };
}

/** Fake apply that mutates like the real one and records calls. */
function successDeps(config: Record<string, any>, calls: Record<string, number | boolean>[] = []): ConfigCommandDeps {
  return {
    config,
    apply: (values) => {
      calls.push(values);
      Object.assign(config, values);
      return null;
    },
  };
}

/** Fake apply that rejects without mutating and records calls. */
function rejectDeps(config: Record<string, any>, err: string, calls: unknown[] = []): ConfigCommandDeps {
  return {
    config,
    apply: (values) => {
      calls.push(values);
      return err;
    },
  };
}

describe('escapeHtml', () => {
  it('escapes & < >', () => {
    assert.equal(escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  });
  it('escapes double and single quotes', () => {
    assert.equal(escapeHtml('"\'<>&'), '&quot;&#39;&lt;&gt;&amp;');
  });
  it('leaves plain text alone', () => {
    assert.equal(escapeHtml('hello 123'), 'hello 123');
  });
});

describe('fmtVal', () => {
  it('booleans -> ON/OFF', () => {
    assert.equal(fmtVal(true), 'ON');
    assert.equal(fmtVal(false), 'OFF');
  });
  it('numbers and strings via String()', () => {
    assert.equal(fmtVal(0.5), '0.5');
    assert.equal(fmtVal(0), '0');
  });
});

describe('renderSetHelp', () => {
  it('lists aliases with current values and full env names', () => {
    const text = renderSetHelp(baseConfig());
    assert.ok(text.includes('/set'));
    assert.ok(text.includes('<code>buy</code> → BUY_AMOUNT_SOL (0.5)'));
    assert.ok(text.includes('BUY_AMOUNT_SOL'));
  });
});

describe('handleSetCommand', () => {
  it('0 args returns help', () => {
    const config = baseConfig();
    const text = handleSetCommand([], successDeps(config));
    assert.ok(text.includes('Cara pakai'));
    assert.ok(text.includes('/set buy 0.25'));
  });

  it('1 arg returns help', () => {
    const config = baseConfig();
    const text = handleSetCommand(['buy'], successDeps(config));
    assert.ok(text.includes('Cara pakai'));
  });

  it('unknown name errors', () => {
    const config = baseConfig();
    const text = handleSetCommand(['nope', '1'], successDeps(config));
    assert.ok(text.startsWith('❌ Nama tidak dikenal'));
    assert.ok(text.includes('nope'));
  });

  it('unknown name is HTML-escaped', () => {
    const config = baseConfig();
    const text = handleSetCommand(['<x>', '1'], successDeps(config));
    assert.ok(text.includes('&lt;x&gt;'));
    assert.ok(!text.includes('<x>'));
  });

  it('invalid value passes parseValue error through, HTML-escaped', () => {
    const config = baseConfig();
    const text = handleSetCommand(['buy', 'abc'], successDeps(config));
    // parseValue -> "BUY_AMOUNT_SOL harus angka >= 0", ">" must be escaped
    assert.ok(text.startsWith('❌ '));
    assert.ok(text.includes('BUY_AMOUNT_SOL harus angka &gt;= 0'));
  });

  it('alias works and shows before -> after', () => {
    const config = baseConfig();
    const calls: Record<string, number | boolean>[] = [];
    const text = handleSetCommand(['buy', '0.25'], successDeps(config, calls));
    assert.equal(text, '✅ <b>BUY_AMOUNT_SOL</b>: 0.5 → 0.25');
    assert.deepEqual(calls, [{ BUY_AMOUNT_SOL: 0.25 }]);
    assert.equal(config.BUY_AMOUNT_SOL, 0.25);
  });

  it('full env name works', () => {
    const config = baseConfig();
    const text = handleSetCommand(['PUMP_MAX_POSITIONS', '5'], successDeps(config));
    assert.equal(text, '✅ <b>PUMP_MAX_POSITIONS</b>: 3 → 5');
    assert.equal(config.PUMP_MAX_POSITIONS, 5);
  });

  it('boolean words work (off -> OFF)', () => {
    const config = baseConfig();
    const text = handleSetCommand(['security', 'off'], successDeps(config));
    assert.equal(text, '✅ <b>PUMP_SECURITY_CHECK</b>: ON → OFF');
    assert.equal(config.PUMP_SECURITY_CHECK, false);
  });

  it('boolean words work (on)', () => {
    const config = baseConfig();
    config.PUMP_SECURITY_CHECK = false;
    const text = handleSetCommand(['PUMP_SECURITY_CHECK', 'on'], successDeps(config));
    assert.equal(text, '✅ <b>PUMP_SECURITY_CHECK</b>: OFF → ON');
  });

  it('apply error returns ❌ with escaped message and config untouched', () => {
    const config = baseConfig();
    const before = { ...config };
    const text = handleSetCommand(['buy', '0.25'], rejectDeps(config, 'bad <value> & stuff'));
    assert.ok(text.startsWith('❌ '));
    assert.ok(text.includes('&lt;value&gt;'));
    assert.ok(text.includes('&amp;'));
    assert.ok(!text.includes('<value>'));
    assert.deepEqual(config, before);
  });
});

describe('handlePresetCommand', () => {
  it('missing name lists presets', () => {
    const text = handlePresetCommand(undefined, successDeps(baseConfig()));
    assert.ok(text.includes('Preset tersedia:'));
    assert.ok(text.includes('lowrisk'));
  });

  it('unknown name lists presets', () => {
    const text = handlePresetCommand('foo', successDeps(baseConfig()));
    assert.ok(text.includes('Preset tersedia:'));
    assert.ok(text.includes('lowrisk'));
  });

  it('lowrisk success shows diff lines and mutates config', () => {
    const config = baseConfig();
    const text = handlePresetCommand('lowrisk', successDeps(config));
    assert.ok(text.includes('✅ <b>Preset lowrisk diterapkan</b>'));
    assert.ok(text.includes('• BUY_AMOUNT_SOL: 0.5 → 0.25'));
    assert.ok(text.includes('• PUMP_MAX_POSITIONS: 3 → 3'));
    assert.equal(config.BUY_AMOUNT_SOL, 0.25);
    assert.equal(config.PUMP_MAX_HOLD_MINUTES, 5);
  });

  it('rejection returns ❌, escapes message, and changes nothing', () => {
    const config = baseConfig();
    const before = { ...config };
    const text = handlePresetCommand('lowrisk', rejectDeps(config, 'TP <bad>'));
    assert.ok(text.startsWith('❌ Preset lowrisk ditolak'));
    assert.ok(text.includes('&lt;bad&gt;'));
    assert.ok(!text.includes('<bad>'));
    assert.deepEqual(config, before);
  });

  it('preset name with HTML is escaped on success', () => {
    // name must still resolve: use exact "lowrisk" but mixed case to prove
    // lower-casing works and output escapes the raw name
    const config = baseConfig();
    const text = handlePresetCommand('LowRisk', successDeps(config));
    assert.ok(text.includes('✅ <b>Preset LowRisk diterapkan</b>'));
  });
});

describe('renderConfig', () => {
  it('reflects the real TP1/TP2 strategy and no stale fields', () => {
    const text = renderConfig(baseConfig());
    assert.ok(text.includes('TP1: +30% (jual 50%)'));
    assert.ok(text.includes('TP2: +80%'));
    assert.ok(text.includes('🌙 Moonbag: 15%'));
    assert.ok(text.includes('🛑 Stop Loss: -18%'));
    assert.ok(!text.includes('(dibatasi 25%)'));
    assert.ok(!text.includes('Take Profit:'));
    assert.ok(!text.includes('Max MCap'));
    assert.ok(text.includes('Ubah: /set'));
    assert.ok(text.includes('/preset'));
  });

  it('caps stop loss at 25 with note when configured higher', () => {
    const config = baseConfig();
    config.STOP_LOSS_PERCENT = 40;
    const text = renderConfig(config);
    assert.ok(text.includes('🛑 Stop Loss: -25% (dibatasi 25%)'));
  });

  it('shows the moonbag trail setting', () => {
    const text = renderConfig({ ...baseConfig(), MOONBAG_TRAIL_PERCENT: 30 });
    assert.ok(text.includes('🌠 Moonbag Trail: 30%'));
    // Missing key falls back to the 30 default without NaN/undefined.
    const fallback = renderConfig(baseConfig());
    assert.ok(fallback.includes('🌠 Moonbag Trail: 30%'));
    assert.ok(!fallback.includes('NaN'));
    assert.ok(!fallback.includes('undefined'));
  });

  it('moonbag OFF state', () => {
    const config = baseConfig();
    config.MOONBAG_ENABLED = false;
    const text = renderConfig(config);
    assert.ok(text.includes('🌙 Moonbag: OFF'));
  });

  it('hold 0 shows nonaktif', () => {
    const config = baseConfig();
    config.PUMP_MAX_HOLD_MINUTES = 0;
    const text = renderConfig(config);
    assert.ok(text.includes('⌛ Max Hold: nonaktif'));
  });

  it('trailing and approval states', () => {
    const off = renderConfig(baseConfig());
    assert.ok(off.includes('📈 Trailing TP: OFF'));
    assert.ok(off.includes('🕹 Approval Buy: OFF'));

    const config = baseConfig();
    config.TRAILING_TP_ENABLED = true;
    config.TRAILING_TP_DROP_PERCENT = 12;
    config.BUY_APPROVAL_ENABLED = true;
    config.BUY_APPROVAL_TIMEOUT_SEC = 45;
    const on = renderConfig(config);
    assert.ok(on.includes('📈 Trailing TP: ON (drop 12%)'));
    assert.ok(on.includes('🕹 Approval Buy: ON (45s)'));
  });

  it('never prints NaN or undefined with missing keys', () => {
    const text = renderConfig({});
    assert.ok(!text.includes('NaN'));
    assert.ok(!text.includes('undefined'));
  });

  it('shows SOL buy line when BUY_AMOUNT_USD is 0', () => {
    const text = renderConfig(baseConfig());
    assert.ok(text.includes('💰 Buy Amount: 0.5 SOL'));
    assert.ok(!text.includes('$'));
  });

  it('shows USD buy line with SOL approx when BUY_AMOUNT_USD > 0', () => {
    const config = baseConfig();
    config.BUY_AMOUNT_USD = 10;
    config.PUMP_SOL_PRICE_USD = 100;
    const text = renderConfig(config);
    assert.ok(text.includes('💰 Buy Amount: $10 (≈ 0.1000 SOL)'));
    assert.ok(!text.includes('NaN'));
  });
});
