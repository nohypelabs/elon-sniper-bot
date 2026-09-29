/**
 * Origin allow-list check: CSRF / cross-site WebSocket-hijacking guard.
 *
 * Pure functions: no I/O, no logging, never throws.
 *
 * Rule: no Origin header => allowed (non-browser clients like curl or
 * tunnel probes send none; browsers always send Origin on cross-site POST
 * and on WebSocket handshakes). Origin present => allowed only when its
 * host matches the request Host, or when it is explicitly allow-listed.
 */

function stripTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, '');
}

/** Parse a comma-separated env var (e.g. DASHBOARD_ALLOWED_ORIGINS) into origins. */
export function parseAllowedOrigins(env: string | undefined): string[] {
  if (!env) return [];
  return env
    .split(',')
    .map((s) => stripTrailingSlashes(s.trim()))
    .filter((s) => s.length > 0);
}

export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: string[],
): boolean {
  if (!origin) return true;
  // Sandboxed iframes / file:// navigations send "Origin: null"; never trust it.
  if (origin === 'null') return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  // Same-host (includes port: URL.host is "hostname:port"). Case-insensitive.
  if (host && originHost === host.toLowerCase()) return true;
  // Explicit allow-list: exact match after trailing-slash normalisation.
  const normalized = stripTrailingSlashes(origin).toLowerCase();
  return allowed.some((a) => stripTrailingSlashes(a).toLowerCase() === normalized);
}
