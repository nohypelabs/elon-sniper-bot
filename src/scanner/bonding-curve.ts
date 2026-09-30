/**
 * Pump.fun bonding-curve account parsing (Stage 10).
 *
 * Pure module — no I/O, no CONFIG, no logging. Lets the bot price any
 * pump.fun token from Solana account state (accountSubscribe on the
 * bonding-curve PDA) instead of relying on PumpPortal trade subscriptions,
 * which need a funded API key.
 */

import { PublicKey } from '@solana/web3.js';

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
/** Anchor discriminator for the pump.fun BondingCurve account. */
export const BONDING_CURVE_DISCRIMINATOR_HEX = '17b7f83760d8ac60';
/** Minimum bytes needed: 8 (disc) + 5*u64 (40) + 1 (complete) = 49. */
export const BONDING_CURVE_MIN_LEN = 49;

export interface ParsedBondingCurve {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

function toBuffer(data: Buffer | Uint8Array | string): Buffer | null {
  try {
    if (typeof data === 'string') {
      if (data.length === 0) return null;
      return Buffer.from(data, 'base64');
    }
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a pump.fun bonding-curve account blob.
 * Returns null when shorter than 49 bytes or when the discriminator differs.
 * Bytes after byte 49 (the account is 125 bytes on-chain) are ignored.
 */
export function parseBondingCurve(
  data: Buffer | Uint8Array | string,
): ParsedBondingCurve | null {
  const buf = toBuffer(data);
  if (!buf || buf.length < BONDING_CURVE_MIN_LEN) return null;
  const disc = buf.subarray(0, 8).toString('hex');
  if (disc !== BONDING_CURVE_DISCRIMINATOR_HEX) return null;
  try {
    return {
      virtualTokenReserves: buf.readBigUInt64LE(8),
      virtualSolReserves: buf.readBigUInt64LE(16),
      realTokenReserves: buf.readBigUInt64LE(24),
      realSolReserves: buf.readBigUInt64LE(32),
      tokenTotalSupply: buf.readBigUInt64LE(40),
      complete: buf[48] !== 0,
    };
  } catch {
    return null;
  }
}

/** SOL per token = (vSol/1e9) / (vTok/1e6). 0 when reserves are 0, never NaN/Infinity. */
export function curvePriceInSol(curve: ParsedBondingCurve): number {
  try {
    const vTok = Number(curve.virtualTokenReserves);
    const vSol = Number(curve.virtualSolReserves);
    if (!Number.isFinite(vTok) || !Number.isFinite(vSol)) return 0;
    if (vTok <= 0 || vSol <= 0) return 0;
    const price = vSol / 1e9 / (vTok / 1e6);
    return Number.isFinite(price) && price > 0 ? price : 0;
  } catch {
    return 0;
  }
}

/** marketCapSol = priceInSol * (tokenTotalSupply/1e6). */
export function curveMarketCapSol(curve: ParsedBondingCurve): number {
  try {
    const price = curvePriceInSol(curve);
    if (price <= 0) return 0;
    const supply = Number(curve.tokenTotalSupply);
    if (!Number.isFinite(supply) || supply <= 0) return 0;
    const mcap = price * (supply / 1e6);
    return Number.isFinite(mcap) && mcap >= 0 ? mcap : 0;
  } catch {
    return 0;
  }
}

/**
 * Derive the bonding-curve PDA for a mint:
 * findProgramAddressSync([b'bonding-curve', mint], PUMP_PROGRAM).
 * Throw-free: returns '' on invalid input.
 */
export function deriveBondingCurve(mint: string): string {
  try {
    if (!mint || typeof mint !== 'string') return '';
    const mintPk = new PublicKey(mint.trim());
    const program = new PublicKey(PUMP_PROGRAM_ID);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mintPk.toBuffer()],
      program,
    );
    return pda.toBase58();
  } catch {
    return '';
  }
}
