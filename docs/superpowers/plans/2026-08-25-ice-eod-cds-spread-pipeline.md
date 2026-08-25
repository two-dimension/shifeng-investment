# ICE EOD CDS Spread Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mixed screenshot/DTCC CDS series with a single-source ICE EOD Price → model-derived 5Y spread workflow that appends daily history to Excel and updates the AI dashboard.

**Architecture:** A local-only import flow parses ICE table rows and an audited discount curve, selects one canonical 5Y contract per tracked company, converts clean price to par spread with a deterministic CDS model, and commits an Excel archive plus the JSON dashboard snapshot under one batch ID. The public dashboard reads only JSON; Excel remains the downloadable audit archive. No DTCC or screenshot-estimated point may enter the new series.

**Tech Stack:** Node.js ESM, Express 5, React 19, TypeScript, Ant Design, ECharts, ExcelJS 4.4, node:test, local JSON snapshots.

**Spec:** `docs/superpowers/specs/2026-08-25-ice-eod-cds-spread-pipeline-design.md`

## Global Constraints

- Free mode accepts user-supplied ICE table/CSV rows; it does not scrape the ICE public webpage.
- The page label is `ICE EOD Price · ISDA 换算值`; it must never call model-derived values official ICE spreads.
- `validated` requires an official spread benchmark with relative error `<= 1%`, absolute error `<= min(2 bp, officialSpreadBp * 1%)`, and price residual `<= 0.005` price point.
- Without an official spread benchmark, publish only as `model-derived`; price round-trip alone cannot promote a row to `validated`.
- One-day change means the previous valid ICE clearing day; missing references display null, never a mislabeled older point.
- Excel and JSON share one batch ID; partial success must roll both outputs back to the last-good batch.
- Existing unrelated modifications in `server/data/ai-dashboard/snapshot.json`, `server/data/news.json`, `server/lib/newsIntelligence.js`, and `server/lib/newsIntelligence.test.js` must not be overwritten or committed.
- Runtime workbook generation follows the repository's existing `exceljs` dependency; final workbook QA additionally follows the Spreadsheets skill's formula, inspection, error-scan, and visual-render requirements.

---

### Task 1: Cut the production CDS schema over to ICE-derived records

**Files:**
- Modify: `server/lib/aiCdsData.js`
- Modify: `server/lib/aiCdsData.test.js`
- Modify: `server/lib/aiDashboardService.js`
- Modify: `server/lib/aiDashboardService.test.js`
- Modify: `src/pages/AIDashboard/types.ts`
- Modify: `src/pages/AIDashboard/viewModel.ts`

**Interfaces:**
- Produces: normalized `CdsRiskSnapshot` with `sourceKind: "ice_eod_isda"`, `batchId`, `qualityStatus`, `workbookAvailable`, and source-rich history points.
- Removes from production: automatic `createDtccCreditRiskCollector()` registration and `cds-5y.json` overlay.

- [ ] **Step 1: Write failing normalization tests**

Add a test whose input contains:

```js
{
  asOf: '2026-08-24',
  sourceKind: 'ice_eod_isda',
  sourceLabel: 'ICE EOD Price · ISDA 换算值',
  batchId: 'ice-20260824-a1',
  qualityStatus: 'model-derived',
  workbookAvailable: true,
  companies: [{
    company: 'Oracle', latestBp: 207.4, latestEodPrice: 95.24,
    latestInstrumentName: 'ORCL.SNRFOR.USD.XR14.100.2031-06-20',
    qualityStatus: 'model-derived',
    changes: { oneDayBp: 2.1, sevenDayBp: 14.2, oneMonthBp: 6.3 },
    history: [{ date: '2026-08-24', valueBp: 207.4, eodPrice: 95.24,
      instrumentName: 'ORCL.SNRFOR.USD.XR14.100.2031-06-20', qualityStatus: 'model-derived' }],
  }],
}
```

Assert that every field survives normalization and that invalid `eodPrice`, `qualityStatus`, or future/malformed dates are rejected rather than coerced to zero.

- [ ] **Step 2: Write failing service-isolation tests**

Assert that `createAiDashboardServiceFromEnv()` does not register a DTCC collector, does not overlay `cds-5y.json`, and returns an unavailable ICE credit-risk slice when no workbook-backed batch exists. Assert the source message is `等待导入 ICE EOD Price`.

- [ ] **Step 3: Run the focused tests and confirm failure**

Run:

```bash
node --test server/lib/aiCdsData.test.js server/lib/aiDashboardService.test.js
```

Expected: failures for missing ICE fields and legacy DTCC/file overlay behavior.

- [ ] **Step 4: Implement the new normalized shape and isolate legacy sources**

Use these accepted statuses:

```js
const CDS_QUALITY_STATUSES = new Set([
  'validated', 'model-derived', 'needs-review', 'stale', 'unavailable',
]);
```

Update TypeScript interfaces so `CdsHistoryPoint` carries `eodPrice`, `instrumentName`, and `qualityStatus`, while `CdsCompanyMetric` carries `latestEodPrice`, `latestInstrumentName`, and company quality. Preserve nullable change values. Remove default DTCC registration and the `readCdsFile()` overlay path from the environment factory. Leave the legacy modules unchanged but unreferenced by production so this task does not combine source migration with unrelated file deletion.

- [ ] **Step 5: Run focused tests and commit**

Run the same test command; expected PASS. Then commit only the files in this task:

```bash
git add server/lib/aiCdsData.js server/lib/aiCdsData.test.js server/lib/aiDashboardService.js server/lib/aiDashboardService.test.js src/pages/AIDashboard/types.ts src/pages/AIDashboard/viewModel.ts
git commit -m "refactor: isolate ICE-derived CDS records"
```

### Task 2: Parse ICE rows and select canonical 5Y contracts

**Files:**
- Create: `server/lib/iceCdsRegistry.js`
- Create: `server/lib/iceCdsImport.js`
- Create: `server/lib/iceCdsImport.test.js`
- Create: `server/fixtures/ice-cds/icc-single-name-sample.tsv`

**Interfaces:**
- Produces: `parseIceSettlementText(text): IceSettlementRow[]`.
- Produces: `parseIceInstrumentName(value): ParsedIceInstrument`.
- Produces: `selectTrackedFiveYearContracts(rows, clearingDate): { selected, errors }`.
- `selected` rows feed Task 3; `errors` feed preview and validation logs.

- [ ] **Step 1: Add a representative fixture and failing parser tests**

The fixture headers are exactly:

```text
Clearing Date\tName\tInstrument Name\tEOD Price
```

Include Oracle 100 bp 5Y, Oracle wrong-tenor, CoreWeave 500 bp 5Y, NVIDIA 100 bp 5Y, a duplicate, and an untracked issuer. Tests must assert typed dates/numbers, duplicate detection, and this parsed shape:

```js
{
  symbol: 'ORCL', tier: 'SNRFOR', currency: 'USD', restructuring: 'XR14',
  couponBp: 100, maturityDate: '2031-06-20',
}
```

- [ ] **Step 2: Add failing contract-selection tests**

Assert all seven registry companies exist: Oracle, CoreWeave, NVIDIA, Amazon, Google (mapped from Alphabet), Microsoft, and Meta. Assert investment-grade names select 100 bp, CoreWeave selects 500 bp, maturity falls between 4.5 and 5.5 years from clearing date, and ambiguous or missing candidates produce explicit errors instead of a best guess.

- [ ] **Step 3: Run the focused test and confirm failure**

```bash
node --test server/lib/iceCdsImport.test.js
```

Expected: module-not-found failure.

- [ ] **Step 4: Implement registry, delimiter-safe parsing, and deterministic selection**

Export registry rows with this stable contract:

```js
{
  company: 'Oracle', aliases: ['ORACLE CORP', 'ORACLE CORPORATION'],
  currency: 'USD', tier: 'SNRFOR', restructuring: 'XR14', couponBp: 100,
}
```

Normalize case/whitespace, accept tab or RFC-4180 CSV input, validate real calendar dates, reject non-finite/negative EOD prices, and sort candidates by absolute distance from five years only after all registry constraints match.

- [ ] **Step 5: Run the test and commit**

```bash
node --test server/lib/iceCdsImport.test.js
git add server/lib/iceCdsRegistry.js server/lib/iceCdsImport.js server/lib/iceCdsImport.test.js server/fixtures/ice-cds/icc-single-name-sample.tsv
git commit -m "feat: parse ICE CDS settlement rows"
```

### Task 3: Build the deterministic price-to-spread engine

**Files:**
- Create: `server/lib/isdaCdsSpread.js`
- Create: `server/lib/isdaCdsSpread.test.js`
- Create: `server/fixtures/ice-cds/usd-sofr-curve-sample.json`

**Interfaces:**
- Consumes: one selected contract from Task 2 plus a `DiscountCurve`.
- Produces: `cleanPriceToParSpread(input): CdsPricingResult`.
- Produces: `parSpreadToCleanPrice(input): number` for round-trip QA.

- [ ] **Step 1: Write failing curve and pricing invariant tests**

Use a fixed curve:

```js
{
  curveId: 'usd-sofr-2026-08-24-test', asOf: '2026-08-24', currency: 'USD',
  nodes: [
    { years: 0.25, zeroRate: 0.041 }, { years: 1, zeroRate: 0.039 },
    { years: 3, zeroRate: 0.037 }, { years: 5, zeroRate: 0.036 },
    { years: 10, zeroRate: 0.038 },
  ],
}
```

Assert: nodes must be unique and ascending; price `100` with coupon `100 bp` returns `100 bp` within `0.01 bp`; price below 100 produces spread above coupon; price above 100 produces spread below coupon; converting a synthetic `207 bp` to price and back returns within `0.01 bp`; malformed curves and solver non-convergence throw typed validation errors.

- [ ] **Step 2: Run the test and confirm failure**

```bash
node --test server/lib/isdaCdsSpread.test.js
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement dates, cash flows, interpolation, and root solving**

Implement step-in date T+1, cash-settlement date T+3, quarterly IMM premium dates, modified-following weekend adjustment, ACT/360 premium accrual, accrued-on-default using the half-period approximation, continuously compounded zero-rate interpolation, survival `exp(-hazard * t)`, protection-leg PV, risky annuity, and bisection on hazard. Convert ICE clean price to upfront with:

```js
const upfrontFraction = (100 - cleanPrice) / 100;
```

Solve:

```text
protectionLegPv - couponRate * riskyAnnuity - upfrontFraction = 0
parSpreadBp = protectionLegPv / riskyAnnuity * 10,000
```

Return `spreadBp`, `roundTripPrice`, `priceResidual`, `hazardRate`, `curveId`, `recoveryRate`, and `modelVersion: "ice-isda-compatible-v1"`. This result is always `model-derived` unless Task 5 also receives an official spread benchmark.

- [ ] **Step 4: Run tests, record model limitations, and commit**

Add JSDoc stating this is an ISDA-compatible estimator, not the licensed ICE calculation. Run:

```bash
node --test server/lib/isdaCdsSpread.test.js
git add server/lib/isdaCdsSpread.js server/lib/isdaCdsSpread.test.js server/fixtures/ice-cds/usd-sofr-curve-sample.json
git commit -m "feat: estimate CDS spreads from EOD prices"
```

### Task 4: Generate and read the seven-sheet Excel archive

**Files:**
- Create: `server/lib/iceCdsWorkbook.js`
- Create: `server/lib/iceCdsWorkbook.test.js`

**Interfaces:**
- Consumes: `IceCdsArchiveState` containing raw rows, derived rows, curves, registry, and logs.
- Produces: `buildIceCdsWorkbook(state): Promise<Buffer>`.
- Produces: `readIceCdsWorkbook(buffer): Promise<IceCdsArchiveState>`.

- [ ] **Step 1: Write failing workbook structure tests**

Build a two-day, two-company state and assert these sheets exist exactly: `Raw EOD Prices`, `Derived 5Y Spreads`, `Daily Dashboard`, `Discount Curves`, `Contract Registry`, `Validation Log`, `Methodology`. Re-open the buffer and assert dates/numbers remain typed, URLs survive, batch IDs match, header filters/frozen rows exist, and Daily Dashboard change cells contain formulas with cached numeric results.

- [ ] **Step 2: Write failing workbook consistency tests**

Assert a duplicate derived unique key is rejected. Assert `readIceCdsWorkbook(buildIceCdsWorkbook(state))` preserves raw/derived counts and key values. Scan formula strings for `#REF!`, `#DIV/0!`, `#VALUE!`, and `#NAME?`.

- [ ] **Step 3: Run the focused tests and confirm failure**

```bash
node --test server/lib/iceCdsWorkbook.test.js
```

Expected: module-not-found failure.

- [ ] **Step 4: Implement the workbook with existing ExcelJS runtime support**

Use reusable helpers for title/header/body/source-link styles, fixed widths, wrapped headers, filters, frozen panes, `yyyy-mm-dd`, `0.0000`, `0.00`, and `0.00%` formats. Formula cells use both formula and result:

```js
cell.value = { formula: formulaText, result: computedValue };
```

Set `workbook.calcProperties.fullCalcOnLoad = true`. Put methodology URLs in cells and short model/input explanations in comments. Keep all seven sheets legible without hidden calculation columns.

- [ ] **Step 5: Run the test and commit**

```bash
node --test server/lib/iceCdsWorkbook.test.js
git add server/lib/iceCdsWorkbook.js server/lib/iceCdsWorkbook.test.js
git commit -m "feat: archive ICE CDS history in Excel"
```

### Task 5: Coordinate preview, import, changes, validation, and atomic batch commit

**Files:**
- Create: `server/lib/iceCdsPipeline.js`
- Create: `server/lib/iceCdsPipeline.test.js`
- Create: `server/data/ai-dashboard/ice-cds/.gitkeep`

**Interfaces:**
- Consumes: `{ iceText, discountCurve, officialSpreads? }`.
- Produces: `preview(input): IceCdsPreview` without writes.
- Produces: `import(input): Promise<{ snapshot, batchId, workbookPath }>`.
- Produces: `status(): Promise<IceCdsImportStatus>` and `exportWorkbook(): Promise<Buffer>`.
- Produces: `createIceCdsPipelineFromEnv(options?): IceCdsPipeline` for server wiring in Task 6.

- [ ] **Step 1: Write failing preview and calculation tests**

Assert preview returns seven selected contracts, derived spreads, warnings, quality status, and no filesystem changes. With no official benchmark, every accepted row is `model-derived`. With an official benchmark, only rows meeting all three thresholds become `validated`; failures become `needs-review` and are not published.

- [ ] **Step 2: Write failing change-period tests**

For dates Friday, Monday, the prior Monday, and the prior-month anchor, assert one-day uses Friday for Monday, seven-day/month use the latest valid clearing day at or before the target, and missing anchors return null. Assert values are absolute bp differences, not percentages.

- [ ] **Step 3: Write failing atomicity and idempotency tests**

In a temporary directory, assert repeated identical import keeps one unique row, a corrected row creates a revision log, Excel and JSON contain the same batch ID, and an injected Excel/JSON rename failure restores both last-good files. Assert 30 current backups remain in `backups/` and older ones move to `archive/`.

- [ ] **Step 4: Run the focused test and confirm failure**

```bash
node --test server/lib/iceCdsPipeline.test.js
```

Expected: module-not-found failure.

- [ ] **Step 5: Implement the pipeline and atomic commit protocol**

Stage files as explicit paths inside `server/data/ai-dashboard/ice-cds/`:

```text
ice-cds-history.<batchId>.tmp.xlsx
snapshot.<batchId>.tmp.json
```

Validate both staged outputs, move current files to last-good names, rename both staged files, and restore last-good on either failure. Update only `sources.creditRisk` and `creditRisk.cds5y` in the snapshot loaded at commit time so unrelated dashboard slices are preserved.

- [ ] **Step 6: Run the test and commit**

```bash
node --test server/lib/iceCdsPipeline.test.js
git add server/lib/iceCdsPipeline.js server/lib/iceCdsPipeline.test.js server/data/ai-dashboard/ice-cds/.gitkeep
git commit -m "feat: commit daily ICE CDS batches atomically"
```

### Task 6: Expose local import, status, and Excel download APIs

**Files:**
- Modify: `server/api/ai_dashboard.js`
- Modify: `server/api/ai_dashboard.test.js`
- Modify: `server/lib/aiDashboardService.js`
- Modify: `server/index.js`

**Interfaces:**
- Consumes: `cdsPipeline` from Task 5 injected into `createAiDashboardRouter()`.
- Produces: preview, import, status, and Excel download endpoints from the spec.

- [ ] **Step 1: Write failing API tests**

Test:

```text
POST /api/ai-dashboard/cds/import/preview
POST /api/ai-dashboard/cds/import
GET  /api/ai-dashboard/cds/import-status
GET  /api/ai-dashboard/cds/export.xlsx
```

Assert JSON body accepts `iceText`, `discountCurve`, and optional `officialSpreads`; unknown fields and payloads over the configured limit return 400/413; import recomputes rather than trusting preview values; export returns the XLSX MIME type and `attachment; filename="ice-cds-history.xlsx"`.

- [ ] **Step 2: Add failing write-boundary tests**

Assert preview/import accept loopback clients and reject non-loopback clients with 403 while the read-only export remains available wherever the dashboard is readable. Inject client-address resolution in tests instead of depending on the host network.

- [ ] **Step 3: Run API tests and confirm failure**

```bash
node --test server/api/ai_dashboard.test.js
```

Expected: 404 responses for new routes.

- [ ] **Step 4: Implement routes and environment wiring**

Add `cdsPipeline`, `isLocalWriter(req)`, and route handlers. The browser reads selected CSV files as text and posts JSON, so no multipart parser is added; reject ICE text over 1 MiB, curve inputs over 10,000 nodes, and unknown top-level fields before calling the pipeline. In `server/index.js`, call `createIceCdsPipelineFromEnv()` separately from `createAiDashboardServiceFromEnv()` and inject both objects into `createAiDashboardRouter({ service, cdsPipeline })`. Do not change the existing dashboard-service return type and do not re-enable CDS access codes.

- [ ] **Step 5: Run API tests and commit**

```bash
node --test server/api/ai_dashboard.test.js server/lib/aiDashboardService.test.js
git add server/api/ai_dashboard.js server/api/ai_dashboard.test.js server/lib/aiDashboardService.js server/index.js
git commit -m "feat: add ICE CDS import and Excel APIs"
```

### Task 7: Add the import/download workflow and correct CDS labels to the UI

**Files:**
- Create: `src/pages/AIDashboard/IceCdsImportModal.tsx`
- Modify: `src/pages/AIDashboard/AIDashboardPanel.tsx`
- Modify: `src/pages/AIDashboard/AIDashboardSections.tsx`
- Modify: `src/pages/AIDashboard/AIDashboardPanel.css`
- Modify: `src/pages/AIDashboard/types.ts`
- Modify: `src/pages/AIDashboard/viewModel.ts`

**Interfaces:**
- Consumes: Task 6 endpoints and normalized types from Task 1.
- Produces: local import modal, preview table, import result, Excel download, and source-accurate CDS cards/charts.

- [ ] **Step 1: Add typed request/response models and modal state**

Define `IceCdsPreview`, `IceCdsImportStatus`, `IceCdsPreviewRow`, and `DiscountCurveInput`. The modal contains two file/text inputs: ICE rows and discount-curve CSV/JSON. File selection uses `File.text()` and sends text/typed nodes to preview; no browser-side financial calculation is allowed.

- [ ] **Step 2: Implement preview-before-write interaction**

The first action calls preview and shows company, contract, EOD Price, estimated spread, residual, and status. Disable confirmation while any company has a blocking error. Confirmation calls import with the original inputs, closes on success, reloads the dashboard, and displays the committed batch ID.

- [ ] **Step 3: Correct labels, tooltip provenance, and download behavior**

Replace `DTCC CDS` with `5Y CDS`. The chart subtitle is exactly `ICE EOD Price · ISDA 换算值`. Tooltip shows EOD Price, instrument, spread, quality status, and source date. Add `下载 Excel` using a normal link to `/api/ai-dashboard/cds/export.xlsx`. Show `导入 ICE 当日数据` only when import status says local writes are allowed.

- [ ] **Step 4: Cover empty, stale, review, and validated states visually**

No imported ICE batch shows `等待导入 ICE EOD Price`, not legacy values. Use distinct tags for `模型换算值`, `已通过官方基准验证`, `待复核`, and `数据过期`. Preserve the screenshot's three-column summary cards and two-column charts on desktop, with single-column mobile stacking.

- [ ] **Step 5: Run lint/build and commit**

```bash
npm run lint
npm run build
git add src/pages/AIDashboard/IceCdsImportModal.tsx src/pages/AIDashboard/AIDashboardPanel.tsx src/pages/AIDashboard/AIDashboardSections.tsx src/pages/AIDashboard/AIDashboardPanel.css src/pages/AIDashboard/types.ts src/pages/AIDashboard/viewModel.ts
git commit -m "feat: add ICE CDS daily import workflow"
```

### Task 8: Initialize, verify, and visually inspect the workbook and dashboard

**Files:**
- Create: `server/scripts/init_ice_cds_workbook.mjs`
- Create: `server/scripts/verify_ice_cds_workbook.mjs`
- Modify: `package.json`
- Create at runtime: `server/data/ai-dashboard/ice-cds/ice-cds-history.xlsx`

**Interfaces:**
- Consumes: workbook builder and registry from Tasks 2/4.
- Produces: an auditable initial workbook, repeatable verification command, and final acceptance evidence.

- [ ] **Step 1: Add initialization and verification scripts**

`init_ice_cds_workbook.mjs` creates a workbook with populated Contract Registry and Methodology sheets and empty typed data tables; it never seeds screenshot or DTCC values. `verify_ice_cds_workbook.mjs` reopens the file, checks seven sheet names, required headers, unique keys, batch consistency, formula errors, and JSON/workbook value equality.

- [ ] **Step 2: Add package scripts and run the focused suite**

Add:

```json
{
  "init:ice-cds-workbook": "node server/scripts/init_ice_cds_workbook.mjs",
  "verify:ice-cds-workbook": "node server/scripts/verify_ice_cds_workbook.mjs"
}
```

Run:

```bash
npm run init:ice-cds-workbook
npm run verify:ice-cds-workbook
node --test server/lib/aiCdsData.test.js server/lib/iceCdsImport.test.js server/lib/isdaCdsSpread.test.js server/lib/iceCdsWorkbook.test.js server/lib/iceCdsPipeline.test.js server/api/ai_dashboard.test.js server/lib/aiDashboardService.test.js
```

- [ ] **Step 3: Run full repository verification**

```bash
node --test server/**/*.test.js
npm run lint
npm run build
```

Expected: all tests pass, lint exits zero, and Vite production build succeeds.

- [ ] **Step 4: Perform spreadsheet-specific inspection and rendering**

Use the bundled Spreadsheets runtime to import the generated workbook, inspect key ranges on all seven sheets, scan for `#REF!|#DIV/0!|#VALUE!|#NAME?|#N/A`, and render every sheet at readable scale. Fix clipped headers, excessive widths, formula errors, or broken source links, then rerun verification. Do not substitute a different workbook library for this final QA.

- [ ] **Step 5: Perform browser verification**

Start the server and Vite app, open `/ai-dashboard`, select `融资与债务`, and verify desktop/mobile plus light/dark modes. Confirm there are no DTCC or `ICE ICC（用户截图）` labels, no legacy points, preview is read-only, import updates the displayed batch, and Excel download opens the same values shown on the page.

- [ ] **Step 6: Commit verification tooling without committing unrelated data changes**

```bash
git add package.json server/scripts/init_ice_cds_workbook.mjs server/scripts/verify_ice_cds_workbook.mjs server/data/ai-dashboard/ice-cds/ice-cds-history.xlsx
git commit -m "test: verify ICE CDS workbook and dashboard"
```

Before committing, run `git status --short` and explicitly exclude the pre-existing unrelated news and snapshot files listed in Global Constraints.

### Task 9: Final review and handoff

**Files:**
- Review: all files committed by Tasks 1-8
- Update only if needed: `docs/superpowers/specs/2026-08-25-ice-eod-cds-spread-pipeline-design.md`

**Interfaces:**
- Produces: a reviewable branch with truthful source labels, a working local import flow, a downloadable Excel archive, and no regressions.

- [ ] **Step 1: Compare the implementation against every spec section**

Check source/input mode, 1% definition, contract selection, model inputs, Excel sheets, atomicity, change periods, APIs, states, tests, and phased limitations. Record no requirement as complete unless exercised by a test or manual verification.

- [ ] **Step 2: Run the final clean verification commands**

```bash
npm run verify:ice-cds-workbook
node --test server/**/*.test.js
npm run lint
npm run build
git status --short --branch
```

- [ ] **Step 3: Request code review before merge**

Use `superpowers:requesting-code-review` against the complete branch diff. Resolve validated findings, rerun affected tests, and keep unrelated user changes untouched.

- [ ] **Step 4: Prepare the final handoff**

Report the workbook path, import steps, source/quality labeling, exact tests run, and the limitation that free EOD Price conversion is `model-derived` until compared with an official spread benchmark.
