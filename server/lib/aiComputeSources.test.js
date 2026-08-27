import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AI_COMPUTE_SOURCE_REGISTRY,
  createAiComputeCollector,
  createComputeSourceAdapter,
} from './aiComputeSources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'fixtures/ai-compute/aws-pricing.html'), 'utf8');
const aws = AI_COMPUTE_SOURCE_REGISTRY.find((row) => row.id === 'aws-ec2-pricing');
const document = { text: html, finalUrl: aws.entryUrl, retrievedAt: '2026-08-23T00:00:00.000Z' };

test('compute registry covers the five required official platforms', () => {
  assert.deepEqual(new Set(AI_COMPUTE_SOURCE_REGISTRY.map((row) => row.platform)), new Set(['AWS', 'Azure', 'Google Cloud', 'CoreWeave', 'Lambda']));
});

test('official compute adapter parses instance, GPU count, region, and billing mode before price', () => {
  const quotes = createComputeSourceAdapter(aws).parseDocument(document);
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].instanceSpec, 'p5.48xlarge');
  assert.equal(quotes[0].gpuCount, 8);
  assert.equal(quotes[0].region, 'us-east-1');
  assert.equal(quotes[0].billingMode, 'on_demand');
  assert.equal(quotes[0].pricePerGpuHour, 12.29);
  assert.equal(quotes[1].billingMode, 'spot');
});

test('compute collector retains exact-key history and reports unavailable dynamic calculators', async () => {
  const azure = AI_COMPUTE_SOURCE_REGISTRY.find((row) => row.id === 'azure-vm-pricing');
  const collector = createAiComputeCollector({
    registry: [aws, azure],
    documentClient: {
      async fetchDocument(definition) {
        if (definition.id === 'azure-vm-pricing') throw new Error('dynamic calculator unavailable');
        return document;
      },
    },
  });
  const result = await collector({ previous: { computeRental: [] }, generatedAt: '2026-08-23T00:00:00.000Z' });
  assert.equal(result.source.status, 'ready');
  assert.equal(result.source.stale, true);
  assert.equal(result.payload.computeRental.length, 2);
  assert.equal(result.payload.computeSourceReports.find((row) => row.sourceId === 'azure-vm-pricing').status, 'error');
});

test('compute collector keeps verified ledger row counts when an official page is reachable but unparseable', async () => {
  const collector = createAiComputeCollector({
    registry: [aws],
    documentClient: { async fetchDocument() { return { ...document, text: '<main>official pricing</main>' }; } },
  });
  const result = await collector({
    previous: { computeRental: [], computeSourceReports: [{ sourceId: aws.id, rows: 3, message: '核验台账保留 3 条精确报价。' }] },
    generatedAt: '2026-08-23T00:00:00.000Z',
  });
  assert.equal(result.payload.computeSourceReports[0].rows, 3);
  assert.match(result.payload.computeSourceReports[0].message, /核验台账/);
});
