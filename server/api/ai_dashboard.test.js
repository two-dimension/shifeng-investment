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
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use('/api/ai-dashboard', createAiDashboardRouter({
    service,
    accessCode: 'correct horse',
    sessionSecret: 'session-secret-with-enough-entropy',
    now: () => new Date('2026-08-20T00:00:00.000Z'),
    ...options,
  }));
  return { app, service };
}

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
