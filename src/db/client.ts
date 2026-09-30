import { mkdirSync, openSync, closeSync, writeSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema';

export type Db = PgliteDatabase<typeof schema> & { $client: PGlite };

/** Absolute path of the ./drizzle migrations folder (repo root), independent of cwd (src/db or dist/db). */
function migrationsFolder(): string {
  return path.resolve(__dirname, '..', '..', 'drizzle');
}

/** File-backed path for the singleton, or default `<cwd>/data/sniper.pglite`. */
export function defaultDbPath(): string {
  return process.env.DB_PATH || path.join(process.cwd(), 'data', 'sniper.pglite');
}

/**
 * Build a fresh Drizzle+PGlite handle. With no `dataDir` this is an
 * in-memory instance (`new PGlite()`) suitable for tests. Migrations are
 * applied before returning. Does NOT touch the module singleton.
 */
export async function createDb(dataDir?: string): Promise<Db> {
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  const handle = drizzle(client, { schema });
  await migrate(handle, { migrationsFolder: migrationsFolder() });
  return handle;
}

let singleton: Db | null = null;
let initPromise: Promise<Db> | null = null;
// ── Stage 9b-A: DB lifecycle (separate block).
// `closedExplicitly` makes ensureDb() refuse to silently re-open after
// closeDb() until initDb() is called explicitly again.
// `heldLockPath`/`heldLockDir` track the singleton's file lock so closeDb()
// can release it exactly once.
let closedExplicitly = false;
let heldLockPath: string | null = null;
let heldLockDataDir: string | null = null;

/** Module-level singleton binding (kept for back-compat; prefer getDb()/ensureDb()). */
export let db: Db;

/** Apply migrations and publish the module-level singleton. Idempotent. */
export async function initDb(dataDir?: string): Promise<Db> {
  if (singleton) {
    db = singleton;
    return singleton;
  }
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const dir = dataDir ?? defaultDbPath();
    // PGlite treats the path as a data directory; ensure the parent exists.
    mkdirSync(path.dirname(dir), { recursive: true });
    // ── Stage 9b-A: take the single-process file lock before opening.
    acquireDbLock(dir);
    heldLockDataDir = dir;
    heldLockPath = lockPathFor(dir);
    try {
      singleton = await createDb(dir);
    } catch (err) {
      releaseDbLock(heldLockDataDir);
      heldLockDataDir = null;
      heldLockPath = null;
      throw err;
    }
    db = singleton;
    closedExplicitly = false;
    return singleton;
  })();
  try {
    return await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

/** Resolve the singleton, initialising it on first use (dashboard-safe). */
export async function ensureDb(): Promise<Db> {
  if (singleton) return singleton;
  // ── Stage 9b-A: after closeDb() never silently re-open.
  if (closedExplicitly) {
    throw new Error('DB is closed — call initDb() explicitly to reopen');
  }
  return initDb();
}

/** Synchronous accessor — throws if initDb()/ensureDb() has not run yet. */
export function getDb(): Db {
  if (singleton) return singleton;
  if (db) return db;
  throw new Error('DB not initialised — call initDb() first');
}

export async function closeDb(): Promise<void> {
  const handle: Db | null = singleton ?? (db as Db | undefined) ?? null;
  singleton = null;
  initPromise = null;
  // ── Stage 9b-A: mark explicit close (ensureDb refuses until initDb) and
  // release the file lock. Set the flag even when no singleton was open.
  closedExplicitly = true;
  try {
    await (handle?.$client as PGlite | undefined)?.close();
  } catch {
    // best-effort
  } finally {
    if (heldLockDataDir) {
      releaseDbLock(heldLockDataDir);
      heldLockDataDir = null;
      heldLockPath = null;
    }
  }
}

// ── Stage 9b-A: single-process lock for file-backed databases (separate
// block; createDb()/initDb()/getDb()/closeDb() signatures unchanged).
// Lock file is `<dataDir>.lock` containing the owner's pid.

/** Resolve the lock-file path for a data dir (exported for tests). */
export function lockPathFor(dataDir: string): string {
  return `${dataDir}.lock`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM: process exists but we may not signal it -> treat as alive.
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * Create `<dataDir>.lock` with our pid ('wx' = fail if it exists).
 * A live owner refuses with a clear error; a dead pid is a stale lock that
 * we take over. In-memory callers never reach here (createDb without a dir).
 */
export function acquireDbLock(dataDir: string): void {
  const lockPath = lockPathFor(dataDir);
  try {
    const fd = openSync(lockPath, 'wx', 0o644);
    try {
      const buf = Buffer.from(String(process.pid), 'utf8');
      let off = 0;
      while (off < buf.length) {
        // writeSync with explicit offset keeps this atomic enough for a pid.
        off += writeSync(fd, buf, off);
      }
    } finally {
      closeSync(fd);
    }
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  let owner = '';
  try {
    owner = readFileSync(lockPath, 'utf8').trim();
  } catch {
    // Lock vanished between open and read — retry once.
    return acquireDbLock(dataDir);
  }
  const ownerPid = Number(owner);
  if (owner !== '' && Number.isInteger(ownerPid) && ownerPid > 0 && pidAlive(ownerPid)) {
    throw new Error(
      `DB is locked by another process (pid ${ownerPid}, lock ${lockPath}) — close the other bot instance first`,
    );
  }
  // Stale lock (dead pid or unparsable content): take over.
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // fall through to re-acquire attempt
  }
  try {
    const fd = openSync(lockPath, 'wx', 0o644);
    try {
      const buf = Buffer.from(String(process.pid), 'utf8');
      let off = 0;
      while (off < buf.length) {
        off += writeSync(fd, buf, off);
      }
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `DB is locked by another process (lock ${lockPath}) — close the other bot instance first`,
      );
    }
    throw e;
  }
}

/** Remove our lock file (best-effort); only removes locks we own. */
export function releaseDbLock(dataDir: string): void {
  const lockPath = lockPathFor(dataDir);
  try {
    const owner = readFileSync(lockPath, 'utf8').trim();
    if (owner !== '' && owner !== String(process.pid)) {
      // Do not remove another live process's lock. A stale foreign lock is
      // left for the next acquirer to take over.
      const ownerPid = Number(owner);
      if (!Number.isInteger(ownerPid) || ownerPid <= 0 || pidAlive(ownerPid)) return;
    }
  } catch {
    return; // no lock file — nothing to do
  }
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // best-effort
  }
}

export async function logEvent(
  type: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    const handle = await ensureDb();
    await handle.insert(schema.botEvents).values({ type, message, metadata: metadata ?? null });
  } catch {
    // Non-critical — never crash bot over logging
  }
}
