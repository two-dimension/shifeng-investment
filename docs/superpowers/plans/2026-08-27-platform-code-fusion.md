# Platform Code Fusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan. Before editing, use `superpowers:using-git-worktrees`; for each behavior change use `superpowers:test-driven-development`; before claiming completion use `superpowers:verification-before-completion`.

**Goal:** 在新电脑仓库中生成一个可回退的融合分支：保留当前最新版 AI 看板，除 AI 外的平台代码以旧仓库实际工作树为准恢复。

**Architecture:** 当前仓库是唯一目标仓库。旧仓库 `/Users/ray_wang/Downloads/shifeng-investment` 只作为只读代码来源。先在隔离 worktree 中恢复非 AI 前端、后端、脚本和测试，再手工融合共享入口，最后用哈希和测试证明 AI 目录未回退。本计划只融合平台代码；历史数据、旧 Codex 任务和 Cloudflare 分别在后续计划处理。

**Tech Stack:** React 19、TypeScript 6、Vite 8、Node.js ESM、Express 5、Node test runner、Python unittest、Git worktree、rsync。

**Spec:** `docs/superpowers/specs/2026-08-27-platform-recovery-fusion-design.md`

## Global Constraints

- 不修改 `/Users/ray_wang/Downloads/shifeng-investment` 和 `/Users/ray_wang/Downloads/石锋平台要用的`。
- 不复制 `server/data`、`public`、`price_tracking`、PDF、XLSX、PNG、缓存、日志、`.env*` 或密钥。
- 每次同步先运行 `rsync -ain --delete` 预览，再运行相同过滤条件的正式同步。
- 共享入口不得整文件盲目覆盖；必须按本计划逐项融合。
- 当前仓库 AI 基准取执行开始时的 `HEAD`，而不是写死旧提交号；将该 SHA 记录进融合报告。
- 若源仓库在执行期间发生变化，停止同步并重新生成清单。

---

## Task 1: 建立隔离融合分支和可审计清单

**Files:**

- Create: `docs/recovery/platform-code-source-manifest.md`
- Create: `docs/recovery/current-ai-files.sha256`
- Create: `docs/recovery/legacy-code-files.sha256`

- [ ] **Step 1: 确认当前仓库干净并记录 AI 基准**

Run from the current repository:

```bash
git status --short
git rev-parse HEAD
```

Expected: `git status --short` 无输出；保存 `git rev-parse HEAD` 的值作为 `CURRENT_AI_BASELINE`。

- [ ] **Step 2: 创建隔离 worktree**

```bash
git worktree add .worktrees/platform-recovery-fusion -b codex/recovery-fusion HEAD
```

Expected: `.worktrees/platform-recovery-fusion` 创建成功，并检出 `codex/recovery-fusion`。

- [ ] **Step 3: 在 worktree 中记录双方来源**

在 `docs/recovery/platform-code-source-manifest.md` 写入：

```markdown
# Platform Code Source Manifest

- Current repository baseline: `<CURRENT_AI_BASELINE>`
- Legacy repository HEAD: `<LEGACY_HEAD>`
- Legacy repository branch: `<LEGACY_BRANCH>`
- Legacy repository status captured: `2026-08-27`
- Fusion rule: current AI dashboard + legacy non-AI platform code
- Excluded from this phase: runtime data, old Codex tasks, Cloudflare deployment
```

用以下命令取得 `<LEGACY_HEAD>` 和 `<LEGACY_BRANCH>`：

```bash
git -C /Users/ray_wang/Downloads/shifeng-investment rev-parse HEAD
git -C /Users/ray_wang/Downloads/shifeng-investment branch --show-current
git -C /Users/ray_wang/Downloads/shifeng-investment status --short
```

Expected: 旧仓库状态只被读取，不发生任何写入。

- [ ] **Step 4: 生成融合前校验和**

在 worktree 根目录运行：

```bash
find src/pages/AIDashboard server/api server/lib server/scripts tests -type f \( -path 'src/pages/AIDashboard/*' -o -name 'ai_dashboard*' -o -iname 'ai*' -o -iname 'artificialAnalysis*' -o -iname 'iceCds*' -o -iname 'isdaCds*' -o -iname 'official*' -o -iname 'publicSourceRegistry*' -o -iname 'sourceLedgerValidation*' -o -iname 'taskCostMetrics*' -o -name 'aiDashboardViewModel.test.ts' \) -print0 | sort -z | xargs -0 shasum -a 256 > docs/recovery/current-ai-files.sha256
find /Users/ray_wang/Downloads/shifeng-investment/src /Users/ray_wang/Downloads/shifeng-investment/server /Users/ray_wang/Downloads/shifeng-investment/scripts /Users/ray_wang/Downloads/shifeng-investment/tests -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.ts' -o -name '*.tsx' -o -name '*.py' -o -name '*.sh' \) -not -path '*/server/data/*' -not -path '*/public/*' -not -path '*/price_tracking/*' -not -path '*/__pycache__/*' -print0 | sort -z | xargs -0 shasum -a 256 > docs/recovery/legacy-code-files.sha256
shasum -a 256 /Users/ray_wang/Downloads/shifeng-investment/package.json /Users/ray_wang/Downloads/shifeng-investment/package-lock.json /Users/ray_wang/Downloads/shifeng-investment/wrangler.toml >> docs/recovery/legacy-code-files.sha256
```

Expected: 两个清单均非空；清单只包含文件哈希，不包含文件内容或密钥。

- [ ] **Step 5: 提交来源清单**

```bash
git add docs/recovery/platform-code-source-manifest.md docs/recovery/current-ai-files.sha256 docs/recovery/legacy-code-files.sha256
git commit -m "chore: snapshot platform fusion sources"
```

---

## Task 2: 用旧版恢复非 AI 前端

**Files:**

- Modify: `src/components/Fund/AddFundModal.tsx`
- Modify: `src/components/Fund/FundDashboard.tsx`
- Modify: `src/components/Fund/MarketTemperature.tsx`
- Modify: `src/data/stocks.ts`
- Modify: `src/data/usSectorFunds.ts`
- Modify: `src/hooks/useFundPortfolio.ts`
- Modify: `src/hooks/useNewsFeed.ts`
- Modify: `src/hooks/useResearch.ts`
- Modify: `src/pages/Calendar/CalendarPanel.tsx`
- Modify: `src/pages/Home/HomePanel.tsx`
- Modify: `src/pages/News/NewsPanel.tsx`
- Modify: `src/pages/Portfolio/PortfolioAnomalyPanel.tsx`
- Modify: `src/pages/Portfolio/PortfolioPanel.tsx`
- Modify: `src/pages/Research/ResearchPanel.tsx`
- Modify: `src/pages/Stock/StockDetailPanel.tsx`
- Modify: `src/types/fund.ts`
- Preserve: `src/pages/AIDashboard/**`
- Preserve for Task 4: `src/App.tsx`
- Preserve for Task 4: `src/components/Layout/MainLayout.tsx`
- Preserve for Task 4: `src/pages/index.ts`
- Delete: `src/pages/Research/researchSyncClient.ts`
- Delete: `src/pages/Portfolio/portfolioEntryState.ts`

- [ ] **Step 1: 预览前端同步**

在融合 worktree 运行：

```bash
rsync -ain --delete \
  --exclude='.DS_Store' \
  --exclude='/pages/AIDashboard/***' \
  --exclude='/types/aiDashboard.ts' \
  --exclude='/App.tsx' \
  --exclude='/components/Layout/MainLayout.tsx' \
  --exclude='/pages/index.ts' \
  /Users/ray_wang/Downloads/shifeng-investment/src/ src/
```

Expected: 预览包含旧版非 AI 文件更新和两个 current-only helper 的删除；不包含 `src/pages/AIDashboard`。

- [ ] **Step 2: 执行完全相同过滤条件的同步**

将上一步命令中的 `-ain` 改为 `-a` 后执行。禁止添加 `--delete-excluded`。

- [ ] **Step 3: 证明 AI 前端未被改动**

```bash
git diff --exit-code HEAD -- src/pages/AIDashboard
```

Expected: exit code 0，无输出。

- [ ] **Step 4: 删除新版独有的非 AI helper 及其测试**

使用 `apply_patch` 精确删除：

- `src/pages/Research/researchSyncClient.ts`
- `src/pages/Portfolio/portfolioEntryState.ts`
- `tests/researchSyncClient.test.ts`
- `tests/portfolioEntryState.test.ts`
- `tests/usSectorPresetFunds.test.ts`

- [ ] **Step 5: 检查同步结果**

再次运行 Step 1 的 dry-run 命令。

Expected: 非共享、非 AI 前端没有内容差异；最多只显示时间戳差异。

- [ ] **Step 6: 提交旧版非 AI 前端**

```bash
git add src tests
git commit -m "restore: use legacy non-ai frontend"
```

---

## Task 3: 恢复旧版非 AI 后端、量化模块和测试

**Files:**

- Restore: `server/lib/quantStrategy.js`
- Restore: `scripts/generate_quant_report.py`
- Restore: `scripts/quant_backfill.mjs`
- Restore: `scripts/quant_migrate_kline_cache.mjs`
- Restore: `scripts/quant_parquet_loop.py`
- Restore: `scripts/test_quant_strategy.mjs`
- Modify: `server/api/calendar.js`
- Modify: `server/api/calendar.test.js`
- Modify: `server/lib/calendarRefresh.js`
- Modify: `server/lib/calendarStore.js`
- Modify: `server/lib/newsIntelligence.js`
- Modify: `server/lib/researchSync.js`
- Preserve for Task 4: `server/index.js`
- Preserve for Task 4: `server/startup.test.js`
- Preserve: current AI API, services, scripts, fixtures, and `server/data/ai-dashboard/**`
- Delete: `server/lib/validateQuantStrategy.js`

- [ ] **Step 1: 预览服务端同步**

在融合 worktree 运行：

```bash
rsync -ain --delete \
  --exclude='.DS_Store' --exclude='__pycache__/***' --exclude='*.pyc' \
  --exclude='/index.js' --exclude='/startup.test.js' --exclude='/data/***' --exclude='/public/***' --exclude='/price_tracking/***' \
  --exclude='/fixtures/ice-cds/***' \
  --exclude='/api/ai_dashboard*' \
  --exclude='/lib/aiCapital*' --exclude='/lib/aiCds*' --exclude='/lib/aiCompute*' \
  --exclude='/lib/aiDashboard*' --exclude='/lib/aiGrowth*' --exclude='/lib/aiPricing*' \
  --exclude='/lib/artificialAnalysis*' --exclude='/lib/iceCds*' --exclude='/lib/isdaCds*' \
  --exclude='/lib/officialBenchmark*' --exclude='/lib/officialDocument*' --exclude='/lib/officialModelCard*' \
  --exclude='/lib/publicSourceRegistry*' --exclude='/lib/sourceLedgerValidation*' --exclude='/lib/taskCostMetrics*' \
  --exclude='/lib/fixtures/ai-*' --exclude='/lib/fixtures/artificial-analysis/***' \
  --exclude='/lib/fixtures/official-model-cards/***' --exclude='/lib/fixtures/official-sources/***' \
  --exclude='/scripts/*ai*' --exclude='/scripts/*ice_cds*' \
  /Users/ray_wang/Downloads/shifeng-investment/server/ server/
```

Expected: `quantStrategy.js` 将被新增；旧版非 AI API/服务被恢复；AI、运行数据和共享 `server/index.js` 不在输出中。

- [ ] **Step 2: 执行服务端同步**

将 Step 1 命令中的 `-ain` 改为 `-a` 后执行。禁止添加 `--delete-excluded`。

- [ ] **Step 3: 同步根脚本目录**

先预览，再执行：

```bash
rsync -ain --delete --exclude='.DS_Store' --exclude='__pycache__/***' --exclude='*.pyc' /Users/ray_wang/Downloads/shifeng-investment/scripts/ scripts/
rsync -a --delete --exclude='.DS_Store' --exclude='__pycache__/***' --exclude='*.pyc' /Users/ray_wang/Downloads/shifeng-investment/scripts/ scripts/
```

Expected: 五个量化脚本恢复，缓存文件不复制。

- [ ] **Step 4: 同步旧版非 AI 测试**

```bash
rsync -ain --delete --exclude='aiDashboardViewModel.test.ts' --exclude='__pycache__/***' --exclude='*.pyc' /Users/ray_wang/Downloads/shifeng-investment/tests/ tests/
rsync -a --delete --exclude='aiDashboardViewModel.test.ts' --exclude='__pycache__/***' --exclude='*.pyc' /Users/ray_wang/Downloads/shifeng-investment/tests/ tests/
```

Expected: 旧版 spot/TMT/backfill 测试恢复，当前 AI view-model 测试保留。

- [ ] **Step 5: 先运行量化单元测试**

```bash
node scripts/test_quant_strategy.mjs
```

Expected: 输出 `quant strategy tests passed`。

- [ ] **Step 6: 运行旧版核心后端测试**

```bash
node --test server/api/calendar.test.js server/api/etf_monitor.test.js server/api/research.test.js server/api/tmt_margin.test.js
node --test tests/spotRefreshState.test.ts
python3 -m unittest discover -s tests -p 'test_*.py'
```

Expected: 5 个 Node 测试文件和 2 个 Python 测试文件全部通过。

- [ ] **Step 7: 证明 AI 后端未被同步覆盖**

```bash
git diff --exit-code HEAD -- src/pages/AIDashboard server/api/ai_dashboard.js server/lib/aiDashboardService.js server/lib/iceCdsPipeline.js
```

Expected: exit code 0，无输出。

- [ ] **Step 8: 提交旧版非 AI 后端**

```bash
git add server scripts tests
git commit -m "restore: recover legacy non-ai backend and quant"
```

---

## Task 4: 手工融合共享入口和依赖

**Files:**

- Modify: `server/index.js`
- Modify: `server/startup.test.js`
- Preserve: current-only root `index.js` (the legacy repository has no root entrypoint)
- Verify: `src/App.tsx`
- Verify: `src/components/Layout/MainLayout.tsx`
- Verify: `src/pages/index.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Verify: `wrangler.toml`

- [ ] **Step 1: 先把启动测试改成融合后的预期**

在 `server/startup.test.js` 中：

- 删除 `validateQuantStrategy.js` 的导入和两个 optional-module validator 测试；
- 将“缺少 quant 仍启动”改为“恢复 quant 后正常启动”；
- 将 `/api/quant/overview` 的预期从 500 改为 200，并断言 `body.success === true`；
- 保留根 `index.js` 启动、AI 路由公开、禁用后台任务、`RESEARCH_REPORTS_DIR` 五项测试。

Run:

```bash
node --test server/startup.test.js
```

Expected: FAIL，因为 `server/index.js` 仍使用即将删除的 optional quant 兼容层，或 quant 断言不符合融合目标。

- [ ] **Step 2: 融合 `server/index.js`**

以旧版非 AI 行为为基准，使用 `apply_patch` 做以下精确修改：

- 直接从 `./lib/quantStrategy.js` 导入 `getQuantOverview`、`runQuantBacktest`、`runQuantIteration`、`getQuantExperiments` 和 `backfillQuantHistory`；
- 删除 `validateQuantStrategy.js`、dynamic import 和 unavailable fallback；
- 保留当前 `createAiDashboardServiceFromEnv`、`createAiDashboardRouter`、ICE CDS pipeline/client 和 AI 自动刷新逻辑；
- 保留 `process.env.RESEARCH_REPORTS_DIR || ...`；
- 保留 `DISABLE_BACKGROUND_JOBS !== '1'` 的后台任务保护；
- AI 路由继续使用 `createAiDashboardRouter({ service, cdsPipeline })`；
- 非 AI API、调度频率和处理逻辑采用旧版；
- 不添加与本次融合无关的代理、认证或 Cloudflare 逻辑。

- [ ] **Step 3: 运行启动测试**

```bash
node --test server/startup.test.js
```

Expected: 全部通过；`/api/health`、`/api/quant/overview`、`/api/ai-dashboard` 均可用。

- [ ] **Step 4: 合并 `package.json` scripts**

保留当前所有 AI/ICE scripts 和依赖，同时加入：

```json
"test:quant": "node scripts/test_quant_strategy.mjs",
"quant:migrate": "node scripts/quant_migrate_kline_cache.mjs",
"quant:backfill": "node scripts/quant_backfill.mjs",
"quant:loop": "node --max-old-space-size=8192 --input-type=module -e \"import('./server/lib/quantStrategy.js').then(async ({ runQuantIteration }) => console.log(JSON.stringify(await runQuantIteration(), null, 2)))\""
```

必须继续使用：

```json
"server": "node index.js"
```

不得恢复旧版 `ai-dashboard:migrate` 和旧 AI migration test，因为新版 AI 看板已替代它们。

- [ ] **Step 5: 更新 lockfile 并测试量化脚本**

```bash
npm install --package-lock-only
npm run test:quant
```

Expected: lockfile 更新成功；量化测试通过。

- [ ] **Step 6: 检查三个前端共享入口**

对比旧版和当前版：

```bash
git diff --no-index /Users/ray_wang/Downloads/shifeng-investment/src/App.tsx src/App.tsx
git diff --no-index /Users/ray_wang/Downloads/shifeng-investment/src/components/Layout/MainLayout.tsx src/components/Layout/MainLayout.tsx
git diff --no-index /Users/ray_wang/Downloads/shifeng-investment/src/pages/index.ts src/pages/index.ts
```

Expected: 只允许 AI 看板 import、route、menu、export 的位置差异；不存在其他非 AI 行为差异。若出现非 AI 差异，用旧版对应片段覆盖。

- [ ] **Step 7: 检查 `wrangler.toml`**

```bash
git diff --no-index /Users/ray_wang/Downloads/shifeng-investment/wrangler.toml wrangler.toml
```

Expected: 本阶段不修改 Cloudflare 配置；若双方不同，保留当前文件并把差异写入最终报告，不在此任务解决。

- [ ] **Step 8: 提交共享入口融合**

```bash
git add server/index.js server/startup.test.js index.js src/App.tsx src/components/Layout/MainLayout.tsx src/pages/index.ts package.json package-lock.json wrangler.toml
git commit -m "feat: fuse legacy platform with current ai dashboard"
```

---

## Task 5: 验证新版 AI 看板未回退

**Files:**

- Verify: `src/pages/AIDashboard/**`
- Verify: `server/api/ai_dashboard.js`
- Verify: current AI/ICE/official-source services and tests
- Verify: `server/data/ai-dashboard/**`
- Modify only if a fusion-caused failure exists: shared imports in `server/index.js` or frontend shared entries

- [ ] **Step 1: 校验 AI 文件哈希**

使用 Task 1 完全相同的 `find ... | shasum` 命令生成 `/private/tmp/current-ai-files-after.sha256`，然后运行：

```bash
diff -u docs/recovery/current-ai-files.sha256 /private/tmp/current-ai-files-after.sha256
```

Expected: 无差异。若只因 Task 4 的共享入口未在清单内，则仍应无差异；任何 AI 文件内容差异都必须停止并恢复当前基准版本。

- [ ] **Step 2: 运行 AI API 和服务测试**

```bash
node --test server/api/ai_dashboard.test.js
node --test server/lib/ai*.test.js server/lib/artificialAnalysis*.test.js
node --test server/lib/iceCds*.test.js server/lib/isdaCds*.test.js
node --test server/lib/official*.test.js server/lib/publicSourceRegistry.test.js server/lib/sourceLedgerValidation.test.js server/lib/taskCostMetrics.test.js
node --test tests/aiDashboardViewModel.test.ts
```

Expected: 全部通过。若 shell pattern 未匹配文件，先用 `rg --files server/lib | rg` 列出实际测试，再运行实际存在的文件；不得把缺少测试误当通过。

- [ ] **Step 3: 验证 AI 数据源和前端构建**

```bash
npm run verify:ai-sources
npm run build
```

Expected: AI source validation 和 production build 均成功。

- [ ] **Step 4: 仅在发生融合兼容修复时提交**

如果为修复共享入口做了修改：

```bash
git add server/index.js src/App.tsx src/components/Layout/MainLayout.tsx src/pages/index.ts
git commit -m "fix: preserve ai dashboard across platform fusion"
```

若无修改，不创建空提交。

---

## Task 6: 全量验证并形成融合报告

**Files:**

- Create: `docs/recovery/platform-code-fusion-report.md`

- [ ] **Step 1: 运行前端静态检查和构建**

```bash
npm run lint
npm run build
```

Expected: 两项均通过。只修复由融合引起的问题；若当前 AI 基准本身已有 lint 问题，记录原始命令和错误，不扩大本次范围。

- [ ] **Step 2: 运行后端、量化和 Python 测试**

```bash
node --test server/startup.test.js
npm run test:quant
node --test server/api/*.test.js server/lib/*.test.js
python3 -m unittest discover -s tests -p 'test_*.py'
```

Expected: 全部实际存在的测试通过；启动测试证明健康、量化和 AI API 同时可用。

- [ ] **Step 3: 检查敏感文件和大文件未进入 Git**

```bash
git status --short
git diff --cached --name-only
git ls-files | rg '(^|/)(\.env|.*\.log$|__pycache__|.*\.pyc$)|\.(pdf|xlsx|xls|png|jpg|jpeg)$'
git ls-files -z | xargs -0 du -k | sort -nr | head -20
```

Expected: 无 `.env`、密钥、缓存、日志或本阶段新增的大型运行数据；任何图片若是既有前端静态资产，需在报告中注明，不删除既有合法资产。

- [ ] **Step 4: 编写融合报告**

`docs/recovery/platform-code-fusion-report.md` 必须包含：

```markdown
# Platform Code Fusion Report

## Sources
- Current AI baseline: `<sha>`
- Legacy repository HEAD: `<sha>`
- Legacy dirty worktree included: yes

## Result
- AI dashboard: current version preserved
- Non-AI frontend/backend: restored from legacy worktree
- Quant module and scripts: restored
- Shared entries: manually fused

## Verification
- `npm run lint`: `<pass/fail with reason>`
- `npm run build`: `<pass/fail with reason>`
- Node tests: `<count and result>`
- Python tests: `<count and result>`
- AI hash comparison: `<identical/difference explained>`

## Deferred
- Historical runtime data migration
- Old Codex task integration
- Cloudflare architecture and deployment
```

填写所有尖括号字段，不得保留占位符。

- [ ] **Step 5: 最终提交并确认工作树干净**

```bash
git add docs/recovery/platform-code-fusion-report.md
git commit -m "docs: record platform code fusion verification"
git status --short
git log --oneline --decorate -8
```

Expected: `git status --short` 无输出；日志包含来源快照、前端恢复、后端量化恢复、共享入口融合和验证报告提交。

- [ ] **Step 6: 停止在融合分支，不部署、不合并主分支**

向用户汇报测试结果和 worktree 路径，等待用户确认后再决定是否合并。Cloudflare、历史数据和旧 Codex 任务均不在本计划内。
