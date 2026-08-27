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
  const kimi = OFFICIAL_MODEL_CARD_SOURCES.find((row) => row.vendor === 'Kimi');
  assert.equal(kimi.cardUrl, 'https://www.kimi.com/en/blog/kimi-k3');
  assert.equal(new URL(kimi.fetchUrl).hostname, 'raw.githubusercontent.com');
  const minimax = OFFICIAL_MODEL_CARD_SOURCES.find((row) => row.vendor === 'MiniMax');
  assert.equal(minimax.model, 'MiniMax M3');
  assert.equal(minimax.cardUrl, 'https://github.com/MiniMax-AI/MiniMax-M3');
  assert.equal(minimax.fetchUrl, 'https://raw.githubusercontent.com/MiniMax-AI/MiniMax-M3/main/README.md');
  assert.equal(minimax.officialScores.length, 32);
  assert.deepEqual(
    Object.fromEntries(OFFICIAL_MODEL_CARD_SOURCES.map((row) => [row.vendor, row.model])),
    {
      Anthropic: 'Claude Opus 5', OpenAI: 'GPT-5.6 Sol', Gemini: 'Gemini 3.7 Flash',
      智谱: 'GLM-5.3-Flash', MiniMax: 'MiniMax M3', Qwen: 'Qwen3.8-Flash-Next',
      Mimo: 'MiMo-V2.5-Pro', DeepSeek: 'DeepSeek-V4-Pro-0813', Kimi: 'Kimi K3',
      Meta: 'Muse Spark 1.2', Tencent: 'Hy3', xAI: 'Grok 4.6',
    },
  );
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
    comparisonNote: null, sourceUrl: OFFICIAL_MODEL_CARD_SOURCES.find((row) => row.vendor === 'Anthropic').cardUrl,
    publishedAt: '2026-07-01', retrievedAt: '2026-08-23T00:00:00.000Z', sourceOrder: 0,
  });
  assert.equal(byVendor.get('OpenAI').model, 'GPT-5.6 Sol');
  assert.equal(byVendor.get('Gemini').model, 'Gemini 3.7 Flash');
  assert.equal(byVendor.get('MiniMax').model, 'MiniMax M3');
  assert.equal(byVendor.get('MiniMax').scores.some((row) => (
    row.testName === 'Terminal-Bench' && row.testVersion === '2.1' && row.value === 66
  )), true);
  assert.deepEqual(byVendor.get('MiniMax').specs, {
    totalParameters: '428B', activeParameters: '23B', contextWindowTokens: 1_000_000,
    contextWindowLabel: '1M tokens', sourceUrl: 'https://github.com/MiniMax-AI/MiniMax-M3',
  });
  assert.equal(byVendor.get('智谱').model, 'GLM-5.3-Flash');
  assert.equal(byVendor.get('智谱').scores.some((row) => (
    row.testName === 'Terminal-Bench' && row.testVersion === '2.1' && row.value === 84.3
  )), true);
  assert.equal(byVendor.get('智谱').scores.length, 13);
  assert.equal(byVendor.get('Qwen').model, 'Qwen3.8-Flash-Next');
  assert.equal(byVendor.get('Qwen').scores.some((row) => row.testName === 'SWE-bench'), true);
  assert.equal(byVendor.get('Qwen').scores.length, 27);
  assert.equal(byVendor.get('Qwen').scores.some((row) => /Agentic coding/i.test(row.testName)), false);
  assert.equal(byVendor.get('DeepSeek').model, 'DeepSeek-V4-Pro-0813');
  assert.equal(byVendor.get('DeepSeek').scores.some((row) => (
    row.testName === 'Terminal-Bench' && row.testVersion === '2.1' && row.value === 87.9
  )), true);
  assert.equal(byVendor.get('DeepSeek').scores.length, 11);
  assert.equal(byVendor.get('Kimi').model, 'Kimi K3');
  assert.equal(byVendor.get('Tencent').model, 'Hy3');
  assert.equal(byVendor.get('Tencent').scores.some((row) => row.testName === 'Terminal-Bench' && row.testVersion === '2.1'), true);
  assert.equal(byVendor.get('xAI').model, 'Grok 4.6');
  assert.equal(byVendor.get('Mimo').status, 'ready');
  assert.equal(byVendor.get('Meta').model, 'Muse Spark 1.2');
  assert.equal(byVendor.get('Meta').scores.some((row) => (
    row.testName === 'Terminal-Bench' && row.testVersion === '2.1' && row.value === 82.9
  )), true);
  assert.equal(byVendor.get('Meta').scores.length, 4);
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

test('rejects narrative prose accidentally captured as a benchmark row', async () => {
  const definition = OFFICIAL_MODEL_CARD_SOURCES.find((row) => row.vendor === 'Gemini');
  const registry = createOfficialModelCardRegistry({
    registry: [definition],
    documentClient: {
      async fetchDocument({ entryUrl }) {
        return {
          finalUrl: entryUrl,
          text: `
            <div data-model="Gemini 3.7 Flash"></div>
            <table>
              <tr><th>Benchmark</th><th>Gemini 3.7 Flash</th></tr>
              <tr><td>We can rule out the CCL for this domain with reasonable confidence based on the results from our testing, but the model remains below the alert threshold.</td><td>3.7</td></tr>
              <tr><td>GPQA Diamond</td><td>93.5%</td></tr>
            </table>
          `,
          bytes: new Uint8Array(),
          contentType: 'text/html',
          retrievedAt: '2026-08-23T00:00:00.000Z',
        };
      },
    },
  });

  const [card] = await registry.readAll();
  assert.deepEqual(card.scores.map((score) => score.testName), ['GPQA']);
});

test('reads official model specs and benchmark names from multi-column model-card tables', async () => {
  const definition = {
    ...OFFICIAL_MODEL_CARD_SOURCES.find((row) => row.vendor === 'Qwen'),
    specs: undefined,
    preferConfiguredScores: false,
    officialScores: [],
    model: 'Qwen3.8-Flash-Next',
    modelAliases: ['Qwen3.8-Flash-Next'],
  };
  const registry = createOfficialModelCardRegistry({
    registry: [definition],
    documentClient: {
      async fetchDocument({ entryUrl }) {
        return {
          finalUrl: entryUrl,
          text: `
# Qwen3.8-Flash-Next

| Model | Total Params | Active Params | Context Length |
| --- | --- | --- | --- |
| Qwen3.8-Flash-Next | 125B | 6B | 262,144 tokens, extensible to 1,000,000 tokens |

| Category | Benchmark | Setting | Qwen3.8-Flash-Next | Other Model |
| --- | --- | --- | --- | --- |
| Agent | Terminal-Bench 2.1 | Qwen Code, high | 86.6% | 80.0% |
| Coding | SWE-bench Verified | pass@1 | 79.2% | 70.0% |
| Reasoning | GPQA Diamond | 5-shot | 91.4% | 80.0% |
          `,
          bytes: new Uint8Array(),
          contentType: 'text/markdown',
          retrievedAt: '2026-08-23T00:00:00.000Z',
        };
      },
    },
  });

  const [card] = await registry.readAll();
  assert.deepEqual(card.specs, {
    totalParameters: '125B',
    activeParameters: '6B',
    contextWindowTokens: 1_000_000,
    contextWindowLabel: '262,144 tokens, extensible to 1,000,000 tokens',
    sourceUrl: definition.cardUrl,
  });
  assert.deepEqual(card.scores.map((score) => score.testName), ['Terminal-Bench', 'SWE-bench', 'GPQA']);
  assert.equal(card.scores.find((score) => score.testName === 'GPQA').shots, 5);
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
