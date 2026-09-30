import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBondingCurve,
  curvePriceInSol,
  curveMarketCapSol,
  deriveBondingCurve,
} from './bonding-curve';

// Real account snapshot (125 bytes, base64) for the fixture curve below.
// NOTE (verified 2026-09-30): this blob is a real snapshot of the fixture
// curve but from a DIFFERENT slot than the exact reserve numbers quoted in
// the spec — it decodes to vTok=927775562464559 / vSol=34695891232 (same
// curve: identical tokenTotalSupply, complete=0, same 30-SOL virtual floor
// vSol-rSol=30e9 and same vTok-rTok delta). The exact-numbers assertions
// therefore encode the quoted reserves into a buffer explicitly; the blob
// itself is asserted for structural consistency (see 'live snapshot blob').
const FIXTURE_B64 =
  'F7f4N2DYrGAv/dSUzksDACBJCRQIAAAAL2XCSD1NAgAgneUXAQAAAACAxqR+jQMAAGZxgmiH1SiIU649Ou5mwvTS0DjHjqu2vl1PGIkVmaq3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const FIXTURE_MINT = 'ByC6mSH1tZ85SHi8UrN8UKAZRHEfTTpnxrwvbAQLpump';
const FIXTURE_CURVE = '6zmH5rF19wUui3YKLv6d488nuqhf2MyiBccRv4dGLGfZ';

/** Buffer encoding the exact spec-quoted reserves (discriminator + 125 bytes). */
function specNumbersBuffer(): Buffer {
  const buf = Buffer.alloc(125);
  Buffer.from('17b7f83760d8ac60', 'hex').copy(buf, 0);
  buf.writeBigUInt64LE(976416280758379n, 8);
  buf.writeBigUInt64LE(32967496174n, 16);
  buf.writeBigUInt64LE(696516280758379n, 24);
  buf.writeBigUInt64LE(2967496174n, 32);
  buf.writeBigUInt64LE(1000000000000000n, 40);
  buf[48] = 0;
  return buf;
}

describe('parseBondingCurve exact numbers', () => {
  it('decodes exact reserve numbers', () => {
    const c = parseBondingCurve(specNumbersBuffer());
    assert.ok(c);
    assert.equal(c.virtualTokenReserves, 976416280758379n);
    assert.equal(c.virtualSolReserves, 32967496174n);
    assert.equal(c.realTokenReserves, 696516280758379n);
    assert.equal(c.realSolReserves, 2967496174n);
    assert.equal(c.tokenTotalSupply, 1000000000000000n);
    assert.equal(c.complete, false);
  });

  it('accepts base64 and Uint8Array identically', () => {
    const buf = specNumbersBuffer();
    const fromB64 = parseBondingCurve(buf.toString('base64'));
    const fromU8 = parseBondingCurve(new Uint8Array(buf));
    assert.deepEqual(fromB64, fromU8);
    assert.deepEqual(fromU8, parseBondingCurve(buf));
  });

  it('price matches PumpPortal marketCapSol', () => {
    const c = parseBondingCurve(specNumbersBuffer())!;
    const price = curvePriceInSol(c);
    assert.ok(Math.abs(price - 3.376377148114968e-8) / 3.376377148114968e-8 < 1e-9);
    const mcap = curveMarketCapSol(c);
    assert.ok(Math.abs(mcap - 33.763771481010004) < 1e-6);
  });
});

describe('parseBondingCurve live snapshot blob', () => {
  it('parses the 125-byte real blob with consistent state', () => {
    const raw = Buffer.from(FIXTURE_B64, 'base64');
    assert.equal(raw.length, 125);
    const c = parseBondingCurve(FIXTURE_B64);
    assert.ok(c);
    assert.equal(c.tokenTotalSupply, 1000000000000000n);
    assert.equal(c.complete, false);
    // 30-SOL virtual floor invariant holds for real pump.fun curves.
    assert.equal(c.virtualSolReserves - c.realSolReserves, 30000000000n);
    const price = curvePriceInSol(c);
    assert.ok(Number.isFinite(price) && price > 0);
    assert.ok(Math.abs(curveMarketCapSol(c) - price * 1e9) / (price * 1e9) < 1e-9);
  });

  it('null on truncated input', () => {
    assert.equal(parseBondingCurve(Buffer.alloc(0)), null);
    assert.equal(parseBondingCurve(Buffer.alloc(48)), null);
    assert.equal(parseBondingCurve('AAAA'), null);
    assert.equal(parseBondingCurve(''), null);
  });

  it('null on wrong discriminator', () => {
    const buf = specNumbersBuffer();
    buf[0] ^= 0xff;
    assert.equal(parseBondingCurve(buf), null);
  });

  it('null on garbage base64', () => {
    assert.equal(parseBondingCurve('!!!not-base64!!!'), null);
  });

  it('zero reserves give price 0, never NaN/Infinity', () => {
    const buf = specNumbersBuffer();
    buf.writeBigUInt64LE(0n, 8);
    buf.writeBigUInt64LE(0n, 16);
    const c = parseBondingCurve(buf)!;
    assert.equal(curvePriceInSol(c), 0);
    assert.equal(curveMarketCapSol(c), 0);
  });
});

describe('deriveBondingCurve', () => {
  it('matches the PDA PumpPortal sent for the fixture mint', () => {
    assert.equal(deriveBondingCurve(FIXTURE_MINT), FIXTURE_CURVE);
  });

  it('throw-free on invalid input', () => {
    assert.equal(deriveBondingCurve(''), '');
    assert.equal(deriveBondingCurve('not-a-key'), '');
    assert.equal(deriveBondingCurve(null as any), '');
  });
});
