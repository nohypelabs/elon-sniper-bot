import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EDITABLE_CONFIG, RANGES, parseValue, type EditableKey } from './editable';
import {
  GROUPS,
  GROUP_ORDER,
  SETTING_META,
  comfortRange,
  fmtNumber,
  fmtValue,
  hiddenNote,
  toDisplay,
  toStored,
  visibleKeys,
} from './setting-meta';

describe('SETTING_META keys === EDITABLE_CONFIG', () => {
  it('no missing, no extra', () => {
    const metaKeys = Object.keys(SETTING_META).sort();
    const editableKeys = [...EDITABLE_CONFIG].sort();
    assert.deepEqual(metaKeys, editableKeys);
  });

  it('labels <= 22 chars, hints one sentence <= 90 chars', () => {
    for (const key of EDITABLE_CONFIG) {
      const m = SETTING_META[key];
      assert.ok(m.label.length <= 22, `${key} label too long: ${m.label}`);
      assert.ok(m.hint.length <= 90, `${key} hint too long: ${m.hint}`);
      assert.ok(m.hint.length > 0, `${key} hint empty`);
    }
  });

  it('groups cover all keys with valid group ids', () => {
    const ids = new Set(GROUPS.map((g) => g.id));
    assert.deepEqual([...ids].sort(), ['entry', 'exec', 'features', 'size']);
    for (const key of EDITABLE_CONFIG) {
      assert.ok(ids.has(SETTING_META[key].group), `${key} bad group`);
    }
  });
});

describe('quick values pass parseValue after toStored', () => {
  for (const key of EDITABLE_CONFIG) {
    const m = SETTING_META[key];
    if (m.kind !== 'number' || !m.quick) continue;
    it(`${key} quick inside RANGES`, () => {
      assert.ok(m.quick!.length >= 3 && m.quick!.length <= 4, `${key} quick count`);
      for (const q of m.quick!) {
        const stored = toStored(key, q);
        const res = parseValue(key, String(stored));
        assert.equal(res, stored, `${key} quick ${q} -> stored ${stored} rejected: ${res}`);
      }
    });
  }
});

describe('comfort zones inside RANGES', () => {
  for (const key of EDITABLE_CONFIG) {
    const m = SETTING_META[key];
    if (m.kind !== 'number') continue;
    it(`${key} comfort inside RANGES`, () => {
      const c = comfortRange(key);
      assert.ok(c, `${key} missing comfort`);
      const [lo, hi] = c!;
      assert.ok(lo <= hi, `${key} comfort inverted`);
      const range = RANGES[key];
      assert.ok(range, `${key} missing RANGES`);
      const loStored = toStored(key, lo);
      const hiStored = toStored(key, hi);
      assert.ok(loStored >= range.min && hiStored <= range.max, `${key} comfort ${lo}-${hi} outside ${range.min}-${range.max}`);
      if (m.comfort) {
        assert.deepEqual(m.comfort, c);
      } else {
        assert.deepEqual(c, [Math.min(...m.quick!), Math.max(...m.quick!)]);
      }
    });
  }
});

describe('fmtNumber', () => {
  it('table', () => {
    assert.equal(fmtNumber(0.5, 2), '0,5');
    assert.equal(fmtNumber(1000, 2), '1.000');
    assert.equal(fmtNumber(0.0000712, 7), '0,0000712');
    assert.equal(fmtNumber(10, 2), '10');
    assert.equal(fmtNumber(Number.NaN, 2), '-');
    assert.equal(fmtNumber(Number.POSITIVE_INFINITY, 2), '-');
    assert.equal(fmtNumber(undefined as unknown as number, 2), '-');
    assert.equal(fmtNumber(-5, 2), '-5');
    assert.equal(fmtNumber(0.25, 3), '0,25');
    assert.equal(fmtNumber(2.5, 2), '2,5');
    assert.equal(fmtNumber(30, 0), '30');
  });
});

describe('fmtValue units', () => {
  it('usd/sol/mnt/dtk/plain', () => {
    assert.equal(fmtValue('BUY_AMOUNT_USD', 10), '$10');
    assert.equal(fmtValue('BUY_AMOUNT_USD', 1000), '$1.000');
    assert.equal(fmtValue('BUY_AMOUNT_SOL', 0.25), '0,25 SOL');
    assert.equal(fmtValue('PUMP_MAX_HOLD_MINUTES', 30), '30 mnt');
    assert.equal(fmtValue('BUY_APPROVAL_TIMEOUT_SEC', 20), '20 dtk');
    assert.equal(fmtValue('PUMP_MAX_POSITIONS', 3), '3');
  });

  it('plus on TP1/TP2, U+2212 on stop loss', () => {
    assert.equal(fmtValue('TP1_PERCENT', 30), '+30%');
    assert.equal(fmtValue('TP2_PERCENT', 50), '+50%');
    assert.equal(fmtValue('STOP_LOSS_PERCENT', 25), '−25%');
    assert.ok(fmtValue('STOP_LOSS_PERCENT', 25).startsWith('−'));
    assert.equal(fmtValue('TP1_SELL_PERCENT', 80), '80%');
    assert.equal(fmtValue('MOONBAG_TRAIL_PERCENT', 30), '30%');
  });

  it('slippage bps 200 -> 2%', () => {
    assert.equal(fmtValue('MAX_SLIPPAGE_BPS', 200), '2%');
  });

  it('toggles ON/OFF, missing -> -', () => {
    assert.equal(fmtValue('AUTO_SELL', true), 'ON');
    assert.equal(fmtValue('AUTO_SELL', false), 'OFF');
    assert.equal(fmtValue('BUY_AMOUNT_USD', undefined), '-');
    assert.equal(fmtValue('BUY_AMOUNT_USD', Number.NaN), '-');
    assert.equal(fmtValue('AUTO_SELL', undefined), '-');
  });
});

describe('toStored/toDisplay slippage round trip', () => {
  it('2.5% -> 250 bps', () => {
    assert.equal(toStored('MAX_SLIPPAGE_BPS', 2.5), 250);
    assert.equal(toDisplay('MAX_SLIPPAGE_BPS', 250), 2.5);
    assert.equal(fmtValue('MAX_SLIPPAGE_BPS', 250), '2,5%');
  });
});

describe('visibleKeys/hiddenNote', () => {
  const base: Record<string, unknown> = {
    BUY_AMOUNT_USD: 10,
    MOONBAG_ENABLED: true,
    TRAILING_TP_ENABLED: false,
    BUY_APPROVAL_ENABLED: false,
  };

  it('hides BUY_AMOUNT_SOL while USD > 0', () => {
    assert.ok(!visibleKeys('size', base).includes('BUY_AMOUNT_SOL'));
    assert.ok(visibleKeys('size', base).includes('BUY_AMOUNT_USD'));
    assert.ok(visibleKeys('size', { ...base, BUY_AMOUNT_USD: 0 }).includes('BUY_AMOUNT_SOL'));
  });

  it('hides approval timeout while approval OFF', () => {
    assert.ok(!visibleKeys('features', base).includes('BUY_APPROVAL_TIMEOUT_SEC' as EditableKey));
    assert.ok(visibleKeys('features', { ...base, BUY_APPROVAL_ENABLED: true }).includes('BUY_APPROVAL_TIMEOUT_SEC' as EditableKey));
  });

  it('hides trailing drop while trailing OFF', () => {
    assert.ok(!visibleKeys('features', base).includes('TRAILING_TP_DROP_PERCENT' as EditableKey));
    assert.ok(visibleKeys('features', { ...base, TRAILING_TP_ENABLED: true }).includes('TRAILING_TP_DROP_PERCENT' as EditableKey));
  });

  it('hides moonbag pct/trail while moonbag OFF', () => {
    assert.ok(visibleKeys('features', base).includes('MOONBAG_PERCENT' as EditableKey));
    const off = { ...base, MOONBAG_ENABLED: false };
    assert.ok(!visibleKeys('features', off).includes('MOONBAG_PERCENT' as EditableKey));
    assert.ok(!visibleKeys('features', off).includes('MOONBAG_TRAIL_PERCENT' as EditableKey));
  });

  it('hiddenNote lists hidden labels or null', () => {
    assert.equal(hiddenNote('size', { ...base, BUY_AMOUNT_USD: 0, MOONBAG_ENABLED: true }), null);
    const note = hiddenNote('size', base);
    assert.ok(note && note.startsWith('Disembunyikan (tidak dipakai saat ini):'));
    assert.ok(note!.includes('Ukuran beli (SOL)'));
    assert.equal(hiddenNote('features', base), null);
    assert.equal(hiddenNote('features', { ...base, MOONBAG_ENABLED: true, TRAILING_TP_ENABLED: true, BUY_APPROVAL_ENABLED: true }), null);
  });
});

describe('GROUP_ORDER display order (12A-R)', () => {
  it('covers every EDITABLE_CONFIG key exactly once and matches meta.group', () => {
    const all = [...GROUP_ORDER.size, ...GROUP_ORDER.exec, ...GROUP_ORDER.entry, ...GROUP_ORDER.features];
    assert.equal(all.length, EDITABLE_CONFIG.length);
    assert.equal(new Set(all).size, EDITABLE_CONFIG.length);
    assert.deepEqual([...all].sort(), [...EDITABLE_CONFIG].sort());
    for (const g of ['size', 'exec', 'entry', 'features'] as const) {
      for (const k of GROUP_ORDER[g]) assert.equal(SETTING_META[k].group, g, `${k} group mismatch`);
    }
  });

  it('features toggles in R1 order', () => {
    const toggles = GROUP_ORDER.features.filter((k) => SETTING_META[k].kind === 'toggle');
    assert.deepEqual(toggles, [
      'AUTO_SELL', 'PUMP_SECURITY_CHECK', 'ANTI_MEV',
      'MOONBAG_ENABLED', 'TRAILING_TP_ENABLED', 'BUY_APPROVAL_ENABLED',
    ]);
  });
});

describe('labels and emoji uniqueness (12A-R)', () => {
  it('no two settings share a label', () => {
    const labels = [...EDITABLE_CONFIG].map((k) => SETTING_META[k].label);
    assert.equal(new Set(labels).size, labels.length);
  });

  it('emoji unique within each group', () => {
    for (const g of ['size', 'exec', 'entry', 'features'] as const) {
      const emojis = GROUP_ORDER[g].map((k) => SETTING_META[k].emoji);
      assert.equal(new Set(emojis).size, emojis.length, `${g} duplicate emoji`);
    }
  });
});

describe('hold runtime range (12A-R R4)', () => {
  it("parseValue rejects '0' and accepts '1'", () => {
    assert.equal(typeof parseValue('PUMP_MAX_HOLD_MINUTES', '0'), 'string');
    assert.equal(parseValue('PUMP_MAX_HOLD_MINUTES', '1'), 1);
  });

  it('meta carries runtimeMin 1', () => {
    assert.equal(SETTING_META['PUMP_MAX_HOLD_MINUTES'].runtimeMin, 1);
  });
});

describe('USD off display (12A-R R5)', () => {
  it("fmtValue 0 -> 'nonaktif'", () => {
    assert.equal(fmtValue('BUY_AMOUNT_USD', 0), 'nonaktif');
    assert.equal(fmtValue('BUY_AMOUNT_USD', 10), '$10');
  });
});
