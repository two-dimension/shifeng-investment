# Platform Code Fusion Report

## Sources

- Current AI baseline: `773657818f1c4a13c28d4f71dda7bdc354f4717e`
- Legacy repository HEAD: `9582decbaab4df10af98f03d07c4a3299c926fdb`
- Legacy repository branch: `codex/home-dashboard-redesign`
- Legacy dirty worktree included: yes
- Fusion branch: `codex/recovery-fusion`
- Fusion worktree: `.worktrees/platform-recovery-fusion`

## Result

- AI dashboard: current version preserved byte-for-byte across the protected hash manifest.
- Non-AI frontend and backend: restored from the legacy working tree.
- Quant strategy module and five legacy quant scripts: restored.
- Quant parquet path: made portable with `QUANT_PARQUET_DIR`, falling back to the current user's `~/Downloads/parquet`.
- Shared server entry: legacy quant is enabled directly while current AI, ICE CDS, isolated reports path, root `.env.local` entrypoint, and background-job test guard remain active.
- Shared frontend entries: current versions retained because their only difference from legacy is AI dashboard ordering.
- Calendar tests: use the tracked current-machine funds fixture instead of depending on ignored runtime data.
- Current-only non-AI modules and helpers absent from the legacy baseline were removed as required by the fusion rule.
- `wrangler.toml` and `scripts/cloudflare-tunnel.sh`: current versions retained; Cloudflare behavior was not changed in this phase.

## Verification

- `npm run build`: passed.
- Full Node suite: 246 tests passed, 0 failed.
- Python suite: 27 tests passed, 0 failed in an isolated temporary environment.
- `npm run test:quant`: passed.
- AI-focused suite: 199 tests passed, 0 failed.
- `npm run verify:ai-sources`: passed with 62 sources and 70 ledger records.
- AI hash comparison: identical for all 69 protected files.
- Startup/API smoke coverage: health, root entrypoint, quant overview, AI dashboard, background-job guard, and isolated reports route passed.
- Sensitive/generated-file check: no `.env`, logs, caches, PDFs, spreadsheets, images, or runtime data were added by the fusion commits.

## Lint Exception

`npm run lint` reports 31 errors in 10 restored legacy frontend files. Running the same ESLint version and rules directly against those same 10 files in `/Users/ray_wang/Downloads/shifeng-investment` reports the identical 31 errors. They are legacy React-hook/compiler, fast-refresh, unused-expression, unused-variable, explicit-`any`, and unnecessary-escape findings, not differences introduced by the fusion.

The files are:

- `src/components/Fund/AddFundModal.tsx`
- `src/components/Fund/FundDashboard.tsx`
- `src/components/Fund/MarketTemperature.tsx`
- `src/data/stocks.ts`
- `src/hooks/useNewsFeed.ts`
- `src/hooks/useResearch.ts`
- `src/pages/News/NewsPanel.tsx`
- `src/pages/Portfolio/PortfolioAnomalyPanel.tsx`
- `src/pages/Portfolio/PortfolioPanel.tsx`
- `src/pages/Stock/StockDetailPanel.tsx`

These were not changed merely to silence the linter because the approved rule is to preserve legacy non-AI behavior. They should be handled later as a separate tested cleanup.

## Deferred

- Historical runtime data migration and checksum reconciliation.
- Old Codex task integration from `/Users/ray_wang/Downloads/石锋平台要用的`.
- Cloudflare architecture, storage selection, deployment, and free-tier validation.
- Optional tested cleanup of the 31 inherited legacy lint findings.

The branch remains isolated and has not been merged into `codex/ai-dashboard` or deployed.
