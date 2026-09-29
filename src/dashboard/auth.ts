import { timingSafeEqual } from 'node:crypto';

/** Sent with 401 responses so browsers/clients know to prompt for credentials. */
export const unauthorizedResponseHeaders: Record<string, string> = {
  'WWW-Authenticate': 'Basic realm="Elon Sniper"',
};

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * True if the Authorization header carries valid Basic credentials
 * (or auth is disabled because the expected password is empty).
 *
 * Never throws and never logs credentials. The password is split on the
 * FIRST colon only, so passwords may themselves contain ':'.
 */
export function isAuthorized(
  header: string | undefined,
  user: string,
  password: string,
): boolean {
  if (!password) return true;
  if (!header || header.length < 7) return false;
  // "Basic " scheme, case-insensitive per RFC 7617.
  if (header.slice(0, 6).toLowerCase() !== 'basic ') return false;
  const encoded = header.slice(6).trim();
  if (!encoded || encoded.length % 4 === 1 || !BASE64_RE.test(encoded)) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return false;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  // Evaluate both compares, then combine (no short-circuit of one on the other).
  const userOk = safeEqual(decoded.slice(0, i), user);
  const passOk = safeEqual(decoded.slice(i + 1), password);
  return userOk && passOk;
}
