import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAiDashboardService,
  createAiDashboardServiceFromEnv,
  createOpenRouterClient,
  startAiDashboardAutoRefresh,
} from './aiDashboardService.js';

test('refresh writes a normalized snapshot and preserves last-good OpenRouter data when that source fails', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-dashboard-service-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'snapshot.json');
  await fs.promises.writeFile(dataFile, JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-08-19T00:00:00.000Z',
    sources: { openRouter: { status: 'ready', asOf: '2026-08-19T00:00:00.000Z' } },
    arrAndValuation: { companies: [], valuations: [] },
    openRouter: { weekTotalTokens: '123', topModels: [], history: [] },
    modelPricing: { token: [{ vendor: 'OpenAI', model: 'last-good', inputPrice: 1 }], video: [], codingPlans: [] },
    benchmarks: { models: [{ vendor: 'OpenAI', model: 'last-good-benchmark', releasedAt: '2026-08-01', scores: {} }], winners: {} },
    computeRental: [],
    debtFinancing: [],
  }), 'utf8');
  const feishuClient = {
    async readWorkbook() {
      return {
        'ARR&估值': [
          ['title'],
          ['月份', 'Anthropic', null, '估值日期', 'Anthropic'],
          ['2026年7月', 730, null, '2026年7月', 9650],
        ],
        '债务融资': [
          ['公司', '日期', '手段', '规模', '币种'],
          ['CoreWeave', '2026-08-01', '可转债', 2000, 'USD mn'],
        ],
        '模型基准测试': [
          ['测试分类', '评测维度', '核心指标', 'GPT incomplete'],
          ['Coding', 'SWE-bench', '修复率', 99],
        ],
        'API模型token价格&发布日期&优化方向': [
          ['价格表暂时维护中'],
        ],
      };
    },
  };
  const openRouterClient = { async fetchRankings() { throw new Error('upstream unavailable'); } };
  const service = createAiDashboardService({
    dataFile,
    feishuClient,
    openRouterClient,
    now: () => new Date('2026-08-20T00:00:00.000Z'),
  });

  const snapshot = await service.refresh();

  assert.equal(snapshot.sources.feishu.status, 'ready');
  assert.equal(snapshot.sources.openRouter.status, 'error');
  assert.equal(snapshot.sources.openRouter.stale, true);
  assert.equal(snapshot.openRouter.weekTotalTokens, '123');
  assert.equal(snapshot.arrAndValuation.companies[0].latestActual.value, 730);
  assert.equal(snapshot.arrAndValuation.valuations[0].parrLow, 9650 / 730);
  assert.equal(snapshot.debtFinancing[0].method, '可转债');
  assert.equal(snapshot.modelPricing.token[0].model, 'last-good');
  assert.equal(snapshot.benchmarks.models[0].model, 'last-good-benchmark');
  assert.equal(snapshot.sources.feishu.stale, true);
  assert.equal(JSON.parse(await fs.promises.readFile(dataFile, 'utf8')).generatedAt, '2026-08-20T00:00:00.000Z');
});

test('missing credentials return an empty authorization-required snapshot instead of fabricated values', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-dashboard-empty-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const service = createAiDashboardService({
    dataFile: path.join(dir, 'snapshot.json'),
    now: () => new Date('2026-08-20T00:00:00.000Z'),
  });

  const snapshot = await service.getSnapshot();

  assert.equal(snapshot.sources.feishu.status, 'authorization_required');
  assert.equal(snapshot.sources.openRouter.status, 'authorization_required');
  assert.deepEqual(snapshot.arrAndValuation.companies, []);
  assert.deepEqual(snapshot.openRouter.topModels, []);
});

test('local Feishu export seeds a real snapshot when API credentials are unavailable', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-dashboard-local-export-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const feishuExportFile = path.join(dir, 'feishu-export.json');
  const dataFile = path.join(dir, 'snapshot.json');
  await fs.promises.writeFile(feishuExportFile, JSON.stringify({
    exportedAt: '2026-08-23T00:00:00.000Z',
    workbook: {
      'ARR&估值': [
        [null, 'Yipit'],
        [null, 'Anthropic', 'OpenAI'],
        [46215, 73, 45],
      ],
    },
  }), 'utf8');

  const service = createAiDashboardServiceFromEnv({
    dataFile,
    feishuExportFile,
    now: () => new Date('2026-08-23T00:00:00.000Z'),
  });
  const snapshot = await service.refresh({ sources: ['feishu'] });

  assert.equal(snapshot.sources.feishu.status, 'ready');
  assert.equal(snapshot.arrAndValuation.companies[0].company, 'Anthropic');
  assert.equal(snapshot.arrAndValuation.companies[0].latestActual.value, 730);
});

test('public OpenRouter export seeds the visible weekly Top 10 without fabricating a platform total', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-dashboard-openrouter-public-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const openRouterPublicFile = path.join(dir, 'openrouter-public.json');
  const dataFile = path.join(dir, 'snapshot.json');
  await fs.promises.writeFile(openRouterPublicFile, JSON.stringify({
    asOf: '2026-08-22',
    startDate: '2026-08-16',
    endDate: '2026-08-22',
    topModels: [
      { rank: 1, model: 'DeepSeek V4 Flash 0731', totalTokens: '11600000000000', approximate: true },
    ],
  }), 'utf8');

  const service = createAiDashboardServiceFromEnv({
    dataFile,
    feishuExportFile: path.join(dir, 'missing-feishu.json'),
    openRouterPublicFile,
    now: () => new Date('2026-08-23T00:00:00.000Z'),
  });
  const snapshot = await service.refresh({ sources: ['openRouter'] });

  assert.equal(snapshot.sources.openRouter.status, 'ready');
  assert.equal(snapshot.sources.openRouter.stale, true);
  assert.match(snapshot.sources.openRouter.message, /Data API/);
  assert.equal(snapshot.openRouter.weekTotalTokens, null);
  assert.equal(snapshot.openRouter.topModels[0].model, 'DeepSeek V4 Flash 0731');
  assert.deepEqual(snapshot.openRouter.history, []);
});

test('OpenRouter client sends the configured API key and preserves response metadata', async () => {
  const calls = [];
  const client = createOpenRouterClient({
    apiKey: 'openrouter-key',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json({
        data: [{ date: '2026-08-19', model_permaslug: 'vendor/model', total_tokens: '42' }],
        meta: { as_of: '2026-08-20T01:00:00.000Z', start_date: '2026-05-28', end_date: '2026-08-19' },
      });
    },
  });

  const payload = await client.fetchRankings({ startDate: '2026-05-28', endDate: '2026-08-19' });

  assert.equal(payload.meta.as_of, '2026-08-20T01:00:00.000Z');
  assert.match(calls[0].url, /start_date=2026-05-28/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer openrouter-key');
});

test('OpenRouter client reads the text model catalog and unified benchmarks with the server-side key', async () => {
  const calls = [];
  const client = createOpenRouterClient({
    apiKey: 'server-only-key',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/models')) return Response.json({ data: [{ id: 'openai/gpt-new' }] });
      return Response.json({ data: [{ source: 'artificial-analysis' }], meta: { as_of: '2026-08-23T00:00:00.000Z' } });
    },
  });

  const models = await client.fetchModels();
  const benchmarks = await client.fetchBenchmarks();

  assert.equal(models.data[0].id, 'openai/gpt-new');
  assert.equal(benchmarks.meta.as_of, '2026-08-23T00:00:00.000Z');
  assert.match(calls[0].url, /\/api\/v1\/models\?output_modalities=text/);
  assert.match(calls[1].url, /\/api\/v1\/benchmarks$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer server-only-key');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer server-only-key');
});

test('OpenRouter benchmark client rejects source-specific HTTP and timeout failures', async () => {
  const failedClient = createOpenRouterClient({
    apiKey: 'key',
    fetchImpl: async () => new Response('', { status: 401 }),
  });
  await assert.rejects(failedClient.fetchBenchmarks(), /OpenRouter Benchmarks API failed with HTTP 401/);

  const timeoutClient = createOpenRouterClient({
    apiKey: 'key',
    timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }),
  });
  await assert.rejects(timeoutClient.fetchModels(), /timed out/);
});

function benchmarkClientFixture({ onFetch } = {}) {
  return {
    async fetchModels() {
      onFetch?.('models');
      return {
        data: [
          { id: 'openai/gpt-old', name: 'GPT Old', created: 100, architecture: { output_modalities: ['text'] } },
          { id: 'openai/gpt-new', name: 'GPT New', created: 200, architecture: { output_modalities: ['text'] } },
        ],
      };
    },
    async fetchBenchmarks() {
      onFetch?.('benchmarks');
      return {
        data: [{ source: 'artificial-analysis', model_permaslug: 'openai/gpt-new', intelligence_index: 71.2 }],
        meta: { as_of: '2026-08-23T00:00:00.000Z', version: 'v1' },
      };
    },
  };
}

test('benchmark refresh replaces only the benchmark slice and records independent source status', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-dashboard-benchmark-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const service = createAiDashboardService({
    dataFile: path.join(dir, 'snapshot.json'),
    openRouterClient: benchmarkClientFixture(),
    now: () => new Date('2026-08-23T00:01:00.000Z'),
  });

  const snapshot = await service.refresh({ sources: ['benchmarks'], force: true });

  assert.equal(snapshot.sources.benchmarks.status, 'ready');
  assert.equal(snapshot.sources.benchmarks.stale, false);
  assert.equal(snapshot.benchmarks.sourceMode, 'openrouter');
  assert.equal(snapshot.benchmarks.models[0].model, 'GPT New');
  assert.equal(snapshot.benchmarks.metrics[0].key, 'artificial-analysis:intelligence_index');
  assert.equal(snapshot.openRouter.weekTotalTokens, null);
});

test('benchmark refresh respects 15-minute freshness while force bypasses it', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-dashboard-benchmark-fresh-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const service = createAiDashboardService({
    dataFile: path.join(dir, 'snapshot.json'),
    openRouterClient: benchmarkClientFixture({ onFetch: () => { calls += 1; } }),
    now: () => new Date('2026-08-24T00:05:00.000Z'),
  });

  const first = await service.refresh({ sources: ['benchmarks'], force: true });
  assert.equal(first.sources.benchmarks.syncedAt, '2026-08-24T00:05:00.000Z');
  await service.refresh({ sources: ['benchmarks'] });
  assert.equal(calls, 2);
  await service.refresh({ sources: ['benchmarks'], force: true });
  assert.equal(calls, 4);
});

test('overlapping forced benchmark refreshes share a single upstream request', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-dashboard-benchmark-dedupe-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let benchmarkCalls = 0;
  const client = benchmarkClientFixture();
  const service = createAiDashboardService({
    dataFile: path.join(dir, 'snapshot.json'),
    openRouterClient: {
      ...client,
      async fetchBenchmarks() {
        benchmarkCalls += 1;
        await gate;
        return client.fetchBenchmarks();
      },
    },
    now: () => new Date('2026-08-23T00:05:00.000Z'),
  });

  const first = service.refresh({ sources: ['benchmarks'], force: true });
  const second = service.refresh({ sources: ['benchmarks'], force: true });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

  assert.equal(benchmarkCalls, 1);
  assert.equal(firstSnapshot.generatedAt, secondSnapshot.generatedAt);
});

test('failed or empty online benchmark refresh preserves last-good and marks it stale', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-dashboard-benchmark-last-good-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'snapshot.json');
  await fs.promises.writeFile(dataFile, JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-08-22T00:00:00.000Z',
    sources: { benchmarks: { status: 'ready', stale: false, asOf: '2026-08-22T00:00:00.000Z' } },
    benchmarks: {
      models: [{ vendor: 'OpenAI', model: 'Last Good', modelSlug: 'openai/last-good', scores: {} }],
      metrics: [], winners: {}, asOf: '2026-08-22T00:00:00.000Z', sourceMode: 'openrouter',
      coverage: { vendors: 1, evaluatedVendors: 0, metrics: 0 }, attributions: [],
    },
  }), 'utf8');
  const service = createAiDashboardService({
    dataFile,
    openRouterClient: {
      async fetchModels() { return { data: [] }; },
      async fetchBenchmarks() { return { data: [], meta: { as_of: '2026-08-23T00:00:00.000Z' } }; },
    },
    now: () => new Date('2026-08-23T00:05:00.000Z'),
  });

  const snapshot = await service.refresh({ sources: ['benchmarks'], force: true });

  assert.equal(snapshot.benchmarks.models[0].model, 'Last Good');
  assert.equal(snapshot.sources.benchmarks.status, 'error');
  assert.equal(snapshot.sources.benchmarks.stale, true);
});

test('online benchmark refresh keeps Feishu-only tracked vendors across later refreshes', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-dashboard-benchmark-feishu-fallback-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'snapshot.json');
  const feishuModels = [{
    vendor: 'Moonshot', model: 'Kimi Latest', releasedAt: '2026-08-01',
    scores: { Legacy: { value: 99, direction: 'higher', metric: '分' } },
  }];
  await fs.promises.writeFile(dataFile, JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-08-22T00:00:00.000Z',
    benchmarks: {
      models: feishuModels,
      metrics: [], winners: {}, asOf: '2026-08-22T00:00:00.000Z', sourceMode: 'feishu',
      coverage: { vendors: 1, evaluatedVendors: 1, metrics: 1 }, attributions: [],
      feishuFallbackModels: feishuModels,
    },
  }), 'utf8');
  const service = createAiDashboardService({
    dataFile,
    openRouterClient: benchmarkClientFixture(),
    now: () => new Date('2026-08-23T00:05:00.000Z'),
  });

  const first = await service.refresh({ sources: ['benchmarks'], force: true });
  const second = await service.refresh({ sources: ['benchmarks'], force: true });

  assert.deepEqual(first.benchmarks.models.map((model) => model.vendor), ['Kimi', 'OpenAI']);
  assert.deepEqual(second.benchmarks.models.map((model) => model.vendor), ['Kimi', 'OpenAI']);
});

test('overlapping source refreshes are serialized without dropping the daily OpenRouter run', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-dashboard-refresh-queue-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  let releaseFeishu;
  const feishuGate = new Promise((resolve) => { releaseFeishu = resolve; });
  let openRouterCalls = 0;
  const service = createAiDashboardService({
    dataFile: path.join(dir, 'snapshot.json'),
    now: () => new Date('2026-08-20T00:00:00.000Z'),
    feishuClient: {
      async readWorkbook() {
        await feishuGate;
        return { 'ARR&估值': [['月份', 'Anthropic'], ['2026年7月', 730]] };
      },
    },
    openRouterClient: {
      async fetchRankings() {
        openRouterCalls += 1;
        return {
          data: Array.from({ length: 7 }, (_, index) => ({
            date: `2026-08-${String(13 + index).padStart(2, '0')}`,
            model_permaslug: 'vendor/model',
            total_tokens: '6',
          })),
          meta: { as_of: '2026-08-20T01:00:00.000Z', end_date: '2026-08-19' },
        };
      },
    },
  });

  const feishuRefresh = service.refresh({ sources: ['feishu'] });
  await new Promise((resolve) => setImmediate(resolve));
  const openRouterRefresh = service.refresh({ sources: ['openRouter'] });
  releaseFeishu();
  await feishuRefresh;
  const snapshot = await openRouterRefresh;

  assert.equal(openRouterCalls, 1);
  assert.equal(snapshot.sources.feishu.status, 'ready');
  assert.equal(snapshot.sources.openRouter.status, 'ready');
  assert.equal(snapshot.openRouter.weekTotalTokens, '42');
});

test('sparse OpenRouter responses preserve the last-good week instead of publishing incomplete days as zero', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-dashboard-openrouter-sparse-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'snapshot.json');
  await fs.promises.writeFile(dataFile, JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-08-19T00:00:00.000Z',
    sources: { openRouter: { status: 'ready', stale: false, asOf: '2026-08-19T01:00:00.000Z' } },
    arrAndValuation: { companies: [], valuations: [] },
    openRouter: { weekTotalTokens: '123', topModels: [], history: [] },
    modelPricing: { token: [], video: [], codingPlans: [] },
    benchmarks: { models: [], winners: {} },
    computeRental: [],
    debtFinancing: [],
  }), 'utf8');
  const service = createAiDashboardService({
    dataFile,
    now: () => new Date('2026-08-20T00:00:00.000Z'),
    openRouterClient: {
      async fetchRankings() {
        return {
          data: [{ date: '2026-08-19', model_permaslug: 'vendor/model', total_tokens: '42' }],
          meta: { as_of: '2026-08-20T01:00:00.000Z', end_date: '2026-08-19' },
        };
      },
    },
  });

  const snapshot = await service.refresh({ sources: ['openRouter'] });

  assert.equal(snapshot.sources.openRouter.status, 'error');
  assert.equal(snapshot.sources.openRouter.stale, true);
  assert.equal(snapshot.openRouter.weekTotalTokens, '123');
});

test('malformed OpenRouter rows do not count as complete UTC-day coverage', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-dashboard-openrouter-malformed-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'snapshot.json');
  await fs.promises.writeFile(dataFile, JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-08-19T00:00:00.000Z',
    sources: { openRouter: { status: 'ready', stale: false, asOf: '2026-08-19T01:00:00.000Z' } },
    openRouter: { weekTotalTokens: '123', topModels: [], history: [] },
  }), 'utf8');
  const service = createAiDashboardService({
    dataFile,
    now: () => new Date('2026-08-20T00:00:00.000Z'),
    openRouterClient: {
      async fetchRankings() {
        return {
          data: Array.from({ length: 7 }, (_, index) => ({
            date: `2026-08-${String(13 + index).padStart(2, '0')}`,
            model_permaslug: '',
            total_tokens: 'not-a-number',
          })),
          meta: { as_of: '2026-08-20T01:00:00.000Z', end_date: '2026-08-19' },
        };
      },
    },
  });

  const snapshot = await service.refresh({ sources: ['openRouter'] });

  assert.equal(snapshot.sources.openRouter.status, 'error');
  assert.equal(snapshot.openRouter.weekTotalTokens, '123');
});

test('OpenRouter metadata must end on the requested latest complete UTC day', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-dashboard-openrouter-stale-meta-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'snapshot.json');
  await fs.promises.writeFile(dataFile, JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-08-19T00:00:00.000Z',
    sources: { openRouter: { status: 'ready', stale: false, asOf: '2026-08-19T01:00:00.000Z' } },
    openRouter: { weekTotalTokens: '123', topModels: [], history: [] },
  }), 'utf8');
  const service = createAiDashboardService({
    dataFile,
    now: () => new Date('2026-08-20T00:00:00.000Z'),
    openRouterClient: {
      async fetchRankings() {
        return {
          data: Array.from({ length: 7 }, (_, index) => ({
            date: `2026-08-${String(6 + index).padStart(2, '0')}`,
            model_permaslug: 'vendor/model',
            total_tokens: '6',
          })),
          meta: { as_of: '2026-08-13T01:00:00.000Z', end_date: '2026-08-12' },
        };
      },
    },
  });

  const snapshot = await service.refresh({ sources: ['openRouter'] });

  assert.equal(snapshot.sources.openRouter.status, 'error');
  assert.equal(snapshot.openRouter.weekTotalTokens, '123');
});

test('auto refresh schedules Benchmark independently and clears every timer', async () => {
  const timeouts = [];
  const intervals = [];
  const clearedTimeouts = [];
  const clearedIntervals = [];
  const calls = [];
  const service = {
    async refresh(options) { calls.push(options); return {}; },
  };
  const stop = startAiDashboardAutoRefresh(service, {
    setTimeoutImpl(callback, ms) {
      const id = { type: 'timeout', index: timeouts.length };
      timeouts.push({ callback, ms, id });
      return id;
    },
    setIntervalImpl(callback, ms) {
      const id = { type: 'interval', index: intervals.length };
      intervals.push({ callback, ms, id });
      return id;
    },
    clearTimeoutImpl(id) { clearedTimeouts.push(id); },
    clearIntervalImpl(id) { clearedIntervals.push(id); },
  });

  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].ms, 5_000);
  assert.deepEqual(intervals.map((timer) => timer.ms), [60 * 60 * 1000, 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]);
  await timeouts[0].callback();
  for (const timer of intervals) await timer.callback();
  assert.deepEqual(calls, [
    { sources: ['feishu', 'openRouter', 'benchmarks'] },
    { sources: ['feishu'] },
    { sources: ['openRouter'] },
    { sources: ['benchmarks'] },
  ]);

  stop();
  assert.deepEqual(clearedTimeouts, [timeouts[0].id]);
  assert.deepEqual(clearedIntervals, intervals.map((timer) => timer.id));
});
