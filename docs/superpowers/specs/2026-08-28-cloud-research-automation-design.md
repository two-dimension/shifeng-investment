# 公告监控云端自动化设计

## 目标

把“公告监控”从本机搬到云端：电脑关机后仍能定时抓取、生成研判并保存结果；用户打开页面时先看到已有缓存，如果缓存过期，系统自动在云端更新。更新失败不能清空旧数据。

第一版采用 GitHub Actions + Cloudflare Worker + D1 + R2：

- GitHub Actions 运行四套现有 Python 任务；
- Cloudflare Worker 提供网站和 `/api/research/*` 接口；
- D1 保存公告研判 JSON、历史日期和任务状态；
- R2 保存 PDF、Excel 等下载文件；
- 不接 Google Drive，也不依赖任何一台个人电脑。

## 现有能力与迁移范围

保留当前页面和数据契约，覆盖四个现有栏目：

- `cninfo`：公告研判；
- `earnings`：业绩预告；
- `earnings-report`：业绩报告；
- `risk`：风险提示。

四套旧任务的当前源码迁入仓库，但不复制它们各自的 `.git`、缓存、历史输出、邮件发送、launchd 配置或凭据。源码里的 `/Users/rayw/...` 等本机绝对路径统一改为相对路径或环境变量。当前 `researchSync` 的标准化结果继续作为前后端契约，避免重做公告页面。

## 总体架构

Cloudflare Worker 同时承载前端静态文件和公告 API。请求 `/api/*` 时先进入 Worker，其余请求交给 Vite 构建后的静态资源。配置从 `wrangler.toml` 迁到 `wrangler.jsonc`，声明 Worker 入口、静态资源、D1 和 R2 绑定。

本次只把公告监控的数据能力搬上云，不假装其他本机 API 已经云化。主域名切到 Worker 后，网站外壳和公告监控始终可用；新闻、持仓、行情等仍依赖本机 Express 的接口，电脑在线时由 Worker 转发到一个独立的 Tunnel 源站域名，电脑关机时这些接口明确返回 `503`，不会被误当成空数据。后续可以再按模块逐个迁移。

数据流如下：

1. 用户打开公告监控，页面立即读取 D1 中最后一次成功结果；
2. 页面同时请求一次刷新接口；
3. Worker 判断整套数据是否超过 6 小时，且当前没有任务运行；
4. 需要更新时，Worker 通过 GitHub `repository_dispatch` 启动工作流；
5. GitHub Actions 依次运行四套任务，生成统一 JSON 和报告文件；
6. Action 使用受保护的发布接口把 JSON 写入 D1、文件写入 R2；
7. 全部发布完成后才把任务标记为成功；页面轮询到成功后自动重新读取数据。

GitHub Actions 另设每日定时运行。打开页面触发只是兜底检查，并非每次打开都重复抓取。

## D1 数据设计

`research_summaries` 保存可直接返回给现有前端的完整 JSON：

```sql
CREATE TABLE research_summaries (
  kind TEXT NOT NULL,
  date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL,
  PRIMARY KEY (kind, date)
);
CREATE INDEX research_summaries_latest
  ON research_summaries (kind, date DESC);
```

`research_refresh_state` 保存全局任务锁和最后成功时间：

```sql
CREATE TABLE research_refresh_state (
  scope TEXT PRIMARY KEY,
  job_id TEXT,
  status TEXT NOT NULL,
  requested_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  last_success_at TEXT,
  last_error TEXT
);
```

第一版只使用 `scope = 'all'`，保证同一时间最多运行一套四任务工作流。状态为 `idle`、`queued`、`running`、`success` 或 `failed`。

## R2 文件设计

报告文件使用固定键名：

```text
research/{kind}/{date}/{filename}
```

摘要 JSON 中继续携带现有 `files` 列表，Worker 通过受控下载路由读取 R2，补齐正确的 `Content-Type` 和 `Content-Disposition`。当前约 44 MB、596 个文件可在首次部署时一次性迁入，页面上线后不会从空白状态开始。

## API 契约

公开读取接口保持与当前 Express 版本一致：

- `GET /api/research/:kind/latest`
- `GET /api/research/:kind/history`
- `GET /api/research/:kind/:date`
- `GET /api/research/files/:kind/:date/:filename`

除 `/api/research/*` 外的 `/api/*` 请求由 Worker 转发至非敏感配置 `LEGACY_API_ORIGIN`。该地址必须是与主站不同的 Tunnel 源站域名，防止请求递归；未配置或源站离线时返回结构化 `503`。

刷新接口改为云端语义：

- `POST /api/research/refresh`：检查新鲜度和任务锁，必要时启动 GitHub Action；
- `GET /api/research/refresh/status`：返回当前状态、最后成功时间和错误信息。

内部发布接口不对普通页面开放：

- 写入单日摘要；
- 上传单个报告文件；
- 标记任务开始、成功或失败。

这些接口要求 `Authorization: Bearer` 加发布密钥。公开读取不需要登录。

## 刷新与防重复

缓存新鲜时间设为 6 小时。页面打开和手动刷新都使用同一个全局锁：

- 缓存新鲜：直接返回 `fresh`，不启动任务；
- 已有 `queued` 或 `running`：返回当前任务，不重复启动；
- 缓存过期且没有活动任务：先在 D1 原子写入 `queued`，再发出 GitHub dispatch；
- dispatch 失败：把状态写为 `failed`，但保留旧摘要；
- 任务超过安全时限仍未结束：下次检查可将旧锁标记失败后重新启动。

GitHub 工作流再使用一个固定 `concurrency` 组，并禁止取消正在运行的任务，形成第二层防重。

## GitHub Actions 工作流

新增 `.github/workflows/cloud-research.yml`，支持：

- Cloudflare 发出的 `repository_dispatch`；
- GitHub 页面上的手动运行；
- 每日定时运行。

工作流安装固定版本的 Python/Node 依赖和报告所需字体，依次运行四套任务，再调用仓库中的统一发布脚本。发布顺序为“报告文件 → 单日摘要 → 任务成功状态”。任何步骤失败时记录失败状态，不删除 D1/R2 中最后一次成功数据。

工作流必须先合并到 GitHub 默认分支，`repository_dispatch` 才能触发它。仓库为公开仓库，标准 GitHub Actions 分钟不收费；Cloudflare 的实际额度仍以账号控制台为准，但当前数据量和调用频率远低于该架构的常见免费额度。

## 密钥与权限

代码库中不保存任何令牌：

- Cloudflare Secret：`GITHUB_DISPATCH_TOKEN`、`RESEARCH_PUBLISH_TOKEN`；
- GitHub Secret：`CLOUD_RESEARCH_BASE_URL`、`RESEARCH_PUBLISH_TOKEN`。

GitHub dispatch token 只授予目标仓库所需的最小 Contents 写权限。发布 token 在 Worker 中做恒定时间比较，上传接口限制文件大小、栏目、日期和文件名，避免任意路径写入。日志只记录任务 ID、栏目、日期和数量，不打印密钥或完整请求头。

## 前端体验

公告页面不等待云端任务完成才展示：

- 有缓存时立即展示；
- 后台更新时显示“云端更新中”；
- 更新成功后自动刷新四个栏目的日期和当前内容；
- 更新失败时显示简短警告，并继续展示最后一次成功数据；
- 页面反复打开不会产生多个 GitHub 任务。

## 首次迁移与部署

新增一次性迁移脚本，把当前已经恢复的 208 份摘要 JSON 和 596 个报告文件上传至 D1/R2。正式切换顺序为：

1. 创建 D1 数据库、R2 bucket 并应用迁移；
2. 配置 Cloudflare/GitHub secrets；
3. 部署 Worker 和前端；
4. 上传现有历史数据；
5. 合并工作流到默认分支；
6. 手动运行一次完整任务并检查页面。

如果账号尚未登录或还没有 Cloudflare 资源，代码仍可先完整实现和本地验证，最后只需要用户完成一次账号授权。

## 测试与验收

实现按测试先行进行：

- Worker 测试覆盖 latest/history/date/files、D1 查询、R2 下载、发布鉴权和输入限制；
- 刷新测试覆盖 6 小时新鲜度、全局锁、重复打开、dispatch 失败、超时解锁和失败保留旧数据；
- Python/Node 任务测试覆盖相对路径、四任务运行和标准化输出；
- 前端测试覆盖缓存先展示、刷新状态轮询、成功重载和失败不清屏；
- 最终运行全部现有 Node 测试、Python 测试和生产构建。

验收标准是：本机服务关闭、电脑关机后，GitHub 定时任务仍可更新；任意设备打开 Cloudflare 网站能看到历史缓存；数据过期时只启动一个云端任务；任务失败时旧数据仍然可用。

## 非目标

第一版不把抓取程序直接塞进 Cloudflare Worker，不引入 Google Drive，不增加付费数据库，不重做公告监控 UI，也不把新闻、持仓、行情、AI 看板等其他本机 API 一并迁上云。
