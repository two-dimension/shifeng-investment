# ICE 5Y CDS Durable Daily Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从上线日起，在不依赖用户电脑或 Express 进程的前提下，持续保存 ICE 免费接口实际发布的七家公司单名 CDS EOD Price，使用不晚于结算日的美国财政部曲线换算 5Y spread，并稳定供给现有 AI 投资看板和 Excel 导出。

**Architecture:** 新建 Cloudflare Worker。固定 Durable Object 每 30 分钟自调度采集，小时级 Cron 只负责补建 Alarm；D1 保存原始版本、当前版本、曲线、派生版本、完整发布批次、截图种子和运行审计。Express 通过受保护只读 API 获取云端历史，失败时回退本地 last-good；云端连续通过两个真实 ICE 结算日验收后再关闭本地日更定时器。

**Tech Stack:** TypeScript、Cloudflare Workers、SQLite-backed Durable Objects、D1、`@cloudflare/vitest-plugin`、Vitest、现有 Express/React/Ant Design/ECharts/ExcelJS。

**Spec:** `docs/superpowers/specs/2026-08-25-ice-cds-durable-daily-recording-design.md`

## Global Constraints

- 只跟踪 Oracle、CoreWeave、NVIDIA、Amazon、Google、Microsoft、Meta 七家公司；排序沿用 `server/lib/iceCdsRegistry.js`。
- “每日”指 ICE 实际发布的结算日。不得为周末、节假日或上游缺失日填 0、复制前值或生成伪记录。
- ICE 原始数值是 EOD Price；页面上的 bp 是模型换算值，不得标成“ICE ICC 每日 EOD spread 结算价”。
- 每 30 分钟采集一次；每小时第 17 分钟的 Cron 只唤醒固定 Durable Object 并确保 Alarm 存在。
- 所有写入至少一次执行、幂等；部分公司到达时先保存原始行，七家公司完整且换算通过后才能发布。
- D1 是唯一云端事实源。Excel、JSON 快照和网页都是可重建投影。
- 同一结算日被上游修订时追加 revision，不能覆盖审计历史；当前指针切到新版本并重新发布批次修订号。
- 只读和应急写入分别使用 `READ_TOKEN`、`WRITE_TOKEN`；Secret 不进入源码、日志、前端或 Git。
- Worker 只允许访问 `https://www.ice.com` 和 `https://home.treasury.gov` 的固定路径；限制超时、跳转、响应体大小和字段。
- 单元和集成测试不得访问实时网络，全部使用固定 fixtures；上线 smoke test 才访问真实来源。
- Cloudflare 配置使用 `compatibility_date: "2026-08-25"`，新 Durable Object 使用 declarative `exports` 和 SQLite storage，不使用旧式 DO migrations。
- `published_batches` 采用追加式 `(clearing_date, revision)`；`published_batch_current` 对每个结算日保持唯一当前指针，以同时满足“一个当前批次”和“保留修订历史”。
- `ice_eod_revisions` 保留同公司、同日、不同合约或价格的所有版本；`ice_eod_current` 对 `(clearing_date, company)` 只保留一个当前 revision 指针，防止同一家公司在完整性判断中被重复计数。
- 在云端连续通过两个真实 ICE 结算日以前，保留现有本地自动刷新作为回滚路径；切换由环境开关完成，不能直接删除。
- 不改动与 CDS 无关的用户文件或运行时数据，尤其是 `server/data/news.json`、`server/lib/newsIntelligence.js` 和工作区中的未提交改动。

---

## Task 1: 建立 Worker、测试运行时和安全配置骨架

**Files:**

- Create: `cloudflare/ice-cds-collector/src/index.ts`
- Create: `cloudflare/ice-cds-collector/src/types.ts`
- Create: `cloudflare/ice-cds-collector/test/worker.test.ts`
- Create: `cloudflare/ice-cds-collector/wrangler.test.jsonc`
- Create: `cloudflare/ice-cds-collector/vitest.config.ts`
- Create: `cloudflare/ice-cds-collector/tsconfig.json`
- Create: `cloudflare/ice-cds-collector/.dev.vars.example`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: 安装并锁定 Worker 测试依赖**

Run:

```bash
npm install --save-dev @cloudflare/vitest-plugin vitest wrangler
```

Expected: `package-lock.json` 固定实际解析版本；不要手写猜测版本号。

- [ ] **Step 2: 先写失败的 Worker liveness 测试**

```ts
// cloudflare/ice-cds-collector/test/worker.test.ts
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

describe('ice-cds collector worker', () => {
  it('exposes only a non-sensitive liveness response', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://collector.test/healthz'),
      {} as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: 'ice-cds-collector' });
  });
});
```

Run:

```bash
npx vitest run --config cloudflare/ice-cds-collector/vitest.config.ts
```

Expected: FAIL，因为 `src/index.ts` 和配置尚不存在。

- [ ] **Step 3: 添加测试配置、环境类型和最小 Worker**

`wrangler.test.jsonc` 使用只供本地测试的全零 D1 ID，禁止部署该文件：

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "ice-cds-collector-test",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-25",
  "vars": { "ENVIRONMENT": "test" },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "ice-cds-history-test",
    "database_id": "00000000-0000-0000-0000-000000000000",
    "migrations_dir": "migrations"
  }],
  "durable_objects": {
    "bindings": [{ "name": "CDS_COLLECTOR", "class_name": "CdsCollector" }]
  },
  "exports": {
    "CdsCollector": { "type": "durable-object", "storage": "sqlite" }
  },
  "triggers": { "crons": ["17 * * * *"] }
}
```

`vitest.config.ts` 和 `tsconfig.json` 使用显式绝对配置路径，避免从仓库根运行时找错目录：

```ts
// cloudflare/ice-cds-collector/vitest.config.ts
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: fileURLToPath(new URL('./wrangler.test.jsonc', import.meta.url)) },
  })],
});
```

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "types": ["@cloudflare/vitest-plugin"]
  },
  "include": ["worker-configuration.d.ts", "src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

```ts
// cloudflare/ice-cds-collector/src/types.ts
export interface Env {
  DB: D1Database;
  CDS_COLLECTOR: DurableObjectNamespace;
  READ_TOKEN: string;
  WRITE_TOKEN: string;
  ENVIRONMENT: 'test' | 'staging' | 'production';
}
```

```ts
// cloudflare/ice-cds-collector/src/index.ts
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

export class CdsCollector extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return Response.json({ error: { code: 'NOT_IMPLEMENTED', message: 'Collector is not implemented' } }, { status: 501 });
  }

  async alarm(): Promise<void> {}
}

const worker: ExportedHandler<Env> = {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return Response.json({ ok: true, service: 'ice-cds-collector' });
    }
    return Response.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 });
  },
};

export default worker;
```

Add scripts to root `package.json`:

```json
{
  "test:ice-cds-worker": "vitest run --config cloudflare/ice-cds-collector/vitest.config.ts",
  "typecheck:ice-cds-worker": "tsc -p cloudflare/ice-cds-collector/tsconfig.json --noEmit",
  "cf:ice-cds:types": "wrangler types --config cloudflare/ice-cds-collector/wrangler.test.jsonc --env-interface Env cloudflare/ice-cds-collector/worker-configuration.d.ts",
  "cf:ice-cds:migrate:local": "wrangler d1 migrations apply DB --local --config cloudflare/ice-cds-collector/wrangler.test.jsonc"
}
```

Add `.dev.vars` and Cloudflare local state to `.gitignore`, while committing only `.dev.vars.example` containing empty key names:

```dotenv
READ_TOKEN=
WRITE_TOKEN=
```

- [ ] **Step 4: 运行测试和类型检查**

Run:

```bash
npm run test:ice-cds-worker
npm run cf:ice-cds:types
npm run typecheck:ice-cds-worker
```

Expected: PASS，liveness 不返回数据库、时间或密钥信息。

- [ ] **Step 5: Commit**

```bash
git add .gitignore package.json package-lock.json cloudflare/ice-cds-collector
git commit -m "feat(cds): scaffold durable collector worker"
```

---

## Task 2: 建立 D1 审计模型和幂等 Repository

**Files:**

- Create: `cloudflare/ice-cds-collector/migrations/0001_initial.sql`
- Create: `cloudflare/ice-cds-collector/src/repository.ts`
- Create: `cloudflare/ice-cds-collector/test/apply-migrations.ts`
- Create: `cloudflare/ice-cds-collector/test/repository.test.ts`
- Modify: `cloudflare/ice-cds-collector/vitest.config.ts`
- Modify: `cloudflare/ice-cds-collector/src/types.ts`

- [ ] **Step 1: 写三组失败测试**

测试必须覆盖：相同 payload 重复 100 次只有一个 revision；同日同合约价格修订产生两个 revision 但 current 只有一个；运行记录只追加。

```ts
it('deduplicates identical ICE payloads and advances current on a revision', async () => {
  const repository = new CollectorRepository(env.DB);
  const first = observation({ eodPrice: 101.25, payloadHash: 'hash-a' });
  for (let index = 0; index < 100; index += 1) await repository.upsertIceObservations([first]);
  await repository.upsertIceObservations([
    observation({ eodPrice: 101.5, payloadHash: 'hash-b', retrievedAt: '2026-08-25T01:00:00.000Z' }),
  ]);

  expect(await repository.countIceRevisions()).toBe(2);
  expect((await repository.getCurrentObservations('2026-08-24'))[0].eodPrice).toBe(101.5);
});
```

Run: `npm run test:ice-cds-worker -- repository.test.ts`

Expected: FAIL，因为 migration 和 repository 尚不存在。

- [ ] **Step 2: 创建完整 schema**

`0001_initial.sql` 必须创建并索引以下表：

```sql
CREATE TABLE collector_runs (
  run_id TEXT PRIMARY KEY,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('alarm','cron','manual','seed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','success','partial','failed')),
  source_status TEXT,
  candidate_dates_json TEXT NOT NULL DEFAULT '[]',
  raw_write_count INTEGER NOT NULL DEFAULT 0,
  published_dates_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  error_message TEXT,
  next_alarm_at TEXT
);

CREATE TABLE ice_eod_revisions (
  revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  clearing_date TEXT NOT NULL,
  company TEXT NOT NULL,
  ice_name TEXT NOT NULL,
  instrument_name TEXT NOT NULL,
  eod_price REAL NOT NULL CHECK (eod_price >= 0),
  coupon_bp REAL NOT NULL CHECK (coupon_bp > 0),
  payload_hash TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  UNIQUE (clearing_date, company, instrument_name, payload_hash)
);

CREATE TABLE ice_eod_current (
  clearing_date TEXT NOT NULL,
  company TEXT NOT NULL,
  revision_id INTEGER NOT NULL REFERENCES ice_eod_revisions(revision_id),
  PRIMARY KEY (clearing_date, company)
);

CREATE TABLE treasury_curves (
  curve_id TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  currency TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_url TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL
);

CREATE TABLE treasury_curve_nodes (
  curve_id TEXT NOT NULL REFERENCES treasury_curves(curve_id),
  years REAL NOT NULL,
  zero_rate REAL NOT NULL,
  PRIMARY KEY (curve_id, years)
);

CREATE TABLE cds_spread_revisions (
  spread_revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  clearing_date TEXT NOT NULL,
  company TEXT NOT NULL,
  ice_revision_id INTEGER NOT NULL REFERENCES ice_eod_revisions(revision_id),
  curve_id TEXT NOT NULL REFERENCES treasury_curves(curve_id),
  instrument_name TEXT NOT NULL,
  maturity_date TEXT NOT NULL,
  eod_price REAL NOT NULL,
  coupon_bp REAL NOT NULL,
  spread_bp REAL NOT NULL CHECK (spread_bp > 0),
  round_trip_price REAL NOT NULL,
  price_residual REAL NOT NULL,
  hazard_rate REAL NOT NULL,
  recovery_rate REAL NOT NULL,
  model_version TEXT NOT NULL,
  quality_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (clearing_date, company, ice_revision_id, curve_id, model_version)
);

CREATE TABLE published_batches (
  batch_id TEXT PRIMARY KEY,
  clearing_date TEXT NOT NULL,
  revision INTEGER NOT NULL,
  published_at TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  quality_status TEXT NOT NULL,
  UNIQUE (clearing_date, revision)
);

CREATE TABLE published_batch_rows (
  batch_id TEXT NOT NULL REFERENCES published_batches(batch_id),
  company TEXT NOT NULL,
  spread_revision_id INTEGER NOT NULL REFERENCES cds_spread_revisions(spread_revision_id),
  PRIMARY KEY (batch_id, company)
);

CREATE TABLE published_batch_current (
  clearing_date TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES published_batches(batch_id)
);

CREATE TABLE seed_history (
  observation_date TEXT NOT NULL,
  company TEXT NOT NULL,
  value_bp REAL NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind = 'screenshot_backfill'),
  source_label TEXT NOT NULL,
  note TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (observation_date, company, source_kind)
);

CREATE TABLE collector_state (
  state_key TEXT PRIMARY KEY CHECK (state_key = 'singleton'),
  last_alarm_at TEXT,
  last_source_success_at TEXT,
  last_published_date TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_alarm_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO collector_state (state_key, updated_at) VALUES ('singleton', '1970-01-01T00:00:00.000Z');
CREATE INDEX ice_eod_current_date_company ON ice_eod_current(clearing_date, company);
CREATE INDEX ice_eod_revisions_date_company ON ice_eod_revisions(clearing_date, company, retrieved_at);
CREATE INDEX spread_revisions_date_company ON cds_spread_revisions(clearing_date, company, created_at);
CREATE INDEX published_batches_date_revision ON published_batches(clearing_date, revision DESC);
```

- [ ] **Step 3: 配置每个测试文件的隔离迁移**

在 `vitest.config.ts` 中用 `readD1Migrations()` 读取真实迁移，并通过 `TEST_MIGRATIONS` binding 注入；`test/apply-migrations.ts` 在 `beforeEach` 中调用 `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`。

```ts
// cloudflare/ice-cds-collector/vitest.config.ts
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const configPath = fileURLToPath(new URL('./wrangler.test.jsonc', import.meta.url));
const migrationsPath = fileURLToPath(new URL('./migrations', import.meta.url));

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath },
    miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsPath) } },
  }))],
  test: { setupFiles: ['./test/apply-migrations.ts'] },
});
```

```ts
// cloudflare/ice-cds-collector/test/apply-migrations.ts
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';
import type { Env } from '../src/types';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
```

- [ ] **Step 4: 实现绑定参数的 Repository**

至少实现：

```ts
export class CollectorRepository {
  constructor(private readonly db: D1Database) {}
  startRun(input: RunStart): Promise<void>;
  finishRun(input: RunFinish): Promise<void>;
  upsertIceObservations(rows: IceObservation[]): Promise<{ inserted: number; current: number }>;
  upsertTreasuryCurve(curve: TreasuryCurve): Promise<void>;
  getCurrentObservations(clearingDate: string): Promise<StoredIceObservation[]>;
  listPartialDates(): Promise<Array<{ clearingDate: string; missingCompanies: Company[] }>>;
  saveSpreadRevisions(rows: DerivedSpread[]): Promise<StoredDerivedSpread[]>;
  publishBatch(input: PublishBatchInput): Promise<PublishedBatch>;
  latestBatch(): Promise<PublishedBatch | null>;
  history(query: HistoryQuery): Promise<HistoryPage>;
  exportSource(query: ExportQuery): Promise<ExportPage>;
  health(now: Date): Promise<CollectorHealth>;
}
```

`upsertIceObservations` 对 `ice_eod_revisions` 使用 `INSERT ... ON CONFLICT DO NOTHING` 后查询 revision ID，再对 `ice_eod_current` 使用 `INSERT ... ON CONFLICT(clearing_date, company) DO UPDATE`，仅指向 `retrieved_at` 更新、同时间 revision ID 更大的版本；重放旧 seed 不能把 current 倒退。所有值用 `.bind()`。

- [ ] **Step 5: 运行 migration、repository 和全量 Worker 测试**

Run:

```bash
npm run cf:ice-cds:migrate:local
npm run test:ice-cds-worker
npm run typecheck:ice-cds-worker
```

Expected: PASS；相同 payload 不膨胀，修订不丢历史。

- [ ] **Step 6: Commit**

```bash
git add cloudflare/ice-cds-collector
git commit -m "feat(cds): add revisioned D1 repository"
```

---

## Task 3: 移植并锁定 ICE、Treasury、5Y 合约选择和换算口径

**Files:**

- Create: `cloudflare/ice-cds-collector/src/domain/registry.ts`
- Create: `cloudflare/ice-cds-collector/src/domain/contracts.ts`
- Create: `cloudflare/ice-cds-collector/src/domain/spread.ts`
- Create: `cloudflare/ice-cds-collector/src/sources/http.ts`
- Create: `cloudflare/ice-cds-collector/src/sources/ice.ts`
- Create: `cloudflare/ice-cds-collector/src/sources/treasury.ts`
- Create: `cloudflare/ice-cds-collector/test/fixtures/ice-partial.json`
- Create: `cloudflare/ice-cds-collector/test/fixtures/ice-complete.json`
- Create: `cloudflare/ice-cds-collector/test/fixtures/treasury-2026.csv`
- Create: `cloudflare/ice-cds-collector/test/sources.test.ts`
- Create: `cloudflare/ice-cds-collector/test/spread-parity.test.ts`
- Modify: `cloudflare/ice-cds-collector/src/types.ts`

- [ ] **Step 1: 写失败的来源边界与服务器口径 parity 测试**

覆盖：非法内容类型、重定向、超过 8 MiB ICE JSON、超过 2 MiB Treasury CSV、缺字段、未来曲线、部分公司、完整七家公司、同名多合约时选规范 5Y、反算残差小于 `0.005`。

Parity test 对相同 fixture 同时调用 Worker 的 `cleanPriceToParSpread` 和现有 `server/lib/isdaCdsSpread.js`，要求：

```ts
expect(workerResult.spreadBp).toBeCloseTo(serverResult.spreadBp, 8);
expect(workerResult.roundTripPrice).toBeCloseTo(serverResult.roundTripPrice, 8);
expect(workerResult.priceResidual).toBeLessThanOrEqual(0.005);
```

Run: `npm run test:ice-cds-worker -- sources.test.ts spread-parity.test.ts`

Expected: FAIL。

- [ ] **Step 2: 创建不可变七家公司注册表与 Cloudflare 兼容纯函数**

注册表字段和现有 `ICE_CDS_CONTRACT_REGISTRY` 完全一致；不要引入 `node:*`。导出：

```ts
export const TRACKED_COMPANIES: readonly Company[];
export function normalizeIcePayload(payload: unknown, retrievedAt: string): NormalizedIceRow[];
export function selectTrackedFiveYearContracts(rows: NormalizedIceRow[], clearingDate: string): ContractSelection;
export function validateDiscountCurve(curve: TreasuryCurve): TreasuryCurve;
export function cleanPriceToParSpread(input: SpreadInput): SpreadResult;
```

- [ ] **Step 3: 实现安全固定来源客户端**

`sources/http.ts` 必须：HTTPS only、`redirect: 'error'`、AbortSignal 超时、流式累计字节上限、Content-Type 校验、稳定错误码、错误消息不包含完整响应体。

`sources/ice.ts` 固定：

```ts
export const ICE_PUBLIC_URL = 'https://www.ice.com/api/cds-settlement-prices/icc-single-names';
export async function fetchIceObservations(fetchImpl: typeof fetch, now: Date): Promise<IceFetchResult>;
```

返回所有当前可见结算日的已选中公司行，不等待七家齐全；每个 `payloadHash` 使用 Web Crypto SHA-256 对规范化字段计算。

`sources/treasury.ts` 固定 Treasury URL，选择 `asOf <= clearingDate` 的最近曲线；曲线 hash 包含有序节点。

- [ ] **Step 4: 运行 Worker 测试并核对现有 Node 测试**

Run:

```bash
npm run test:ice-cds-worker
node --test server/lib/isdaCdsSpread.test.js server/lib/iceCdsImport.test.js server/lib/iceCdsPublicSource.test.js
npm run typecheck:ice-cds-worker
```

Expected: 全部 PASS，Worker 和现有服务器对同一输入结果一致到 8 位小数。

- [ ] **Step 5: Commit**

```bash
git add cloudflare/ice-cds-collector
git commit -m "feat(cds): port verified public-source pricing domain"
```

---

## Task 4: 实现部分到达、换算和原子发布状态机

**Files:**

- Create: `cloudflare/ice-cds-collector/src/publisher.ts`
- Create: `cloudflare/ice-cds-collector/test/publisher.test.ts`
- Modify: `cloudflare/ice-cds-collector/src/repository.ts`
- Modify: `cloudflare/ice-cds-collector/src/types.ts`

- [ ] **Step 1: 写失败的三阶段发布测试**

第一次写 Oracle/CoreWeave，第二次写 NVIDIA/Amazon，第三次写 Google/Microsoft/Meta：前两次 `latestBatch()` 仍为空，第三次只发布一个七行批次。再并发执行两次发布，仍只出现一个 revision。

同时测试：未来 Treasury 曲线不发布、残差超限不发布、ICE 修订后产生 revision 2 且 current 指针更新。

- [ ] **Step 2: 实现 `publishReadyDates`**

```ts
export async function publishReadyDates(input: {
  repository: CollectorRepository;
  fetchTreasuryCurve: (clearingDate: string) => Promise<TreasuryCurve>;
  now: Date;
}): Promise<{ published: PublishedBatch[]; partial: PartialDate[] }>;
```

算法固定为：

1. 扫描所有未完整发布或 current 输入发生变化的日期；
2. 七家公司 current 行齐全才取曲线；
3. 曲线不得晚于结算日；
4. 七行全部换算，任何一行 `priceResidual > 0.005` 则整批不发布并记录失败；
5. `saveSpreadRevisions` 后用一个 `D1Database.batch()` 写 `published_batches`、七条 `published_batch_rows` 和 `published_batch_current`；
6. batch ID 为规范化日期、revision、七个 spread revision ID 的 SHA-256 前 16 位，不依赖执行时间。

- [ ] **Step 3: 运行并发与修订测试**

Run: `npm run test:ice-cds-worker -- publisher.test.ts`

Expected: PASS；无混批，无重复，修订可审计。

- [ ] **Step 4: Commit**

```bash
git add cloudflare/ice-cds-collector
git commit -m "feat(cds): publish only complete revisioned batches"
```

---

## Task 5: 实现 Durable Object Alarm、Cron 心跳和故障恢复

**Files:**

- Create: `cloudflare/ice-cds-collector/src/collector.ts`
- Create: `cloudflare/ice-cds-collector/src/usBusinessDays.ts`
- Create: `cloudflare/ice-cds-collector/test/collector.test.ts`
- Create: `cloudflare/ice-cds-collector/test/usBusinessDays.test.ts`
- Modify: `cloudflare/ice-cds-collector/src/index.ts`
- Modify: `cloudflare/ice-cds-collector/src/types.ts`

- [ ] **Step 1: 写失败的 Alarm 生命周期测试**

使用 `runInDurableObject` 验证：首次 `ensure-alarm` 设定下一次 30 分钟；Alarm 在发网络请求前先设置后续 Alarm；来源 500 后 run 标记 failed、失败数加一、5 分钟后重试；恢复后归零；重复 Cron 不创建多个对象。

固定对象 ID：

```ts
export const COLLECTOR_OBJECT_NAME = 'ice-cds-global-v1';
```

另写时区/新鲜度测试：纽约时间周末不计数；美国联邦假日及周五/周一 observed day 不计数；跨过两个完整美国工作日才 stale。测试至少覆盖 2026-07-03（Independence Day observed）和 2026-11-26（Thanksgiving）。

- [ ] **Step 2: 实现一次采集**

```ts
export async function collectOnce(input: {
  env: Env;
  triggerKind: 'alarm' | 'cron' | 'manual';
  now: Date;
  fetchImpl?: typeof fetch;
}): Promise<CollectorRunResult>;
```

必须先 `startRun`，然后获取 ICE、立即 `upsertIceObservations`，再 `publishReadyDates`，最后 `finishRun`。任何异常都用稳定 `error.code` 写审计，再抛出给 Alarm 重试。

- [ ] **Step 3: 实现 Durable Object**

```ts
import { DurableObject } from 'cloudflare:workers';

const REGULAR_INTERVAL_MS = 30 * 60 * 1000;
const FAILURE_INTERVAL_MS = 5 * 60 * 1000;

export class CdsCollector extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response>;
  async alarm(): Promise<void>;
  private async ensureAlarm(now: Date, delayMs = REGULAR_INTERVAL_MS): Promise<string>;
}
```

`alarm()` 第一条有副作用的语句必须是设置常规下一次 Alarm；catch 中改为 5 分钟后并 rethrow。`fetch()` 仅接受 Worker 内部发送的 `POST /ensure-alarm` 和 `POST /collect-now`，不直接暴露互联网。

- [ ] **Step 4: 实现 Cron heartbeat**

```ts
async scheduled(_controller, env, ctx) {
  const id = env.CDS_COLLECTOR.idFromName(COLLECTOR_OBJECT_NAME);
  const stub = env.CDS_COLLECTOR.get(id);
  ctx.waitUntil(stub.fetch('https://collector.internal/ensure-alarm', { method: 'POST' }));
}
```

- [ ] **Step 5: 实现确定性的美国工作日新鲜度计算**

```ts
export function isUsFederalBusinessDay(date: string): boolean;
export function completedUsBusinessDaysBetween(lastPublishedDate: string, now: Date): number;
export function isCollectorStale(lastPublishedDate: string | null, now: Date): boolean;
```

按 `America/New_York` 取当前日期，覆盖 New Year、MLK、Washington's Birthday、Memorial Day、Juneteenth、Independence Day、Labor Day、Columbus Day、Veterans Day、Thanksgiving、Christmas 及法定 observed day。这里仅用于告警，不据此生成或删除 ICE 结算日。

- [ ] **Step 6: 运行故障注入测试**

Run:

```bash
npm run test:ice-cds-worker -- collector.test.ts usBusinessDays.test.ts
npm run test:ice-cds-worker
npm run typecheck:ice-cds-worker
```

Expected: PASS；Alarm 中断不会失去后续执行，Cron 只修复调度。

- [ ] **Step 7: Commit**

```bash
git add cloudflare/ice-cds-collector
git commit -m "feat(cds): add durable alarm collection loop"
```

---

## Task 6: 建立受保护的读取、健康、导出和应急写入 API

**Files:**

- Create: `cloudflare/ice-cds-collector/src/auth.ts`
- Create: `cloudflare/ice-cds-collector/src/api.ts`
- Create: `cloudflare/ice-cds-collector/test/api.test.ts`
- Modify: `cloudflare/ice-cds-collector/src/index.ts`
- Modify: `cloudflare/ice-cds-collector/src/repository.ts`
- Modify: `cloudflare/ice-cds-collector/src/types.ts`

- [ ] **Step 1: 写失败的 API 契约与安全测试**

覆盖：无 Token/错误 Token 返回 401；读 Token 不能写；写 Token 不能替代读 Token；日期、cursor、limit 非法返回 400；`limit` 最大 366 个结算日；错误不包含 SQL、Token 或上游响应体；历史和导出可分页。

- [ ] **Step 2: 实现 Web Crypto 固定时间 Token 比较**

先 SHA-256 两端，再对 32 字节数组做完整 XOR 累积；不得直接 `===` 比较 secret。只从 `Authorization: Bearer` 读取。

- [ ] **Step 3: 实现 API 路由**

```text
GET  /healthz
GET  /v1/cds/latest
GET  /v1/cds/history?from=YYYY-MM-DD&to=YYYY-MM-DD&cursor=YYYY-MM-DD&limit=90
GET  /v1/cds/health
GET  /v1/cds/export-source?cursor=opaque&limit=500
POST /internal/v1/cds/import
POST /internal/v1/cds/collect-now
```

所有 `/v1` 使用 `READ_TOKEN`；所有 `/internal` 使用 `WRITE_TOKEN`。手工 import 的 body 必须是七家公司已预览结构，复用 `upsertIceObservations` 和 `publishReadyDates`，trigger 记为 `manual`。

互联网 Worker 通过认证后，所有 `/internal` 写请求必须转发到 `ice-cds-global-v1` Durable Object，由该对象串行执行；API handler 不得直接写 D1。只读 `/v1` 可以直接查询 D1。这样 Alarm、手工导入、seed 和 collect-now 共用同一写入序列。

`latest` response 固定：

```ts
interface LatestResponse {
  data: {
    asOf: string;
    batchId: string;
    revision: number;
    sourceKind: 'ice_eod_isda';
    publishedAt: string;
    companies: Array<{
      company: Company;
      spreadBp: number;
      eodPrice: number;
      instrumentName: string;
      qualityStatus: 'model-derived';
    }>;
  };
}
```

- [ ] **Step 4: 运行 API 测试**

Run: `npm run test:ice-cds-worker -- api.test.ts`

Expected: PASS；`/healthz` 之外没有匿名数据接口。

- [ ] **Step 5: Commit**

```bash
git add cloudflare/ice-cds-collector
git commit -m "feat(cds): expose authenticated collector APIs"
```

---

## Task 7: 迁移截图曲线和现有 ICE 历史到 D1

**Files:**

- Create: `server/scripts/build_ice_cds_cloud_seed.mjs`
- Create: `server/scripts/import_ice_cds_cloud_seed.mjs`
- Create: `server/lib/iceCdsCloudSeed.test.js`
- Create: `cloudflare/ice-cds-collector/src/seed.ts`
- Create: `cloudflare/ice-cds-collector/test/seed.test.ts`
- Modify: `package.json`

- [ ] **Step 1: 写失败的种子隔离测试**

输入现有 workbook/archive，断言截图点只进入 `seed_history` 且 `source_kind = screenshot_backfill`；2026-08-24 的 ICE 原始/派生数据进入 revision/batch 表且 `source_kind = ice_eod_isda`；同一 seed 重放两次计数不变。

- [ ] **Step 2: 实现确定性 seed 包**

`build_ice_cds_cloud_seed.mjs` 只读：

```text
server/data/ai-dashboard/ice-cds/ice-cds-history.xlsx
server/data/ai-dashboard/ice-cds/snapshot.last-good.json
```

输出到临时路径或显式 `--out`，schema：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-25T00:00:00.000Z",
  "screenshotHistory": [],
  "iceObservations": [],
  "treasuryCurves": [],
  "derivedSpreads": [],
  "publishedBatches": []
}
```

不要把生成文件、Token 或 workbook 二进制纳入本任务 commit。

- [ ] **Step 3: 实现 Worker seed 导入**

增加 `POST /internal/v1/cds/seed`，只允许 `WRITE_TOKEN`，认证后转发给固定 Durable Object。每个 section 单独计数并幂等写入，响应包含 `inserted`、`existing`、`rejected`。任何非法日期或非七家公司名整包拒绝。

- [ ] **Step 4: 实现分片上传脚本**

`import_ice_cds_cloud_seed.mjs` 从环境读取 `ICE_CDS_COLLECTOR_BASE_URL` 和 `ICE_CDS_COLLECTOR_WRITE_TOKEN`，每批最多 500 行，失败可重试，禁止在日志打印 Authorization。

Add scripts:

```json
{
  "build:ice-cds-cloud-seed": "node server/scripts/build_ice_cds_cloud_seed.mjs",
  "import:ice-cds-cloud-seed": "node server/scripts/import_ice_cds_cloud_seed.mjs"
}
```

- [ ] **Step 5: 运行种子测试，不触碰真实云端**

Run:

```bash
node --test server/lib/iceCdsCloudSeed.test.js
npm run test:ice-cds-worker -- seed.test.ts
```

Expected: PASS；两种来源不会互相冒充。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/scripts/build_ice_cds_cloud_seed.mjs server/scripts/import_ice_cds_cloud_seed.mjs server/lib/iceCdsCloudSeed.test.js cloudflare/ice-cds-collector
git commit -m "feat(cds): add idempotent cloud history seeding"
```

---

## Task 8: 让 Express 读取云端历史并保留 last-good 回退

**Files:**

- Create: `server/lib/iceCdsCloudClient.js`
- Create: `server/lib/iceCdsCloudClient.test.js`
- Create: `server/lib/iceCdsCloudProjection.js`
- Create: `server/lib/iceCdsCloudProjection.test.js`
- Modify: `server/lib/aiDashboardService.js`
- Modify: `server/lib/aiDashboardService.test.js`
- Modify: `server/index.js`
- Modify: `server/lib/iceCdsPublicSource.js`
- Modify: `server/lib/iceCdsPublicSource.test.js`

- [ ] **Step 1: 写失败的云端读取与回退测试**

覆盖：Token 只发往配置 host；超时 10 秒；非 2xx/非法 schema 抛稳定错误；云端成功时生成现有 `creditRisk.cds5y`；云端失败保留上一 snapshot 并 `stale: true`；云端无完整批次时不显示 0。

- [ ] **Step 2: 实现只读客户端**

```js
export function createIceCdsCloudClient({
  baseUrl = process.env.ICE_CDS_COLLECTOR_BASE_URL,
  readToken = process.env.ICE_CDS_COLLECTOR_READ_TOKEN,
  fetchImpl = fetch,
  timeoutMs = 10_000,
} = {}) {
  return {
    latest: () => request('/v1/cds/latest'),
    history: (query) => request(`/v1/cds/history?${query}`),
    health: () => request('/v1/cds/health'),
    exportSource: (cursor) => request(`/v1/cds/export-source?${cursor}`),
  };
}
```

只允许 HTTPS；本地测试可显式注入 `allowHttpForTests: true`。

- [ ] **Step 3: 实现云端到现有 snapshot 的投影**

保留现有 `CdsCompanyMetric` 字段和截图曲线；云端点按 `(date, company, sourceKind)` 去重；1D/7D/1M 继续使用绝对 bp 差，不计算百分比。

增加健康字段：

```ts
cds5y.collection = {
  lastCollectedAt,
  lastPublishedDate,
  nextAlarmAt,
  partialDates,
  consecutiveFailures,
  state: 'healthy' | 'partial' | 'stale' | 'source-error'
};
```

- [ ] **Step 4: 以 feature flag 接入服务，暂不关闭本地调度**

环境变量：

```text
ICE_CDS_COLLECTOR_ENABLED=true|false
ICE_CDS_LOCAL_REFRESH_ENABLED=true|false
```

`ICE_CDS_COLLECTOR_BASE_URL` 必须等于 Task 10 部署输出中的完整 HTTPS URL；`ICE_CDS_COLLECTOR_READ_TOKEN` 必须等于 Task 10 写入 Worker `READ_TOKEN` 的同一服务端值。两者只在部署环境中设置，不在文档示例中伪造。

当 cloud enabled 时将 `creditRisk` 加入 AI dashboard automatic sources；local refresh 是否启动只看 `ICE_CDS_LOCAL_REFRESH_ENABLED !== 'false'`。默认保持 `true` 直至 Task 11 cutover。

- [ ] **Step 5: 运行服务器回归测试**

Run:

```bash
node --test server/lib/iceCdsCloudClient.test.js server/lib/iceCdsCloudProjection.test.js server/lib/aiDashboardService.test.js server/lib/iceCdsPublicSource.test.js
```

Expected: PASS；云端失败时页面数据仍存在但明确 stale。

- [ ] **Step 6: Commit**

```bash
git add server/lib/iceCdsCloudClient.js server/lib/iceCdsCloudClient.test.js server/lib/iceCdsCloudProjection.js server/lib/iceCdsCloudProjection.test.js server/lib/aiDashboardService.js server/lib/aiDashboardService.test.js server/index.js server/lib/iceCdsPublicSource.js server/lib/iceCdsPublicSource.test.js
git commit -m "feat(cds): read durable cloud history with fallback"
```

---

## Task 9: 从云端事实源生成 Excel，并在现有截图式页面显示采集健康状态

**Files:**

- Create: `server/lib/iceCdsCloudExport.js`
- Create: `server/lib/iceCdsCloudExport.test.js`
- Modify: `server/lib/iceCdsWorkbook.js`
- Modify: `server/lib/iceCdsWorkbook.test.js`
- Modify: `server/api/ai_dashboard.js`
- Modify: `server/api/ai_dashboard.test.js`
- Modify: `src/pages/AIDashboard/types.ts`
- Modify: `src/pages/AIDashboard/AIDashboardSections.tsx`
- Modify: `src/pages/AIDashboard/AIDashboardPanel.css`

- [ ] **Step 1: 写失败的 Excel 和 UI 纯函数测试**

Excel 断言：七个现有 sheet 均存在；截图和 ICE 来源标签正确；每个云端批次七家公司；当前值与 D1 export-source 一致；last-good fallback 的 Methodology 明确标记生成时间。

UI 状态映射抽成可测纯函数：healthy=绿色“云端每日记录正常”；partial=黄色并列缺失公司；stale/source-error=红色；不得用“ICE ICC 每日 EOD spread 结算价”。

- [ ] **Step 2: 实现分页拉取与 workbook 投影**

`createIceCdsCloudExport` 迭代 `export-source` cursor 到结束，转换成现有 `buildIceCdsWorkbook(state)` 所需 archive state。成功导出后原子更新 `ice-cds-history.last-good.xlsx`；云端失败则读取该文件并在 HTTP header `X-ICE-CDS-Data-State: stale-last-good` 标记。

- [ ] **Step 3: 调整导出 API**

`GET /api/ai-dashboard/cds/export.xlsx` 在 cloud enabled 时优先 cloud export；否则保留现有 pipeline。响应文件名仍为 `ice-cds-history.xlsx`，不破坏现有按钮。

- [ ] **Step 4: 在现有 CDS 区块增加状态，不改变截图结构**

保留七张卡片和两列趋势图。标题下方新增一行紧凑状态：最后完整结算日、最近采集、下一次检查、partial 缺失公司。来源文案固定为：

```text
截图历史回填 + ICE EOD Price · 模型换算
```

tooltip 中原始值标为 `ICE EOD Price`，派生值标为 `5Y spread 模型换算值`。

- [ ] **Step 5: 运行 API、Excel、前端检查**

Run:

```bash
node --test server/lib/iceCdsCloudExport.test.js server/lib/iceCdsWorkbook.test.js server/api/ai_dashboard.test.js
npm run lint
npm run build
```

Expected: PASS；桌面、移动、亮/暗模式不破坏现有截图式布局。

- [ ] **Step 6: Commit**

```bash
git add server/lib/iceCdsCloudExport.js server/lib/iceCdsCloudExport.test.js server/lib/iceCdsWorkbook.js server/lib/iceCdsWorkbook.test.js server/api/ai_dashboard.js server/api/ai_dashboard.test.js src/pages/AIDashboard/types.ts src/pages/AIDashboard/AIDashboardSections.tsx src/pages/AIDashboard/AIDashboardPanel.css
git commit -m "feat(cds): export and display durable collection health"
```

---

## Task 10: 创建 Cloudflare staging 资源、部署并完成故障演练

**Files:**

- Create: `cloudflare/ice-cds-collector/wrangler.jsonc`
- Create: `docs/runbooks/ice-cds-collector.md`
- Modify: `package.json`
- Modify: `package-lock.json`

> 本任务会创建外部云资源并写 Cloudflare Secret。执行前使用 Cloudflare 登录/授权流程；不要把返回的 token 或 database ID 以外的凭据写入仓库。

- [ ] **Step 1: 先创建无 D1 binding 的可部署配置骨架**

`wrangler.jsonc` 先只保存可确定配置；下一步由 Wrangler 将真实 D1 binding 和 UUID 写回该文件：

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "ice-cds-collector-staging",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-25",
  "vars": { "ENVIRONMENT": "staging" },
  "durable_objects": { "bindings": [{ "name": "CDS_COLLECTOR", "class_name": "CdsCollector" }] },
  "exports": { "CdsCollector": { "type": "durable-object", "storage": "sqlite" } },
  "triggers": { "crons": ["17 * * * *"] },
  "env": {
    "production": {
      "name": "ice-cds-collector",
      "vars": { "ENVIRONMENT": "production" },
      "durable_objects": { "bindings": [{ "name": "CDS_COLLECTOR", "class_name": "CdsCollector" }] },
      "exports": { "CdsCollector": { "type": "durable-object", "storage": "sqlite" } },
      "triggers": { "crons": ["17 * * * *"] }
    }
  }
}
```

- [ ] **Step 2: 验证账号并让 Wrangler 创建、绑定两个明确命名的 D1 database**

Run:

```bash
npx wrangler whoami
npx wrangler d1 create ice-cds-history-staging --binding DB --update-config --config cloudflare/ice-cds-collector/wrangler.jsonc
npx wrangler d1 create ice-cds-history-production --binding DB --update-config --env production --config cloudflare/ice-cds-collector/wrangler.jsonc
```

Expected: 两条命令成功，并分别在顶层和 `env.production` 写入 `binding: "DB"`、准确的 database name 和真实 `database_id`。随后在这两个 D1 binding 中各自加入 `"migrations_dir": "migrations"` 并检查 diff；不允许全零测试 ID、`pending` 或空 ID 出现在 `wrangler.jsonc`。

- [ ] **Step 3: 迁移并首次部署 staging**

Run:

```bash
npx wrangler d1 migrations apply DB --remote --config cloudflare/ice-cds-collector/wrangler.jsonc
npx wrangler deploy --config cloudflare/ice-cds-collector/wrangler.jsonc
```

Expected: migration success；部署输出显示 `CdsCollector` declarative export 已创建；Cron 存在。此时受保护接口因尚无 Secret 而拒绝访问，`/healthz` 可用。

- [ ] **Step 4: 创建 staging 独立随机读写 Token 并写 Secrets**

Generate two different 32-byte random values locally without printing them into logs; enter them interactively:

```bash
npx wrangler secret put READ_TOKEN --config cloudflare/ice-cds-collector/wrangler.jsonc
npx wrangler secret put WRITE_TOKEN --config cloudflare/ice-cds-collector/wrangler.jsonc
```

Save the matching server-side values only in deployment environment variables, not `.env` committed files.

- [ ] **Step 5: 导入 staging 种子并做真实 smoke test**

Run the seed builder/importer with staging URL and write token, then query with read token:

```bash
npm run build:ice-cds-cloud-seed -- --out /private/tmp/ice-cds-cloud-seed.json
npm run import:ice-cds-cloud-seed -- --file /private/tmp/ice-cds-cloud-seed.json
```

Verify latest/history/health/export counts against the local workbook: seven companies per ICE batch, screenshot row count unchanged, 2026-08-24 values identical.

- [ ] **Step 6: 做五项 staging 故障演练**

1. 同一 seed 重放 3 次，行数不变；
2. 只导入 2/7 公司，health 显示 partial 且 latest 不推进；
3. 补齐 5/7，公司完整后只发布一次；
4. 导入同日修订值，revision +1 且旧 revision 可查；
5. 临时使用错误 Treasury fixture，批次不发布，恢复后自动发布。

把实际命令、期望 JSON 字段、回滚步骤写入 `docs/runbooks/ice-cds-collector.md`。

- [ ] **Step 7: 增加 deploy scripts 并 commit**

```json
{
  "cf:ice-cds:deploy:staging": "wrangler deploy --config cloudflare/ice-cds-collector/wrangler.jsonc",
  "cf:ice-cds:deploy:production": "wrangler deploy --env production --config cloudflare/ice-cds-collector/wrangler.jsonc",
  "cf:ice-cds:migrate:staging": "wrangler d1 migrations apply DB --remote --config cloudflare/ice-cds-collector/wrangler.jsonc",
  "cf:ice-cds:migrate:production": "wrangler d1 migrations apply DB --remote --env production --config cloudflare/ice-cds-collector/wrangler.jsonc"
}
```

```bash
git add cloudflare/ice-cds-collector/wrangler.jsonc docs/runbooks/ice-cds-collector.md package.json package-lock.json
git commit -m "ops(cds): provision durable collector deployment"
```

---

## Task 11: 生产上线、两结算日观察和安全切换

**Files:**

- Modify: deployment environment only (no secret files committed)
- Modify: `docs/runbooks/ice-cds-collector.md`
- Modify: `server/index.js` only if the feature flag does not already fully control local scheduling
- Modify: `server/index.test.js` or the existing scheduler test file

- [ ] **Step 1: 生产迁移、部署和种子导入**

Run:

```bash
npm run cf:ice-cds:migrate:production
npm run cf:ice-cds:deploy:production
npx wrangler secret put READ_TOKEN --env production --config cloudflare/ice-cds-collector/wrangler.jsonc
npx wrangler secret put WRITE_TOKEN --env production --config cloudflare/ice-cds-collector/wrangler.jsonc
```

为 production 生成与 staging 不同的两个随机 Token，交互写入后再使用 production URL/write token 导入同一个已验证 seed。核对 latest、history、health 和 Excel。

- [ ] **Step 2: 让 Express 影子读取云端，但继续本地日更**

Set deployment environment:

```text
ICE_CDS_COLLECTOR_ENABLED=true
ICE_CDS_LOCAL_REFRESH_ENABLED=true
```

同时把 `ICE_CDS_COLLECTOR_BASE_URL` 设为 production deploy 输出的完整 HTTPS URL，把 `ICE_CDS_COLLECTOR_READ_TOKEN` 设为对应 production `READ_TOKEN` 的同一服务端值；不要把实际值写入文档或 Git。

重启 Express。页面应读取云端，local scheduler 仍作为临时回滚路径；日志不能打印 Token。

- [ ] **Step 3: 连续观察两个真实 ICE 结算日**

每个结算日完成后记录验收表：

```text
ICE clearing date
七家公司原始行齐全
Treasury asOf <= clearing date
七家公司 spread residual <= 0.005
D1 current/revisions/published current 一致
Worker health healthy
Excel 与 API 每家公司数值一致
网页最新日期和 1D/7D/1M 绝对 bp 变化一致
```

只有两个实际结算日全部通过才进入下一步；自然周末不算结算日。

- [ ] **Step 4: 关闭本地 scheduler，保留手动回滚**

Set:

```text
ICE_CDS_LOCAL_REFRESH_ENABLED=false
```

重启后验证本地 timer 未启动、云端读取正常、手工 import 仍可通过受保护 cloud write API。不要删除本地代码和 last-good 文件。

- [ ] **Step 5: 验证 stale 告警**

在 staging 用注入时钟模拟超过两个纽约工作日没有新完整批次，断言 Worker health、Express source state 和页面均为 stale；生产只做只读核查，不人为篡改数据。

- [ ] **Step 6: 运行最终验证**

Run:

```bash
npm run test:ice-cds-worker
npm run typecheck:ice-cds-worker
node --test server/lib/*.test.js server/api/*.test.js
npm run lint
npm run build
git status --short
```

Expected: Worker tests、服务器测试、lint、生产构建全部 PASS；`git status` 只允许已知用户运行时文件，不应出现 secret、seed 临时文件或 Cloudflare local state。

- [ ] **Step 7: 更新 runbook 并 commit**

把两个真实结算日的日期、批次 ID、七家公司核对结果、切换时间和回滚开关写入 runbook，但不写 Token。

```bash
git add docs/runbooks/ice-cds-collector.md server/index.js server/index.test.js
git commit -m "ops(cds): complete durable daily collection cutover"
```

如果 `server/index.js` 和测试没有变化，只提交 runbook，不为制造 commit 修改代码。

---

## Task 12: PR 前审查与合并边界

**Files:**

- Review: all files changed by Tasks 1–11
- Review: `docs/superpowers/specs/2026-08-25-ice-cds-durable-daily-recording-design.md`
- Review: `docs/runbooks/ice-cds-collector.md`

- [ ] **Step 1: 做需求逐条审查**

逐项确认：七家公司、30 分钟 Alarm、小时心跳、部分保存/完整发布、revision/current、两工作日 stale、受保护 API、seed 来源隔离、Excel cloud export、last-good、两真实结算日 cutover 全部有实现和测试。

- [ ] **Step 2: 检查安全和仓库卫生**

Run:

```bash
rg -n "READ_TOKEN=.+|WRITE_TOKEN=.+|Bearer [A-Za-z0-9_-]{20,}|sk-or-v1" . --glob '!node_modules/**' --glob '!dist/**'
git diff --check
git status --short
```

Expected: 没有密钥命中；diff 无空白错误；不 stage 用户无关文件。

- [ ] **Step 3: 复查现有 PR 冲突，不擅自覆盖 main**

现有 PR #8 已知与 main 冲突。先获取最新 main，在隔离 worktree 中审查每个冲突；保留 main 的日历/公告等无关变更，同时保留本分支 ICE→模型换算→D1→Excel 的 CDS 实现。任何会整体选择 ours/theirs 的操作都必须再次获得用户明确确认。

- [ ] **Step 4: 最终提交和 PR 检查**

Run:

```bash
git log --oneline --decorate -12
gh pr checks 8
gh pr view 8 --json url,mergeStateStatus,reviewDecision,statusCheckRollup
```

Expected: 所有 CI green，PR 不再冲突，runbook 中记录生产验收。只有在用户对冲突解决和自动合并授权仍然明确有效时才 merge。
