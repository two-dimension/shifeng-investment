# Announcement Monitor Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the `cninfo` announcement-monitor tab by fetching official Shanghai and Shenzhen announcements directly, judging portfolio matches deterministically, and preserving usable cached history when the upstream source fails.

**Architecture:** A pure CNINFO client owns pagination, validation, retry, and normalization. A separate judgement module maps the current `funds.json` positions to directional research entries. `researchSync` keeps the old local-artifact importer when its complete inputs exist and otherwise uses the direct client, writing the existing `ResearchSummary` contract atomically; the React page only gains accurate sync-result messaging.

**Tech Stack:** Node.js 24 ESM, built-in `fetch`, `node:test`, Express 5, React 19, TypeScript 6, Ant Design 6.

**Spec:** `docs/superpowers/specs/2026-08-23-announcement-monitor-recovery-design.md`

## Global Constraints

- Restore only the `cninfo` announcement-judgement tab; retain the existing import-only behavior for earnings forecasts, earnings reports, and risk alerts.
- Fetch Shanghai and Shenzhen announcements from CNINFO without adding credentials, paid providers, or package dependencies.
- Store market-wide counts but create detailed entries only for six-digit A-share positions with positive shares in `server/data/funds.json`.
- Do not claim that a title-based classification read or verified the PDF body.
- Do not overwrite a usable cached date when an upstream request or response validation fails.
- Keep the existing `ResearchSummary` response shape and all current latest/history/detail URLs.
- Preserve unrelated uncommitted workspace changes; stage only the files named by each task.

---

### Task 1: Official CNINFO paginated client

**Files:**
- Create: `server/lib/cninfoAnnouncements.js`
- Create: `server/lib/cninfoAnnouncements.test.js`

**Interfaces:**
- Consumes: CNINFO's `POST https://www.cninfo.com.cn/new/hisAnnouncement/query` response fields `totalRecordNum`, `totalAnnouncement`, and `announcements`.
- Produces: `fetchCninfoMarketDay({ date, fetchImpl, sleepImpl, timeoutMs, attempts, pageSize, columns }) -> Promise<{ date, totalCount, announcements, columns }>` and `CninfoUpstreamError`.

- [ ] **Step 1: Write failing pagination, merge, and de-duplication tests**

Create fixtures that mirror a full CNINFO announcement object, including `secCode`, `secName`, `announcementId`, `announcementTitle`, `announcementTime`, `adjunctUrl`, `adjunctType`, `pageColumn`, and `announcementType`. The fake `fetchImpl` must read `options.body.get('pageNum')` and `options.body.get('column')`, return two pages for `szse`, one page for `sse`, and repeat one `announcementId` across pages.

```js
test('fetchCninfoMarketDay reads every Shanghai and Shenzhen page and removes duplicate ids', async () => {
  const result = await fetchCninfoMarketDay({
    date: '2026-08-20',
    pageSize: 2,
    attempts: 1,
    fetchImpl: createPagedFetch({
      szse: [
        [announcement('sz-1', '000001'), announcement('shared', '000002')],
        [announcement('shared', '000002')],
      ],
      sse: [[announcement('sh-1', '600000')]],
    }),
  });

  assert.equal(result.totalCount, 4);
  assert.deepEqual(result.announcements.map((item) => item.announcementId), [
    'sh-1', 'sz-1', 'shared',
  ]);
  assert.deepEqual(result.columns, [
    { column: 'sse', totalCount: 1, pages: 1 },
    { column: 'szse', totalCount: 3, pages: 2 },
  ]);
});
```

- [ ] **Step 2: Run the client test and verify RED**

Run: `node --test server/lib/cninfoAnnouncements.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `cninfoAnnouncements.js`.

- [ ] **Step 3: Implement request construction, response validation, pagination, and normalization**

Implement the public entry point with these defaults and exact request keys:

```js
const CNINFO_QUERY_URL = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';

export async function fetchCninfoMarketDay({
  date,
  fetchImpl = globalThis.fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 10_000,
  attempts = 3,
  pageSize = 100,
  columns = ['sse', 'szse'],
} = {}) {
  assertDate(date);
  const marketResults = [];
  for (const column of columns) {
    marketResults.push(await fetchColumn({
      date, column, fetchImpl, sleepImpl, timeoutMs, attempts, pageSize,
    }));
  }
  const unique = new Map();
  for (const item of marketResults.flatMap((result) => result.announcements)) {
    unique.set(item.announcementId || `${item.secCode}:${item.announcementTime}:${item.announcementTitle}`, item);
  }
  return {
    date,
    totalCount: marketResults.reduce((sum, result) => sum + result.totalCount, 0),
    announcements: [...unique.values()],
    columns: marketResults.map(({ column, totalCount, pages }) => ({ column, totalCount, pages })),
  };
}
```

`fetchColumn` must POST `pageNum`, `pageSize`, `column`, `tabName=fulltext`, empty `plate/stock/searchkey/secid/category/trade`, `seDate=<date>~<date>`, empty `sortName/sortType`, and `isHLtitle=true`. It must fetch `Math.ceil(totalRecordNum / pageSize)` pages, validate that every response has an `announcements` array and finite non-negative total, and reject when the number of raw rows fetched is smaller than `totalRecordNum`.

Normalize every returned item to these fields only:

```js
{
  announcementId: String(raw.announcementId || ''),
  secCode: String(raw.secCode || '').split(',')[0].trim(),
  secName: stripHtml(raw.secName || raw.tileSecName || ''),
  announcementTitle: stripHtml(raw.announcementTitle || raw.shortTitle || ''),
  announcementTime: Number(raw.announcementTime) || 0,
  adjunctUrl: normalizePdfUrl(raw.adjunctUrl),
  adjunctType: String(raw.adjunctType || ''),
}
```

- [ ] **Step 4: Add failure tests for malformed responses and retryable status codes**

```js
test('fetchCninfoMarketDay retries 503 and returns the later valid response', async () => {
  let calls = 0;
  const result = await fetchCninfoMarketDay({
    date: '2026-08-20',
    columns: ['szse'],
    attempts: 2,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return response({}, 503);
      return response({ totalRecordNum: 1, totalAnnouncement: 1, announcements: [announcement('a-1', '000001')] });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.announcements.length, 1);
});

test('fetchCninfoMarketDay rejects an incomplete final page', async () => {
  await assert.rejects(
    fetchCninfoMarketDay({
      date: '2026-08-20',
      columns: ['szse'],
      pageSize: 2,
      attempts: 1,
      fetchImpl: async () => response({ totalRecordNum: 2, totalAnnouncement: 2, announcements: [] }),
    }),
    /incomplete CNINFO response/,
  );
});
```

Retry only thrown network errors, HTTP `429`, and HTTP `500..599`; reject other non-2xx statuses immediately. Throw `CninfoUpstreamError` with `code`, `column`, `page`, and a message that is safe to return to the UI.

- [ ] **Step 5: Run Task 1 tests and verify GREEN**

Run: `node --test server/lib/cninfoAnnouncements.test.js`

Expected: PASS with no warnings or network access.

- [ ] **Step 6: Commit Task 1**

```bash
git add server/lib/cninfoAnnouncements.js server/lib/cninfoAnnouncements.test.js
git commit -m "feat: add official cninfo announcement client"
```

---

### Task 2: Portfolio matching and explainable title judgement

**Files:**
- Create: `server/lib/announcementJudgement.js`
- Create: `server/lib/announcementJudgement.test.js`

**Interfaces:**
- Consumes: normalized announcements from Task 1 and parsed `{ funds: [...] }` data from `server/data/funds.json`.
- Produces: `buildPortfolioUniverse(fundsData)`, `classifyAnnouncementTitle(title)`, and `buildDirectCninfoSummary({ date, totalCount, announcements, universe, generatedAt })`.

- [ ] **Step 1: Write failing portfolio-universe and classification tests**

```js
test('buildPortfolioUniverse keeps positive A-share positions and combines fund labels', () => {
  const universe = buildPortfolioUniverse({ funds: [
    { name: '小金属', positions: [
      { code: '600497', name: '驰宏锌锗', shares: 100 },
      { code: 'AAPL', name: 'Apple', shares: 10 },
    ] },
    { name: '资源股', positions: [
      { code: '600497', name: '驰宏锌锗', shares: 20 },
      { code: '000001', name: '平安银行', shares: 0 },
    ] },
  ] });

  assert.deepEqual(universe.get('600497'), {
    code: '600497', name: '驰宏锌锗', subsets: ['小金属', '资源股'],
  });
  assert.equal(universe.has('AAPL'), false);
  assert.equal(universe.has('000001'), false);
});

test('classifyAnnouncementTitle reports matched rules without pretending to read the body', () => {
  assert.deepEqual(classifyAnnouncementTitle('关于收到行政处罚决定书的公告'), {
    score: -6,
    direction: 'bad',
    matchedRules: ['行政处罚'],
  });
  assert.deepEqual(classifyAnnouncementTitle('关于签订重大合同的公告'), {
    score: 5,
    direction: 'good',
    matchedRules: ['重大合同'],
  });
  assert.deepEqual(classifyAnnouncementTitle('2026年第一次临时股东大会决议公告'), {
    score: 0,
    direction: 'neutral',
    matchedRules: [],
  });
});
```

- [ ] **Step 2: Run the judgement test and verify RED**

Run: `node --test server/lib/announcementJudgement.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `announcementJudgement.js`.

- [ ] **Step 3: Implement the literal rule table and public helpers**

Use ordered rules with labels and weights. Prevent `不减持` from matching the negative `减持` rule.

```js
const TITLE_RULES = [
  { label: '退市风险', score: -9, pattern: /退市风险|终止上市/ },
  { label: '立案调查', score: -8, pattern: /立案|调查通知书/ },
  { label: '行政处罚', score: -6, pattern: /行政处罚|监管措施|警示函/ },
  { label: '重大亏损', score: -6, pattern: /重大亏损|首亏|续亏/ },
  { label: '业绩预减', score: -5, pattern: /业绩预减|预亏/ },
  { label: '冻结诉讼', score: -5, pattern: /冻结|诉讼|仲裁/ },
  { label: '质押风险', score: -4, pattern: /质押.*风险|风险.*质押/ },
  { label: '股东减持', score: -4, pattern: /减持/, exclude: /不减持/ },
  { label: '股份回购', score: 6, pattern: /股份回购|回购.*股份/ },
  { label: '业绩改善', score: 6, pattern: /业绩预增|扭亏为盈|扭亏/ },
  { label: '重大合同', score: 5, pattern: /中标|重大合同|签订.*合同/ },
  { label: '股东增持', score: 4, pattern: /增持/ },
  { label: '分红方案', score: 3, pattern: /现金分红|利润分配/ },
  { label: '获得批复', score: 3, pattern: /获得.*批复|收到.*批复|获批/ },
];
```

`classifyAnnouncementTitle` sums every applicable rule, clamps the result to `-10..10`, and returns a direction based on the final sign. `buildPortfolioUniverse` accepts only `/^[036]\d{5}$/` codes with `Number(position.shares) > 0`, de-duplicates subset labels, and retains the first non-empty stock name.

- [ ] **Step 4: Write a failing summary aggregation test**

```js
test('buildDirectCninfoSummary aggregates portfolio companies and keeps market totals', () => {
  const universe = new Map([['600497', {
    code: '600497', name: '驰宏锌锗', subsets: ['小金属', '资源股'],
  }]]);
  const summary = buildDirectCninfoSummary({
    date: '2026-08-20',
    totalCount: 2492,
    generatedAt: '2026-08-20T15:00:00.000Z',
    universe,
    announcements: [
      announcement({ id: 'a1', code: '600497', title: '关于股东增持股份的公告', time: 1787220000000 }),
      announcement({ id: 'a2', code: '600497', title: '2026年第一次临时股东大会决议公告', time: 1787221000000 }),
      announcement({ id: 'a3', code: '000001', title: '关于股份回购的公告', time: 1787222000000 }),
    ],
  });

  assert.equal(summary.totalCount, 2492);
  assert.equal(summary.watchlistHits, 2);
  assert.equal(summary.topGood.length, 1);
  assert.equal(summary.topGood[0].annCount, 2);
  assert.equal(summary.topGood[0].subset, '小金属；资源股');
  assert.match(summary.topGood[0].summary, /标题规则：股东增持/);
  assert.doesNotMatch(summary.topGood[0].summary, /正文/);
  assert.equal(summary.topGood[0].url, 'https://static.cninfo.com.cn/finalpage/a1.PDF');
  assert.equal(summary.stats.neutralFiltered, 1);
});
```

- [ ] **Step 5: Implement the existing `ResearchSummary` mapping**

For every matched code, group announcements, classify each title, sum directional scores with `-10..10` clamping, choose the highest absolute-scoring announcement as the main title, and use the newest announcement as the tie-breaker. Omit net-neutral companies from `allGood/allBad`, but count all matched neutral announcements in `stats.neutralFiltered`.

Return exactly these stable fields:

```js
{
  kind: 'cninfo',
  date,
  reportDate: date.slice(2).replaceAll('-', ''),
  generatedAt,
  coverage: `${date} 沪深市场`,
  totalCount,
  watchlistHits: matchedAnnouncements.length,
  topGood: allGood.slice(0, 5),
  topBad: allBad.slice(0, 5),
  allGood,
  allBad,
  files: [],
  stats: { goodCount: allGood.length, badCount: allBad.length, neutralFiltered },
  sentiment: {
    summary: `持仓命中 ${matchedAnnouncements.length} 条，利好 ${allGood.length} 家，利空 ${allBad.length} 家`,
    goodSectors: [],
    badSectors: [],
    netScore: allGood.reduce((sum, item) => sum + item.score, 0)
      + allBad.reduce((sum, item) => sum + item.score, 0),
  },
}
```

- [ ] **Step 6: Run Task 2 tests and verify GREEN**

Run: `node --test server/lib/announcementJudgement.test.js`

Expected: PASS with literal expected scores and no network access.

- [ ] **Step 7: Commit Task 2**

```bash
git add server/lib/announcementJudgement.js server/lib/announcementJudgement.test.js
git commit -m "feat: judge portfolio announcement titles"
```

---

### Task 3: Direct fallback in the existing research synchronization service

**Files:**
- Modify: `server/lib/researchSync.js`
- Create: `server/lib/researchSync.cninfo.test.js`

**Interfaces:**
- Consumes: `fetchCninfoMarketDay` and `buildDirectCninfoSummary` from Tasks 1–2, plus `server/data/funds.json`.
- Produces: the existing `syncResearch(options, dependencies?)` result, extended with per-result `source`, `fetched`, `matched`, and `totalCount`; `dependencies` accepts `fetchCninfoMarketDayImpl`, `fundsFile`, and `now` for deterministic tests.

- [ ] **Step 1: Write a failing direct-fallback integration test**

Import `researchSync.js` only after setting `RESEARCH_DATA_DIR`, `RESEARCH_REPORTS_DIR`, and `CNINFO_OUTPUT_DIR` to fresh test directories. Inject a complete official-source result instead of mocking the sync service itself.

```js
test('cninfo sync uses the official source when legacy artifacts are absent', async () => {
  fs.writeFileSync(fundsFile, JSON.stringify({ funds: [{
    name: '小金属',
    positions: [{ code: '600497', name: '驰宏锌锗', shares: 100 }],
  }] }));

  const result = await syncResearch({ kind: 'cninfo', date: '2026-08-20' }, {
    fundsFile,
    fetchCninfoMarketDayImpl: async () => ({
      date: '2026-08-20', totalCount: 2492, columns: [],
      announcements: [announcement('600497', '关于股东增持股份的公告')],
    }),
  });

  assert.equal(result.success, true);
  assert.equal(result.totals.attempted, 1);
  assert.equal(result.results[0].source, 'cninfo-direct');
  assert.equal(result.results[0].fetched, 1);
  assert.equal(result.results[0].matched, 1);
  const cached = JSON.parse(fs.readFileSync(path.join(dataRoot, 'cninfo', '2026-08-20.json')));
  assert.equal(cached.topGood[0].code, '600497');
  assert.deepEqual(cached.files, []);
});
```

- [ ] **Step 2: Run the focused integration test and verify RED**

Run: `node --test server/lib/researchSync.cninfo.test.js`

Expected: FAIL because `syncResearch` ignores the injected direct client and attempts only the missing legacy directory.

- [ ] **Step 3: Implement legacy-first/direct-fallback selection**

Rename the current private `buildCninfoSummary` to `buildImportedCninfoSummary`. Keep `syncCninfoDate` for complete legacy dates. Add:

```js
async function syncDirectCninfoDate(date, dependencies = {}) {
  const fetchDay = dependencies.fetchCninfoMarketDayImpl || fetchCninfoMarketDay;
  const fundsFile = dependencies.fundsFile || path.join(SERVER_DIR, 'data/funds.json');
  const marketDay = await fetchDay({ date });
  if (marketDay.totalCount === 0) {
    return { kind: 'cninfo', date, success: false, skipped: true, error: `CNINFO has no announcements for ${date}` };
  }
  const universe = buildPortfolioUniverse(readJson(fundsFile));
  const summary = buildDirectCninfoSummary({
    date,
    totalCount: marketDay.totalCount,
    announcements: marketDay.announcements,
    universe,
    generatedAt: new Date().toISOString(),
  });
  const summaryWritten = writeJsonAtomicIfChanged(
    path.join(RESEARCH_DIR, 'cninfo', `${date}.json`),
    summary,
  );
  return {
    kind: 'cninfo', date, success: true, summaryWritten,
    filesCopied: 0, filesSkipped: 0,
    source: 'cninfo-direct', fetched: marketDay.announcements.length,
    matched: summary.watchlistHits, totalCount: marketDay.totalCount,
  };
}
```

When `isAutoSyncableDate('cninfo', date)` is true, call the legacy path. Otherwise call `syncDirectCninfoDate`. Pass the optional `dependencies` argument from `syncResearch` through `syncOne` without changing existing callers.

- [ ] **Step 4: Make summary writes atomic and test failure preservation**

Add `writeJsonAtomicIfChanged(filePath, data)` that compares existing text, writes a sibling file named `${filePath}.${process.pid}.${Date.now()}.tmp`, then calls `fs.renameSync(tempPath, filePath)` inside `try/finally`; the `finally` removes a leftover temp file only when it still exists. Use it for all research summaries.

Add this failure test:

```js
test('failed official refresh leaves the previous cached summary unchanged', async () => {
  const target = path.join(dataRoot, 'cninfo', '2026-08-20.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ kind: 'cninfo', date: '2026-08-20', totalCount: 7 }));

  const result = await syncResearch({ kind: 'cninfo', date: '2026-08-20' }, {
    fundsFile,
    fetchCninfoMarketDayImpl: async () => { throw new Error('CNINFO upstream unavailable'); },
  });

  assert.equal(result.success, false);
  assert.match(result.results[0].error, /upstream unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(target)).totalCount, 7);
});
```

- [ ] **Step 5: Add recent-weekday fallback and zero-attempt semantics**

Implement `recentShanghaiWeekdays(now, lookbackDays)` using the Shanghai date key, UTC date arithmetic, and exclusion of Saturday/Sunday. For `kind=cninfo`, no explicit date, and no complete local source dates, try weekdays newest-first and stop at the first `success: true`; continue only past `{ skipped: true }`, not past a network/contract error.

When a single requested kind produces no results, return:

```js
{
  success: false,
  error: `未找到可同步的 ${kind} 数据源`,
  totals: { attempted: 0, succeeded: 0, failed: 0, changedDates: 0, filesCopied: 0, filesSkipped: 0 },
  results: [],
}
```

For `kind=all`, missing import-only sources remain non-fatal when direct `cninfo` succeeds. Add tests using `now: new Date('2026-08-23T04:00:00.000Z')` to prove Sunday starts from Friday `2026-08-21`, and a zero-announcement Friday proceeds to Thursday.

- [ ] **Step 6: Extend source status without removing legacy diagnostics**

Keep `root`, `exists`, and `latestDates` under `cninfo`; add:

```js
direct: {
  enabled: true,
  endpoint: 'https://www.cninfo.com.cn/new/hisAnnouncement/query',
  markets: ['sse', 'szse'],
}
```

Assert this structure in `server/lib/researchSync.cninfo.test.js`.

- [ ] **Step 7: Run focused and existing research tests**

Run: `node --test server/lib/cninfoAnnouncements.test.js server/lib/announcementJudgement.test.js server/lib/researchSync.cninfo.test.js server/api/research.test.js`

Expected: all tests PASS; existing earnings-report import tests remain unchanged.

- [ ] **Step 8: Commit Task 3**

```bash
git add server/lib/researchSync.js server/lib/researchSync.cninfo.test.js
git commit -m "feat: restore direct announcement synchronization"
```

---

### Task 4: Accurate manual-refresh feedback in the announcement page

**Files:**
- Create: `src/pages/Research/researchSyncClient.ts`
- Create: `tests/researchSyncClient.test.ts`
- Modify: `src/pages/Research/ResearchPanel.tsx`

**Interfaces:**
- Consumes: existing `POST /api/research/sync` response plus the extended `error` and per-result diagnostics from Task 3.
- Produces: `postResearchSync(kind, date, fetchImpl?)` and `describeResearchSyncResult(result) -> { level: 'success' | 'warning' | 'error', text: string }`.

- [ ] **Step 1: Write failing view-model tests for success, upstream failure, and no source**

```ts
test('describeResearchSyncResult does not call zero attempts a success', () => {
  assert.deepEqual(describeResearchSyncResult({
    success: false,
    error: '未找到可同步的 earnings 数据源',
    totals: { attempted: 0, succeeded: 0, failed: 0, changedDates: 0, filesCopied: 0, filesSkipped: 0 },
    results: [],
  }), {
    level: 'error',
    text: '未找到可同步的 earnings 数据源',
  });
});

test('describeResearchSyncResult surfaces the first failed date reason', () => {
  assert.deepEqual(describeResearchSyncResult({
    success: false,
    totals: { attempted: 1, succeeded: 0, failed: 1, changedDates: 0, filesCopied: 0, filesSkipped: 0 },
    results: [{ kind: 'cninfo', date: '2026-08-20', success: false, error: '巨潮资讯暂时不可用' }],
  }), {
    level: 'error',
    text: '巨潮资讯暂时不可用',
  });
});

test('describeResearchSyncResult reports fetched and matched direct announcements', () => {
  assert.deepEqual(describeResearchSyncResult({
    success: true,
    totals: { attempted: 1, succeeded: 1, failed: 0, changedDates: 1, filesCopied: 0, filesSkipped: 0 },
    results: [{ kind: 'cninfo', date: '2026-08-20', success: true, source: 'cninfo-direct', fetched: 4021, matched: 18 }],
  }), {
    level: 'success',
    text: '公告已更新：抓取 4,021 条，持仓命中 18 条',
  });
});
```

- [ ] **Step 2: Run the client test and verify RED**

Run: `node --test tests/researchSyncClient.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `researchSyncClient.ts`.

- [ ] **Step 3: Extract the request and implement result descriptions**

Move `ResearchSyncResponse` and `postResearchSync` out of `ResearchPanel.tsx`. Preserve the current POST body. Define a per-result interface containing `kind`, `date`, `success`, `error`, `source`, `fetched`, and `matched`.

`describeResearchSyncResult` must use this precedence:

1. top-level `error` when present;
2. first failed result's `error`;
3. attempted `0` -> `未找到可同步来源`;
4. direct `cninfo` success -> formatted fetched/matched message;
5. partial failure -> `同步完成，但有 N 个日期失败`;
6. existing changed/copied success wording.

- [ ] **Step 4: Update `ResearchPanel` to display the returned level**

Replace its inline request function with imports from `researchSyncClient.ts`. After refetching history/latest, run:

```tsx
const notice = describeResearchSyncResult(result);
if (notice.level === 'error') message.error(notice.text);
else if (notice.level === 'warning') message.warning(notice.text);
else message.success(notice.text);
```

Change the refresh tooltip from `刷新最近 14 天本地产物` to `从官方公告源刷新；本地产物存在时优先导入`.

- [ ] **Step 5: Run Task 4 tests and production type checking**

Run: `node --test tests/researchSyncClient.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: TypeScript and Vite production build PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/pages/Research/researchSyncClient.ts tests/researchSyncClient.test.ts src/pages/Research/ResearchPanel.tsx
git commit -m "fix: report announcement refresh outcomes accurately"
```

---

### Task 5: Full regression and live recovery verification

**Files:**
- Verify only; expected generated cache: `server/data/research/cninfo/<latest-weekday>.json` (gitignored).

**Interfaces:**
- Consumes: all Tasks 1–4.
- Produces: evidence that tests, build, startup behavior, and one real official synchronization succeed without modifying tracked data.

- [ ] **Step 1: Run all server JavaScript tests**

Run: `node --test server/*.test.js server/api/*.test.js server/lib/*.test.js`

Expected: PASS. If an unrelated pre-existing failure occurs, record its exact test name and verify every announcement-monitor test separately.

- [ ] **Step 2: Run all standalone TypeScript tests**

Run: `node --test tests/*.test.ts`

Expected: PASS.

- [ ] **Step 3: Run static checks**

Run: `npm run lint`

Expected: PASS, or an exact list of unrelated pre-existing lint findings.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Perform one real official-source synchronization**

Run:

```bash
node --input-type=module -e "import('./server/lib/researchSync.js').then(async ({ syncResearch }) => { const result = await syncResearch({ kind: 'cninfo', days: 7 }); console.log(JSON.stringify(result, null, 2)); if (!result.success) process.exitCode = 1; })"
```

Expected: `attempted: 1`, `succeeded: 1`, `source: "cninfo-direct"`, a positive `totalCount`, and a new cached summary under `server/data/research/cninfo/`.

- [ ] **Step 5: Verify the generated contract without editing it**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; const dir="server/data/research/cninfo"; const file=fs.readdirSync(dir).filter((name)=>name.endsWith(".json")).sort().at(-1); const value=JSON.parse(fs.readFileSync(path.join(dir,file))); console.log(JSON.stringify({ file, kind:value.kind, totalCount:value.totalCount, watchlistHits:value.watchlistHits, topGood:value.topGood.length, topBad:value.topBad.length, files:value.files.length }, null, 2)); if (value.kind !== "cninfo" || !(value.totalCount > 0) || !Array.isArray(value.topGood) || !Array.isArray(value.topBad)) process.exitCode=1;'
```

Expected: `kind: "cninfo"`, positive `totalCount`, array-backed good/bad lists, and `files: 0`.

- [ ] **Step 6: Inspect final scope and status**

Run: `git status --short`

Expected: the user's pre-existing unrelated changes remain present; no generated `server/data/research` files are staged; only the planned announcement-monitor commits were added.
