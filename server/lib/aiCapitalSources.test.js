import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AI_CAPITAL_SOURCE_REGISTRY,
  createAiCapitalCollector,
  createCapitalSourceAdapter,
} from './aiCapitalSources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readFixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures/ai-capital', name), 'utf8');
const source = (id) => AI_CAPITAL_SOURCE_REGISTRY.find((row) => row.id === id);
const document = (text, finalUrl) => ({ text, finalUrl, retrievedAt: '2026-08-23T00:00:00.000Z' });

test('capital registry explicitly covers every requested global and Chinese AI/CSP entity', () => {
  const entities = new Set(AI_CAPITAL_SOURCE_REGISTRY.map((row) => row.entity));
  for (const entity of ['OpenAI', 'Anthropic', 'Google', 'Microsoft', 'Amazon', 'Meta', 'xAI', 'CoreWeave', 'Alibaba', 'Tencent', 'Baidu', '智谱', 'MiniMax', 'Moonshot', 'DeepSeek', 'Xiaomi']) {
    assert.equal(entities.has(entity), true, `${entity} must be registered`);
  }
  assert.equal(AI_CAPITAL_SOURCE_REGISTRY.every((row) => ['active', 'discovery-maintained'].includes(row.status)), true);
});

test('capital adapter parses official-style equity and fixed-rate debt releases without third-party fallback', () => {
  const openai = source('openai-capital');
  const openaiEvents = createCapitalSourceAdapter(openai).parseDocument(document(readFixture('openai-round.html'), openai.entryUrl));
  assert.equal(openaiEvents[0].entity, 'OpenAI');
  assert.equal(openaiEvents[0].instrumentCategory, 'equity');
  assert.equal(openaiEvents[0].amountOriginal, 110_000_000_000);
  assert.equal(openaiEvents[0].sourceKind, 'official');

  const coreweave = source('coreweave-capital');
  const debtEvents = createCapitalSourceAdapter(coreweave).parseDocument(document(readFixture('coreweave-notes.html'), coreweave.entryUrl));
  assert.equal(debtEvents[0].instrumentCategory, 'debt');
  assert.equal(debtEvents[0].couponPercent, 5.5);
  assert.equal(debtEvents[0].maturityDate, '2031-12-31');
});

test('capital collector preserves previous verified events when one official endpoint fails', async () => {
  const registry = [source('openai-capital'), source('coreweave-capital')];
  const collector = createAiCapitalCollector({
    registry,
    documentClient: {
      async fetchDocument(definition) {
        if (definition.id === 'coreweave-capital') throw new Error('official IR unavailable');
        return document(readFixture('openai-round.html'), definition.entryUrl);
      },
    },
  });
  const result = await collector({ previous: { capitalEvents: [] }, generatedAt: '2026-08-23T00:00:00.000Z' });
  assert.equal(result.source.status, 'ready');
  assert.equal(result.source.stale, true);
  assert.equal(result.payload.capitalEvents.length, 1);
  assert.equal(result.payload.capitalSourceReports.find((row) => row.sourceId === 'coreweave-capital').status, 'error');
});
