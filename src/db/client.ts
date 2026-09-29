import { mkdirSync } from 'node:fs';
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
    singleton = await createDb(dir);
    db = singleton;
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
  try {
    await (handle?.$client as PGlite | undefined)?.close();
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
