# ICE 5Y CDS 云端连续记录设计

日期：2026-08-25

## 1. 背景与目标

现有 AI 看板已经能够从 ICE 免费公开接口读取七家公司最新的单名 CDS EOD Price，结合美国财政部期限曲线换算 5Y CDS spread，并把结果写入本地 Excel 和 JSON 快照。当前定时器运行在 Express 进程内：电脑关机、服务重启或部署中断时不会执行，而且恢复后只能读取 ICE 公开接口当时仍可见的数据，不能保证补回已经从接口消失的日期。

本设计新增一个独立于用户电脑和网页服务的云端采集系统。系统从上线时开始持续保存 ICE 已发布的每个目标观察日，保留原始输入、计算结果、修订记录和运行状态，并向现有 AI 看板及 Excel 导出提供稳定数据。

“严格每日记录”在本项目中定义为：

- 记录对象是 ICE 实际发布的结算日，不为周末、节假日或 ICE 未发布日伪造数据；
- ICE 免费接口出现七家目标公司的新结算数据后，系统必须自动持久化，不依赖用户电脑；
- 调度和写入采用至少一次执行，重复执行不得产生重复记录；
- 采集、计算或发布失败必须自动重试，并保留上一成功批次；
- 无法从上游取得的数据必须标记缺失并告警，不能填零或复制前日数值。

系统不能保证 ICE 本身一定发布数据，也不能恢复系统上线前已经不再由免费接口提供的精确原始记录。

## 2. 方案选择

采用 Cloudflare Worker、Durable Object Alarm 和 D1：

- Durable Object Alarm 自调度，每 30 分钟检查一次来源；Cron Trigger 每小时只做一次 Alarm 存活检查，防止首次部署或意外状态丢失；
- Alarm 使用平台提供的至少一次执行和失败重试；
- D1 是长期事实源，保存原始观察、贴现曲线、派生 spread、发布批次和运行审计；
- 现有 Express 服务通过只读采集 API 获取 D1 历史；
- Excel 由 D1 中的完整历史按需生成，不再承担唯一事实源角色。

不采用以下方案：

- GitHub Actions 定时任务：官方明确说明调度可能延迟，极端负载下排队任务可能被丢弃，不满足连续采集要求；
- 本机 `launchd` 或 Express 定时器：依赖电脑和进程持续运行；
- 每日自动提交二进制 Excel 到 Git：审计可见，但 Git 不是合适的高频运行数据库，二进制文件无法可靠合并。

## 3. 系统边界

### 3.1 新增组件

在独立目录 `cloudflare/ice-cds-collector/` 建立采集 Worker，包含：

1. `scheduled` 入口：每小时唤醒固定的 Durable Object，并确保下一次 Alarm 已设置；
2. Durable Object：维护下一次 Alarm，并执行采集状态机；
3. ICE 客户端：读取免费单名 EOD Price JSON；
4. Treasury 客户端：读取对应年份的美国财政部日度期限曲线 CSV；
5. 合约选择器：复用七家公司注册表和 5Y 合约规则；
6. 换算器：复用现有 clean-price-to-par-spread 口径；
7. D1 存储库：执行幂等写入、修订保存和完整批次发布；
8. 只读 API：向现有后端提供最新批次、历史和健康状态。

### 3.2 现有服务调整

Express 的 AI 看板服务新增 D1 采集 API 适配器。读取顺序为：

1. 云端采集 API 的最新完整批次；
2. 云端不可用时使用本地 last-good 快照；
3. 两者都不存在时显示不可用，绝不显示 0。

现有进程内 ICE 日更定时器在云端系统通过验收后关闭，避免产生两个独立事实源。手动导入入口保留为应急工具，但写入必须进入同一云端数据结构，不能建立平行历史。

## 4. 数据模型

D1 使用迁移管理以下表。

### 4.1 `collector_runs`

记录每次 Alarm 的开始时间、结束时间、触发类型、来源响应、候选结算日、写入数量、结果、错误代码和下一次 Alarm。运行记录只追加。

### 4.2 `ice_eod_revisions`

保存 ICE 原始观察的每个不同版本：

- `clearing_date`；
- `company`；
- `ice_name`；
- `instrument_name`；
- `eod_price`；
- `payload_hash`；
- `retrieved_at`；
- `source_url`。

唯一键为 `clearing_date + company + instrument_name + payload_hash`。相同载荷重复抓取不新增行；同日期数值被 ICE 修订时追加新版本，不覆盖旧版本。

### 4.3 `ice_eod_current`

保存每个结算日、公司和合约当前有效版本，唯一键为 `clearing_date + company + instrument_name`，并指向 `ice_eod_revisions`。它只用于快速计算，完整审计仍来自 revisions 表。

### 4.4 `treasury_curve_nodes`

按 `as_of + years` 保存财政部期限节点、原始收益率、换算后的零利率代理值、来源和抓取时间。曲线日期不得晚于 ICE 结算日。

### 4.5 `cds_spread_revisions`

保存每次有效输入组合对应的换算结果：spread、票息、到期日、曲线日期、回收率、模型版本、反算价格、价格残差和质量状态。唯一键包含结算日、公司、原始版本、曲线 ID 和模型版本。

### 4.6 `published_batches`

完整批次以 `clearing_date` 唯一。只有七家公司均通过合约选择、数值校验和换算后，才在一个 D1 事务中标记为 `published`。部分数据可以提前进入原始表，但不得成为看板最新批次。

### 4.7 `seed_history`

用户截图回填历史继续保留，但明确标记 `source_kind = screenshot_backfill`。2026-08-24 起的 ICE 公开数据标记为 `source_kind = ice_eod_isda`。两个来源可以在一张趋势图中连续展示，但 tooltip、Excel 和 API 必须能区分。

## 5. 采集与调度状态机

Durable Object Alarm 每 30 分钟执行一次：

1. 在网络请求之前先安排下一次 Alarm，防止当前执行异常中断后失去后续调度；
2. 请求 ICE 免费接口并验证响应类型、大小和有效日期；
3. 对七家公司分别选择规范 5Y 合约，不要求等待全市场所有发行人同步；
4. 立即幂等保存已出现公司的原始版本；
5. 查找尚未发布且原始数据已齐全的结算日；
6. 读取该日或此前最近的财政部曲线；
7. 对七家公司换算 spread，并执行反算价格校验；
8. 在一个事务内保存派生结果并发布完整批次；
9. 写入运行审计和健康状态。

同一个 Alarm 被重复执行不会产生重复结果。来源部分发布时只保存已经出现的公司，后续轮次补齐其余公司。来源超时、429、5xx、CSV 不完整或计算失败时，处理器在 `catch` 中设置较短的下一次 Alarm 后重新抛出错误，让平台执行自动重试；每小时 Cron 心跳还会检查并修复缺失的 Alarm。

## 6. 缺失检测和补漏

系统不使用自然日强行推断 ICE 交易日。缺失检测分两层：

- 来源日期推进后，如果某个日期只出现部分目标公司，则批次保持 `partial` 并持续补抓；
- 最后完整批次超过两个美国工作日没有推进时，健康状态变为 `stale`，看板显示红色告警。

这里的“美国工作日”只用于新鲜度告警：按纽约时区的周一至周五并排除美国联邦假日计算。它不被当作 ICE 结算日，也不会据此生成市场数据。

每次采集都会扫描 D1 中所有 `partial` 日期，而不只处理最新日期。只要 ICE 当前响应仍包含缺失记录，系统就会补齐并重新发布。免费接口已经不再提供的历史记录不会用估算替代；状态保持 `missing-upstream`，等待人工提供可核验原始行或未来授权历史接口。

## 7. API 与访问控制

采集 Worker 对看板提供只读接口：

- `GET /v1/cds/latest`：最新完整批次；
- `GET /v1/cds/history?from=&to=`：分页历史和来源标记；
- `GET /v1/cds/health`：最后成功时间、partial 日期、缺失公司、连续失败次数和下一次 Alarm；
- `GET /v1/cds/export-source`：供 Express 生成 Excel 的完整审计数据。

应急人工导入使用独立的 `POST /internal/v1/cds/import`。该接口只接受已通过现有预览校验的七家公司原始行，使用单独的写 Token，并复用与 Alarm 完全相同的 D1 存储和发布流程。它不向浏览器直接暴露，Express 只允许本机受控操作调用。

读写接口分别要求不同的服务端 Bearer Token。Token 存放在 Cloudflare Secret 和现有后端环境变量中，不进入浏览器、日志或仓库。Worker 不提供匿名写接口；Cron、Alarm、受控迁移和内部应急导入是允许的写入路径。

请求限制日期范围、分页大小和响应体大小。错误返回稳定错误代码，不返回密钥、D1 SQL 或上游完整响应。

## 8. Excel 与看板

现有 `GET /api/ai-dashboard/cds/export.xlsx` 改为：

1. 从采集 API 读取完整历史；
2. 使用现有七工作表模板生成工作簿；
3. 校验原始行、派生行、公式、批次 ID 和来源标签；
4. 返回下载文件；
5. 云端暂时不可用时允许导出最近一次本地 last-good Excel，并在 Methodology 页标明生成时间。

看板仍展示七张摘要卡和七条趋势曲线。最新值只能来自 `published` 批次；历史截图点显示“用户截图曲线回填（近似）”，ICE 点显示“ICE EOD Price · 模型换算”。页面增加：

- 最后完整结算日；
- 最近采集时间；
- 数据状态：正常、部分发布、过期或来源失败；
- 缺失公司；
- 云端历史 Excel 下载。

## 9. 一致性与故障恢复

- 原始观察先于派生结果写入；任何计算失败都不会丢失已抓到的原始值；
- 完整批次使用 D1 事务发布，避免七家公司跨批次混合；
- API 永远只返回最新完整批次，partial 数据只出现在健康状态；
- 相同日期被 ICE 修订时保存修订版本，重新计算并以新批次修订号发布；
- Express 保留 last-good 快照，云端 API 失败时继续显示并标记 stale；
- D1 是事实源，Excel、JSON 和页面都是可重建投影；
- D1 的平台备份能力用于灾难恢复，应用层仍保留可导出的审计记录。

## 10. 可观测性

每次 Alarm 记录结构化日志和 `collector_runs`。健康接口至少返回：

- `lastAlarmAt`；
- `lastSourceSuccessAt`；
- `lastPublishedDate`；
- `consecutiveFailures`；
- `partialDates` 及缺失公司；
- `nextAlarmAt`；
- `stale` 和原因。

一期告警显示在 AI 看板并保留 Cloudflare 日志。超过两个美国工作日未发布、连续六次来源失败、D1 写入失败或合约选择变化都进入红色状态。邮件、短信或企业微信通知不在一期范围，后续可根据用户选择接入。

## 11. 安全与成本

- 所有上游 URL 固定在允许列表，拒绝重定向到非允许域名、私网地址和非 HTTPS 地址；
- 对 ICE JSON 和财政部 CSV 设置超时、最大字节数、字段白名单和行数上限；
- D1 SQL 使用参数绑定；
- Token 只存在 Secret；
- 手动写入必须经过现有本地写入保护和审计，不向互联网开放；
- 每天约数百次查询和数十行写入，远低于 D1 免费计划的日常额度，但部署前仍检查账户配额和告警。

## 12. 测试与验收

测试遵循先失败后实现，实时网络不进入单元测试。覆盖：

- Alarm 首次创建、自调度和失败后仍保留下一次执行；
- 相同来源响应重复 100 次只产生一组 current 记录；
- ICE 修订同日期价格时保存两个 revision、一个 current；
- 七家公司分三次到达时，前两次保持 partial，第三次原子发布；
- Treasury 曲线缺失、晚于结算日或字段不完整时不发布；
- 两个并发 Alarm 不产生重复批次；
- Worker 重启、Alarm 重试和 D1 暂时失败后的恢复；
- `latest`、`history`、`health` 和分页 API 契约；
- Bearer Token、URL allowlist、响应大小和错误脱敏；
- 截图历史种子与 ICE 历史来源隔离；
- D1 历史生成 Excel 后，七张表、公式和批次值一致；
- Express 云端失败时回退 last-good 并标记 stale；
- 连续两个模拟 ICE 结算日的端到端采集和页面显示；
- lint、Worker 类型检查、D1 迁移测试、完整服务端测试和生产构建。

上线验收要求：

1. 迁移现有截图历史和 2026-08-24 ICE 批次；
2. 在测试环境模拟部分发布、重复执行、修订和来源失败；
3. 云端连续观察至少两个实际 ICE 结算日；
4. D1、API、Excel 和页面逐家公司核对一致；
5. 确认健康状态和 stale 告警生效后，再关闭 Express 进程内定时器。

## 13. 部署与回滚

部署顺序：

1. 创建 D1 数据库和迁移；
2. 部署无 Alarm 的 Worker，只开放受保护健康接口；
3. 导入截图历史和现有 ICE/Excel 数据；
4. 启用 Durable Object Alarm，验证幂等采集；
5. 更新 Express 读取云端数据，但保留本地 last-good；
6. 连续观察两个结算日；
7. 关闭 Express 内的 ICE 定时器。

出现异常时先禁用 Alarm，不删除 D1 数据；Express 切回本地 last-good。迁移和 Worker 版本可回滚，已经写入的 revision 不回退或覆盖。

## 14. 方法与平台依据

- ICE 单名 CDS 免费接口：https://www.ice.com/api/cds-settlement-prices/icc-single-names
- ICE Settlement Prices 页面：https://www.ice.com/cds-settlement-prices/icc/single-name-instruments
- 美国财政部期限利率：https://home.treasury.gov/resource-center/data-chart-center/interest-rates
- Cloudflare Cron Triggers：https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Cloudflare Durable Object Alarms：https://developers.cloudflare.com/durable-objects/api/alarms/
- Cloudflare D1：https://developers.cloudflare.com/d1/
- GitHub Actions schedule 限制：https://docs.github.com/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
