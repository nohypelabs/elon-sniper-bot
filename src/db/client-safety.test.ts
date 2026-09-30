import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Stage 9b-A: DB safety (separate file; no edits to repo.test.ts).

describe('db: single-process file lock', () => {
  it('acquire writes our pid; second acquire refused; release removes the file', async () => {
    const { acquireDbLock, releaseDbLock, lockPathFor } = await import('./client');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sniper-lock-'));
    try {
      const dataDir = path.join(dir, 'sniper.pglite');
      acquireDbLock(dataDir);
      const lockPath = lockPathFor(dataDir);
      assert.equal(fs.readFileSync(lockPath, 'utf8').trim(), String(process.pid));
      assert.throws(() => acquireDbLock(dataDir), /locked by another process/);
      releaseDbLock(dataDir);
      assert.equal(fs.existsSync(lockPath), false);
      // Re-acquire after release works.
      acquireDbLock(dataDir);
      releaseDbLock(dataDir);
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stale pid lock is taken over', async () => {
    const { acquireDbLock, releaseDbLock, lockPathFor } = await import('./client');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sniper-lock-stale-'));
    try {
      const dataDir = path.join(dir, 'sniper.pglite');
      const lockPath = lockPathFor(dataDir);
      // 2^31-1 is virtually never a live pid.
      fs.writeFileSync(lockPath, '2147483647');
      acquireDbLock(dataDir);
      assert.equal(fs.readFileSync(lockPath, 'utf8').trim(), String(process.pid));
      releaseDbLock(dataDir);
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('in-memory createDb() never creates a lock file', async () => {
    const { createDb } = await import('./client');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sniper-lock-mem-'));
    try {
      const cwd = process.cwd();
      process.chdir(tmp);
      try {
        const handle = await createDb();
        await (handle.$client as unknown as { close(): Promise<void> }).close();
      } finally {
        process.chdir(cwd);
      }
      assert.deepEqual(fs.readdirSync(tmp), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('db: closeDb lifecycle', () => {
  let client: typeof import('./client');

  before(async () => {
    client = await import('./client');
  });

  after(async () => {
    await client.closeDb().catch(() => {});
  });

  it('ensureDb after closeDb throws; initDb after closeDb works', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sniper-lifecycle-'));
    try {
      const dataDir = path.join(dir, 'sniper.pglite');
      await client.closeDb().catch(() => {});
      await client.initDb(dataDir);
      await client.logEvent('START', 'open');
      await client.closeDb();
      await assert.rejects(() => client.ensureDb(), /call initDb\(\) explicitly/);
      // logEvent swallows the closed-DB error (never throws).
      await assert.doesNotReject(client.logEvent('ERROR', 'after close'));
      // Explicit re-open works and the lock is re-created.
      await client.initDb(dataDir);
      await client.logEvent('START', 'reopened');
      const { lockPathFor } = client;
      assert.equal(fs.readFileSync(lockPathFor(dataDir), 'utf8').trim(), String(process.pid));
      await client.closeDb();
      assert.equal(fs.existsSync(lockPathFor(dataDir)), false);
    } finally {
      await client.closeDb().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('second file-backed initDb while locked is refused', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sniper-locked-'));
    try {
      const dataDir = path.join(dir, 'sniper.pglite');
      await client.closeDb().catch(() => {});
      await client.initDb(dataDir);
      // A second process-equivalent acquire on the same dir must refuse
      // (same pid counts as alive).
      assert.throws(() => client.acquireDbLock(dataDir), /locked by another process/);
      await client.closeDb();
    } finally {
      await client.closeDb().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
