import assert from 'node:assert/strict';
import test from 'node:test';
import { createOfficialDocumentClient } from './officialDocumentClient.js';

const source = {
  entryUrl: 'https://docs.vendor.test/model-card',
  allowedHosts: ['docs.vendor.test'],
  format: 'html',
};

test('rejects initial and redirected hosts outside the source allowlist', async () => {
  const initialClient = createOfficialDocumentClient({
    fetchImpl: async () => new Response('should not run'),
  });
  await assert.rejects(initialClient.fetchDocument({
    ...source,
    entryUrl: 'https://example.test/model-card',
  }), /host is not allowlisted/);

  const redirectClient = createOfficialDocumentClient({
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { location: 'https://example.test/value' },
    }),
  });
  await assert.rejects(redirectClient.fetchDocument(source), /redirect host is not allowlisted/);
});

test('rejects private IP literals, embedded credentials, and non-HTTPS URLs before fetching', async () => {
  let calls = 0;
  const client = createOfficialDocumentClient({ fetchImpl: async () => { calls += 1; return new Response('x'); } });

  await assert.rejects(client.fetchDocument({ ...source, entryUrl: 'https://127.0.0.1/value', allowedHosts: ['127.0.0.1'] }), /private or local host/);
  await assert.rejects(client.fetchDocument({ ...source, entryUrl: 'https://user:secret@docs.vendor.test/value' }), /embedded credentials/);
  await assert.rejects(client.fetchDocument({ ...source, entryUrl: 'http://docs.vendor.test/value' }), /must use HTTPS/);
  assert.equal(calls, 0);
});

test('returns verified text documents with final URL, content type, and retrieval time', async () => {
  const client = createOfficialDocumentClient({
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'manual');
      return new Response('<main>Official model card</main>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
    now: () => new Date('2026-08-23T12:00:00.000Z'),
  });

  const document = await client.fetchDocument(source);

  assert.equal(document.finalUrl, source.entryUrl);
  assert.equal(document.text, '<main>Official model card</main>');
  assert.equal(document.contentType, 'text/html');
  assert.equal(document.retrievedAt, '2026-08-23T12:00:00.000Z');
  assert.equal(document.bytes.byteLength, 32);
});

test('follows allowlisted redirects and caps redirect count', async () => {
  const calls = [];
  const client = createOfficialDocumentClient({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length < 3) return new Response(null, { status: 302, headers: { location: `/hop-${calls.length}` } });
      return new Response('{"official":true}', { headers: { 'content-type': 'application/json' } });
    },
    maxRedirects: 2,
  });

  const document = await client.fetchDocument({ ...source, format: 'json' });
  assert.deepEqual(calls, [
    'https://docs.vendor.test/model-card',
    'https://docs.vendor.test/hop-1',
    'https://docs.vendor.test/hop-2',
  ]);
  assert.equal(document.text, '{"official":true}');

  const loopClient = createOfficialDocumentClient({
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: '/again' } }),
    maxRedirects: 2,
  });
  await assert.rejects(loopClient.fetchDocument(source), /too many redirects/);
});

test('rejects unsupported content types and bodies over the byte limit', async () => {
  const unsupported = createOfficialDocumentClient({
    fetchImpl: async () => new Response('binary', { headers: { 'content-type': 'application/zip' } }),
  });
  await assert.rejects(unsupported.fetchDocument(source), /unsupported content type/);

  const oversized = createOfficialDocumentClient({
    fetchImpl: async () => new Response('12345678901', { headers: { 'content-type': 'text/plain' } }),
    maxBytes: 10,
  });
  await assert.rejects(oversized.fetchDocument({ ...source, format: 'markdown' }), /exceeds 10 bytes/);
});

test('aborts source requests after the configured timeout', async () => {
  const client = createOfficialDocumentClient({
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
    timeoutMs: 5,
  });

  await assert.rejects(client.fetchDocument(source), /timed out after 5ms/);
});

test('preserves PDF bytes for the format-specific parser without decoding them as UTF-8 text', async () => {
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  const client = createOfficialDocumentClient({
    fetchImpl: async () => new Response(pdfBytes, { headers: { 'content-type': 'application/pdf' } }),
  });

  const document = await client.fetchDocument({ ...source, format: 'pdf' });
  assert.equal(document.text, null);
  assert.deepEqual([...document.bytes], [...pdfBytes]);
});
