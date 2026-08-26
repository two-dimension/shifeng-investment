import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  OFFICIAL_MODEL_CARD_SOURCES,
  TRACKED_OFFICIAL_VENDORS,
  createOfficialModelCardRegistry,
} from './officialModelCardRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = path.join(__dirname, 'fixtures/official-model-cards');
const fixtureExtensions = {
  Anthropic: 'html', OpenAI: 'html', Gemini: 'html', 智谱: 'html', MiniMax: 'md', Qwen: 'md',
  Mimo: 'md', DeepSeek: 'md', Kimi: 'md', Meta: 'html', Tencent: 'md', xAI: 'html',
};

function fixtureName(vendor) {
  return ({ 智谱: 'zhipu' }[vendor] || vendor.toLowerCase());
}

function fixtureDocumentClient({ failVendor, finalUrlFor } = {}) {
  return {
    async fetchDocument(definition) {
      if (definition.vendor === failVendor) throw new Error(`${failVendor} fixture unavailable`);
      const extension = fixtureExtensions[definition.vendor];
      const text = await fs.promises.readFile(path.join(fixtureDirectory, `${fixtureName(definition.vendor)}.${extension}`), 'utf8');
      return {
        finalUrl: finalUrlFor?.(definition) || definition.entryUrl,
        text,
        bytes: new TextEncoder().encode(text),
        contentType: extension === 'md' ? 'text/markdown' : 'text/html',
        retrievedAt: '2026-08-23T00:00:00.000Z',
      };
    },
  };
}

test('registers exactly the 12 tracked vendors on vendor-controlled entry points', () => {
  assert.deepEqual(TRACKED_OFFICIAL_VENDORS, [
    'Anthropic', 'OpenAI', 'Gemini', '智谱', 'MiniMax', 'Qwen',
    'Mimo', 'DeepSeek', 'Kimi', 'Meta', 'Tencent', 'xAI',
  ]);
  assert.deepEqual(OFFICIAL_MODEL_CARD_SOURCES.map((row) => row.vendor), TRACKED_OFFICIAL_VENDORS);
  assert.equal(new Set(OFFICIAL_MODEL_CARD_SOURCES.map((row) => row.vendor)).size, 12);
  assert.ok(OFFICIAL_MODEL_CARD_SOURCES.every((row) => row.allowedHosts.includes(new URL(row.indexUrl).hostname)));
});

test('reads compact official excerpts and preserves exact score configurations', async () => {
  const registry = createOfficialModelCardRegistry({
    documentClient: fixtureDocumentClient(),
    now: () => new Date('2026-08-23T00:00:00.000Z'),
  });
  const cards = await registry.readAll();
  const byVendor = new Map(cards.map((card) => [card.vendor, card]));

  assert.equal(cards.length, 12);
  assert.equal(byVendor.get('Anthropic').model, 'Claude Opus 5');
  assert.deepEqual(byVendor.get('Anthropic').scores[0], {
    testName: 'Terminal-Bench', testVersion: '2.1', split: null, scoreName: 'Accuracy',
    value: 83.8, unit: 'percent-point', direction: 'higher', agent: 'Claude Code', harness: null,
    effort: 'xhigh', shots: null, passK: null, tools: null, configurationComplete: true,
    comparisonNote: null, sourceUrl: 'https://anthropic.com/claude-opus-5-system-card',
    publishedAt: '2026-07-01', retrievedAt: '2026-08-23T00:00:00.000Z', sourceOrder: 0,
  });
  assert.equal(byVendor.get('OpenAI').model, 'GPT-5.6 Sol');
  assert.equal(byVendor.get('Gemini').model, 'Gemini 3.7 Flash');
  assert.equal(byVendor.get('MiniMax').model, 'MiniMax M2.7');
  assert.equal(byVendor.get('Qwen').model, 'Qwen3.8-2.4T-A95B');
  assert.equal(byVendor.get('Qwen').scores.some((row) => row.testName === 'SWE-bench'), true);
  assert.equal(byVendor.get('Kimi').model, 'Kimi K3');
  assert.equal(byVendor.get('Tencent').model, 'Hy3');
  assert.equal(byVendor.get('xAI').model, 'Grok 4.6');
  assert.equal(byVendor.get('Mimo').status, 'unavailable');
  assert.equal(byVendor.get('Meta').model, null);
  assert.equal(cards.flatMap((card) => card.scores).some((score) => /Artificial Analysis|Design Arena|OpenRouter/i.test(score.testName)), false);
});

test('keeps an undisclosed configuration unknown instead of marking it explicitly incomplete', async () => {
  const definition = OFFICIAL_MODEL_CARD_SOURCES.find((row) => row.vendor === 'Anthropic');
  const registry = createOfficialModelCardRegistry({
    registry: [definition],
    documentClient: {
      async fetchDocument({ entryUrl }) {
        return {
          finalUrl: entryUrl,
          text: '<div data-model="Claude Opus 5"></div><table><tr><th>Benchmark</th><th>Claude Opus 5</th></tr><tr><td>GPQA Diamond</td><td>91.2%</td></tr></table>',
          bytes: new Uint8Array(),
          contentType: 'text/html',
          retrievedAt: '2026-08-23T00:00:00.000Z',
        };
      },
    },
  });

  const [card] = await registry.readAll();
  assert.equal(card.scores[0].configurationComplete, undefined);
  assert.equal(card.scores[0].comparisonNote, null);
});

test('rejects GitHub and Hugging Face paths outside the registered official owner', () => {
  const qwen = OFFICIAL_MODEL_CARD_SOURCES.find((row) => row.vendor === 'Qwen');
  assert.throws(() => createOfficialModelCardRegistry({
    documentClient: fixtureDocumentClient(),
    registry: [{ ...qwen, cardUrl: 'https://github.com/not-qwen/copied-card' }],
  }), /official owner/);
  assert.throws(() => createOfficialModelCardRegistry({
    documentClient: fixtureDocumentClient(),
    registry: [{ ...qwen, cardUrl: 'https://huggingface.co/not-qwen/copied-card' }],
  }), /official owner/);
});

test('isolates a failed vendor and keeps the remaining official cards readable', async () => {
  const registry = createOfficialModelCardRegistry({
    documentClient: fixtureDocumentClient({ failVendor: 'Gemini' }),
    now: () => new Date('2026-08-23T00:00:00.000Z'),
  });
  const cards = await registry.readAll();
  const gemini = cards.find((card) => card.vendor === 'Gemini');
  assert.equal(cards.length, 12);
  assert.equal(gemini.status, 'error');
  assert.equal(gemini.stale, true);
  assert.match(gemini.error, /fixture unavailable/);
  assert.equal(cards.find((card) => card.vendor === 'OpenAI').status, 'ready');
});
