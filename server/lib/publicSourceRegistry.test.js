import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PUBLIC_SOURCE_REGISTRY,
  validatePublicSourceRegistry,
} from './publicSourceRegistry.js';

const validDefinition = {
  id: 'openai-pricing',
  slice: 'pricing',
  entity: 'OpenAI',
  entryUrl: 'https://platform.openai.com/pricing',
  allowedHosts: ['platform.openai.com'],
  format: 'html',
  freshMs: 86_400_000,
  sourceKind: 'official',
};

test('accepts complete HTTPS source definitions and returns an immutable registry', () => {
  const registry = validatePublicSourceRegistry([validDefinition]);

  assert.equal(registry.length, 1);
  assert.equal(registry[0].id, 'openai-pricing');
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(registry[0]), true);
  assert.equal(Object.isFrozen(registry[0].allowedHosts), true);
});

test('rejects duplicate IDs, unsupported slices, and invalid freshness windows', () => {
  assert.throws(
    () => validatePublicSourceRegistry([validDefinition, validDefinition]),
    /duplicate source id: openai-pricing/,
  );
  assert.throws(
    () => validatePublicSourceRegistry([{ ...validDefinition, slice: 'feishu' }]),
    /unsupported source slice: feishu/,
  );
  assert.throws(
    () => validatePublicSourceRegistry([{ ...validDefinition, freshMs: 0 }]),
    /freshMs must be a positive number/,
  );
});

test('rejects non-HTTPS URLs and entry hosts outside their allowlist', () => {
  assert.throws(
    () => validatePublicSourceRegistry([{ ...validDefinition, entryUrl: 'http://platform.openai.com/pricing' }]),
    /entryUrl must use HTTPS/,
  );
  assert.throws(
    () => validatePublicSourceRegistry([{ ...validDefinition, allowedHosts: ['openai.com'] }]),
    /entry host is not allowlisted/,
  );
});

test('ships only validated public sources and isolates Artificial Analysis as named third party', () => {
  assert.equal(PUBLIC_SOURCE_REGISTRY.length > 0, true);
  const aa = PUBLIC_SOURCE_REGISTRY.find((source) => source.id === 'artificial-analysis-index');
  assert.equal(aa?.slice, 'artificialAnalysis');
  assert.equal(aa?.sourceKind, 'named-third-party');
  assert.equal(PUBLIC_SOURCE_REGISTRY.some((source) => source.slice === 'feishu'), false);
});
