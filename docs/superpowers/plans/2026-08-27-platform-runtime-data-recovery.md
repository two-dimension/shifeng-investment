# Platform Runtime Data Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让融合后的本机 5173 平台重新显示旧仓库的非 AI 历史数据，并让旧 Codex 任务目录在新电脑路径下可被研究同步服务发现。

**Architecture:** Git 继续只保存代码和迁移报告；大体积 JSON、PDF、XLSX、PNG、量化及 TMT 缓存从旧仓库只读复制到当前仓库的 ignored 目录。现有新电脑运行数据不覆盖，AI 看板数据目录完全排除。研究同步代码通过统一任务根目录解析新电脑的 `石锋平台要用的` 文件夹，同时保留显式环境变量优先级。

**Tech Stack:** Node.js ESM、Express 5、Node test runner、React/Vite、rsync、Git worktree。

**Spec:** `docs/superpowers/specs/2026-08-27-platform-recovery-fusion-design.md`

## Global Constraints

- `/Users/ray_wang/Downloads/shifeng-investment` 与 `/Users/ray_wang/Downloads/石锋平台要用的` 只读。
- 不覆盖当前仓库中已经存在的运行数据；新闻归档按 entry id 合并。
- 不从旧仓库复制 `server/data/ai-dashboard/`。
- 不把运行数据、报告、缓存或凭据加入 Git。
- 代码修改先写失败测试，再写最小实现。

---

### Task 1: 保存迁移前证据并停止旧后端进程

**Files:**

- Create: `docs/recovery/platform-runtime-data-recovery-report.md`

**Interfaces:**

- Consumes: 当前 3000 端口 API、旧仓库运行数据目录。
- Produces: 可核对的迁移前文件数、容量和 API 空白状态。

- [ ] **Step 1: 记录当前与旧仓库容量和关键文件数**

Run:

```bash
du -sh server/data /Users/ray_wang/Downloads/shifeng-investment/server/data
rg --files -uu server/data/research server/public/reports | wc -l
rg --files -uu /Users/ray_wang/Downloads/shifeng-investment/server/data/research /Users/ray_wang/Downloads/shifeng-investment/server/public/reports | wc -l
```

Expected: 当前研究数据为 0；旧仓库研究摘要和报告合计 804 个文件。

- [ ] **Step 2: 在报告中记录 API 现状**

写入已验证事实：研究三类 latest 均为 `null`，MACD 返回 500，TMT 返回 503，ETF 上游 8000 未运行，当前后端启动早于融合提交。

- [ ] **Step 3: 停止 3000 端口的融合前后端进程**

先用 `lsof -nP -iTCP:3000 -sTCP:LISTEN` 确认精确 PID，再只终止该 PID。

Expected: 3000 端口释放；5173 Vite 保持运行。

### Task 2: 恢复非 AI 运行数据

**Files:**

- Populate (Git ignored): `server/data/**`，排除 `server/data/ai-dashboard/**`
- Populate (Git ignored): `server/public/reports/**`
- Populate (Git ignored): `macd screener/*.xlsx`
- Preserve: 当前 `server/data/news.json`、`server/data/calendar/events.json`、`server/data/funds.json` 和整个 `server/data/ai-dashboard/**`

**Interfaces:**

- Consumes: 旧仓库只读运行数据。
- Produces: 当前平台可直接读取的研究、MACD、TMT、量化和价格历史。

- [ ] **Step 1: 预览只补缺失文件的数据同步**

Run:

```bash
rsync -ain --ignore-existing --exclude='/ai-dashboard/***' /Users/ray_wang/Downloads/shifeng-investment/server/data/ server/data/
rsync -ain --ignore-existing /Users/ray_wang/Downloads/shifeng-investment/server/public/reports/ server/public/reports/
rsync -ain --ignore-existing --include='*.xlsx' --exclude='*' '/Users/ray_wang/Downloads/shifeng-investment/macd screener/' 'macd screener/'
```

Expected: AI 目录和当前已有文件不在复制清单；研究、量化、TMT、报告和 MACD 缓存出现在清单中。

- [ ] **Step 2: 执行相同过滤条件的正式同步**

将三条命令的 `-ain` 改为 `-a`，其他参数保持完全一致。

- [ ] **Step 3: 合并新旧新闻归档**

读取当前和旧仓库的 `server/data/news.json`，按 entry `id` 去重，当前同 id 的 entry 优先；按 `createdAt` 降序保存，并保留时间较新的 `lastUpdated`、`lastCheckedAt` 和 `refreshStatus`。

Expected: 当前 11 个 entries 和旧仓库 50 个 entries 均不丢失，合并结果至少 50 个 entries。

- [ ] **Step 4: 核对迁移结果**

Run:

```bash
du -sh server/data server/public/reports
rg --files -uu server/data/research server/public/reports | wc -l
git status --short
```

Expected: 运行数据恢复到 GB 级；研究数据和报告合计至少 804 个文件；Git 状态不新增 ignored 运行文件。

### Task 3: 用新电脑任务目录替代旧用户名硬编码

**Files:**

- Modify: `server/lib/researchSync.js`
- Create: `server/lib/researchSync.paths.test.js`

**Interfaces:**

- Consumes: `SHIFENG_TASKS_DIR`、`CNINFO_OUTPUT_DIR`、`EARNINGS_OUTPUT_DIR`、`EARNINGS_REPORT_OUTPUT_DIR`、`RISK_OUTPUT_DIR`。
- Produces: `getResearchSourceStatus()` 返回新电脑实际存在的四类任务根目录。

- [ ] **Step 1: 写失败测试**

测试创建临时 `石锋平台要用的` 根目录和四类子目录，设置 `SHIFENG_TASKS_DIR` 后动态导入 `researchSync.js`，断言：

```js
assert.equal(status.cninfo.root, path.join(tasksRoot, '巨潮资讯', 'output'));
assert.equal(status.earnings.root, path.join(tasksRoot, '业绩预告', '业绩预告'));
assert.equal(status['earnings-report'].root, path.join(tasksRoot, '业绩报告', '业绩报告'));
assert.equal(status.risk.root, path.join(tasksRoot, '风险提示', 'output'));
```

- [ ] **Step 2: 运行测试并确认正确失败**

Run:

```bash
node --test server/lib/researchSync.paths.test.js
```

Expected: FAIL，实际路径仍指向 `/Users/rayw/Documents/...`。

- [ ] **Step 3: 写最小路径解析实现**

在 `researchSync.js` 中让显式的四个 `*_OUTPUT_DIR` 变量优先；否则从 `SHIFENG_TASKS_DIR` 解析四类任务目录；未设置时优先使用 `~/Downloads/石锋平台要用的`，最后才兼容旧 `/Users/rayw/Documents` 目录。

- [ ] **Step 4: 运行测试并确认通过**

Run:

```bash
node --test server/lib/researchSync.paths.test.js server/api/research.test.js
```

Expected: 全部通过。

- [ ] **Step 5: 提交代码和报告**

```bash
git add server/lib/researchSync.js server/lib/researchSync.paths.test.js docs/recovery/platform-runtime-data-recovery-report.md docs/superpowers/plans/2026-08-27-platform-runtime-data-recovery.md
git commit -m "fix: restore non-ai runtime data discovery"
```

### Task 4: 重启服务并逐页验收

**Files:**

- Update: `docs/recovery/platform-runtime-data-recovery-report.md`

**Interfaces:**

- Consumes: 恢复后的 ignored 数据和已修复任务路径。
- Produces: 3000 API 与 5173 页面验收证据。

- [ ] **Step 1: 启动融合后的 3000 后端**

Run:

```bash
SHIFENG_TASKS_DIR='/Users/ray_wang/Downloads/石锋平台要用的' npm run server
```

Expected: `/api/health` 返回 200；进程加载融合后的后端代码。

- [ ] **Step 2: 验证关键 API**

检查 `/api/research/cninfo/latest`、`/earnings/latest`、`/risk/latest`、`/api/macd`、`/api/tmt-margin`、`/api/news`。

Expected: 研究、MACD、TMT 和新闻均返回非空历史数据。ETF `/api/etf-monitor/overview` 若仍为 503，必须明确记录缺少独立 `etf_monitor` 项目，而不是误报平台融合完成。

- [ ] **Step 3: 浏览器逐页验证**

在 `http://localhost:5173` 检查首页、新闻、日历、子集、MACD、拥挤度、公告监控和 AI 看板；采集 DOM、控制台和截图证据。

Expected: 公告、MACD、TMT 不再空白；AI 看板保持新版本；ETF 独立服务若缺失则只保留一项明确降级提示。

- [ ] **Step 4: 运行回归验证**

Run:

```bash
node --test server/startup.test.js server/api/*.test.js server/lib/*.test.js server/scripts/*.test.js tests/*.test.ts
python3 -m unittest discover -s tests -p 'test_*.py'
npm run test:quant
npm run build
shasum -a 256 -c docs/recovery/current-ai-files.sha256
```

Expected: 自动化测试、构建和 AI 哈希检查全部通过；已知 donor lint 问题仍按原报告记录。

