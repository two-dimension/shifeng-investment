import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  publishResearchManifest,
} from './publish_cloud_research.mjs';

function jsonResponse(body = { success: true }, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function fixtureManifest(t, fileCount = 2) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'research-publish-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const files = [];
  for (let index = 0; index < fileCount; index += 1) {
    const filename = `report-${index}.pdf`;
    const filePath = path.join(root, filename);
    await fs.promises.writeFile(filePath, `pdf-${index}`);
    files.push({
      kind: 'cninfo',
      date: '2026-08-28',
      filename,
      type: 'pdf',
      size: 5,
      url: `/api/research/files/cninfo/2026-08-28/${filename}`,
      path: filePath,
    });
  }
  return {
    jobId: 'job-123',
    generatedAt: '2026-08-28T12:00:00.000Z',
    files,
    summaries: [{
      kind: 'cninfo',
      date: '2026-08-28',
      generatedAt: '2026-08-28T12:00:00.000Z',
      totalCount: 1,
      files: files.map(({ filename, type, size, url }) => ({ filename, type, size, url })),
      topGood: [{}],
      topBad: [],
    }],
  };
}

test('publishes running, files, summaries, then success without leaking the token', async (t) => {
  const manifest = await fixtureManifest(t);
  const token = 'very-secret-publish-token';
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse();
  };

  await publishResearchManifest({
    manifest,
    baseUrl: 'https://research.example',
    token,
    fetchImpl,
    retryDelay: async () => {},
  });

  assert.match(calls[0].url, /\/internal\/refresh-state$/);
  assert.equal(JSON.parse(calls[0].init.body).status, 'running');
  const fileIndexes = calls
    .map((call, index) => call.url.includes('/internal/files/') ? index : -1)
    .filter((index) => index >= 0);
  const summaryIndex = calls.findIndex((call) => call.url.includes('/internal/summaries/'));
  const successIndex = calls.findIndex((call) => {
    if (!call.url.endsWith('/internal/refresh-state') || typeof call.init.body !== 'string') return false;
    return JSON.parse(call.init.body).status === 'success';
  });
  assert.equal(fileIndexes.length, 2);
  assert.ok(fileIndexes.every((index) => index > 0 && index < summaryIndex));
  assert.ok(summaryIndex < successIndex);
  assert.ok(calls.every((call) => new Headers(call.init.headers).get('Authorization') === `Bearer ${token}`));
  assert.ok(calls.every((call) => !call.url.includes(token)));
  assert.ok(calls.every((call) => typeof call.init.body !== 'string' || !call.init.body.includes(token)));
  for (const index of fileIndexes) {
    assert.equal(calls[index].init.duplex, 'half');
    assert.ok(Number(new Headers(calls[index].init.headers).get('Content-Length')) > 0);
  }
});

test('a failed upload records failed and never records success', async (t) => {
  const manifest = await fixtureManifest(t, 1);
  const states = [];
  const fetchImpl = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/internal/refresh-state')) {
      states.push(JSON.parse(init.body).status);
      return jsonResponse();
    }
    if (url.includes('/internal/files/')) return jsonResponse({ error: 'bad file' }, 400);
    return jsonResponse();
  };

  await assert.rejects(
    publishResearchManifest({
      manifest,
      baseUrl: 'https://research.example',
      token: 'token',
      fetchImpl,
      retryDelay: async () => {},
    }),
    /HTTP 400/,
  );
  assert.deepEqual(states, ['running', 'failed']);
  assert.ok(!states.includes('success'));
});

test('file uploads are capped at three concurrent requests and retry transient failures', async (t) => {
  const manifest = await fixtureManifest(t, 5);
  let activeFiles = 0;
  let maxActiveFiles = 0;
  let firstFileAttempts = 0;
  const fetchImpl = async (input) => {
    const url = String(input);
    if (!url.includes('/internal/files/')) return jsonResponse();
    activeFiles += 1;
    maxActiveFiles = Math.max(maxActiveFiles, activeFiles);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeFiles -= 1;
    if (url.endsWith('/report-0.pdf')) {
      firstFileAttempts += 1;
      if (firstFileAttempts < 3) return jsonResponse({ error: 'retry' }, 503);
    }
    return jsonResponse();
  };

  await publishResearchManifest({
    manifest,
    baseUrl: 'https://research.example',
    token: 'token',
    fetchImpl,
    retryDelay: async () => {},
  });

  assert.equal(maxActiveFiles, 3);
  assert.equal(firstFileAttempts, 3);
});
