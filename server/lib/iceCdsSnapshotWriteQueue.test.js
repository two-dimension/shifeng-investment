import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CHILD_CODE = `
import fs from 'node:fs/promises';
const [moduleUrl, lockFile, traceFile, label, delayMs] = process.argv.slice(1);
const { enqueueIceCdsSnapshotWrite } = await import(moduleUrl);
await enqueueIceCdsSnapshotWrite(async () => {
  await fs.appendFile(traceFile, \`start:\${label}\\n\`);
  await new Promise((resolve) => setTimeout(resolve, Number(delayMs)));
  await fs.appendFile(traceFile, \`end:\${label}\\n\`);
}, { lockFile, timeoutMs: 2_000, retryMs: 10, staleMs: 10_000 });
`;

function runChild(args) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', CHILD_CODE, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited with code ${code} signal ${signal}: ${stderr}`));
    });
  });
}

async function waitForTrace(traceFile, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const trace = await fs.promises.readFile(traceFile, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (trace.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`trace never contained ${expected}`);
}

test('snapshot writes with the same lock file serialize across Node processes', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ice-cds-lock-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const lockFile = path.join(root, 'snapshot.lock');
  const traceFile = path.join(root, 'trace.log');
  const moduleUrl = new URL('./iceCdsSnapshotWriteQueue.js', import.meta.url).href;

  const first = runChild([moduleUrl, lockFile, traceFile, 'first', '150']);
  await waitForTrace(traceFile, 'start:first');
  const second = runChild([moduleUrl, lockFile, traceFile, 'second', '10']);
  await Promise.all([first, second]);

  const trace = (await fs.promises.readFile(traceFile, 'utf8')).trim().split('\n');
  assert.deepEqual(trace, ['start:first', 'end:first', 'start:second', 'end:second']);
});
