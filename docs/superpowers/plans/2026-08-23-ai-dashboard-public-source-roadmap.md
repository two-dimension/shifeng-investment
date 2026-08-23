# AI Dashboard Public-Source Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Feishu-backed AI dashboard with independently refreshable, source-backed growth, traffic, pricing, capital, official-model-card benchmark, Artificial Analysis, task-cost, and compute-rental slices.

**Architecture:** A schema-v2 snapshot stores each research slice and its own provenance/freshness status. Server-side allowlisted source adapters fetch and normalize official HTML/JSON/Markdown/PDF materials, validate complete slices, and atomically preserve last-good data; React sections consume normalized records and emphasize month/week changes, methodology tooltips, source links, and stale states.

**Tech Stack:** Node.js ESM, Express 5, React 19, TypeScript 6, Ant Design 6, ECharts 6, Node test runner, ESLint, Vite, `cheerio`, `pdfjs-dist`.

**Spec:** `docs/superpowers/specs/2026-08-23-ai-dashboard-public-source-redesign.md`

## Global Constraints

- Feishu must not participate in production snapshot generation, refresh routing, source status, page copy, or last-good fallback.
- Every visible number carries source label, original URL, source kind, data date, retrieval date, methodology, commentary, and stale state where applicable.
- Search results and media summaries may discover sources but never become final numeric evidence.
- Official and Yipit-estimated ARR values remain separate records and are never averaged or silently reconciled.
- OpenRouter remains a Token-traffic source only; it never supplies Benchmark scores.
- Official-model-card Benchmark scores come only from vendor-controlled first-party materials.
- Artificial Analysis appears only in a visibly separate named-third-party panel and never affects official Benchmark winners.
- Unknown, unavailable, or undisclosed values remain null and render as unavailable, never zero.
- Refreshes accept no caller-supplied URLs, follow only allowlisted redirects, cap response size, time out, and atomically preserve last-good slices.
- Preserve unrelated dirty work in `server/data/news.json`, `server/lib/newsIntelligence.js`, and `server/lib/newsIntelligence.test.js`.
- Each production-code change follows RED, GREEN, REFACTOR and ends with the focused test command shown below.

---

### Task 1: Freeze Schema v2 and Shared Provenance Contracts

**Files:**
- Modify: `src/pages/AIDashboard/types.ts`
- Modify: `src/pages/AIDashboard/viewModel.ts`
- Modify: `tests/aiDashboardViewModel.test.ts`
- Modify: `server/lib/aiDashboardService.js`
- Modify: `server/lib/aiDashboardService.test.js`

**Interfaces:**
- Produces TypeScript type `MetricProvenance` with `sourceLabel`, `sourceUrl`, `sourceKind`, `asOf`, `retrievedAt`, `methodology`, `commentary`, and `stale`.
- Produces source keys `growth | openRouter | pricing | capital | benchmarks | artificialAnalysis | compute`.
- Produces schema-v2 empty snapshot with `sources` matching those keys and no `feishu` property.
- Produces `methodologyTooltip(provenance: MetricProvenance): string[]` for consistent UI copy.

- [ ] **Step 1: Write failing frontend contract tests**

Add assertions:

```ts
test('methodology tooltip keeps source, method, date, and commentary in order', () => {
  assert.deepEqual(dashboardViewModel.methodologyTooltip?.({
    sourceLabel: 'Yipit', sourceUrl: 'https://example.test/yipit', sourceKind: 'estimate',
    asOf: '2026-08-01', retrievedAt: '2026-08-23T00:00:00Z',
    methodology: 'ARR estimate', commentary: 'Monthly observation', stale: false,
  }), ['数据口径：ARR estimate', '数据来源：Yipit', '数据日期：2026-08-01', '点评：Monthly observation']);
});
```

- [ ] **Step 2: Write failing backend schema test**

```js
test('empty dashboard snapshot uses public-source schema v2 without Feishu', () => {
  const snapshot = createEmptyAiDashboardSnapshot('2026-08-23T00:00:00Z');
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal('feishu' in snapshot.sources, false);
  assert.deepEqual(Object.keys(snapshot.sources).sort(), [
    'artificialAnalysis', 'benchmarks', 'capital', 'compute', 'growth', 'openRouter', 'pricing',
  ]);
});
```

- [ ] **Step 3: Run both tests and verify RED**

Run: `node --test tests/aiDashboardViewModel.test.ts server/lib/aiDashboardService.test.js`

Expected: FAIL because the provenance helper and schema-v2 source keys do not exist.

- [ ] **Step 4: Add the shared types, helper, and schema-v2 empty snapshot**

Use this exact source-kind union:

```ts
export type SourceKind = 'official' | 'filing' | 'estimate' | 'named-third-party';
```

Keep current slice payloads temporarily empty/compatible so the app remains buildable while later tasks migrate each slice.

- [ ] **Step 5: Run focused tests and build**

Run: `node --test tests/aiDashboardViewModel.test.ts server/lib/aiDashboardService.test.js`

Expected: PASS.

Run: `npm run build`

Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/pages/AIDashboard/types.ts src/pages/AIDashboard/viewModel.ts tests/aiDashboardViewModel.test.ts server/lib/aiDashboardService.js server/lib/aiDashboardService.test.js
git commit -m "refactor: define AI dashboard public-source schema"
```

---

### Task 2: Build the Allowlisted Public-Source Client and Registry

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `server/lib/publicSourceRegistry.js`
- Create: `server/lib/publicSourceRegistry.test.js`
- Create: `server/lib/officialDocumentClient.js`
- Create: `server/lib/officialDocumentClient.test.js`
- Create: `server/lib/fixtures/official-sources/sample.html`
- Create: `server/lib/fixtures/official-sources/sample.md`
- Create: `server/lib/fixtures/official-sources/sample.json`
- Create: `server/lib/fixtures/official-sources/sample.pdf`

**Interfaces:**
- Produces `PUBLIC_SOURCE_REGISTRY`, keyed by canonical source ID and containing `slice`, `entity`, `entryUrl`, `allowedHosts`, `format`, `freshMs`, and `sourceKind`.
- Produces `createOfficialDocumentClient({ fetchImpl, timeoutMs, maxBytes, now })`.
- Produces `fetchDocument(sourceDefinition): Promise<{ finalUrl, text, contentType, retrievedAt }>`.
- Consumers: Tasks 4 through 9 and the existing official-model-card plan.

- [ ] **Step 1: Install parsers**

Run: `npm install cheerio pdfjs-dist`

Expected: only `package.json` and `package-lock.json` dependency sections change.

- [ ] **Step 2: Write failing registry validation tests**

Test that every definition uses HTTPS, has a positive `freshMs`, has at least one allowed host, the entry URL host is allowlisted, and only the seven schema-v2 slice names are accepted. Add duplicate-ID and duplicate-canonical-entity rejection tests.

- [ ] **Step 3: Write failing client security tests**

```js
test('rejects an initial or redirected host outside the source allowlist', async () => {
  const client = createOfficialDocumentClient({
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://example.com/value' } }),
  });
  await assert.rejects(client.fetchDocument({
    entryUrl: 'https://openai.com/api/pricing/', allowedHosts: ['openai.com'], format: 'html',
  }), /redirect host/);
});
```

Also test timeout, maximum bytes, unsupported content type, redirect loop, HTML text, Markdown, JSON, and PDF extraction.

- [ ] **Step 4: Run tests and verify RED**

Run: `node --test server/lib/publicSourceRegistry.test.js server/lib/officialDocumentClient.test.js`

Expected: FAIL because both modules are missing.

- [ ] **Step 5: Implement validation and safe fetching**

Use manual redirects so every hop is checked. Reject private-IP literal hosts, embedded credentials, non-HTTPS protocols, and bodies exceeding 8 MiB. Default timeout is 15 seconds and the maximum redirect count is 3.

- [ ] **Step 6: Seed verified top-level official entries**

Register the official entry pages confirmed during implementation for OpenAI, Anthropic, Gemini, 智谱, MiniMax, Kimi, DeepSeek, Mimo, Qwen, Kling, Seedance, AWS, Azure, Google Cloud, CoreWeave, Lambda, and Artificial Analysis. A source is not registered until its entry URL is reachable through its official site and its final host passes the allowlist test.

- [ ] **Step 7: Run tests and commit**

Run: `node --test server/lib/publicSourceRegistry.test.js server/lib/officialDocumentClient.test.js`

Expected: PASS.

```bash
git add package.json package-lock.json server/lib/publicSourceRegistry.js server/lib/publicSourceRegistry.test.js server/lib/officialDocumentClient.js server/lib/officialDocumentClient.test.js server/lib/fixtures/official-sources
git commit -m "feat: add safe public source registry"
```

---

### Task 3: Remove Feishu From Runtime and Add Slice-Scoped Refresh

**Files:**
- Modify: `server/lib/aiDashboardService.js`
- Modify: `server/lib/aiDashboardService.test.js`
- Modify: `server/api/ai_dashboard.js`
- Modify: `server/api/ai_dashboard.test.js`
- Modify: `server/index.js`
- Modify: `src/pages/AIDashboard/AIDashboardPanel.tsx`
- Modify: `tests/aiDashboardViewModel.test.ts`

**Interfaces:**
- `createAiDashboardService({ collectors, dataFile, now })` consumes collector methods named by schema-v2 source key.
- `refresh({ sources, force })` accepts only schema-v2 keys and merges independently validated slices.
- `startAiDashboardAutoRefresh` schedules growth/pricing/capital/compute daily, OpenRouter daily, official Benchmark daily, and Artificial Analysis daily; intervals remain injectable in tests.

- [ ] **Step 1: Replace Feishu-preservation tests with public-slice tests**

Create collector fixtures where `growth` succeeds and `pricing` fails. Assert growth replaces only its payload, pricing preserves last-good, `sources.pricing.stale === true`, and `sources.feishu` is absent.

- [ ] **Step 2: Add failing API validation tests**

Assert `sources: ['feishu']` returns HTTP 400 and `sources: ['growth', 'pricing']` is accepted.

- [ ] **Step 3: Add failing UI tests**

Assert the view-model exposes no Feishu badge/link and maps the seven slice statuses to Chinese labels.

- [ ] **Step 4: Run tests and verify RED**

Run: `node --test server/lib/aiDashboardService.test.js server/api/ai_dashboard.test.js tests/aiDashboardViewModel.test.ts`

Expected: FAIL on the current Feishu source and refresh allowlist.

- [ ] **Step 5: Refactor service orchestration**

Delete production calls to `createFeishuClient`, `normalizeFeishuWorkbook`, `AI_DASHBOARD_SHEET_TITLES`, local Feishu export seeding, and the hourly Feishu interval. Keep `server/lib/aiDashboardData.js` only until all old parsing tests are removed in Task 10.

- [ ] **Step 6: Update API, scheduler, and header**

Remove the “飞书” badge and “飞书源表” button. Render compact per-slice status badges; a stale slice must not make successful slices look failed.

- [ ] **Step 7: Run focused tests, build, and commit**

Run: `node --test server/lib/aiDashboardService.test.js server/api/ai_dashboard.test.js tests/aiDashboardViewModel.test.ts`

Run: `npm run build`

Expected: all PASS.

```bash
git add server/lib/aiDashboardService.js server/lib/aiDashboardService.test.js server/api/ai_dashboard.js server/api/ai_dashboard.test.js server/index.js src/pages/AIDashboard/AIDashboardPanel.tsx tests/aiDashboardViewModel.test.ts
git commit -m "refactor: remove Feishu from AI dashboard runtime"
```

---

### Task 4: Implement ARR Month-over-Month, Combined ARR, Historical P/ARR, and OpenRouter Week-over-Week

**Files:**
- Modify: `server/lib/aiDashboardMetrics.js`
- Modify: `server/lib/aiDashboardMetrics.test.js`
- Create: `server/lib/aiGrowthData.js`
- Create: `server/lib/aiGrowthData.test.js`
- Create: `server/lib/fixtures/ai-growth/anthropic-yipit.json`
- Create: `server/lib/fixtures/ai-growth/anthropic-official.html`
- Create: `server/lib/fixtures/ai-growth/openai-official.html`
- Modify: `server/lib/aiDashboardService.js`
- Modify: `src/pages/AIDashboard/types.ts`
- Modify: `src/pages/AIDashboard/AIDashboardSections.tsx`
- Modify: `src/pages/AIDashboard/viewModel.ts`
- Modify: `tests/aiDashboardViewModel.test.ts`

**Interfaces:**
- `buildArrMetrics` returns `momAbsolute` and `momPercent` and no longer exposes `slope3m` as a required UI metric.
- `buildArrComparison(companies, names)` returns aligned Anthropic/OpenAI actual and estimate series without merging provenance.
- `attachValuationMultiples` preserves complete history and its exact matched ARR provenance.
- `aggregateOpenRouterWeekly` returns `weekOverWeekAbsolute` and `weekOverWeekPercent` from two complete UTC weeks.
- `normalizeGrowthRecords({ yipitRecords, officialRecords, valuationRecords })` preserves parallel official/estimate series.

- [ ] **Step 1: Write failing ARR month-over-month tests**

```js
assert.deepEqual(metric.actualPoints.map(({ momAbsolute, momPercent }) => ({ momAbsolute, momPercent })), [
  { momAbsolute: null, momPercent: null },
  { momAbsolute: 30, momPercent: 0.5 },
]);
```

Also prove a missing month remains a direct observation-to-observation change and is labeled with the two dates instead of being described as a one-calendar-month change.

- [ ] **Step 2: Write failing provenance and P/ARR tests**

Use separate Anthropic records for `Yipit` and `Anthropic official`. Assert they remain two series and that an OpenAI valuation on 2026-08-15 matches the latest OpenAI ARR dated on or before 2026-08-15.

- [ ] **Step 3: Write failing OpenRouter week-over-week tests**

Use 14 complete UTC days and assert latest-week total, prior-week total, absolute delta, percentage delta, and negative change. Add a prior-week-zero case with null percent.

- [ ] **Step 4: Run metrics tests and verify RED**

Run: `node --test server/lib/aiDashboardMetrics.test.js server/lib/aiGrowthData.test.js`

Expected: FAIL for missing percent, comparison, provenance, and weekly delta fields.

- [ ] **Step 5: Implement metrics and fixture-backed growth normalization**

Every normalized point includes `seriesKind: 'official' | 'estimate'`, `currency`, `unitScale`, and the shared provenance fields. Conversion to display units happens once and retains the original value and unit.

- [ ] **Step 6: Write failing view-model tests for tooltip copy and delta formatting**

Assert positive, negative, zero, and unavailable month/week deltas render with sign, unit, and percentage where available.

- [ ] **Step 7: Replace the ARR selector chart with a combined comparison chart**

Render Anthropic and OpenAI together, use solid/dashed styling for official/estimate, and include source/methodology/commentary in ECharts tooltip. Replace the overview slope KPI with the latest observed month-over-month change. Add the OpenAI P/ARR history series.

- [ ] **Step 8: Change OpenRouter KPI and history chart**

Lead with weekly Token delta; show total as secondary context. When Data API is unavailable, say “平台周环比需 Data API 授权” and do not infer it from Top 10.

- [ ] **Step 9: Run focused tests, build, and commit**

Run: `node --test server/lib/aiDashboardMetrics.test.js server/lib/aiGrowthData.test.js tests/aiDashboardViewModel.test.ts`

Run: `npm run build`

Expected: PASS.

```bash
git add server/lib/aiDashboardMetrics.js server/lib/aiDashboardMetrics.test.js server/lib/aiGrowthData.js server/lib/aiGrowthData.test.js server/lib/fixtures/ai-growth server/lib/aiDashboardService.js src/pages/AIDashboard/types.ts src/pages/AIDashboard/AIDashboardSections.tsx src/pages/AIDashboard/viewModel.ts tests/aiDashboardViewModel.test.ts
git commit -m "feat: make AI growth metrics change-oriented"
```

---

### Task 5: Build Official Latest-Generation Pricing, Video, Coding Plan, and Price Events

**Files:**
- Create: `server/lib/aiPricingData.js`
- Create: `server/lib/aiPricingData.test.js`
- Create: `server/lib/aiPricingSources.js`
- Create: `server/lib/aiPricingSources.test.js`
- Create: `server/lib/fixtures/ai-pricing/`
- Modify: `server/lib/aiDashboardService.js`
- Modify: `src/pages/AIDashboard/types.ts`
- Modify: `src/pages/AIDashboard/AIDashboardSections.tsx`
- Modify: `src/pages/AIDashboard/viewModel.ts`
- Modify: `tests/aiDashboardViewModel.test.ts`

**Interfaces:**
- `normalizeTokenPrice(record)` preserves currency, context tier, service tier, input, cached input, cache write, and output price per million tokens.
- `selectLatestGeneration(prices, vendorGenerationRules)` returns only current-generation public SKUs for the main chart while retaining history.
- `derivePriceEvents(history)` returns official same-SKU changes with old/new price and absolute/percentage delta.
- `normalizeVideoPrice` preserves original unit and derives comparable USD/second only when duration and currency are known.
- `normalizeCodingPlan` supports fixed price, inquiry-only, allowance text, overage, region, and source.

- [x] **Step 1: Write failing normalization and latest-generation tests**

Fixtures must cover OpenAI, Anthropic, Gemini, 智谱, MiniMax, Kimi, DeepSeek, Mimo, and Qwen. Test short/long context tiers, absent cached input, CNY and USD, and a vendor generation containing flagship/balanced/light SKUs.

- [x] **Step 2: Write failing price-event tests**

Assert only the same vendor/model/tier/context/currency/price-field forms a change event; a renamed model or currency change does not fabricate a percentage.

- [x] **Step 3: Write failing video and Coding Plan tests**

Cover Kling and Seedance resolution/duration modes, an API without public price, a fixed monthly Coding Plan, annual effective monthly price, inquiry-only price, and missing overage.

- [x] **Step 4: Run tests and verify RED**

Run: `node --test server/lib/aiPricingData.test.js server/lib/aiPricingSources.test.js`

Expected: FAIL because pricing modules do not exist.

- [x] **Step 5: Implement source adapters using only registered official pages**

Each adapter exports `discoverCurrentGeneration(document)` and `parsePricing(document)`. It rejects a parsed row if model identity, price unit, currency, or source date cannot be established. It never falls back to Feishu or OpenRouter model prices.

- [x] **Step 6: Implement price history and events**

Preserve prior normalized records in the slice, deduplicate by full SKU key and `asOf`, and derive events at read time so a re-fetch of the same price is idempotent.

- [x] **Step 7: Redesign the pricing page**

Keep Token/视频/Coding tabs. The Token main chart shows only latest-generation standard public prices; a side card lists recent official price changes. Video and Coding tables remove all “请在飞书录入” copy and show official source status.

- [x] **Step 8: Run focused tests, build, and commit**

Run: `node --test server/lib/aiPricingData.test.js server/lib/aiPricingSources.test.js tests/aiDashboardViewModel.test.ts`

Run: `npm run build`

Expected: PASS.

```bash
git add server/lib/aiPricingData.js server/lib/aiPricingData.test.js server/lib/aiPricingSources.js server/lib/aiPricingSources.test.js server/lib/fixtures/ai-pricing server/lib/aiDashboardService.js src/pages/AIDashboard/types.ts src/pages/AIDashboard/AIDashboardSections.tsx src/pages/AIDashboard/viewModel.ts tests/aiDashboardViewModel.test.ts
git commit -m "feat: source current AI pricing from official pages"
```

---

### Task 6: Build CSP/Model-Vendor Financing History and Compute Rental Refresh

**Files:**
- Create: `server/lib/aiCapitalData.js`
- Create: `server/lib/aiCapitalData.test.js`
- Create: `server/lib/aiCapitalSources.js`
- Create: `server/lib/aiCapitalSources.test.js`
- Create: `server/lib/aiComputeData.js`
- Create: `server/lib/aiComputeData.test.js`
- Create: `server/lib/aiComputeSources.js`
- Create: `server/lib/aiComputeSources.test.js`
- Create: `server/lib/fixtures/ai-capital/`
- Create: `server/lib/fixtures/ai-compute/`
- Modify: `server/lib/aiDashboardService.js`
- Modify: `src/pages/AIDashboard/types.ts`
- Modify: `src/pages/AIDashboard/AIDashboardSections.tsx`

**Interfaces:**
- `normalizeCapitalEvent` outputs entity, geography, event/close/maturity dates, instrument, amount, currency, comparable USD amount, rate type, coupon, benchmark, spread, tenor, counterparties, use of proceeds, and provenance.
- `buildCapitalMetrics(events, { now })` returns cumulative amount, trailing-12-month amount/count, event frequency, and comparable fixed-coupon weighted average.
- `normalizeComputeQuote` keys history by platform, GPU, instance spec, region, billing mode, and currency.
- `enrichComputeQuotes` calculates absolute and percentage changes only inside the exact quote key.

- [ ] **Step 1: Write failing capital normalization tests**

Use official-style fixtures for a fixed-rate bond, benchmark-plus-spread loan, convertible note, equity round, missing-rate event, CNY event, and USD event. Assert unknown rates remain null and equity does not enter debt coupon calculations.

- [ ] **Step 2: Write failing frequency and weighted-rate tests**

Assert event count and trailing-12-month cadence per company, while weighted average coupon includes only fixed-rate debt with comparable amount currency.

- [ ] **Step 3: Write failing compute tests**

Prove that H100 on-demand in `us-east` never compares with H100 Spot, H100 in another region, or a different instance specification. Test positive and negative percentage changes.

- [ ] **Step 4: Run tests and verify RED**

Run: `node --test server/lib/aiCapitalData.test.js server/lib/aiCapitalSources.test.js server/lib/aiComputeData.test.js server/lib/aiComputeSources.test.js`

Expected: FAIL because the modules do not exist.

- [ ] **Step 5: Implement official capital-source registries**

Initial entity registry covers OpenAI, Anthropic, Google, Microsoft, Amazon, Meta, xAI, CoreWeave, Alibaba, Tencent, Baidu, 智谱, MiniMax, Moonshot, DeepSeek, and Xiaomi. Each entry names official IR/news/filing endpoints and regulator identifiers where available; an entity without a verified endpoint is marked discovery-maintained rather than silently omitted.

- [ ] **Step 6: Implement official compute adapters**

Initial platforms are AWS, Azure, Google Cloud, CoreWeave, and Lambda. Parse exact instance/SKU and region before price. If a dynamic calculator cannot be read reproducibly, mark that platform unavailable and retain its last-good official record.

- [ ] **Step 7: Replace financing and compute UI**

Financing page shows industry summary, company filter, full timeline, amount, instrument, rate/coupon, frequency, tenor, and official links. Compute page shows exact-SKU latest comparison, history, absolute/percentage change, region, and freshness. Remove “海外” and Feishu-specific copy.

- [ ] **Step 8: Run focused tests, build, and commit**

Run: `node --test server/lib/aiCapitalData.test.js server/lib/aiCapitalSources.test.js server/lib/aiComputeData.test.js server/lib/aiComputeSources.test.js`

Run: `npm run build`

Expected: PASS.

```bash
git add server/lib/aiCapitalData.js server/lib/aiCapitalData.test.js server/lib/aiCapitalSources.js server/lib/aiCapitalSources.test.js server/lib/aiComputeData.js server/lib/aiComputeData.test.js server/lib/aiComputeSources.js server/lib/aiComputeSources.test.js server/lib/fixtures/ai-capital server/lib/fixtures/ai-compute server/lib/aiDashboardService.js src/pages/AIDashboard/types.ts src/pages/AIDashboard/AIDashboardSections.tsx
git commit -m "feat: track AI capital and compute rental history"
```

---

### Task 7: Execute the Official Model-Card Benchmark Plan

**Files:**
- Follow every file and interface in `docs/superpowers/plans/2026-08-23-official-model-card-benchmarks.md`.
- Modify that plan before execution only where it conflicts with this roadmap.

**Interfaces:**
- Produces `benchmarks.sourceMode === 'official-model-cards'`.
- Produces only the latest flagship/general text model per tracked vendor.
- Produces exact official test definitions, comparable winners, per-vendor model-card status, and first-party attribution.

- [ ] **Step 1: Add a regression test removing the Fable/Mythos exclusion**

In `server/lib/aiDashboardMetrics.test.js`, add a record named `Fable` and one named `Mythos` with valid comparable scores and assert the higher score can win. Delete `EXCLUDED_WINNER_RE` and any UI label saying those names are excluded.

- [ ] **Step 2: Execute Tasks 1–7 of the official-model-card plan in order**

Use the RED/GREEN commands and exact interfaces defined in `docs/superpowers/plans/2026-08-23-official-model-card-benchmarks.md`.

- [ ] **Step 3: Remove all aggregated Benchmark clients and fallback paths**

Delete the OpenRouter `/api/v1/benchmarks` call, `normalizeOnlineBenchmarks`, Feishu Benchmark fallback, and `sourceMode: 'openrouter' | 'feishu'` rendering. OpenRouter `/models` may not select Benchmark models after this task.

- [ ] **Step 4: Run the official Benchmark suite and build**

Run: `node --test server/lib/officialBenchmarkData.test.js server/lib/officialDocumentClient.test.js server/lib/officialBenchmarkSources.test.js server/lib/aiDashboardService.test.js server/api/ai_dashboard.test.js tests/aiDashboardViewModel.test.ts`

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit Task 7**

```bash
git add server/lib src/pages/AIDashboard tests package.json package-lock.json
git commit -m "feat: use first-party model cards for benchmarks"
```

---

### Task 8: Add the Separate Artificial Analysis and Per-Task Token-Cost Panels

**Files:**
- Create: `server/lib/artificialAnalysisData.js`
- Create: `server/lib/artificialAnalysisData.test.js`
- Create: `server/lib/artificialAnalysisSource.js`
- Create: `server/lib/artificialAnalysisSource.test.js`
- Create: `server/lib/taskCostMetrics.js`
- Create: `server/lib/taskCostMetrics.test.js`
- Create: `server/lib/fixtures/artificial-analysis/`
- Modify: `server/lib/aiDashboardService.js`
- Modify: `src/pages/AIDashboard/types.ts`
- Modify: `src/pages/AIDashboard/AIDashboardSections.tsx`
- Modify: `src/pages/AIDashboard/viewModel.ts`

**Interfaces:**
- `normalizeArtificialAnalysisSnapshot` returns Intelligence Index rows and task-run rows with `sourceKind: 'named-third-party'`.
- `calculateTaskCost({ inputTokens, cachedInputTokens, outputTokens, price })` returns exact component costs and total in the price currency.
- Official Benchmark types and winners cannot consume Artificial Analysis records.

- [ ] **Step 1: Write failing isolation tests**

Assert an Artificial Analysis score appears only in `snapshot.artificialAnalysis`, never in `snapshot.benchmarks.metrics` or `snapshot.benchmarks.winners`.

- [ ] **Step 2: Write failing task-cost tests**

```js
assert.deepEqual(calculateTaskCost({
  inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 100_000,
  price: { input: 2, cachedInput: 0.2, output: 10, currency: 'USD', perTokens: 1_000_000 },
}), { inputCost: 2, cachedInputCost: 0.04, outputCost: 1, totalCost: 3.04, currency: 'USD' });
```

Add null tests for missing Token counts, missing price, incompatible price date, and mismatched task/harness/version.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test server/lib/artificialAnalysisData.test.js server/lib/artificialAnalysisSource.test.js server/lib/taskCostMetrics.test.js`

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement the named-third-party adapter and strict separation**

Only the registered Artificial Analysis entry may populate this slice. Preserve methodology, date, original model label, and source URL. If stable extraction is not permitted, publish last-good with `stale: true` rather than scrape around access controls.

- [ ] **Step 5: Implement task cost by joining task runs to same-date official prices**

Use the latest official price not later than the task-run date. Do not convert currencies without a source-backed FX rate for that date. No comparable task key means no ranking.

- [ ] **Step 6: Add two visually separate cards**

Render “Artificial Analysis Intelligence Index（第三方参考）” and “单任务 Token 与成本”. Add copy stating neither card changes official model-card winners. Include task, version, harness, Token components, cost formula, and source tooltip.

- [ ] **Step 7: Run focused tests, build, and commit**

Run: `node --test server/lib/artificialAnalysisData.test.js server/lib/artificialAnalysisSource.test.js server/lib/taskCostMetrics.test.js tests/aiDashboardViewModel.test.ts`

Run: `npm run build`

Expected: PASS.

```bash
git add server/lib/artificialAnalysisData.js server/lib/artificialAnalysisData.test.js server/lib/artificialAnalysisSource.js server/lib/artificialAnalysisSource.test.js server/lib/taskCostMetrics.js server/lib/taskCostMetrics.test.js server/lib/fixtures/artificial-analysis server/lib/aiDashboardService.js src/pages/AIDashboard/types.ts src/pages/AIDashboard/AIDashboardSections.tsx src/pages/AIDashboard/viewModel.ts
git commit -m "feat: add separate AI index and task cost views"
```

---

### Task 9: Seed and Verify Current Public Data

**Files:**
- Create: `server/data/ai-dashboard/source-manifest.json`
- Create: `server/data/ai-dashboard/research-ledger.json`
- Modify: `server/data/ai-dashboard/snapshot.json`
- Create: `server/scripts/verify_ai_dashboard_sources.mjs`
- Create: `server/scripts/verify_ai_dashboard_sources.test.js`

**Interfaces:**
- `source-manifest.json` contains only registered source IDs and official entry URLs; no free-form fetched HTML.
- `research-ledger.json` records entity, metric, value, unit, data date, source ID, source URL, retrieved date, methodology, and verification result.
- Verification script fails on missing provenance, non-allowlisted final host, future data date, unitless number, or an official/estimate classification mismatch.

- [ ] **Step 1: Write failing ledger-validation tests**

Create invalid records for missing URL, unregistered host, missing currency/unit, Yipit marked official, and a media URL. Assert each produces a stable error code.

- [ ] **Step 2: Run the validator test and verify RED**

Run: `node --test server/scripts/verify_ai_dashboard_sources.test.js`

Expected: FAIL because the validator does not exist.

- [ ] **Step 3: Implement the validator**

The validator performs structural and host checks without live network. `--live` additionally issues safe HEAD/GET requests through `officialDocumentClient` and records the final URL and retrieval result.

- [ ] **Step 4: Research and enter current source-backed records**

For each required vendor/company/platform, navigate from the verified official entry to the current model, price, filing, announcement, or compute SKU. Use Yipit only for records explicitly classified as estimates. Save no number that cannot be reconciled to its original source page.

- [ ] **Step 5: Run structural and live verification**

Run: `node server/scripts/verify_ai_dashboard_sources.mjs`

Expected: zero structural failures.

Run: `node server/scripts/verify_ai_dashboard_sources.mjs --live`

Expected: every reachable source passes its allowlist; failures are recorded as stale/unavailable rather than silently ignored.

- [ ] **Step 6: Refresh the local snapshot and commit**

Run the server-side refresh command added by the service integration and verify schema v2 output contains no Feishu source or fallback.

```bash
git add server/data/ai-dashboard/source-manifest.json server/data/ai-dashboard/research-ledger.json server/data/ai-dashboard/snapshot.json server/scripts/verify_ai_dashboard_sources.mjs server/scripts/verify_ai_dashboard_sources.test.js
git commit -m "data: seed verified AI dashboard sources"
```

---

### Task 10: Remove Legacy Parsers and Complete Automated Verification

**Files:**
- Delete: `server/lib/aiDashboardData.js`
- Delete or rewrite: `server/lib/aiDashboardData.test.js`
- Delete: `server/data/ai-dashboard/feishu-export.json`
- Modify: `server/lib/aiDashboardService.js`
- Modify: `README.md`
- Modify: `server/api/ai_dashboard.test.js`
- Modify: `server/lib/aiDashboardService.test.js`

**Interfaces:**
- No production import or environment variable contains `FEISHU` for the AI dashboard.
- README documents public-source refresh keys, cadence, source policy, and failure behavior.

- [ ] **Step 1: Add a failing legacy-reference check**

Add a test/script assertion over AI-dashboard production files that rejects `feishu`, `FEISHU`, `飞书源表`, `normalizeFeishuWorkbook`, and `/api/v1/benchmarks` references, while allowing historical docs and migration tests outside production paths.

- [ ] **Step 2: Run the check and verify RED**

Run: `node --test server/lib/aiDashboardService.test.js server/api/ai_dashboard.test.js`

Expected: FAIL on current legacy imports/routes/copy.

- [ ] **Step 3: Remove legacy files and update documentation**

Delete old parsers and local export only after all schema-v2 tests pass. Document that Yipit is an estimate source, Artificial Analysis is a separate named-third-party panel, and official-model-card Benchmark has no third-party fallback.

- [ ] **Step 4: Run the complete automated suite**

Run: `node --test tests/*.test.ts server/lib/*.test.js server/api/*.test.js server/scripts/*.test.js`

Expected: PASS with no failures.

Run: `npm run lint`

Expected: PASS with no errors or warnings introduced by this work.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit Task 10**

```bash
git add -A server/lib/aiDashboardData.js server/lib/aiDashboardData.test.js server/data/ai-dashboard/feishu-export.json server/lib/aiDashboardService.js server/api/ai_dashboard.test.js server/lib/aiDashboardService.test.js README.md
git commit -m "chore: remove legacy AI dashboard sources"
```

---

### Task 11: Rendered Desktop and Mobile QA

**Files:**
- Modify if defects are found: `src/pages/AIDashboard/AIDashboardSections.tsx`
- Modify if defects are found: `src/pages/AIDashboard/AIDashboardPanel.tsx`
- Modify if defects are found: `src/pages/AIDashboard/AIDashboardPanel.css`
- Modify if defects are found: `src/pages/AIDashboard/viewModel.ts`
- Test if defects are found: `tests/aiDashboardViewModel.test.ts`

**Target flow:** `/ai-dashboard` loads -> each primary tab renders source-backed data -> methodology tooltips and filters respond -> no Feishu or aggregated Benchmark source appears.

- [ ] **Step 1: Start the app and record page identity**

Run the repository server and Vite development scripts on their configured local hosts. Use the in-app Browser plugin because it is available.

- [ ] **Step 2: Verify desktop at 1440×1000**

Check non-blank content, no framework overlay, console health, source badges, overview deltas, combined ARR chart, OpenRouter week delta, pricing news, financing filters, official Benchmark matrix, separate AA/task-cost cards, and compute history.

- [ ] **Step 3: Exercise target interactions**

Open at least one methodology question icon, hover one ARR point, change a financing company filter, switch pricing subtabs, open one official model-card link, and verify the rendered state after every interaction.

- [ ] **Step 4: Verify mobile at 390×844**

Check card stacking, chart readability, table horizontal scrolling, no clipped tooltips, no overlapping badges, and no inaccessible controls.

- [ ] **Step 5: Fix each defect with a failing test first**

For any deterministic formatting/state defect, add a failing view-model or component-level test before editing production code. Repeat the exact Browser interaction after the fix.

- [ ] **Step 6: Run final verification and commit**

Run: `node --test tests/*.test.ts server/lib/*.test.js server/api/*.test.js server/scripts/*.test.js`

Run: `npm run lint`

Run: `npm run build`

Expected: all PASS and Browser console contains no relevant warnings/errors.

```bash
git add src/pages/AIDashboard tests
git commit -m "fix: complete AI dashboard responsive QA"
```
