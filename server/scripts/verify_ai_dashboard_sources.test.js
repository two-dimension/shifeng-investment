import assert from 'node:assert/strict';
import test from 'node:test';
import { manifestDrift, verifyLiveSource } from './verify_ai_dashboard_sources.mjs';

const source = {
  id: 'official',
  entryUrl: 'https://official.example/data',
  allowedHosts: ['official.example'],
  sourceKind: 'official',
};

test('manifest drift reports missing, changed, and unknown source definitions', () => {
  const expected = { sources: [source, { ...source, id: 'second' }] };
  const actual = { sources: [{ ...source, entryUrl: 'https://official.example/changed' }, { ...source, id: 'unknown' }] };
  assert.deepEqual(manifestDrift(actual, expected).map((error) => error.code).sort(), [
    'MANIFEST_REGISTERED_SOURCE_DRIFT',
    'MANIFEST_REGISTERED_SOURCE_MISSING',
    'MANIFEST_UNKNOWN_SOURCE',
  ]);
});

test('live verification follows only allowlisted HTTPS redirects', async () => {
  const calls = [];
  const ready = await verifyLiveSource(source, {
    fetchImpl: async (url) => {
      calls.push(url.toString());
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: '/final' } });
      return new Response('ok', { status: 200 });
    },
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.finalUrl, 'https://official.example/final');

  const blocked = await verifyLiveSource(source, {
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
  });
  assert.equal(blocked.status, 'error');
  assert.match(blocked.message, /allowlist/);
});
