import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let writeTail = Promise.resolve();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function releaseOwnedLock(lockFile, token, heartbeat) {
  clearInterval(heartbeat);
  try {
    const record = JSON.parse(await fs.promises.readFile(lockFile, 'utf8'));
    if (record.token === token) await fs.promises.rm(lockFile, { force: true });
  } catch (error) {
    if (!['ENOENT', 'SyntaxError'].includes(error?.code) && !(error instanceof SyntaxError)) throw error;
  }
}

async function acquireFileLock(lockFile, { timeoutMs, retryMs, staleMs }) {
  await fs.promises.mkdir(path.dirname(lockFile), { recursive: true });
  const startedAt = Date.now();
  const token = `${process.pid}-${crypto.randomUUID()}`;

  while (true) {
    try {
      const handle = await fs.promises.open(lockFile, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
      } finally {
        await handle.close();
      }
      const heartbeatMs = Math.max(250, Math.floor(staleMs / 3));
      const heartbeat = setInterval(() => {
        const now = new Date();
        fs.promises.utimes(lockFile, now, now).catch(() => undefined);
      }, heartbeatMs);
      heartbeat.unref?.();
      return () => releaseOwnedLock(lockFile, token, heartbeat);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    try {
      const stat = await fs.promises.stat(lockFile);
      if (Date.now() - stat.mtimeMs > staleMs) {
        const staleFile = `${lockFile}.${token}.stale`;
        await fs.promises.rename(lockFile, staleFile);
        await fs.promises.rm(staleFile, { force: true });
        continue;
      }
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`snapshot write lock timed out after ${timeoutMs}ms`);
    }
    await delay(retryMs);
  }
}

/** Serializes read/modify/write operations locally and, when configured, across Node processes. */
export function enqueueIceCdsSnapshotWrite(operation, {
  lockFile,
  timeoutMs = 30_000,
  retryMs = 50,
  staleMs = 5 * 60_000,
} = {}) {
  if (typeof operation !== 'function') throw new TypeError('snapshot write operation must be a function');
  if (lockFile && (!Number.isFinite(timeoutMs) || timeoutMs <= 0
    || !Number.isFinite(retryMs) || retryMs <= 0
    || !Number.isFinite(staleMs) || staleMs <= 0)) {
    throw new TypeError('snapshot lock timing options must be positive numbers');
  }
  const queued = writeTail.then(async () => {
    if (!lockFile) return operation();
    const release = await acquireFileLock(path.resolve(lockFile), { timeoutMs, retryMs, staleMs });
    try {
      return await operation();
    } finally {
      await release();
    }
  });
  writeTail = queued.catch(() => undefined);
  return queued;
}
