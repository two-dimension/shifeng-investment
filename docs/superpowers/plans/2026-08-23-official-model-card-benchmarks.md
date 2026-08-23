# Official Model Card Benchmarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace aggregated Benchmark sources with source-backed scores from the 12 tracked vendors' official model cards, group exact test names by capability, and make Terminal-Bench the primary Agent benchmark surface.

**Architecture:** A server-side official-source registry discovers and fetches each vendor's current flagship text-model card through allowlisted domains. Format-specific document readers feed vendor descriptors into one strict normalization layer that preserves test name, version, split, harness, effort, unit, and source metadata; the dashboard service atomically publishes per-vendor last-good results, and the existing React page renders Terminal-Bench first followed by capability-grouped winners and matrix columns.

**Tech Stack:** Node.js ESM, Express, React 19, TypeScript, Ant Design, `cheerio` for HTML, `pdfjs-dist` for PDF text extraction, Node test runner, ESLint, Vite.

**Spec:** `docs/superpowers/specs/2026-08-23-official-model-card-benchmarks-design.md`

## Global Constraints

- Benchmark vendors are exactly Anthropic, OpenAI, Gemini, 智谱, MiniMax, Qwen, Mimo, DeepSeek, Kimi, Meta, Tencent, and xAI.
- Benchmark scores may come only from a vendor-controlled model card, system card, technical report, release page, official GitHub organization, or official Hugging Face organization.
- Feishu Benchmark, Artificial Analysis, Design Arena, OpenRouter Benchmark API, media summaries, and third-party leaderboards never populate scores or winners.
- Each vendor shows its latest released flagship/general text model even when that model has no disclosed scores; old-model scores never substitute for it.
- Exact test version, split, score name, harness/agent compatibility, effort, shots/pass@k, and tool policy define comparability.
- Terminal-Bench belongs to Agent, sorts first, and never merges 2.0 with 2.1 or incompatible harness/configuration results.
- Missing scores render as unavailable, never zero; incomplete configurations do not enter winner calculations.
- Refresh remains read-only, uses a 15-minute freshness window on tab entry, supports forced manual refresh, and atomically preserves per-vendor last-good data.
- Runtime fetching accepts no user-supplied URL, follows only allowlisted redirects, caps response size, and never invokes model inference or a generic search engine.
- Preserve unrelated dirty work in `server/data/news.json`, `server/lib/newsIntelligence.js`, and `server/lib/newsIntelligence.test.js`.

---

### Task 1: Define the Official Benchmark Metric Model

**Files:**
- Create: `server/lib/officialBenchmarkData.js`
- Create: `server/lib/officialBenchmarkData.test.js`

**Interfaces:**
- Produces: `classifyOfficialBenchmark(testName: string): "Agent" | "Coding" | "Search & Tool Use" | "Reasoning & Knowledge" | "Multimodal" | "其他"`.
- Produces: `officialComparisonKey(score): string | null`; returns `null` when required comparability fields are incomplete.
- Produces: `normalizeOfficialBenchmarks({ vendorCards, asOf }): OfficialBenchmarkSnapshot`.
- `OfficialBenchmarkSnapshot` contains `models`, `metrics`, `winners`, `vendorSources`, `coverage`, `asOf`, `sourceMode: "official-model-cards"`, and `attributions`.
- Consumers: Tasks 3, 4, and 5.

- [ ] **Step 1: Write failing classification and exact-name tests**

```js
test('classifies exact tests by capability and pins Terminal-Bench first', () => {
  assert.equal(classifyOfficialBenchmark('Terminal-Bench 2.1'), 'Agent');
  assert.equal(classifyOfficialBenchmark('SWE-bench Verified'), 'Coding');
  assert.equal(classifyOfficialBenchmark('BrowseComp'), 'Search & Tool Use');
  assert.equal(classifyOfficialBenchmark('GPQA Diamond'), 'Reasoning & Knowledge');
  assert.equal(classifyOfficialBenchmark('MMMU-Pro'), 'Multimodal');
  assert.equal(classifyOfficialBenchmark('Vendor Novel Eval'), '其他');
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test server/lib/officialBenchmarkData.test.js`

Expected: FAIL because `officialBenchmarkData.js` or its exports do not exist.

- [ ] **Step 3: Implement the category classifier and stable ordering**

```js
export const BENCHMARK_CATEGORY_ORDER = Object.freeze([
  'Agent', 'Coding', 'Search & Tool Use',
  'Reasoning & Knowledge', 'Multimodal', '其他',
]);

const CATEGORY_RULES = [
  ['Agent', /terminal[- ]bench|tau.?bench|τ.?bench|gaia|osworld|mcp|toolbench/i],
  ['Coding', /swe[- ]bench|livecodebench|aider.*polyglot|humaneval|mbpp/i],
  ['Search & Tool Use', /browsecomp|webarena|wide.?search|search/i],
  ['Reasoning & Knowledge', /gpqa|mmlu|aime|hle|arc[- ]/i],
  ['Multimodal', /mmmu|mathvista|chartqa|videomme/i],
];
```

Sort metrics by category order, then `Terminal-Bench` family priority, then source-card order and exact display label.

- [ ] **Step 4: Write failing comparability and winner tests**

Use literal records proving:

```js
test('does not compare Terminal-Bench versions or incomplete run configurations', () => {
  const result = normalizeOfficialBenchmarks({ vendorCards: fixtureCards, asOf: '2026-08-23T00:00:00Z' });
  assert.deepEqual(result.winners['agent:terminal-bench:2.1:accuracy:claude-code:xhigh'], {
    models: ['Claude Opus 5'], value: 83.8,
  });
  assert.equal(result.winners['agent:terminal-bench:2.0:accuracy:claude-code:xhigh']?.value, 82.2);
  assert.equal(result.metrics.find((metric) => metric.testName === 'Terminal-Bench' && !metric.comparable)?.winnerKey, null);
});
```

The fixture must also prove higher/lower direction, ties, percent values stored as percentage points, exact labels, and unknown tests retained in `其他`.

- [ ] **Step 5: Run the tests and verify RED for missing normalization**

Run: `node --test server/lib/officialBenchmarkData.test.js`

Expected: classification passes; normalization/winner assertions fail because those functions are not implemented.

- [ ] **Step 6: Implement strict normalization and winner generation**

The normalized metric definition must include:

```js
{
  key, category, testName, testFamily, testVersion, split, scoreName,
  label, unit, direction, agent, harness, effort, shots, passK, tools,
  comparable, comparisonNote, sourceOrder
}
```

Generate a winner only when every record in that comparison has a non-null comparison key and matching configuration. Preserve ties as `{ models: string[], value: number }`. Count `disclosedVendors`, `metrics`, and `comparableMetrics` separately.

- [ ] **Step 7: Run Task 1 tests and commit**

Run: `node --test server/lib/officialBenchmarkData.test.js`

Expected: all Task 1 tests PASS.

```bash
git add server/lib/officialBenchmarkData.js server/lib/officialBenchmarkData.test.js
git commit -m "feat: define official benchmark metric model"
```

---

### Task 2: Add Safe Official-Document Fetching

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `server/lib/officialDocumentClient.js`
- Create: `server/lib/officialDocumentClient.test.js`
- Create: `server/lib/fixtures/official-model-cards/sample.html`
- Create: `server/lib/fixtures/official-model-cards/sample.md`
- Create: `server/lib/fixtures/official-model-cards/sample.json`
- Create: `server/lib/fixtures/official-model-cards/sample.pdf`

**Interfaces:**
- Consumes: a registry-owned `Set<string>` of allowed hostnames.
- Produces: `createOfficialDocumentClient({ fetchImpl, timeoutMs, maxBytes, allowedHosts })`.
- Produces method: `fetchDocument({ url, format }): Promise<{ finalUrl, text, contentType, retrievedAt }>`.
- Consumers: Task 3.

- [ ] **Step 1: Install the two parsing dependencies**

Run: `npm install cheerio pdfjs-dist`

Expected: `package.json` and `package-lock.json` record exact compatible versions; no other dependency changes.

- [ ] **Step 2: Write failing security and format-reader tests**

```js
test('rejects unregistered hosts and redirects leaving the official allowlist', async () => {
  const client = createOfficialDocumentClient({
    allowedHosts: new Set(['www.anthropic.com']),
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://example.com/card' } }),
  });
  await assert.rejects(client.fetchDocument({ url: 'https://www.anthropic.com/system-cards', format: 'html' }), /redirect host/);
  await assert.rejects(client.fetchDocument({ url: 'https://example.com/card', format: 'html' }), /host is not allowlisted/);
});
```

Add real fixture assertions that HTML table text, Markdown, JSON, and PDF text are decoded, oversized bodies fail before parsing, and timeouts abort the request.

- [ ] **Step 3: Run the client tests and verify RED**

Run: `node --test server/lib/officialDocumentClient.test.js`

Expected: FAIL because the client does not exist.

- [ ] **Step 4: Implement allowlisted manual redirects and bounded body reads**

Use `redirect: 'manual'`, resolve at most three redirects, validate every target hostname, require HTTPS except fixture-only `http://127.0.0.1`, and stream bytes while enforcing `maxBytes` instead of trusting `Content-Length`.

- [ ] **Step 5: Implement document decoding**

```js
const FORMAT_READERS = {
  html: (buffer) => load(buffer.toString('utf8')).text(),
  markdown: (buffer) => buffer.toString('utf8'),
  json: (buffer) => JSON.stringify(JSON.parse(buffer.toString('utf8'))),
  pdf: async (buffer) => extractPdfText(new Uint8Array(buffer)),
};
```

The PDF reader must call `getDocument({ data, useWorkerFetch: false, isEvalSupported: false })`, concatenate page text, and destroy the loaded document in `finally`.

- [ ] **Step 6: Run Task 2 tests, lint, and commit**

Run:

```bash
node --test server/lib/officialDocumentClient.test.js
npm run lint
```

Expected: all client tests PASS and ESLint exits 0.

```bash
git add package.json package-lock.json server/lib/officialDocumentClient.js server/lib/officialDocumentClient.test.js server/lib/fixtures/official-model-cards
git commit -m "feat: fetch allowlisted official model cards"
```

---

### Task 3: Build the 12-Vendor Registry and Model-Card Adapters

**Files:**
- Create: `server/lib/officialModelCardRegistry.js`
- Create: `server/lib/officialModelCardRegistry.test.js`
- Create: `server/data/ai-dashboard/official-model-card-registry.json`
- Create: `server/lib/fixtures/official-model-cards/anthropic.html`
- Create: `server/lib/fixtures/official-model-cards/openai.html`
- Create: `server/lib/fixtures/official-model-cards/gemini.html`
- Create: `server/lib/fixtures/official-model-cards/zhipu.html`
- Create: `server/lib/fixtures/official-model-cards/minimax.md`
- Create: `server/lib/fixtures/official-model-cards/qwen.md`
- Create: `server/lib/fixtures/official-model-cards/mimo.md`
- Create: `server/lib/fixtures/official-model-cards/deepseek.md`
- Create: `server/lib/fixtures/official-model-cards/kimi.md`
- Create: `server/lib/fixtures/official-model-cards/meta.html`
- Create: `server/lib/fixtures/official-model-cards/tencent.md`
- Create: `server/lib/fixtures/official-model-cards/xai.html`

**Interfaces:**
- Consumes: `fetchDocument` from Task 2.
- Produces: `TRACKED_OFFICIAL_VENDORS`, `OFFICIAL_MODEL_CARD_SOURCES`, and `createOfficialModelCardRegistry({ documentClient, now })`.
- Produces method: `readAll(): Promise<Array<{ vendor, status, stale, model, releasedAt, sourceUrl, discoveryMode, scores, error? }>>`.
- Consumer: Task 4.

- [ ] **Step 1: Write a failing registry completeness test**

```js
test('registers exactly the 12 tracked vendors on vendor-controlled entry points', () => {
  assert.deepEqual(OFFICIAL_MODEL_CARD_SOURCES.map((row) => row.vendor), [
    'Anthropic', 'OpenAI', 'Gemini', '智谱', 'MiniMax', 'Qwen',
    'Mimo', 'DeepSeek', 'Kimi', 'Meta', 'Tencent', 'xAI',
  ]);
  assert.equal(new Set(OFFICIAL_MODEL_CARD_SOURCES.map((row) => row.vendor)).size, 12);
  assert.ok(OFFICIAL_MODEL_CARD_SOURCES.every((row) => row.allowedHosts.includes(new URL(row.indexUrl).hostname)));
});
```

- [ ] **Step 2: Add the explicit source registry**

Use these official discovery roots and record their ownership in the JSON file:

```json
[
  { "vendor": "Anthropic", "indexUrl": "https://www.anthropic.com/system-cards", "discoveryMode": "html-index" },
  { "vendor": "OpenAI", "indexUrl": "https://deploymentsafety.openai.com/", "discoveryMode": "html-index" },
  { "vendor": "Gemini", "indexUrl": "https://deepmind.google/models/model-cards/", "discoveryMode": "html-index" },
  { "vendor": "智谱", "indexUrl": "https://docs.z.ai/guides/overview/models", "discoveryMode": "official-docs" },
  { "vendor": "MiniMax", "indexUrl": "https://github.com/MiniMax-AI", "discoveryMode": "official-github" },
  { "vendor": "Qwen", "indexUrl": "https://github.com/QwenLM", "discoveryMode": "official-github" },
  { "vendor": "Mimo", "indexUrl": "https://github.com/XiaomiMiMo", "discoveryMode": "official-github" },
  { "vendor": "DeepSeek", "indexUrl": "https://github.com/deepseek-ai", "discoveryMode": "official-github" },
  { "vendor": "Kimi", "indexUrl": "https://github.com/MoonshotAI", "discoveryMode": "official-github" },
  { "vendor": "Meta", "indexUrl": "https://www.llama.com/models/", "discoveryMode": "html-index" },
  { "vendor": "Tencent", "indexUrl": "https://github.com/Tencent-Hunyuan", "discoveryMode": "official-github" },
  { "vendor": "xAI", "indexUrl": "https://x.ai/news", "discoveryMode": "html-index" }
]
```

Include exact host allowlists for `data.x.ai`, `raw.githubusercontent.com`, `api.github.com`, and vendor documentation/CDN hosts only where a registered official page links to them.

- [ ] **Step 3: Run the completeness test and verify GREEN for the registry only**

Run: `node --test server/lib/officialModelCardRegistry.test.js --test-name-pattern="registers exactly"`

Expected: PASS.

- [ ] **Step 4: Write failing fixture contract tests for all 12 adapters**

Each fixture test must assert a hand-checked current model, official release date, exact source URL, and at least one extracted score when the fixture contains a benchmark table. Include these required cases:

```js
assert.deepEqual(byVendor.get('Anthropic').scores[0], {
  testName: 'Terminal-Bench', testVersion: '2.1', scoreName: 'Accuracy',
  value: 83.8, unit: 'percent-point', direction: 'higher',
  agent: 'Claude Code', effort: 'xhigh', configurationComplete: true,
});
assert.equal(byVendor.get('Gemini').model, 'Gemini 3.7 Flash');
assert.equal(byVendor.get('Qwen').scores.some((row) => row.testName === 'SWE-bench Verified'), true);
```

Use compact saved excerpts with the original official URL in fixture metadata; do not store whole copyrighted pages.

- [ ] **Step 5: Run adapter tests and verify RED**

Run: `node --test server/lib/officialModelCardRegistry.test.js`

Expected: completeness passes; adapter extraction tests fail because `readAll` and parsers are missing.

- [ ] **Step 6: Implement discovery, candidate filtering, and table parsing**

For every descriptor, implement:

- index parsing that returns `{ model, releasedAt, modelCardUrl, format }`;
- flagship/general text filtering with explicit descriptor exclusions;
- model-card table parsing into the raw score shape consumed by Task 1;
- deterministic latest selection by first-party date, `flagship: true`, then stable ID;
- `discoveryMode: "manual-registry"` when an official index cannot machine-discover a card.

The GitHub adapters use organization-owned repository metadata and raw README/technical-report links; they must reject forks and owners that differ from the registered organization.

- [ ] **Step 7: Run Task 1–3 tests and commit**

Run:

```bash
node --test server/lib/officialBenchmarkData.test.js server/lib/officialDocumentClient.test.js server/lib/officialModelCardRegistry.test.js
npm run lint
```

Expected: all tests PASS and ESLint exits 0.

```bash
git add server/lib/officialModelCardRegistry.js server/lib/officialModelCardRegistry.test.js server/lib/fixtures/official-model-cards server/data/ai-dashboard/official-model-card-registry.json
git commit -m "feat: add official model card vendor adapters"
```

---

### Task 4: Replace Aggregated Benchmark Refresh with Official Cards

**Files:**
- Modify: `server/lib/aiDashboardService.js`
- Modify: `server/lib/aiDashboardService.test.js`
- Modify: `server/index.js`
- Modify: `server/server-startup.test.js`
- Retire from active imports: `server/lib/aiBenchmarkData.js`

**Interfaces:**
- Consumes: `officialModelCardRegistry.readAll()` and `normalizeOfficialBenchmarks()`.
- Changes: `createAiDashboardService({ ..., officialBenchmarkClient })`.
- Changes: `createAiDashboardServiceFromEnv({ ..., officialBenchmarkClient })` constructs the registry/client without an API key.
- Keeps: `refresh({ sources: ['benchmarks'], force })`, 15-minute freshness, request deduplication, atomic snapshot writes, and daily scheduling.

- [ ] **Step 1: Write failing service tests for official-only refresh**

```js
test('benchmark refresh publishes official model cards without calling OpenRouter benchmark methods', async () => {
  const openRouterClient = { fetchRankings: async () => rankingsFixture };
  const officialBenchmarkClient = { readAll: async () => officialVendorCardsFixture };
  const service = createAiDashboardService({ dataFile, openRouterClient, officialBenchmarkClient, now });
  const snapshot = await service.refresh({ sources: ['benchmarks'], force: true });
  assert.equal(snapshot.benchmarks.sourceMode, 'official-model-cards');
  assert.equal(snapshot.sources.benchmarks.status, 'ready');
  assert.equal(snapshot.benchmarks.attributions.every((row) => row.source === 'official-model-card'), true);
});
```

Add tests proving an old `sourceMode: "openrouter"` or `"feishu"` snapshot is not used as Benchmark fallback, one failed vendor retains only that vendor's official last-good slice and becomes stale, and a first-ever failure produces an explicit unavailable vendor.

- [ ] **Step 2: Run service tests and verify RED**

Run: `node --test server/lib/aiDashboardService.test.js server/server-startup.test.js`

Expected: FAIL because the service still calls OpenRouter models/benchmarks and has no official client.

- [ ] **Step 3: Wire official model-card refresh into the service**

Replace the benchmark promise with:

```js
const benchmarkPromise = shouldRefreshBenchmarks && officialBenchmarkClient
  ? officialBenchmarkClient.readAll()
  : null;
```

Normalize the returned vendor cards, merge per-vendor official last-good data only, write once, and set messages such as `官网模型卡同步：10/12 家成功 · 8 家披露评分`. `sources.benchmarks.stale` is true whenever any vendor is stale or discovery is manual.

- [ ] **Step 4: Remove Benchmark responsibility from the OpenRouter client**

Keep `fetchRankings`; delete active service calls to `fetchModels` and `fetchBenchmarks`. Update README-facing comments and tests so `OPENROUTER_API_KEY` is required only for rankings-daily, not official Benchmark cards.

- [ ] **Step 5: Run service/startup tests and commit**

Run:

```bash
node --test server/lib/aiDashboardService.test.js server/server-startup.test.js server/api/ai_dashboard.test.js
npm run lint
```

Expected: all selected tests PASS and ESLint exits 0.

```bash
git add server/lib/aiDashboardService.js server/lib/aiDashboardService.test.js server/index.js server/server-startup.test.js
git commit -m "feat: refresh benchmarks from official model cards"
```

---

### Task 5: Extend the Frontend Benchmark View Model

**Files:**
- Modify: `src/pages/AIDashboard/types.ts`
- Modify: `src/pages/AIDashboard/viewModel.ts`
- Modify: `tests/aiDashboardViewModel.test.ts`

**Interfaces:**
- Changes `BenchmarkMetricDefinition` to include category, exact test fields, configuration, comparability, and priority.
- Changes `benchmarks.winners` values from `string[]` to `{ models: string[]; value: number }`.
- Adds `vendorSources`, expanded coverage, and `sourceMode: "official-model-cards"`.
- Produces: `groupOfficialBenchmarkMetrics(metrics)` and `officialWinnerRows(benchmarks)` for Task 6.

- [ ] **Step 1: Write failing view-model ordering and formatting tests**

```ts
test('groups exact benchmark names with Terminal-Bench first', () => {
  const groups = groupOfficialBenchmarkMetrics(metricFixture);
  assert.deepEqual(groups.map((group) => group.category), [
    'Agent', 'Coding', 'Reasoning & Knowledge', '其他',
  ]);
  assert.equal(groups[0].metrics[0].label, 'Terminal-Bench 2.1 · Accuracy');
});

test('winner rows retain exact test, score, ties, and run configuration', () => {
  assert.deepEqual(officialWinnerRows(snapshotFixture)[0], {
    category: 'Agent', metricKey: 'terminal-2.1-claude-code-xhigh',
    label: 'Terminal-Bench 2.1 · Accuracy', models: ['Claude Opus 5'],
    formattedValue: '83.8%', runLabel: 'Claude Code · xhigh', terminalBench: true,
  });
});
```

- [ ] **Step 2: Run the view-model test and verify RED**

Run: `node --test tests/aiDashboardViewModel.test.ts`

Expected: FAIL because the grouping and winner-row helpers do not exist.

- [ ] **Step 3: Update types and implement pure grouping helpers**

Keep percentage-point values as `83.8` and render them as `83.8%`; keep fractional percentages such as `0.72` only when `unit === "percent"`. Return groups and rows in deterministic server priority order, with a frontend fallback sort for old snapshots.

- [ ] **Step 4: Run view-model tests and commit**

Run: `node --test tests/aiDashboardViewModel.test.ts`

Expected: all view-model tests PASS.

```bash
git add src/pages/AIDashboard/types.ts src/pages/AIDashboard/viewModel.ts tests/aiDashboardViewModel.test.ts
git commit -m "feat: model capability-grouped benchmark winners"
```

---

### Task 6: Render Terminal-Bench and Capability-Grouped Winners

**Files:**
- Modify: `src/pages/AIDashboard/AIDashboardSections.tsx`
- Modify: `src/pages/AIDashboard/AIDashboardPanel.css`

**Interfaces:**
- Consumes: `groupOfficialBenchmarkMetrics`, `officialWinnerRows`, expanded metric/source types.
- Produces: one Terminal-Bench emphasis card, grouped winner sections, and category-grouped matrix columns.

- [ ] **Step 1: Add a failing rendered-contract test at the view-model boundary**

Extend `tests/aiDashboardViewModel.test.ts` so the exact fixture produces:

```ts
assert.equal(groups[0].metrics[0].testName, 'Terminal-Bench');
assert.equal(groups[0].metrics[0].testVersion, '2.1');
assert.equal(groups[1].metrics[0].testName, 'SWE-bench');
assert.equal(groups[1].metrics[0].testVersion, 'Verified');
assert.equal(rows.some((row) => /Artificial Analysis|Design Arena|OpenRouter Evals|飞书口径/.test(row.label)), false);
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `node --test tests/aiDashboardViewModel.test.ts`

Expected: FAIL until the UI-facing grouping contract exposes the exact fields.

- [ ] **Step 3: Replace the current source-grouped winner list**

Render in this order:

1. `Terminal-Bench 系列` emphasis panel with exact version rows, winner score, agent/harness/effort, and disclosure-empty state;
2. `各分项最强模型` grouped by capability, each row showing exact test label, direction, winner model(s), and winning score;
3. matrix columns grouped by category, then exact test label.

Remove the `排除 Fable / Mythos` tag and all source-group headings. Keep source metadata only in tooltips and the attribution footer.

- [ ] **Step 4: Add responsive and dark-mode styles**

Create `.ai-terminal-bench-card`, `.ai-benchmark-category`, `.ai-benchmark-run-label`, `.ai-vendor-source-state`, and compact mobile rules. Use existing CSS variables `--ai-border` and `--ai-subtle`; do not hard-code a light-only background.

- [ ] **Step 5: Run frontend tests, lint, build, and commit**

Run:

```bash
node --test tests/aiDashboardViewModel.test.ts
npm run lint
npm run build
```

Expected: tests PASS, ESLint exits 0, and Vite production build exits 0.

```bash
git add src/pages/AIDashboard/AIDashboardSections.tsx src/pages/AIDashboard/AIDashboardPanel.css tests/aiDashboardViewModel.test.ts
git commit -m "feat: prioritize Terminal-Bench in AI dashboard"
```

---

### Task 7: Document Sources and Verify Live Official Reads

**Files:**
- Modify: `README.md`
- Modify: `server/data/ai-dashboard/snapshot.json` only if it is already tracked and the live refresh produces a verified official-model-card snapshot without secrets or full source documents.

**Interfaces:**
- Consumes the complete refresh pipeline.
- Produces operational documentation and live acceptance evidence.

- [ ] **Step 1: Update README source and refresh documentation**

Document that OpenRouter is used only for public Token rankings, Benchmark uses official model cards, no Benchmark API key is required, manual-discovery vendors can lag, exact configurations constrain winners, and Terminal-Bench absence means “未披露”. List the 12 official discovery roots from Task 3.

- [ ] **Step 2: Run the server on an isolated port with background jobs disabled**

Run: `PORT=3002 HOST=127.0.0.1 DISABLE_BACKGROUND_JOBS=1 node index.js`

Expected: server starts and `/api/health` responds successfully.

- [ ] **Step 3: Force an official Benchmark refresh and inspect the contract**

Run:

```bash
curl --fail --silent --show-error \
  -X POST http://127.0.0.1:3002/api/ai-dashboard/refresh \
  -H 'Content-Type: application/json' \
  --data '{"sources":["benchmarks"],"force":true}' \
  | jq '{mode:.data.benchmarks.sourceMode,vendors:[.data.benchmarks.models[].vendor],coverage:.data.benchmarks.coverage,terminal:[.data.benchmarks.metrics[]|select(.testFamily=="Terminal-Bench")|{label,category,agent,harness,effort}],badSources:[.data.benchmarks.attributions[]|select(.source!="official-model-card")]}'
```

Expected: mode is `official-model-cards`; vendors are exactly the 12 allowed names; every Terminal-Bench metric is Agent; `badSources` is empty. Vendor-level failures are explicitly stale/unavailable rather than silently replaced by aggregate data.

- [ ] **Step 4: Inspect the rendered page**

Open `/ai-dashboard`, select Benchmark, and verify desktop and mobile widths in light and dark modes. Confirm Terminal-Bench appears before other tests, exact names/versions are readable, missing/configuration/stale states differ, tooltips link to official model cards, and no old source-group names remain.

- [ ] **Step 5: Commit documentation and any verified tracked snapshot**

```bash
git add README.md
git add server/data/ai-dashboard/snapshot.json  # only when tracked and verified above
git commit -m "docs: document official benchmark sources"
```

If the snapshot is ignored or contains partial live data, omit it from the commit and commit README alone.

---

### Task 8: Full Regression Verification

**Files:**
- No production changes expected.

**Interfaces:**
- Validates all preceding tasks as one releasable change.

- [ ] **Step 1: Run the full automated test suite**

Run: `node --test server/*.test.js server/api/*.test.js server/lib/*.test.js tests/*.test.ts`

Expected: 0 failed, 0 cancelled.

- [ ] **Step 2: Run static and production checks**

Run:

```bash
npm run lint
npm run build
git diff --check
```

Expected: all commands exit 0. The existing Vite chunk-size warning is acceptable; new errors or warnings from official model-card code are not.

- [ ] **Step 3: Audit the final diff and source boundary**

Run:

```bash
git diff HEAD~7 -- README.md package.json package-lock.json server/lib/officialBenchmarkData.js server/lib/officialDocumentClient.js server/lib/officialModelCardRegistry.js server/lib/aiDashboardService.js src/pages/AIDashboard/types.ts src/pages/AIDashboard/viewModel.ts src/pages/AIDashboard/AIDashboardSections.tsx src/pages/AIDashboard/AIDashboardPanel.css
rg -n "Artificial Analysis|Design Arena|OpenRouter Evals|飞书历史口径" server/lib/officialBenchmarkData.js server/lib/officialModelCardRegistry.js src/pages/AIDashboard
```

Expected: old source labels do not participate in the new official path; any remaining strings are migration guards or tests asserting their absence. Unrelated news files are not staged.

- [ ] **Step 4: Record final commit and handoff**

Run: `git status --short && git log -8 --oneline`

Expected: only pre-existing unrelated news changes remain; report the exact test count, live vendor coverage, official-source gaps, and final commit IDs.
