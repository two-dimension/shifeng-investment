import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function fetchJsonWithTimeout(url, timeoutMs = 500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { response, body: await response.json() };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithTimeout(url, timeoutMs = 500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { response, body: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(port, child, stderr) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`server exited with code ${child.exitCode} signal ${child.signalCode}: ${stderr.join('')}`);
    }
    try {
      const { response, body } = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200) return body;
    } catch {
      // The server may not have bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become healthy: ${stderr.join('')}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await waitForExit(child, 1_000);
  if (exited) return;
  child.kill('SIGKILL');
  if (!await waitForExit(child, 1_000)) throw new Error('server child did not exit');
}

function startServer(port, extraEnv = {}, entrypoint = 'server/index.js') {
  const tempRoot = mkdtempSync(join(tmpdir(), 'shifeng-server-test-'));
  const researchDataDir = join(tempRoot, 'research');
  const reportsDir = join(tempRoot, 'reports');
  mkdirSync(researchDataDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  const stderr = [];
  const stdout = [];
  const cleanup = () => rmSync(tempRoot, { recursive: true, force: true });
  let child;
  try {
    child = spawn(process.execPath, [entrypoint], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DISABLE_BACKGROUND_JOBS: '1',
        HOST: '127.0.0.1',
        PORT: String(port),
        RESEARCH_DATA_DIR: researchDataDir,
        RESEARCH_REPORTS_DIR: reportsDir,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  return { child, cleanup, stderr, stdout };
}

async function stopServer(server) {
  try {
    await stopChild(server.child);
  } finally {
    server.cleanup();
  }
}

test('server starts with the restored quant strategy module', async () => {
  const port = await reservePort();
  const server = startServer(port);

  try {
    const health = await waitForHealth(port, server.child, server.stderr);
    assert.equal(health.status, 'ok');
  } finally {
    await stopServer(server);
  }
});

test('root index.js starts the backend server', async () => {
  const port = await reservePort();
  const server = startServer(port, {}, 'index.js');

  try {
    const health = await waitForHealth(port, server.child, server.stderr);
    assert.equal(health.status, 'ok');
  } finally {
    await stopServer(server);
  }
});

test('restored quant strategy serves a real overview', async () => {
  const port = await reservePort();
  const server = startServer(port);
  try {
    await waitForHealth(port, server.child, server.stderr);
    const { response, body } = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/api/quant/overview`);
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(typeof body.data, 'object');
  } finally {
    await stopServer(server);
  }
});

test('AI dashboard routes are mounted and publicly readable without a separate password', async () => {
  const port = await reservePort();
  const server = startServer(port);
  try {
    await waitForHealth(port, server.child, server.stderr);
    const { response, body } = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/api/ai-dashboard`);
    assert.equal(response.status, 200);
    assert.equal(body.publicAccess, true);
    assert.equal(body.data.schemaVersion, 2);
  } finally {
    await stopServer(server);
  }
});

test('test startup mode does not schedule production background jobs', async () => {
  const port = await reservePort();
  const server = startServer(port);
  try {
    await waitForHealth(port, server.child, server.stderr);
    assert.doesNotMatch(server.stdout.join(''), /\[(?:news-refresh|price-refresh|research-sync)\] scheduled/);
  } finally {
    await stopServer(server);
  }
});

test('reports static route honors the isolated research reports directory', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'shifeng-startup-'));
  const researchDataDir = join(tempRoot, 'research');
  const reportsDir = join(tempRoot, 'reports');
  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, 'startup-marker.txt'), 'isolated report', 'utf8');
  const port = await reservePort();
  const server = startServer(port, {
    RESEARCH_DATA_DIR: researchDataDir,
    RESEARCH_REPORTS_DIR: reportsDir,
  });

  try {
    await waitForHealth(port, server.child, server.stderr);
    const { response, body } = await fetchTextWithTimeout(
      `http://127.0.0.1:${port}/reports/startup-marker.txt`,
    );
    assert.equal(response.status, 200);
    assert.equal(body, 'isolated report');
  } finally {
    await stopServer(server);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
