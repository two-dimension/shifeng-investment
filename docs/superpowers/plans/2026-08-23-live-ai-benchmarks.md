# Live AI Benchmarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the AI dashboard's Feishu-first Benchmark slice with a refreshable OpenRouter-backed dataset that always shows one latest text model per vendor and safely falls back to last-good or Feishu data.

**Architecture:** Add a focused benchmark normalizer that joins the OpenRouter text-model catalog to the unified Benchmark API and emits source-qualified metric keys. Extend the existing dashboard service with a separately tracked Benchmark source, 15-minute freshness, in-flight refresh deduplication, and atomic last-good fallback. Keep the existing page structure, but trigger a scoped refresh when the Benchmark tab opens and render richer source/coverage metadata.

**Tech Stack:** Node.js 24, Express, React 19, TypeScript, Ant Design, Node test runner, ESLint, Vite

**Spec:** `docs/superpowers/specs/2026-08-23-live-ai-benchmarks-design.md`

## Global Constraints

- The matrix contains exactly one latest released text model per tracked vendor.
- Fable/Mythos may appear in the matrix but never qualify as a metric winner.
- A vendor's older evaluated model must never replace its latest unevaluated model.
- Source, benchmark type, arena/category, and material run configuration are part of metric identity; unlike configurations never merge.
- Missing values render as unavailable, never zero.
- `OPENROUTER_API_KEY` stays server-side and no inference endpoint is called.
- Entering the Benchmark tab refreshes only when the last successful online sync is at least 15 minutes old; explicit page refresh forces the online check.
- Online failure preserves last-good data, with Feishu used only when no online last-good slice exists.
- Snapshot writes remain atomic.

---

### Task 1: Normalize OpenRouter benchmark data

**Files:**
- Create: `server/lib/aiBenchmarkData.js`
- Create: `server/lib/aiBenchmarkData.test.js`

**Interfaces:**
- Consumes: OpenRouter model-catalog objects and unified `/api/v1/benchmarks` response objects.
- Produces: `normalizeOnlineBenchmarks({ catalog, benchmarkPayload, feishuModels })` returning `{ models, metrics, winners, asOf, sourceMode, coverage, attributions }`.
- Produces: `selectLatestCatalogModels(catalog, benchmarkRows, feishuModels)` for direct unit testing.

- [ ] **Step 1: Write the failing latest-model selection tests**

Test a catalog containing two OpenAI models, a `:free` variant, one latest Anthropic model without scores, and one Feishu-only Fable model. Assert one row per vendor, the newer OpenAI model wins, `:free` does not create another row, Anthropic remains with empty scores, and Fable remains tagged `feishu`.

```js
test('selects one latest canonical text model per evaluated or Feishu-tracked vendor', () => {
  const selected = selectLatestCatalogModels(catalog, benchmarkRows, feishuModels);
  assert.deepEqual(selected.map(({ vendor, modelSlug }) => [vendor, modelSlug]), [
    ['Anthropic', 'anthropic/claude-new'],
    ['Fable', 'feishu/fable-5'],
    ['OpenAI', 'openai/gpt-new'],
  ]);
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `node --test server/lib/aiBenchmarkData.test.js`

Expected: FAIL because `server/lib/aiBenchmarkData.js` does not exist.

- [ ] **Step 3: Implement canonical vendor/model selection**

Implement stable helpers with these signatures:

```js
const VENDOR_LABELS = new Map([
  ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['google', 'Google'],
  ['deepseek', 'DeepSeek'], ['qwen', 'Alibaba'], ['z-ai', 'Zhipu'],
  ['moonshotai', 'Moonshot'], ['minimax', 'MiniMax'], ['fable', 'Fable'],
]);

export function canonicalModelSlug(slug) {
  return String(slug || '').trim().replace(/:(?:free|extended|thinking|nitro|floor|exacto)$/i, '');
}

export function vendorLabel(slug) {
  const namespace = canonicalModelSlug(slug).split('/')[0].toLowerCase();
  return VENDOR_LABELS.get(namespace) || namespace;
}

export function selectLatestCatalogModels(catalog, benchmarkRows, feishuModels = []) {
  const tracked = new Set([
    ...benchmarkRows.map((row) => vendorLabel(row.model_permaslug)),
    ...feishuModels.map((row) => row.vendor),
  ]);
  const latest = new Map();
  for (const row of catalog) {
    const modelSlug = canonicalModelSlug(row.id);
    const vendor = vendorLabel(modelSlug);
    const modalities = row.architecture?.output_modalities || row.output_modalities || [];
    if (!tracked.has(vendor) || (modalities.length > 0 && !modalities.includes('text'))) continue;
    const created = Number(row.created || 0);
    const candidate = { vendor, model: row.name || modelSlug.split('/').at(-1), modelSlug, created, releasedAt: created ? new Date(created * 1000).toISOString().slice(0, 10) : null, sourceMode: 'openrouter', scores: {} };
    const current = latest.get(vendor);
    if (!current || candidate.created > current.created || (candidate.created === current.created && candidate.modelSlug < current.modelSlug)) latest.set(vendor, candidate);
  }
  for (const row of feishuModels) {
    if (!latest.has(row.vendor)) latest.set(row.vendor, { ...row, modelSlug: `feishu/${row.model}`, sourceMode: 'feishu' });
  }
  return [...latest.values()].sort((left, right) => left.vendor.localeCompare(right.vendor));
}
```

Use `created` descending, then canonical slug ascending. Limit the vendor universe to vendors represented by benchmark rows plus Feishu-tracked vendors. Only catalog rows whose output modalities include `text` are eligible.

- [ ] **Step 4: Run the latest-model tests and verify they pass**

Run: `node --test server/lib/aiBenchmarkData.test.js`

Expected: PASS for canonicalization, vendor mapping, latest selection, and unevaluated latest models.

- [ ] **Step 5: Write failing normalization tests for all source shapes**

Use fixtures for:

```js
{ source: 'artificial-analysis', model_permaslug: 'openai/gpt-new', intelligence_index: 71.2, coding_index: 65.8, agentic_index: 58.3 }
{ source: 'design-arena', model_permaslug: 'openai/gpt-new', arena: 'models', category: 'dataviz', elo: 1200, win_rate: 48.1, rank: 4 }
{ source: 'openrouter', model_permaslug: 'openai/gpt-new', benchmark_type: 'gpqa_diamond', accuracy: 0.72, accuracy_stddev: 0.03, total_tasks: 300 }
```

Assert source-qualified stable keys, units, direction, attribution, metadata, and that identical display labels from different sources do not collide.

- [ ] **Step 6: Run normalization tests and verify the expected failures**

Run: `node --test server/lib/aiBenchmarkData.test.js`

Expected: FAIL because source adapters and winner generation are absent.

- [ ] **Step 7: Implement source adapters and winner generation**

Return metric definitions shaped as:

```js
{
  key: 'openrouter:gpqa_diamond:accuracy',
  label: 'GPQA Diamond',
  group: 'OpenRouter Evals',
  unit: 'percent',
  direction: 'higher',
  source: 'openrouter',
  sourceUrl: 'https://openrouter.ai/docs/api/api-reference/benchmarks/list-benchmarks'
}
```

Return model scores keyed by `metric.key`, with `{ value, asOf, sampleSize, standardDeviation, source, sourceUrl }`. Compute winners only for known directions, retain ties, and exclude `/fable|mythos/i` from eligibility.

- [ ] **Step 8: Run Task 1 tests and commit**

Run: `node --test server/lib/aiBenchmarkData.test.js`

Expected: all Task 1 tests PASS.

Commit:

```bash
git add server/lib/aiBenchmarkData.js server/lib/aiBenchmarkData.test.js
git commit -m "feat: normalize live AI benchmark data"
```

### Task 2: Add OpenRouter benchmark client and snapshot integration

**Files:**
- Modify: `server/lib/aiDashboardService.js`
- Modify: `server/lib/aiDashboardService.test.js`
- Modify: `server/lib/aiDashboardData.js`

**Interfaces:**
- Consumes: `normalizeOnlineBenchmarks` from Task 1.
- Produces: `createOpenRouterClient({ apiKey, fetchImpl, timeoutMs })` with `fetchRankings`, `fetchModels`, and `fetchBenchmarks`.
- Produces: `service.refresh({ sources, force })`, accepting the source name `benchmarks`.

- [ ] **Step 1: Write failing client tests**

Assert `fetchModels()` requests `/api/v1/models?output_modalities=text`, `fetchBenchmarks()` requests `/api/v1/benchmarks`, both send the bearer key, reject non-2xx responses, and abort after the injected timeout.

- [ ] **Step 2: Run the client tests and verify method-missing failures**

Run: `node --test server/lib/aiDashboardService.test.js`

Expected: FAIL because `fetchModels` and `fetchBenchmarks` are not defined.

- [ ] **Step 3: Implement the client methods and response validation**

`fetchModels` must require an array at `payload.data`. `fetchBenchmarks` must require an array at `payload.data` and a non-array object at `payload.meta`. Throw source-specific errors such as `OpenRouter Benchmarks API failed with HTTP 401`; never include the API key in the error.

- [ ] **Step 4: Write failing snapshot tests**

Add tests proving:

- a successful benchmark refresh adds `sources.benchmarks.status = 'ready'` and replaces only `snapshot.benchmarks`;
- a refresh newer than 15 minutes returns without another upstream call when `force` is false;
- `force: true` calls upstream;
- overlapping benchmark refreshes share one upstream request;
- failure preserves online last-good data;
- no online last-good data falls back to the Feishu slice;
- an empty or malformed unified response cannot overwrite last-good.

- [ ] **Step 5: Run snapshot tests and verify failures are caused by the absent benchmark source**

Run: `node --test server/lib/aiDashboardService.test.js`

Expected: FAIL on missing `sources.benchmarks`, freshness, and scoped refresh behavior.

- [ ] **Step 6: Implement the benchmark refresh slice**

Extend the empty snapshot with:

```js
sources: {
  benchmarks: {
    status: 'authorization_required',
    stale: true,
    asOf: null,
    url: 'https://openrouter.ai/benchmarks',
    message: '需配置 OPENROUTER_API_KEY'
  }
},
benchmarks: {
  models: [], metrics: [], winners: {}, asOf: null,
  sourceMode: 'none', coverage: { vendors: 0, metrics: 0 }, attributions: []
}
```

Fetch models and benchmarks in parallel, normalize only after both validate, and assign the complete slice immediately before the existing atomic snapshot write. Keep a benchmark-specific in-flight promise and compare `sources.benchmarks.asOf` against a 15-minute TTL unless `force` is true.

- [ ] **Step 7: Decouple Feishu fallback from primary online data**

Continue parsing the Feishu Benchmark sheet, but store its normalized slice as fallback input during refresh. A successful Feishu refresh must not overwrite an existing online `sourceMode: 'openrouter'` benchmark slice.

- [ ] **Step 8: Run Task 2 tests and commit**

Run: `node --test server/lib/aiDashboardService.test.js server/lib/aiDashboardData.test.js server/lib/aiBenchmarkData.test.js`

Expected: all Task 1–2 tests PASS.

Commit:

```bash
git add server/lib/aiDashboardService.js server/lib/aiDashboardService.test.js server/lib/aiDashboardData.js
git commit -m "feat: refresh online benchmark snapshots"
```

### Task 3: Validate scoped refresh requests at the API boundary

**Files:**
- Modify: `server/api/ai_dashboard.js`
- Modify: `server/api/ai_dashboard.test.js`

**Interfaces:**
- Consumes: `service.refresh({ sources, force })` from Task 2.
- Produces: `POST /api/ai-dashboard/refresh` accepting `{ sources?: ('feishu'|'openRouter'|'benchmarks')[], force?: boolean }`.

- [ ] **Step 1: Write failing API tests**

Assert that `{ sources: ['benchmarks'], force: false }` is forwarded exactly, omitted options preserve full refresh, and `{ sources: ['unknown'] }` returns HTTP 400 with `AI_DASHBOARD_INVALID_REFRESH_SOURCE` without calling the service.

- [ ] **Step 2: Run the API tests and verify forwarding/validation failures**

Run: `node --test server/api/ai_dashboard.test.js`

Expected: FAIL because the router currently discards the request body.

- [ ] **Step 3: Implement strict request parsing**

Use a module-level source set:

```js
const REFRESH_SOURCES = new Set(['feishu', 'openRouter', 'benchmarks']);
```

Require `sources` to be a non-empty array when provided and `force` to be boolean when provided. Return a structured 400 response for invalid input.

- [ ] **Step 4: Run Task 3 tests and commit**

Run: `node --test server/api/ai_dashboard.test.js`

Expected: all API tests PASS.

Commit:

```bash
git add server/api/ai_dashboard.js server/api/ai_dashboard.test.js
git commit -m "feat: support scoped AI dashboard refresh"
```

### Task 4: Trigger and render live benchmarks in React

**Files:**
- Modify: `src/pages/AIDashboard/types.ts`
- Modify: `src/pages/AIDashboard/viewModel.ts`
- Modify: `tests/aiDashboardViewModel.test.ts`
- Modify: `src/pages/AIDashboard/AIDashboardPanel.tsx`
- Modify: `src/pages/AIDashboard/AIDashboardSections.tsx`
- Modify: `src/pages/AIDashboard/AIDashboardPanel.css`

**Interfaces:**
- Consumes: the extended snapshot and scoped refresh API from Tasks 2–3.
- Produces: controlled primary tabs whose `benchmark` activation invokes a deduplicated scoped refresh.
- Produces: a source-grouped latest-model Benchmark matrix.

- [ ] **Step 1: Write failing view-model tests**

Add pure helpers and tests for:

```ts
benchmarkRefreshRequest('benchmark')
// => { sources: ['benchmarks'], force: false }

benchmarkRefreshRequest('pricing')
// => null

formatBenchmarkValue({ value: 0.72 }, { unit: 'percent' })
// => '72.0%'
```

Also test integer ELO, rank, decimal index, and unavailable values.

- [ ] **Step 2: Run view-model tests and verify helper-missing failures**

Run: `node --test tests/aiDashboardViewModel.test.ts`

Expected: FAIL because the helpers do not exist.

- [ ] **Step 3: Extend TypeScript snapshot types and implement helpers**

Define `BenchmarkMetricDefinition`, extend `BenchmarkScore` with source metadata, extend `BenchmarkModel` with `modelSlug`, `sourceMode`, and nullable `releasedAt`, and add `sources.benchmarks`.

- [ ] **Step 4: Write the controlled-tab refresh behavior**

Track `activeTab` and a separate `benchmarkRefreshing` flag. On an actual transition into `benchmark`, send:

```ts
requestDashboard('/refresh', {
  method: 'POST',
  body: JSON.stringify({ sources: ['benchmarks'], force: false }),
});
```

Replace the page snapshot with the returned atomic snapshot. Do not clear the current matrix while refreshing. The global refresh sends `{ force: true }`.

- [ ] **Step 5: Render source status, coverage, grouped columns, and score metadata**

Add a Benchmark source badge in the page header. In `BenchmarkSection`, render coverage and `asOf`, group metrics by `group`, use the pure formatter, and show a tooltip containing source, data date, sample size, and source link. Render “尚未评测” for empty latest-model rows.

- [ ] **Step 6: Run focused frontend checks**

Run: `node --test tests/aiDashboardViewModel.test.ts`

Run: `npm run lint`

Run: `npm run build`

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/pages/AIDashboard tests/aiDashboardViewModel.test.ts
git commit -m "feat: refresh latest benchmarks on tab entry"
```

### Task 5: Schedule, document, and verify the complete feature

**Files:**
- Modify: `server/lib/aiDashboardService.js`
- Modify: `server/lib/aiDashboardService.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: benchmark refresh behavior from Task 2.
- Produces: daily scheduled `service.refresh({ sources: ['benchmarks'] })` and operator documentation.

- [ ] **Step 1: Write a failing scheduler test with injected timer functions**

Change the intended scheduler signature to `startAiDashboardAutoRefresh(service, { setTimeoutImpl, setIntervalImpl, clearTimeoutImpl, clearIntervalImpl } = {})`. In the test, inject recording timer functions and verify the scheduler registers a daily Benchmark refresh independently from Feishu hourly and OpenRouter rankings daily refreshes, and cleanup clears every recorded timer.

- [ ] **Step 2: Run the scheduler test and verify it fails**

Run: `node --test server/lib/aiDashboardService.test.js`

Expected: FAIL because no Benchmark timer exists.

- [ ] **Step 3: Add the daily refresh and documentation**

Document that `OPENROUTER_API_KEY` powers both rankings and Benchmark Data APIs, that these are data reads rather than inference calls, and that missing credentials keep Feishu/last-good data visible.

- [ ] **Step 4: Run complete automated verification**

Run: `node --test server/*.test.js server/api/*.test.js server/lib/*.test.js tests/*.test.ts`

Expected: zero failed tests.

Run: `npm run lint`

Expected: exit 0 with no lint errors.

Run: `npm run build`

Expected: exit 0 and a production bundle in `dist/`.

Run: `git diff --check`

Expected: exit 0 with no whitespace errors.

- [ ] **Step 5: Perform browser acceptance**

Start the current backend and frontend, open `/ai-dashboard`, enter the Benchmark tab, and verify:

- no password gate appears;
- a scoped refresh occurs only for Benchmark;
- exactly one model row appears per vendor;
- source status, freshness, coverage, grouped metrics, winners, ties, and unavailable values are readable;
- switching tabs repeatedly does not clear the matrix or duplicate upstream work;
- desktop/mobile widths and light/dark themes remain usable.

- [ ] **Step 6: Commit final integration**

```bash
git add server/lib/aiDashboardService.js server/lib/aiDashboardService.test.js README.md
git commit -m "docs: operate live AI benchmark refresh"
```
