import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PRESETS, parseValue, tryApplyConfig, validateConfig } from './editable';
import { LIVE_LOCK_MESSAGE, enforceStartupMode, liveModeBlocked } from './live-guard';

const TMP_DIRS: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-guard-test-'));
  TMP_DIRS.push(dir);
  return dir;
}

/** Fake .env files live under os.tmpdir(); the real cwd/.env is never touched. */
function envFile(content: string): { dir: string; envPath: string } {
  const dir = tmpDir();
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, content);
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

// ── liveModeBlocked ──────────────────────────────────────────────

describe('liveModeBlocked', () => {
  it('requestedPaper=true is always allowed', () => {
    assert.equal(liveModeBlocked(true, false), null);
    assert.equal(liveModeBlocked(true, true), null);
  });

  it('requestedPaper=false + allowed => null', () => {
    assert.equal(liveModeBlocked(false, true), null);
  });

  it('requestedPaper=false + not allowed => Indonesian lock message', () => {
    assert.equal(liveModeBlocked(false, false), LIVE_LOCK_MESSAGE);
    assert.match(liveModeBlocked(false, false) as string, /Mode LIVE dikunci/);
  });
});

// ── enforceStartupMode ───────────────────────────────────────────

describe('enforceStartupMode', () => {
  it('forces PAPER_TRADING=true when false and not allowed', () => {
    const config = { PAPER_TRADING: false, LIVE_TRADING_ALLOWED: false };
    const res = enforceStartupMode(config);
    assert.equal(res.forced, true);
    assert.ok(res.message);
    assert.match(res.message as string, /Mode LIVE dikunci/);
    assert.equal(config.PAPER_TRADING, true);
  });

  it('no change when LIVE is allowed', () => {
    const config = { PAPER_TRADING: false, LIVE_TRADING_ALLOWED: true };
    const res = enforceStartupMode(config);
    assert.equal(res.forced, false);
    assert.equal(res.message, null);
    assert.equal(config.PAPER_TRADING, false);
  });

  it('no change when already paper', () => {
    const config = { PAPER_TRADING: true, LIVE_TRADING_ALLOWED: false };
    const res = enforceStartupMode(config);
    assert.equal(res.forced, false);
    assert.equal(res.message, null);
    assert.equal(config.PAPER_TRADING, true);
  });
});

// ── Stage 9b-A: hardened ranges + TP1/moonbag cap + LIVE-mode guard ──
// (separate block at EOF so a 3-way merge with the other agent's edits stays
// trivial; TYPICAL stays untouched above).

describe('Stage 9b-A: hardened ranges', () => {
  it('STOP_LOSS_PERCENT caps at 25', () => {
    assert.equal(parseValue('STOP_LOSS_PERCENT', '25'), 25);
    assert.match(parseValue('STOP_LOSS_PERCENT', '26') as string, /antara 1 dan 25/);
  });

  it('MAX_SLIPPAGE_BPS caps at 2500', () => {
    assert.equal(parseValue('MAX_SLIPPAGE_BPS', '2500'), 2500);
    assert.match(parseValue('MAX_SLIPPAGE_BPS', '2501') as string, /antara 1 dan 2500/);
  });

  it('BUY_AMOUNT_SOL caps at 2', () => {
    assert.equal(parseValue('BUY_AMOUNT_SOL', '2'), 2);
    assert.match(parseValue('BUY_AMOUNT_SOL', '2.01') as string, /antara 0.001 dan 2/);
  });

  it('PUMP_MAX_POSITIONS caps at 10', () => {
    assert.equal(parseValue('PUMP_MAX_POSITIONS', '10'), 10);
    assert.match(parseValue('PUMP_MAX_POSITIONS', '11') as string, /antara 1 dan 10/);
  });

  it('PUMP_MAX_HOLD_MINUTES runtime floor is 1 via tryApplyConfig', () => {
    const { envPath } = envFile('PUMP_MAX_HOLD_MINUTES=5\n');
    const config: Record<string, any> = { PUMP_MAX_HOLD_MINUTES: 5 };
    assert.match(
      tryApplyConfig({ PUMP_MAX_HOLD_MINUTES: 0 }, { config, envPath }) as string,
      /antara 1 dan 1440/,
    );
    assert.equal(config.PUMP_MAX_HOLD_MINUTES, 5);
    assert.equal(tryApplyConfig({ PUMP_MAX_HOLD_MINUTES: 1 }, { config, envPath }), null);
    assert.equal(config.PUMP_MAX_HOLD_MINUTES, 1);
  });
});

describe('TP1_SELL_PERCENT and MOONBAG_PERCENT are independent (moonbag is taken from the remainder after TP1)', () => {
  it('accepts TP1 selling 80% with a 25% moonbag (the setup the bot actually ran with)', () => {
    assert.equal(
      validateConfig({ TP1_PERCENT: 30, TP2_PERCENT: 50, TP1_SELL_PERCENT: 80, MOONBAG_PERCENT: 25, MOONBAG_ENABLED: true }),
      null,
    );
  });

  it('accepts sums over 100, TP1 selling everything, and moonbag disabled', () => {
    assert.equal(validateConfig({ TP1_SELL_PERCENT: 90, MOONBAG_PERCENT: 15, MOONBAG_ENABLED: true }), null);
    assert.equal(validateConfig({ TP1_SELL_PERCENT: 100, MOONBAG_PERCENT: 50, MOONBAG_ENABLED: true }), null);
    assert.equal(validateConfig({ TP1_SELL_PERCENT: 100, MOONBAG_PERCENT: 50, MOONBAG_ENABLED: false }), null);
  });

  it('an unrelated edit is never blocked by those two values', () => {
    const r = tryApplyConfig(
      { BUY_AMOUNT_USD: 12 },
      {
        config: { TP1_PERCENT: 30, TP2_PERCENT: 50, TP1_SELL_PERCENT: 80, MOONBAG_PERCENT: 25, MOONBAG_ENABLED: true, BUY_AMOUNT_USD: 10 },
        envPath: path.join(tmpDir(), '.env'),
      },
    );
    assert.equal(r, null);
  });
});

describe('Stage 9b-A: LIVE-mode guard on tryApplyConfig', () => {
  it('rejects PAPER_TRADING=false without the unlock', () => {
    const { envPath } = envFile('PAPER_TRADING=true\n');
    const config: Record<string, any> = { PAPER_TRADING: true };
    const err = tryApplyConfig({ PAPER_TRADING: false }, { config, envPath, liveAllowed: false });
    assert.equal(err, 'Mode LIVE dikunci: set LIVE_TRADING_ALLOWED=true di .env lalu restart');
    assert.equal(config.PAPER_TRADING, true);
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'PAPER_TRADING=true\n');
  });

  it('allows PAPER_TRADING=false with the unlock', () => {
    const { envPath } = envFile('PAPER_TRADING=true\n');
    const config: Record<string, any> = { PAPER_TRADING: true };
    assert.equal(
      tryApplyConfig({ PAPER_TRADING: false }, { config, envPath, liveAllowed: true }),
      null,
    );
    assert.equal(config.PAPER_TRADING, false);
  });

  it('PAPER_TRADING=true is always allowed', () => {
    const { envPath } = envFile('PAPER_TRADING=false\n');
    const config: Record<string, any> = { PAPER_TRADING: false };
    assert.equal(
      tryApplyConfig({ PAPER_TRADING: true }, { config, envPath, liveAllowed: false }),
      null,
    );
    assert.equal(config.PAPER_TRADING, true);
  });
});
