# 公告监控云端自动化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把网站外壳和四类公告监控部署到 Cloudflare，并由 GitHub Actions 在电脑关机时继续抓取、生成、缓存和发布。

**Architecture:** Cloudflare Worker 同源托管 Vite 静态文件和 `/api/research/*`，D1 保存摘要与刷新状态，R2 保存报告；其他 `/api/*` 可选转发到独立的本机 Tunnel 源站。GitHub Actions 顺序运行四套恢复任务，通过鉴权发布接口写入 Worker，页面采用“先读缓存、过期才触发、成功后重载”。

**Tech Stack:** React 19、TypeScript 6、Cloudflare Workers、D1、R2、Wrangler 4.127.0、Vitest 4.1.11、Cloudflare Vitest Pool 0.22.0、GitHub Actions、Node 24、Python 3.12。

**Spec:** `docs/superpowers/specs/2026-08-28-cloud-research-automation-design.md`

## Global Constraints

- 新 Worker 使用 `compatibility_date: "2026-08-28"` 和 `nodejs_compat`。
- Worker 必须由 `wrangler types` 生成 `Env`，不得手写绑定类型。
- 公告栏目固定为 `cninfo`、`earnings`、`earnings-report`、`risk`。
- 缓存新鲜期固定为 6 小时；活动任务锁超时固定为 45 分钟。
- 公开接口只读；内部发布接口必须校验 `RESEARCH_PUBLISH_TOKEN`。
- GitHub dispatch token 和发布 token 不得写入源码、配置、命令参数或日志。
- 更新失败只能更新任务状态，不得删除或覆盖最后一次成功摘要。
- 非公告 API 未云化：有 `LEGACY_API_ORIGIN` 时转发，未配置或离线时返回结构化 `503`。
- Python 依赖固定为 `requests==2.32.5`、`pypdf==6.16.2`、`openpyxl==3.1.5`、`reportlab==5.0.1`、`pdfplumber==0.11.10`、`pytest==8.4.2`。
- 每个实现任务严格执行“失败测试 → 最小实现 → 通过测试 → 提交”。

---

### Task 1: Cloudflare 配置、测试环境与 D1 表结构

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Delete: `wrangler.toml`
- Create: `wrangler.jsonc`
- Create: `tsconfig.worker.json`
- Create: `vitest.config.ts`
- Modify: `.gitignore`
- Create: `.dev.vars.example`
- Create: `worker/migrations/0001_research.sql`
- Generate: `worker-configuration.d.ts`

**Interfaces:**
- Produces: generated global `Env` with `ASSETS: Fetcher`, `RESEARCH_DB: D1Database`, `RESEARCH_REPORTS: R2Bucket`, `GITHUB_DISPATCH_TOKEN: string`, `RESEARCH_PUBLISH_TOKEN: string`, `GITHUB_OWNER: string`, `GITHUB_REPO: string`, `LEGACY_API_ORIGIN: string`. Secret names are inferred from committed fake values in `.dev.vars.example`; real values remain Worker secrets.
- Produces: D1 tables `research_summaries` and `research_refresh_state`.

- [x] **Step 1: Install exact Worker development dependencies**

Run:

```bash
npm install --save-dev wrangler@4.127.0 @cloudflare/vitest-pool-workers@0.22.0 vitest@4.1.11
```

Expected: `package-lock.json` records those versions and `npm ls` exits 0.

- [x] **Step 2: Create the real Cloudflare resources and config**

Run `npx wrangler whoami`, then:

```bash
npx wrangler d1 create shifeng-research
npx wrangler r2 bucket create shifeng-research-reports
```

Write the returned D1 UUID directly into `wrangler.jsonc`; never invent or commit a dummy UUID. Configure `main: "worker/index.ts"`, SPA assets from `./dist`, `run_worker_first: ["/api/*"]`, D1/R2 bindings, `GITHUB_OWNER: "raywang99131"`, `GITHUB_REPO: "shifeng-investment"`, empty `LEGACY_API_ORIGIN`, local dev port 8788, and observability sampling 1.0. Add `.dev.vars*` to `.gitignore`, re-include `.dev.vars.example`, and give the example file only fake local tokens.

- [x] **Step 3: Add the D1 migration**

Use the exact schema from the spec and seed the singleton state atomically:

```sql
INSERT OR IGNORE INTO research_refresh_state (scope, status)
VALUES ('all', 'idle');
```

Add package scripts `cf:typegen`, `test:worker`, `cf:migrate:local`, `cf:migrate:remote`, and `deploy:cloud`; `cf:typegen` runs `wrangler types --env-file .dev.vars.example --strict-vars false`.

- [x] **Step 4: Validate the configuration through Wrangler**

Run:

```bash
npm run cf:typegen
npx wrangler types --check --env-file .dev.vars.example --strict-vars false
npm run cf:migrate:local
npx wrangler deploy --dry-run --outdir /tmp/shifeng-worker-dry-run
```

Expected: generated types contain all bindings, the type freshness check exits 0, the migration applies once, and Wrangler's real config/schema/bundle validation succeeds. Task 1 is configuration/generated-code scaffolding, the explicit TDD exception; behavioral tests begin before the first Worker production function in Task 2.

- [x] **Step 5: Commit**

```bash
git add package.json package-lock.json wrangler.jsonc tsconfig.worker.json vitest.config.ts worker worker-configuration.d.ts .gitignore .dev.vars.example
git rm wrangler.toml
git commit -m "build: configure cloud research worker"
```

### Task 2: D1 摘要存储和公开读取接口

**Files:**
- Create: `worker/research-contract.ts`
- Create: `worker/research-store.ts`
- Create: `worker/research-store.test.ts`

**Interfaces:**
- Produces: `RESEARCH_KINDS`, `isResearchKind(value): value is ResearchKind`, `isDateKey(value): boolean`.
- Produces: `getLatestSummary(db, kind)`, `getSummary(db, kind, date)`, `listSummaryDates(db, kind)`, `putSummary(db, input)`.
- `putSummary` consumes `{ kind, date, summary }` and forces `summary.kind`/`summary.date` to validated path values.

- [x] **Step 1: Write failing D1 tests**

Using `cloudflare:test` `env.RESEARCH_DB`, cover:

```ts
await putSummary(env.RESEARCH_DB, { kind: 'cninfo', date: '2026-08-28', summary });
expect(await getLatestSummary(env.RESEARCH_DB, 'cninfo')).toMatchObject({ date: '2026-08-28' });
expect(await listSummaryDates(env.RESEARCH_DB, 'cninfo')).toEqual(['2026-08-28']);
```

Also assert an older date sorts second, malformed JSON rows return a controlled error, and invalid kinds/dates are rejected before SQL.

- [x] **Step 2: Run tests to verify failure**

Run: `npm run test:worker -- worker/research-store.test.ts`

Expected: FAIL because the contract and store functions are missing.

- [x] **Step 3: Implement prepared-statement storage**

Use bound prepared statements only. `putSummary` writes `generated_at`, numeric `total_count`, and `JSON.stringify(summary)` with `ON CONFLICT(kind,date) DO UPDATE`; reads parse `summary_json` and never expose SQL metadata.

- [x] **Step 4: Run tests and typecheck**

Run:

```bash
npm run test:worker -- worker/research-store.test.ts
npx tsc -p tsconfig.worker.json --noEmit
```

Expected: PASS with no `any` or double casts.

- [x] **Step 5: Commit**

```bash
git add worker/research-contract.ts worker/research-store.ts worker/research-store.test.ts
git commit -m "feat: add D1 research summary store"
```

### Task 3: R2 文件下载与鉴权发布接口

**Files:**
- Create: `worker/auth.ts`
- Create: `worker/research-files.ts`
- Create: `worker/research-publish.ts`
- Create: `worker/research-publish.test.ts`

**Interfaces:**
- Produces: `authorizeBearer(request, expected): Promise<boolean>` using fixed-length SHA-256 digests and timing-safe comparison.
- Produces: `researchObjectKey(kind, date, filename): string`.
- Produces internal routes:
  - `PUT /api/research/internal/summaries/:kind/:date`
  - `PUT /api/research/internal/files/:kind/:date/:filename`
- Produces public route: `GET /api/research/files/:kind/:date/:filename`.

- [x] **Step 1: Write failing auth, validation, D1 and R2 tests**

Tests must assert `401` without/wrong token, `400` for invalid kind/date/filename, `413` above the configured upload limit, successful summary upsert, successful R2 stream upload, and byte-identical download with `Content-Disposition`.

Example:

```ts
const response = await SELF.fetch('https://example.com/api/research/internal/files/cninfo/2026-08-28/report.pdf', {
  method: 'PUT',
  headers: { Authorization: 'Bearer test-publish-token', 'Content-Type': 'application/pdf' },
  body: pdfBytes,
});
expect(response.status).toBe(201);
```

- [x] **Step 2: Run tests to verify failure**

Run: `npm run test:worker -- worker/research-publish.test.ts`

Expected: FAIL because routes/helpers are missing.

- [x] **Step 3: Implement minimal streaming publish/download**

Do not buffer report files. Send `request.body` directly to `env.RESEARCH_REPORTS.put()` with `httpMetadata` and custom metadata `{ kind, date, filename }`; stream `R2ObjectBody.body` back to the client. Limit summary JSON to 1 MiB and report uploads to 20 MiB using `Content-Length` plus R2 streaming.

- [x] **Step 4: Run tests and typecheck**

Run: `npm run test:worker -- worker/research-publish.test.ts && npx tsc -p tsconfig.worker.json --noEmit`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add worker/auth.ts worker/research-files.ts worker/research-publish.ts worker/research-publish.test.ts
git commit -m "feat: publish research data to D1 and R2"
```

### Task 4: 刷新状态、D1 全局锁与 GitHub dispatch

**Files:**
- Create: `worker/research-refresh.ts`
- Create: `worker/research-refresh.test.ts`
- Modify: `worker/research-publish.ts`

**Interfaces:**
- Produces: `getRefreshStatus(db): Promise<RefreshState>`.
- Produces: `requestRefresh(env, ctx, now): Promise<{ dispatched: boolean; state: RefreshState }>`.
- Produces public routes `POST /api/research/refresh`, `GET /api/research/refresh/status`.
- Produces internal route `POST /api/research/internal/refresh-state` with body `{ jobId, status: 'running'|'success'|'failed', error?: string }`.
- `RefreshState` is `{ scope: 'all'; jobId: string | null; status: 'idle'|'queued'|'running'|'success'|'failed'; requestedAt: string | null; startedAt: string | null; finishedAt: string | null; lastSuccessAt: string | null; lastError: string | null }`.

- [x] **Step 1: Write failing state-machine tests**

Cover fresh cache (no fetch), stale cache (one dispatch), two simultaneous requests (one dispatch), queued/running reuse, 45-minute abandoned lock recovery, dispatch HTTP failure, success timestamp, failure retaining summaries, and authenticated internal transitions.

Use a mocked dispatch fetch and assert exact body:

```json
{
  "event_type": "research-refresh",
  "client_payload": { "job_id": "7ce179d8-014f-4a79-bf2d-3a99933071c1" }
}
```

- [x] **Step 2: Run tests to verify failure**

Run: `npm run test:worker -- worker/research-refresh.test.ts`

Expected: FAIL because `requestRefresh` is missing.

- [x] **Step 3: Implement the atomic lock and dispatch**

Claim the lock with one conditional D1 `UPDATE` whose `WHERE` rejects fresh data and active locks; only the request with `meta.changes === 1` dispatches. Generate IDs with `crypto.randomUUID()`. Await the dispatch in `ctx.waitUntil()` and always write `failed` if GitHub returns non-2xx or throws.

- [x] **Step 4: Run focused and full Worker tests**

Run: `npm run test:worker -- worker/research-refresh.test.ts && npm run test:worker`

Expected: PASS; dispatch mock called exactly once in the concurrency test.

- [x] **Step 5: Commit**

```bash
git add worker/research-refresh.ts worker/research-refresh.test.ts worker/research-publish.ts
git commit -m "feat: dispatch idempotent cloud research refreshes"
```

### Task 5: Worker 路由、静态网站与旧本机 API 降级

**Files:**
- Create: `worker/index.ts`
- Create: `worker/index.test.ts`

**Interfaces:**
- Consumes all research handlers from Tasks 2–4.
- Produces `default satisfies ExportedHandler<Env>`.
- Routing order: research internal/public routes → other `/api/*` legacy proxy/503 → `env.ASSETS.fetch(request)`.

- [x] **Step 1: Write failing end-to-end route tests**

Assert latest/history/date/null/404 contracts, R2 file route precedence, SPA fallback, non-research `503` when `LEGACY_API_ORIGIN` is empty, proxy URL/header/status preservation when configured, and recursive-origin rejection.

- [x] **Step 2: Run tests to verify failure**

Run: `npm run test:worker -- worker/index.test.ts`

Expected: FAIL because the Worker entry does not exist.

- [x] **Step 3: Implement explicit routing and errors**

Return JSON errors with `{ error, code }`; add cache headers only to public GET responses; never use `passThroughOnException`; log structured objects with request ID, route, status and elapsed milliseconds. Legacy proxy must remove hop-by-hop headers and must not forward publishing secrets.

- [x] **Step 4: Verify Worker locally**

Run:

```bash
npm run test:worker
npx tsc -p tsconfig.worker.json --noEmit
npm run build
```

Expected: all Worker tests/typecheck/build PASS.

- [x] **Step 5: Commit**

```bash
git add worker/index.ts worker/index.test.ts
git commit -m "feat: serve research API and site from Cloudflare"
```

### Task 6: 把四套恢复任务变成可移植的仓库源码

**Files:**
- Create: `automation/research-tasks/requirements.txt`
- Create: `automation/research-tasks/cninfo/` selected source, references, watchlist, and tests
- Create: `automation/research-tasks/earnings/` selected source, industry map, and tests
- Create: `automation/research-tasks/earnings-report/` selected source and tests
- Create: `automation/research-tasks/risk/` selected source and tests
- Create: `automation/research-tasks/tests/test_portable_paths.py`
- Modify: `.gitignore`
- Modify: copied `run.py`, report builders, font resolution and cross-task path references

**Interfaces:**
- Each task writes only below its own directory.
- Commands:
  - cninfo example for target `2026-08-28`: `python run.py --date 2026-08-27 --report-date 2026-08-28 --skip-recap`
  - earnings example: `python fetch_cninfo.py 2026-08-28 output/2026-08-28` then `python build_report.py output/2026-08-28/input.json output/2026-08-28`
  - earnings-report example: `python run.py --date 2026-08-28 --no-mail --force`
  - risk example: `python run.py --scan-date 2026-08-28`

- [x] **Step 1: Import only executable source and regression tests**

Copy the current recovered filesystem versions, including dirty fixes and untracked regression tests that are imported by current code. Exact import set:

- cninfo: `analyze.py`, `build_excel.py`, `build_pdf.py`, `fetch.py`, `placement_analysis.py`, `recap.py`, `run.py`, `trading_calendar.py`, `watchlist.csv`, `watchlist.json`, `references/signals_spec.md`, and `tests/test_placement_analysis.py`, `tests/test_placement_integration.py`, `tests/test_week_audit_regressions.py`;
- earnings: `fetch_cninfo.py`, `build_report.py`, `industry_map.py`, `validate_input.py`;
- earnings-report: `build_report.py`, `extract_financials.py`, `fetch_cninfo.py`, `industry_map.py`, `report_types.py`, `run.py`, `validate_input.py`, and all five current `tests/test_*.py` files;
- risk: `analyze.py`, `build_excel.py`, `build_pdf.py`, `fetch.py`, `run.py`, `trading_calendar.py`.

Exclude `.git`, `AGENTS.md`, `SKILL.md`, mail/publish scripts, launchd/cron installers, caches, `tmp`, historical output directories, generated PDF/XLSX, and credentials. Remove the optional local publisher calls from copied cninfo/earnings code and the mail import/path from earnings-report `run.py`.

- [x] **Step 2: Write the failing portability test**

The test recursively scans executable source and asserts none of these strings remain:

```python
FORBIDDEN = ("/Users/rayw", "/Users/ray_wang", "Library/LaunchAgents")
```

It also imports each task from a temporary checkout and verifies output roots resolve under that checkout.

- [x] **Step 3: Run tests to verify failure**

Create ignored `automation/research-tasks/.venv`, install the pinned requirements, then run: `automation/research-tasks/.venv/bin/python -m pytest automation/research-tasks/tests/test_portable_paths.py -q`.

Expected: FAIL on hard-coded giant/risk paths and macOS-only font assumptions.

- [x] **Step 4: Make paths and fonts portable**

Replace absolute paths with `Path(__file__).resolve().parent` and explicit environment overrides. Font lookup order is `RESEARCH_CJK_FONT`, `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`, then existing macOS fonts; report generation fails with a clear message if no CJK font exists.

- [x] **Step 5: Run all imported task tests**

Run:

```bash
automation/research-tasks/.venv/bin/python -m pytest automation/research-tasks -q
automation/research-tasks/.venv/bin/python -m unittest discover -s automation/research-tasks/cninfo/tests -p 'test_*.py' -q
```

Expected: all recovered regression tests and portability tests PASS without reading the Downloads donor directories.

- [x] **Step 6: Commit**

```bash
git add automation/research-tasks .gitignore
git commit -m "feat: vendor portable research automation tasks"
```

### Task 7: 云端四任务运行器、标准化与发布客户端

**Files:**
- Create: `server/scripts/cloud_research_runner.mjs`
- Create: `server/scripts/cloud_research_runner.test.js`
- Create: `server/scripts/publish_cloud_research.mjs`
- Create: `server/scripts/publish_cloud_research.test.js`
- Modify: `package.json`

**Interfaces:**
- `resolveResearchRunPlan(targetDate, root)` returns four ordered commands and output roots.
- Runner imports `syncResearch` only after setting `SHIFENG_TASKS_DIR`, `RESEARCH_DATA_DIR`, and `RESEARCH_REPORTS_DIR` to its temporary workspace.
- `isPublishableResearchSummary(summary)` returns true only when totals or one of the detail lists contains usable data.
- Runner writes `cloud-research-manifest.json` with `{ jobId, generatedAt, summaries[], files[] }`.
- Publisher consumes that manifest plus `CLOUD_RESEARCH_BASE_URL` and `RESEARCH_PUBLISH_TOKEN` from environment.

- [x] **Step 1: Write failing run-plan and manifest tests**

Use temporary fake task scripts. Assert command order, target/previous dates, `--no-mail`, output isolation, one summary per ready kind, report URL rewriting to `/api/research/files/...`, and no donor-directory dependency.

- [x] **Step 2: Run tests to verify failure**

Run: `node --test server/scripts/cloud_research_runner.test.js`

Expected: FAIL because runner exports do not exist.

- [x] **Step 3: Implement the runner**

Spawn commands with argument arrays and inherited stdout; never build a shell string. Abort remaining publication if a task exits nonzero, but keep its logs. Normalize via existing `syncResearch({ kind: 'all', date: targetDate, force: true })`; include only summaries for which the sync result succeeded and `isPublishableResearchSummary(summary)` holds.

- [x] **Step 4: Write failing publisher tests**

Mock `fetch` and assert state sequence `running → files → summaries → success`; on any upload failure assert a final `failed` state call and no `success` call. Assert the token appears only in the Authorization header.

- [x] **Step 5: Implement bounded uploads**

Use `fs.createReadStream()` with Node `fetch` duplex mode for files, `Promise.all` with concurrency 3, retry `429/5xx` three times, and JSON summaries after all file uploads. Mark success only after every required request returns 2xx.

- [x] **Step 6: Run focused tests**

Run:

```bash
node --test server/scripts/cloud_research_runner.test.js server/scripts/publish_cloud_research.test.js
npm run build
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add server/scripts/cloud_research_runner.mjs server/scripts/cloud_research_runner.test.js server/scripts/publish_cloud_research.mjs server/scripts/publish_cloud_research.test.js package.json
git commit -m "feat: run and publish cloud research jobs"
```

### Task 8: GitHub Actions 定时、手动与 Worker 触发工作流

**Files:**
- Create: `.github/workflows/cloud-research.yml`
- Create: `server/scripts/validate_cloud_research_workflow.test.js`

**Interfaces:**
- Triggers: `repository_dispatch` type `research-refresh`, `workflow_dispatch`, weekday cron `35 14 * * 1-5` (Asia/Shanghai 22:35).
- Concurrency group: `cloud-research-all`, `cancel-in-progress: false`.
- Secrets: `CLOUD_RESEARCH_BASE_URL`, `RESEARCH_PUBLISH_TOKEN`.

- [x] **Step 1: Write the failing workflow contract test**

Parse YAML and assert exact triggers, concurrency, `ubuntu-latest`, Node 24, Python 3.12, pip cache, Noto CJK font installation, dependency install, runner command, publisher command, and `if: always()` failure reporting path.

- [x] **Step 2: Run test to verify failure**

Run: `node --test server/scripts/validate_cloud_research_workflow.test.js`

Expected: FAIL because the workflow is missing.

- [x] **Step 3: Implement the workflow**

Resolve `JOB_ID` from `github.event.client_payload.job_id || github.run_id`; resolve target date inside Node using `Asia/Shanghai`; install `fonts-noto-cjk`; run all scripts without echoing environment values. Grant only `contents: read` to the Action itself. On `if: failure()`, call `node server/scripts/publish_cloud_research.mjs --mark-failed` so a runner failure cannot leave the D1 state locked.

- [x] **Step 4: Validate workflow and local script contracts**

Run:

```bash
node --test server/scripts/validate_cloud_research_workflow.test.js server/scripts/cloud_research_runner.test.js server/scripts/publish_cloud_research.test.js
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add .github/workflows/cloud-research.yml server/scripts/validate_cloud_research_workflow.test.js
git commit -m "ci: automate cloud research refreshes"
```

### Task 9: 公告页面缓存优先、自动检查与状态展示

**Files:**
- Modify: `src/hooks/useResearch.ts`
- Modify: `src/pages/Research/ResearchPanel.tsx`
- Modify: `src/pages/Research/ResearchPanel.css`
- Modify: `src/types/research.ts`
- Create: `src/hooks/researchRefresh.ts`
- Create: `tests/researchRefresh.test.ts`

**Interfaces:**
- Produces `ResearchRefreshState` matching the Worker status.
- Produces `requestResearchRefresh(fetcher)` and `pollResearchRefresh(fetcher, options)` pure helpers.
- UI mounts cached latest/history first, requests refresh once, polls every 4 seconds only while queued/running, then refetches current kind.

- [x] **Step 1: Write failing pure-helper tests**

Cover fresh, queued, running→success, running→failed, timeout, abort, malformed responses, and ensure failed refresh never clears existing summary data.

- [x] **Step 2: Run tests to verify failure**

Run: `node --test tests/researchRefresh.test.ts`

Expected: FAIL because helpers do not exist.

- [x] **Step 3: Implement refresh helpers and types**

Use injected `fetcher`, `AbortSignal`, 4-second poll delay, and a 50-minute client deadline. Return state; do not throw away cached research data on refresh failure.

- [x] **Step 4: Replace local sync UI with cloud refresh UI**

Change tooltip from “刷新最近 14 天本地产物” to “检查云端更新”。On mount call once; manual button uses the same function. Show `云端更新中` for queued/running, success toast then refetch, and a warning with the last-good content still mounted on failure.

- [x] **Step 5: Run tests and build**

Run:

```bash
node --test tests/researchRefresh.test.ts
npm run build
```

Expected: PASS; no TypeScript error and cached detail remains rendered during refresh.

- [x] **Step 6: Commit**

```bash
git add src/hooks/useResearch.ts src/hooks/researchRefresh.ts src/pages/Research/ResearchPanel.tsx src/pages/Research/ResearchPanel.css src/types/research.ts tests/researchRefresh.test.ts
git commit -m "feat: refresh research cache from the cloud"
```

### Task 10: 历史数据迁移、部署说明与端到端验收

**Files:**
- Create: `server/scripts/migrate_research_history.mjs`
- Create: `server/scripts/migrate_research_history.test.js`
- Create: `docs/cloud-research-deployment.md`
- Modify: `README.md`

**Interfaces:**
- Migration consumes `RESEARCH_DATA_DIR`, `RESEARCH_REPORTS_DIR`, `CLOUD_RESEARCH_BASE_URL`, `RESEARCH_PUBLISH_TOKEN`.
- Migration is resumable and idempotent; deterministic order is kind → date → filename.
- Deployment doc includes D1 migration, R2, Worker/GitHub secrets, optional legacy Tunnel origin, deploy, history migration, workflow merge, smoke test and rollback.

- [x] **Step 1: Write failing migration tests**

Use a temporary fixture with two summaries and three files. Assert deterministic manifest, URL rewrite, skip/resume after one uploaded file, invalid JSON rejection, missing file warning, and no token in logs.

- [x] **Step 2: Run tests to verify failure**

Run: `node --test server/scripts/migrate_research_history.test.js`

Expected: FAIL because migration functions are missing.

- [x] **Step 3: Implement resumable history upload**

Reuse the Task 7 publisher primitives. Keep a local ignored checkpoint containing uploaded object keys and summary keys; re-running skips completed uploads and safely upserts summaries.

- [x] **Step 4: Write exact deployment and rollback steps**

Document:

```bash
npm run cf:migrate:remote
npx wrangler secret put GITHUB_DISPATCH_TOKEN
npx wrangler secret put RESEARCH_PUBLISH_TOKEN
npm run deploy:cloud
node server/scripts/migrate_research_history.mjs
```

GitHub repository secrets must be created through repository Settings. The workflow must reach default branch before Worker dispatch is enabled. For rollback, restore the main DNS hostname to the existing named Tunnel; do not delete D1/R2 data.

- [x] **Step 5: Run the complete local verification suite**

Run:

```bash
npm run test:worker
node --test --test-reporter=dot server/startup.test.js server/api/*.test.js server/lib/*.test.js server/scripts/*.test.js tests/*.test.ts
automation/research-tasks/.venv/bin/python -m pytest automation/research-tasks -q
python3 -m unittest discover -s tests -p 'test_*.py' -q
npx tsc -p tsconfig.worker.json --noEmit
npm run build
git diff --check
```

Expected: all tests PASS and production build completes with only the pre-existing chunk-size warning.

- [ ] **Step 6: Run controlled cloud smoke tests after authorization**

Apply the remote migration, deploy Worker, upload one historical date per kind, then verify:

Set the task-specific `SHIFENG_CLOUD_HOST` environment variable to the exact HTTPS hostname printed by Wrangler, then run:

```bash
curl -fsS "${SHIFENG_CLOUD_HOST}/api/research/cninfo/latest"
curl -fsS -X POST "${SHIFENG_CLOUD_HOST}/api/research/refresh"
curl -fsS "${SHIFENG_CLOUD_HOST}/api/research/refresh/status"
```

Use the actual hostname printed by Wrangler in all three commands. Verify one GitHub Action starts, a repeated POST does not start another, and the page remains populated if a controlled failing job is reported.

- [ ] **Step 7: Commit**

```bash
git add server/scripts/migrate_research_history.mjs server/scripts/migrate_research_history.test.js docs/cloud-research-deployment.md README.md docs/superpowers/specs/2026-08-28-cloud-research-automation-design.md
git commit -m "docs: add cloud research migration and deployment"
```

### Task 11: 最终审查与分支交付

**Files:**
- Review: all changes since `5ff948d`

**Interfaces:**
- Produces a reviewable branch without modifying `codex/ai-dashboard` or its dirty working tree.

- [ ] **Step 1: Review requirements and Worker best practices**

Re-read the spec, inspect complete Worker files, validate against the latest Cloudflare best-practices page, latest Workers types, and installed `node_modules/wrangler/config-schema.json`. Check streaming, awaited promises, generated Env, secret handling, structured logs, no global request state, and config/binding agreement.

- [ ] **Step 2: Re-run fresh verification evidence**

Run the full Task 10 suite again after all review fixes; record exact pass counts and build result.

- [ ] **Step 3: Inspect the final branch diff**

Run:

```bash
git status --short
git diff --stat 72570d2...HEAD
git log --oneline 72570d2..HEAD
```

Expected: only cloud research automation files are changed; the main checkout's news/runtime edits are absent.

- [ ] **Step 4: Present integration choices**

Offer the verified branch for review/PR. Do not push, merge, change DNS, or delete the old Tunnel unless the user explicitly authorizes that external action.
