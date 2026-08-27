import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const writeTails = new Map();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireFileLock(lockFile, {
  timeoutMs = 120_000,
  retryMs = 25,
  staleMs = 15 * 60_000,
} = {}) {
  await fs.promises.mkdir(path.dirname(lockFile), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await fs.promises.open(lockFile, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.promises.rm(lockFile, { force: true }).catch(() => undefined);
        throw error;
      }
      return async () => {
        await handle.close().catch(() => undefined);
        try {
          const current = JSON.parse(await fs.promises.readFile(lockFile, 'utf8'));
          if (current.token === token) await fs.promises.unlink(lockFile);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stat;
      try {
        stat = await fs.promises.stat(lockFile);
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - stat.mtimeMs > staleMs) {
        const staleFile = `${lockFile}.stale.${process.pid}.${crypto.randomUUID()}`;
        try {
          await fs.promises.rename(lockFile, staleFile);
          await fs.promises.rm(staleFile, { force: true });
        } catch (renameError) {
          if (renameError.code !== 'ENOENT') throw renameError;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for snapshot write lock: ${lockFile}`);
      await delay(retryMs);
    }
  }
}

/** Serializes every read/modify/write of one dashboard snapshot, including across Node processes. */
export function enqueueIceCdsSnapshotWrite(operation, { lockFile = null, ...lockOptions } = {}) {
  if (typeof operation !== 'function') throw new TypeError('snapshot write operation must be a function');
  const queueKey = lockFile || '__process_local__';
  const previous = writeTails.get(queueKey) || Promise.resolve();
  const queued = previous.then(async () => {
    const release = lockFile ? await acquireFileLock(lockFile, lockOptions) : async () => undefined;
    try {
      return await operation();
    } finally {
      await release();
    }
  });
  writeTails.set(queueKey, queued.catch(() => undefined));
  return queued;
}
