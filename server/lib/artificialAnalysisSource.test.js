import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createArtificialAnalysisCollector, parseArtificialAnalysisDocument } from './artificialAnalysisSource.js';

const fixtureUrl = new URL('./fixtures/artificial-analysis/index.html', import.meta.url);

test('parses only public Dataset JSON-LD from the registered AA page', async () => {
  const html = await fs.promises.readFile(fixtureUrl, 'utf8');
  const result = parseArtificialAnalysisDocument({
    text: html, finalUrl: 'https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index',
    retrievedAt: '2026-08-23T00:00:00.000Z',
  });
  assert.equal(result.intelligenceIndex[0].model, 'Model A');
  assert.equal(result.taskCosts[0].totalCost, 0.26);
  assert.equal(result.intelligenceIndex[0].sourceKind, 'named-third-party');
});

test('collector publishes AA only in the artificialAnalysis slice', async () => {
  const html = await fs.promises.readFile(fixtureUrl, 'utf8');
  const collector = createArtificialAnalysisCollector({
    documentClient: { async fetchDocument() { return { text: html, finalUrl: 'https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index', retrievedAt: '2026-08-23T00:00:00.000Z', contentType: 'text/html' }; } },
  });
  const result = await collector({ generatedAt: '2026-08-23T00:00:00.000Z' });
  assert.deepEqual(Object.keys(result.payload), ['artificialAnalysis']);
  assert.equal(result.source.status, 'ready');
  assert.match(result.source.message, /2 个模型/);
});

test('rejects pages without the three required public datasets', () => {
  assert.throws(() => parseArtificialAnalysisDocument({
    text: '<script type="application/ld+json">{"@type":"Dataset","name":"Other","data":[]}</script>',
    finalUrl: 'https://artificialanalysis.ai/', retrievedAt: '2026-08-23T00:00:00.000Z',
  }), /required public datasets/);
});
