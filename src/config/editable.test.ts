import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CONFIG_ALIASES,
  EDITABLE_CONFIG,
  PRESETS,
  RANGES,
  applyConfig,
  parseValue,
  resolveKey,
  tryApplyConfig,
  validateConfig,
} from './editable';

const TMP_DIRS: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editable-test-'));
  TMP_DIRS.push(dir);
  return dir;
}

/** Fake .env files live under os.tmpdir(); the real cwd/.env is never touched. */
function envFile(content: string, mode = 0o644): { dir: string; envPath: string } {
  const dir = tmpDir();
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, content, { mode });
  fs.chmodSync(envPath, mode); // writeFileSync mode is umask-dependent
  return { dir, envPath };
}

after(() => {
  for (const dir of TMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

// Typical defaults from src/config/index.ts plus the values used by the task.
const TYPICAL: Record<string, number> = {
  BUY_AMOUNT_SOL: 0.5,
  TP1_PERCENT: 30,
  TP2_PERCENT: 50,
  PUMP_MIN_DEV_BUY_SOL: 0.3,
  PUMP_MAX_DEV_BUY_SOL: 5,
  PUMP_MIN_MCAP_SOL: 31,
  PUMP_MAX_MCAP_SOL: 50,
};

// ── parseValue ───────────────────────────────────────────────────

describe('parseValue: happy path', () => {
  it('parses floats', () => {
    assert.equal(parseValue('BUY_AMOUNT_SOL', '0.25'), 0.25);
    assert.equal(parseValue('PRIORITY_FEE_BUY_SOL', '0.0000712'), 0.0000712);
  });

  it('parses integers', () => {
    assert.equal(parseValue('MAX_SLIPPAGE_BPS', '1500'), 1500);
    assert.equal(parseValue('PUMP_MAX_HOLD_MINUTES', '1440'), 1440);
  });

  it('parses every boolean spelling case-insensitively', () => {
    for (const raw of ['true', 'on', '1', 'ya', 'TRUE', 'On', 'Ya']) {
      assert.equal(parseValue('AUTO_SELL', raw), true, `AUTO_SELL=${raw}`);
    }
    for (const raw of ['false', 'off', '0', 'tidak', 'FALSE', 'Off', 'Tidak']) {
      assert.equal(parseValue('AUTO_SELL', raw), false, `AUTO_SELL=${raw}`);
    }
  });

  it('keys without a RANGES entry keep the finite >= 0 rule', () => {
    assert.equal(parseValue('UNKNOWN_KEY', '5'), 5);
    assert.equal(parseValue('UNKNOWN_KEY', '1.5'), 1.5);
    assert.equal(typeof parseValue('UNKNOWN_KEY', '-0.1'), 'string');
  });
});

describe('parseValue: malformed numbers', () => {
  for (const raw of ['1e999', 'Infinity', 'NaN', '0x10', '', '   ', '\t\n', 'abc', '1,5', '10abc', '--1']) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      assert.equal(typeof parseValue('BUY_AMOUNT_SOL', raw), 'string');
    });
  }

  it('rejects negative values with the range message', () => {
    assert.equal(parseValue('BUY_AMOUNT_SOL', '-1'), 'BUY_AMOUNT_SOL harus antara 0.001 dan 10');
  });

  it('rejects garbage booleans', () => {
    for (const raw of ['', 'yes', 'no', '2', 'benar', 'salah']) {
      assert.equal(parseValue('TRAILING_TP_ENABLED', raw), 'TRAILING_TP_ENABLED harus on/off');
    }
  });
});

describe('parseValue: range boundaries', () => {
  for (const [key, range] of Object.entries(RANGES)) {
    it(`${key} accepts min/max and rejects just outside`, () => {
      assert.equal(parseValue(key, String(range.min)), range.min);
      assert.equal(parseValue(key, String(range.max)), range.max);
      const below = range.min > 0 ? range.min / 2 : -0.001;
      const above = range.max + Math.max(range.max / 2, 0.001);
      assert.equal(typeof parseValue(key, String(below)), 'string', `below ${below}`);
      assert.equal(typeof parseValue(key, String(above)), 'string', `above ${above}`);
    });
  }

  it('uses the "antara" message with the table bounds', () => {
    assert.equal(parseValue('BUY_AMOUNT_SOL', '11'), 'BUY_AMOUNT_SOL harus antara 0.001 dan 10');
    assert.equal(parseValue('PUMP_MAX_POSITIONS', '21'), 'PUMP_MAX_POSITIONS harus antara 1 dan 20');
  });

  it('integer keys reject fractions within range', () => {
    assert.equal(parseValue('MAX_SLIPPAGE_BPS', '1.5'), 'MAX_SLIPPAGE_BPS harus bilangan bulat');
    assert.equal(parseValue('PUMP_MAX_POSITIONS', '3.5'), 'PUMP_MAX_POSITIONS harus bilangan bulat');
    assert.equal(parseValue('PUMP_MAX_HOLD_MINUTES', '1.5'), 'PUMP_MAX_HOLD_MINUTES harus bilangan bulat');
    assert.equal(parseValue('BUY_APPROVAL_TIMEOUT_SEC', '5.5'), 'BUY_APPROVAL_TIMEOUT_SEC harus bilangan bulat');
  });
});

// ── resolveKey ───────────────────────────────────────────────────

describe('resolveKey', () => {
  it('resolves every alias', () => {
    for (const [alias, key] of Object.entries(CONFIG_ALIASES)) {
      assert.equal(resolveKey(alias), key);
    }
  });

  it('resolves full names and is case-insensitive', () => {
    assert.equal(resolveKey('BUY_AMOUNT_SOL'), 'BUY_AMOUNT_SOL');
    assert.equal(resolveKey('buy_amount_sol'), 'BUY_AMOUNT_SOL');
    assert.equal(resolveKey('BuY_aMoUnT_sOl'), 'BUY_AMOUNT_SOL');
    assert.equal(resolveKey('BUY'), 'BUY_AMOUNT_SOL');
    assert.equal(resolveKey('Posisi'), 'PUMP_MAX_POSITIONS');
    for (const key of EDITABLE_CONFIG) assert.equal(resolveKey(key), key);
  });

  it('returns null for unknown names', () => {
    assert.equal(resolveKey('nope'), null);
    assert.equal(resolveKey('RPC_URL'), null);
    assert.equal(resolveKey(''), null);
  });
});

// ── validateConfig ───────────────────────────────────────────────

describe('validateConfig', () => {
  it('accepts typical defaults', () => {
    assert.equal(validateConfig(TYPICAL), null);
  });

  it('rejects TP1_PERCENT >= TP2_PERCENT', () => {
    assert.equal(
      validateConfig({ ...TYPICAL, TP1_PERCENT: 50 }),
      'TP1_PERCENT harus lebih kecil dari TP2_PERCENT',
    );
    assert.equal(
      validateConfig({ ...TYPICAL, TP1_PERCENT: 90 }),
      'TP1_PERCENT harus lebih kecil dari TP2_PERCENT',
    );
  });

  it('rejects PUMP_MIN_DEV_BUY_SOL > PUMP_MAX_DEV_BUY_SOL', () => {
    assert.equal(
      validateConfig({ PUMP_MIN_DEV_BUY_SOL: 8, PUMP_MAX_DEV_BUY_SOL: 5 }),
      'PUMP_MIN_DEV_BUY_SOL harus <= PUMP_MAX_DEV_BUY_SOL',
    );
    assert.equal(validateConfig({ PUMP_MIN_DEV_BUY_SOL: 5, PUMP_MAX_DEV_BUY_SOL: 5 }), null);
  });

  it('rejects PUMP_MIN_MCAP_SOL > PUMP_MAX_MCAP_SOL only when max > 0', () => {
    assert.equal(
      validateConfig({ PUMP_MIN_MCAP_SOL: 100, PUMP_MAX_MCAP_SOL: 50 }),
      'PUMP_MIN_MCAP_SOL harus <= PUMP_MAX_MCAP_SOL',
    );
    assert.equal(validateConfig({ PUMP_MIN_MCAP_SOL: 50, PUMP_MAX_MCAP_SOL: 50 }), null);
    assert.equal(validateConfig({ PUMP_MIN_MCAP_SOL: 100, PUMP_MAX_MCAP_SOL: 0 }), null);
  });

  it('skips rules when a key is missing or not a finite number', () => {
    assert.equal(validateConfig({ TP1_PERCENT: 90 }), null);
    assert.equal(validateConfig({ TP1_PERCENT: 90, TP2_PERCENT: 'x' as unknown as number }), null);
    assert.equal(validateConfig({ PUMP_MIN_DEV_BUY_SOL: 99 }), null);
    assert.equal(validateConfig({ PUMP_MIN_MCAP_SOL: 99 }), null);
    assert.equal(validateConfig({ TP2_PERCENT: 50, TP1_PERCENT: Number.NaN }), null);
  });
});

// ── tryApplyConfig ───────────────────────────────────────────────

describe('tryApplyConfig', () => {
  it('writes .env and only then updates config on success', () => {
    const { envPath } = envFile('BUY_AMOUNT_SOL=0.5\nKEEP=me\n');
    const config: Record<string, any> = { ...TYPICAL, KEEP: 'me' };
    const err = tryApplyConfig({ BUY_AMOUNT_SOL: 0.25 }, { config, envPath });
    assert.equal(err, null);
    assert.equal(config.BUY_AMOUNT_SOL, 0.25);
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'BUY_AMOUNT_SOL=0.25\nKEEP=me\n');
  });

  it('allows PAPER_TRADING even though it is not in EDITABLE_CONFIG', () => {
    const dir = tmpDir();
    const envPath = path.join(dir, '.env');
    const config: Record<string, any> = { PAPER_TRADING: true };
    assert.equal(tryApplyConfig({ PAPER_TRADING: false }, { config, envPath }), null);
    assert.equal(config.PAPER_TRADING, false);
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'PAPER_TRADING=false\n');
  });

  it('rejects unknown keys and changes nothing', () => {
    const original = 'BUY_AMOUNT_SOL=0.5\n';
    const { dir, envPath } = envFile(original);
    const config: Record<string, any> = { BUY_AMOUNT_SOL: 0.5 };
    const err = tryApplyConfig({ NOPE: 1 }, { config, envPath });
    assert.ok(err);
    assert.match(err, /NOPE/);
    assert.equal(config.BUY_AMOUNT_SOL, 0.5);
    assert.equal('NOPE' in config, false);
    assert.equal(fs.readFileSync(envPath, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(dir), ['.env']);
  });

  it('re-validates types, ranges and integers and changes nothing', () => {
    const original = 'BUY_AMOUNT_SOL=0.5\n';
    const { envPath } = envFile(original);
    const config: Record<string, any> = { BUY_AMOUNT_SOL: 0.5 };
    assert.match(tryApplyConfig({ BUY_AMOUNT_SOL: true }, { config, envPath }) as string, /angka/);
    assert.match(tryApplyConfig({ AUTO_SELL: 1 }, { config, envPath }) as string, /on\/off/);
    assert.match(tryApplyConfig({ BUY_AMOUNT_SOL: 50 }, { config, envPath }) as string, /antara 0.001 dan 10/);
    assert.match(tryApplyConfig({ BUY_AMOUNT_SOL: Number.NaN }, { config, envPath }) as string, /angka/);
    assert.match(tryApplyConfig({ PUMP_MAX_POSITIONS: 3.5 }, { config, envPath }) as string, /bilangan bulat/);
    assert.equal(config.BUY_AMOUNT_SOL, 0.5);
    assert.equal(fs.readFileSync(envPath, 'utf8'), original);
  });

  it('rejects cross-field violations and changes nothing', () => {
    const tpEnv = envFile('TP1_PERCENT=30\nTP2_PERCENT=50\n');
    const tpConfig: Record<string, any> = { TP1_PERCENT: 30, TP2_PERCENT: 50 };
    assert.equal(
      tryApplyConfig({ TP1_PERCENT: 50 }, { config: tpConfig, envPath: tpEnv.envPath }),
      'TP1_PERCENT harus lebih kecil dari TP2_PERCENT',
    );
    assert.equal(tpConfig.TP1_PERCENT, 30);
    assert.equal(fs.readFileSync(tpEnv.envPath, 'utf8'), 'TP1_PERCENT=30\nTP2_PERCENT=50\n');

    const devEnv = envFile('PUMP_MIN_DEV_BUY_SOL=0.3\nPUMP_MAX_DEV_BUY_SOL=5\n');
    const devConfig: Record<string, any> = { PUMP_MIN_DEV_BUY_SOL: 0.3, PUMP_MAX_DEV_BUY_SOL: 5 };
    assert.match(
      tryApplyConfig({ PUMP_MIN_DEV_BUY_SOL: 6 }, { config: devConfig, envPath: devEnv.envPath }) as string,
      /PUMP_MIN_DEV_BUY_SOL/,
    );
    assert.equal(devConfig.PUMP_MIN_DEV_BUY_SOL, 0.3);
    assert.equal(fs.readFileSync(devEnv.envPath, 'utf8'), 'PUMP_MIN_DEV_BUY_SOL=0.3\nPUMP_MAX_DEV_BUY_SOL=5\n');

    const mcapEnv = envFile('PUMP_MIN_MCAP_SOL=31\nPUMP_MAX_MCAP_SOL=50\n');
    const mcapConfig: Record<string, any> = { PUMP_MIN_MCAP_SOL: 31, PUMP_MAX_MCAP_SOL: 50 };
    assert.match(
      tryApplyConfig({ PUMP_MIN_MCAP_SOL: 100 }, { config: mcapConfig, envPath: mcapEnv.envPath }) as string,
      /PUMP_MIN_MCAP_SOL/,
    );
    assert.equal(mcapConfig.PUMP_MIN_MCAP_SOL, 31);
    assert.equal(fs.readFileSync(mcapEnv.envPath, 'utf8'), 'PUMP_MIN_MCAP_SOL=31\nPUMP_MAX_MCAP_SOL=50\n');
  });
});

// ── tryApplyConfig: atomic .env write ────────────────────────────

describe('tryApplyConfig: atomic .env write', () => {
  it('creates a missing .env with mode 600', () => {
    const dir = tmpDir();
    const envPath = path.join(dir, '.env');
    const config: Record<string, any> = { AUTO_SELL: true };
    assert.equal(tryApplyConfig({ AUTO_SELL: false }, { config, envPath }), null);
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'AUTO_SELL=false\n');
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    assert.equal(config.AUTO_SELL, false);
  });

  it('preserves the existing file mode', () => {
    const { envPath } = envFile('AUTO_SELL=true\n', 0o640);
    const config: Record<string, any> = { AUTO_SELL: true };
    assert.equal(tryApplyConfig({ AUTO_SELL: false }, { config, envPath }), null);
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o640);
  });

  it('keeps unrelated lines and comments byte-for-byte', () => {
    const original = '# top\nTELEGRAM_BOT_TOKEN=abc\n\nBUY_AMOUNT_SOL=0.5\n# outro\nOTHER=1\n';
    const { envPath } = envFile(original);
    const config: Record<string, any> = { ...TYPICAL, BUY_AMOUNT_SOL: 0.5 };
    assert.equal(tryApplyConfig({ BUY_AMOUNT_SOL: 1 }, { config, envPath }), null);
    assert.equal(
      fs.readFileSync(envPath, 'utf8'),
      '# top\nTELEGRAM_BOT_TOKEN=abc\n\nBUY_AMOUNT_SOL=1\n# outro\nOTHER=1\n',
    );
  });

  it('drops only the inline comment on the patched line', () => {
    const { envPath } = envFile('BUY_AMOUNT_SOL=0.5 # remark\nNEXT=1\n');
    const config: Record<string, any> = { ...TYPICAL, BUY_AMOUNT_SOL: 0.5 };
    assert.equal(tryApplyConfig({ BUY_AMOUNT_SOL: 1 }, { config, envPath }), null);
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'BUY_AMOUNT_SOL=1\nNEXT=1\n');
  });

  it('appends missing keys on their own lines', () => {
    const first = envFile('EXISTING=1\n');
    const config: Record<string, any> = { AUTO_SELL: true };
    assert.equal(tryApplyConfig({ AUTO_SELL: false }, { config, envPath: first.envPath }), null);
    assert.equal(fs.readFileSync(first.envPath, 'utf8'), 'EXISTING=1\nAUTO_SELL=false\n');

    const noEol = envFile('EXISTING=1');
    assert.equal(tryApplyConfig({ AUTO_SELL: true }, { config: { ...config }, envPath: noEol.envPath }), null);
    assert.equal(fs.readFileSync(noEol.envPath, 'utf8'), 'EXISTING=1\nAUTO_SELL=true\n');
  });

  it('never interprets the value as a $-pattern (function replacer)', () => {
    const { envPath } = envFile("OTHER=$1$&$'\nBUY_AMOUNT_SOL=$1\n");
    const config: Record<string, any> = { ...TYPICAL, BUY_AMOUNT_SOL: 0.5 };
    assert.equal(tryApplyConfig({ BUY_AMOUNT_SOL: 1 }, { config, envPath }), null);
    assert.equal(fs.readFileSync(envPath, 'utf8'), "OTHER=$1$&$'\nBUY_AMOUNT_SOL=1\n");
  });

  it('leaves no temp files behind on success', () => {
    const { dir, envPath } = envFile('AUTO_SELL=true\n');
    const config: Record<string, any> = { AUTO_SELL: true };
    assert.equal(tryApplyConfig({ AUTO_SELL: false }, { config, envPath }), null);
    assert.deepEqual(fs.readdirSync(dir), ['.env']);
  });

  it('returns an error and leaves config untouched when .env cannot be written', () => {
    const dir = tmpDir();
    const envPath = path.join(dir, 'no-such-dir', '.env');
    const config: Record<string, any> = { ...TYPICAL, BUY_AMOUNT_SOL: 0.5 };
    const err = tryApplyConfig({ BUY_AMOUNT_SOL: 0.25 }, { config, envPath });
    assert.ok(err);
    assert.match(err, /Gagal menulis \.env/);
    assert.equal(config.BUY_AMOUNT_SOL, 0.5);
    assert.equal(fs.existsSync(envPath), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('applies PRESETS.lowrisk cleanly on typical defaults', () => {
    assert.equal(validateConfig({ ...TYPICAL, ...PRESETS.lowrisk }), null);
    const dir = tmpDir();
    const envPath = path.join(dir, '.env');
    const config: Record<string, any> = { ...TYPICAL };
    const err = tryApplyConfig(PRESETS.lowrisk as Record<string, number | boolean>, { config, envPath });
    assert.equal(err, null);
    for (const [key, val] of Object.entries(PRESETS.lowrisk)) assert.equal(config[key], val);
    assert.equal(config.PUMP_SECURITY_CHECK, true);
  });
});

// ── applyConfig ──────────────────────────────────────────────────

describe('applyConfig', () => {
  it('throws on out-of-range numbers', () => {
    assert.throws(() => applyConfig({ BUY_AMOUNT_SOL: 999 }), /BUY_AMOUNT_SOL harus antara 0.001 dan 10/);
  });

  it('throws on unknown keys', () => {
    assert.throws(() => applyConfig({ NOPE: 1 }), /NOPE/);
  });

  it('throws on cross-field violations', () => {
    assert.throws(() => applyConfig({ TP1_PERCENT: 1000, TP2_PERCENT: 1 }), /TP1_PERCENT/);
  });
});