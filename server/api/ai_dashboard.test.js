import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createAiDashboardRouter } from './ai_dashboard.js';

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function testApp(options = {}) {
  const service = options.service || {
    async getSnapshot() { return { schemaVersion: 1, generatedAt: '2026-08-20T00:00:00.000Z' }; },
    async refresh() { return { schemaVersion: 1, refreshed: true }; },
  };
  const cdsPipeline = options.cdsPipeline || {
    async preview() { return { batchId: 'preview-batch', rows: [], errors: [], blocking: false }; },
    async import() { return { batchId: 'import-batch', snapshot: {}, workbookPath: '/tmp/ice-cds-history.xlsx' }; },
    async status() { return { available: false, localWriteAllowed: true, workbookAvailable: false }; },
    async exportWorkbook() { return Buffer.from('xlsx'); },
  };
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/ai-dashboard', createAiDashboardRouter({
    service,
    cdsPipeline,
    accessCode: 'correct horse',
    sessionSecret: 'session-secret-with-enough-entropy',
    now: () => new Date('2026-08-20T00:00:00.000Z'),
    ...options,
  }));
  return { app, service, cdsPipeline };
}

test('local ICE CDS preview, import, status, and Excel export use the pipeline', async (t) => {
  const calls = [];
  const cdsPipeline = {
    async preview(input) { calls.push(['preview', input]); return { batchId: 'preview-batch', rows: [{ company: 'Oracle' }], blocking: false }; },
    async import(input) { calls.push(['import', input]); return { batchId: 'committed-batch', snapshot: { schemaVersion: 2 } }; },
    async status() { return { available: true, localWriteAllowed: true, workbookAvailable: true, batchId: 'committed-batch' }; },
    async exportWorkbook() { return Buffer.from('fake-xlsx'); },
  };
  const { app } = testApp({ cdsPipeline });
  const server = await listen(app);
  t.after(server.close);
  const input = {
    iceText: 'Clearing Date\tName\tInstrument Name\tEOD Price',
    discountCurve: { curveId: 'curve', nodes: [{ years: 1, zeroRate: 0.04 }] },
  };

  const preview = await fetch(`${server.baseUrl}/api/ai-dashboard/cds/import/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).data.batchId, 'preview-batch');

  const imported = await fetch(`${server.baseUrl}/api/ai-dashboard/cds/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).data.batchId, 'committed-batch');
  assert.deepEqual(calls, [['preview', input], ['import', input]]);

  const status = await fetch(`${server.baseUrl}/api/ai-dashboard/cds/import-status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).data.localWriteAllowed, true);

  const exported = await fetch(`${server.baseUrl}/api/ai-dashboard/cds/export.xlsx`);
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(exported.headers.get('content-disposition'), 'attachment; filename="ice-cds-history.xlsx"');
  assert.equal(await exported.text(), 'fake-xlsx');
});

test('ICE CDS import APIs reject remote writers while status masks write access and export remains readable', async (t) => {
  let writeCalls = 0;
  const cdsPipeline = {
    async preview() { writeCalls += 1; return {}; },
    async import() { writeCalls += 1; return {}; },
    async status() { return { available: true, localWriteAllowed: true, workbookAvailable: true }; },
    async exportWorkbook() { return Buffer.from('xlsx'); },
  };
  const { app } = testApp({ cdsPipeline });
  const server = await listen(app);
  t.after(server.close);
  const remoteHeaders = { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.20' };
  const body = JSON.stringify({ iceText: 'x', discountCurve: { nodes: [] } });

  assert.equal((await fetch(`${server.baseUrl}/api/ai-dashboard/cds/import/preview`, { method: 'POST', headers: remoteHeaders, body })).status, 403);
  assert.equal((await fetch(`${server.baseUrl}/api/ai-dashboard/cds/import`, { method: 'POST', headers: remoteHeaders, body })).status, 403);
  const status = await fetch(`${server.baseUrl}/api/ai-dashboard/cds/import-status`, { headers: { 'X-Forwarded-For': '198.51.100.20' } });
  assert.equal((await status.json()).data.localWriteAllowed, false);
  assert.equal((await fetch(`${server.baseUrl}/api/ai-dashboard/cds/export.xlsx`, { headers: { 'X-Forwarded-For': '198.51.100.20' } })).status, 200);
  assert.equal(writeCalls, 0);
});

test('ICE CDS import validation rejects oversized text, excessive curve nodes, and unknown fields', async (t) => {
  let calls = 0;
  const cdsPipeline = {
    async preview() { calls += 1; return {}; },
    async import() { calls += 1; return {}; },
    async status() { return {}; },
    async exportWorkbook() { return Buffer.from('xlsx'); },
  };
  const { app } = testApp({ cdsPipeline });
  const server = await listen(app);
  t.after(server.close);
  const post = (body) => fetch(`${server.baseUrl}/api/ai-dashboard/cds/import/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  assert.equal((await post({ iceText: 'x', discountCurve: { nodes: [] }, derivedRows: [{ spreadBp: 1 }] })).status, 400);
  assert.equal((await post({ iceText: 'x', discountCurve: { nodes: Array.from({ length: 10_001 }, () => ({ years: 1, zeroRate: 0.04 })) } })).status, 400);
  assert.equal((await post({ iceText: 'x'.repeat(1024 * 1024 + 1), discountCurve: { nodes: [] } })).status, 413);
  assert.equal(calls, 0);
});

test('dashboard data and refresh are available without a separate AI session', async (t) => {
  let refreshCount = 0;
  const service = {
    async getSnapshot() { return { schemaVersion: 1, generatedAt: '2026-08-20T00:00:00.000Z' }; },
    async refresh() { refreshCount += 1; return { schemaVersion: 1, refreshed: true }; },
  };
  const { app } = testApp({ service });
  const server = await listen(app);
  t.after(server.close);

  const data = await fetch(`${server.baseUrl}/api/ai-dashboard`);
  assert.equal(data.status, 200);
  assert.equal((await data.json()).data.schemaVersion, 1);

  const refresh = await fetch(`${server.baseUrl}/api/ai-dashboard/refresh`, { method: 'POST' });
  assert.equal(refresh.status, 200);
  assert.equal(refreshCount, 1);
});

test('refresh forwards validated scoped sources and force to the dashboard service', async (t) => {
  const calls = [];
  const service = {
    async getSnapshot() { return { schemaVersion: 1 }; },
    async refresh(options) { calls.push(options); return { schemaVersion: 1, refreshed: true }; },
  };
  const { app } = testApp({ service });
  const server = await listen(app);
  t.after(server.close);

  const scoped = await fetch(`${server.baseUrl}/api/ai-dashboard/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources: ['growth', 'pricing'], force: false }),
  });
  assert.equal(scoped.status, 200);
  assert.deepEqual(calls[0], { sources: ['growth', 'pricing'], force: false });

  const full = await fetch(`${server.baseUrl}/api/ai-dashboard/refresh`, { method: 'POST' });
  assert.equal(full.status, 200);
  assert.equal(calls[1], undefined);
});

test('refresh rejects unknown or malformed source scopes without calling the service', async (t) => {
  let refreshCount = 0;
  const service = {
    async getSnapshot() { return { schemaVersion: 1 }; },
    async refresh() { refreshCount += 1; return { schemaVersion: 1 }; },
  };
  const { app } = testApp({ service });
  const server = await listen(app);
  t.after(server.close);

  for (const body of [
    { sources: ['unknown'] },
    { sources: ['feishu'] },
    { sources: [] },
    { sources: 'benchmarks' },
    { sources: ['benchmarks'], force: 'yes' },
  ]) {
    const response = await fetch(`${server.baseUrl}/api/ai-dashboard/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'AI_DASHBOARD_INVALID_REFRESH_SOURCE');
  }
  assert.equal(refreshCount, 0);
});

test('optional password mode rejects unauthenticated and tampered sessions', async (t) => {
  const { app } = testApp({ publicAccess: false });
  const server = await listen(app);
  t.after(server.close);

  const unauthenticated = await fetch(`${server.baseUrl}/api/ai-dashboard`);
  assert.equal(unauthenticated.status, 401);

  const tampered = await fetch(`${server.baseUrl}/api/ai-dashboard`, {
    headers: { Cookie: 'ai_dashboard_session=payload.invalid-signature' },
  });
  assert.equal(tampered.status, 401);
});

test('optional password mode creates a secure 12-hour session', async (t) => {
  let refreshCount = 0;
  const service = {
    async getSnapshot() { return { schemaVersion: 1, generatedAt: '2026-08-20T00:00:00.000Z' }; },
    async refresh() { refreshCount += 1; return { schemaVersion: 1, refreshed: true }; },
  };
  const { app } = testApp({ service, publicAccess: false });
  const server = await listen(app);
  t.after(server.close);

  const login = await fetch(`${server.baseUrl}/api/ai-dashboard/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessCode: 'correct horse' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0];
  assert.match(cookie, /ai_dashboard_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Max-Age=43200/i);

  const session = await fetch(`${server.baseUrl}/api/ai-dashboard/session`, { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  const sessionBody = await session.json();
  assert.equal(sessionBody.authenticated, true);
  assert.equal(sessionBody.expiresAt, '2026-08-20T12:00:00.000Z');

  const data = await fetch(`${server.baseUrl}/api/ai-dashboard`, { headers: { Cookie: cookie } });
  assert.equal(data.status, 200);
  const dataBody = await data.json();
  assert.equal(dataBody.data.schemaVersion, 1);
  assert.equal(dataBody.sessionExpiresAt, '2026-08-20T12:00:00.000Z');
  assert.equal(data.headers.get('cache-control'), 'no-store');

  const refresh = await fetch(`${server.baseUrl}/api/ai-dashboard/refresh`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(refresh.status, 200);
  assert.equal(refreshCount, 1);

  const logout = await fetch(`${server.baseUrl}/api/ai-dashboard/session`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.getSetCookie()[0], /Max-Age=0/i);
});

test('failed access codes are rate limited per client', async (t) => {
  const { app } = testApp({ publicAccess: false, maxAttempts: 2, windowMs: 60_000 });
  const server = await listen(app);
  t.after(server.close);
  const login = () => fetch(`${server.baseUrl}/api/ai-dashboard/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessCode: 'wrong' }),
  });

  assert.equal((await login()).status, 401);
  assert.equal((await login()).status, 401);
  const blocked = await login();
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).error.message, /稍后重试/);
});

test('rate limiting keeps separate buckets for visitor IPs forwarded by the trusted local tunnel', async (t) => {
  const { app } = testApp({ publicAccess: false, maxAttempts: 1, windowMs: 60_000 });
  const server = await listen(app);
  t.after(server.close);
  const login = (visitorIp) => fetch(`${server.baseUrl}/api/ai-dashboard/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': visitorIp },
    body: JSON.stringify({ accessCode: 'wrong' }),
  });

  assert.equal((await login('198.51.100.10')).status, 401);
  assert.equal((await login('198.51.100.10')).status, 429);
  assert.equal((await login('198.51.100.11')).status, 401);
});

test('missing server auth configuration fails closed', async (t) => {
  const { app } = testApp({ publicAccess: false, accessCode: '', sessionSecret: '' });
  const server = await listen(app);
  t.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/ai-dashboard/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessCode: 'anything' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'AI_DASHBOARD_AUTH_NOT_CONFIGURED');
});
