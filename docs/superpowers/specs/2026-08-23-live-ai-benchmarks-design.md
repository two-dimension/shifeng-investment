# AI 看板在线 Benchmark 同步设计

日期：2026-08-23

## 1. 目标

将 AI 看板的 Benchmark 模块从“飞书工作表为主”改为“在线标准化数据源为主、飞书与本地快照为回退”。看板始终只比较每个厂商最新发布的一个模型，并在进入 Benchmark 页签、手动刷新和后台定时任务中获取最新评测数据。

本次改动不调用模型推理接口，不运行自建 Benchmark，也不抓取厂商宣传网页。在线核心数据来自 OpenRouter 的统一 Benchmark API，范围包括 Artificial Analysis、Design Arena 和 OpenRouter 自有评测。

## 2. 现状与问题

当前 Benchmark 数据由飞书“模型基准测试”工作表解析后写入 `AiDashboardSnapshot.benchmarks`。这一方式可以保留人工数据，但存在三项限制：

- 新模型和新分数依赖人工更新；
- 数据日期、评测版本和来源难以统一；
- 用户进入 Benchmark 页签时无法主动检查在线新数据。

现有“每个厂商最新模型”“左侧分项冠军”“排除 Fable/Mythos”“并列第一”规则继续保留。

## 3. 数据源与权威顺序

### 3.1 主数据源

1. OpenRouter 模型目录：`GET https://openrouter.ai/api/v1/models?output_modalities=text`
   - 用于识别模型厂商、模型标识和发布时间；
   - 同一模型的免费变体、别名或路由变体不视为新模型；
   - 只保留每个厂商发布时间最新的规范模型。

2. OpenRouter Benchmark API：`GET https://openrouter.ai/api/v1/benchmarks`
   - Artificial Analysis：Intelligence、Coding、Agentic 等综合指数；
   - Design Arena：不同 arena/category 的 ELO、胜率和排名；
   - OpenRouter：GPQA、τ-bench 和搜索类评测等已公开结果。

上述接口使用服务端环境变量 `OPENROUTER_API_KEY`。密钥不返回前端，也不写入快照或日志。

### 3.2 回退顺序

在线同步失败时按以下顺序回退：

1. 上一次成功的在线 Benchmark 快照；
2. 当前飞书“模型基准测试”标准化结果；
3. 无数据状态。

回退时必须显示来源、上次成功日期、失败原因和 `stale` 状态。不得把缺失值显示为 0，也不得用旧模型的分数冒充厂商最新模型。

## 4. 最新模型选择规则

每个厂商最终只能出现一行：

1. 厂商范围取 Benchmark API 中至少有一项评测的厂商，并补充飞书当前跟踪但 OpenRouter 尚未覆盖的厂商；
2. 从 OpenRouter 文本模型目录获取上述厂商的规范模型；
3. 过滤 `:free` 等价格或路由变体，并将可识别的别名归并到规范模型；
4. 按 OpenRouter 模型目录的 `created` 发布时间降序选择该厂商最新模型；
5. 发布时间相同时以稳定的模型 slug 排序，确保结果可复现；
6. 将 Benchmark API 返回的 `model_permaslug` 与最新模型连接；
7. 最新模型尚未被某个来源评测时保留该模型行，相关单元格显示“尚未评测”。

厂商名称使用稳定映射表规范化，例如 `openai`、`anthropic`、`google`、`deepseek`、`qwen/alibaba`、`z-ai/zhipu`、`moonshotai` 和 `minimax`。无法识别的厂商使用模型 slug 的命名空间，不丢弃记录。

## 5. 指标标准化与可比性

每个分数统一带以下元数据：

- `source`：`artificial-analysis`、`design-arena`、`openrouter` 或 `feishu`；
- `benchmarkKey`：来源、评测类型、arena/category 和必要配置组成的稳定键；
- `label`：页面显示名称；
- `value` 与 `unit`；
- `direction`：`higher` 或 `lower`；
- `asOf`；
- `sourceUrl` 和引用文本；
- 可选的样本量、标准差、平均成本和运行配置。

同名但来源、版本、arena/category 或运行配置不同的评测不得合并为一列。冠军只在同一个 `benchmarkKey` 内计算，并正确处理并列第一。Fable/Mythos 可以保留在矩阵中，但继续排除在冠军计算之外。

价格、成本和延迟类指标为 `lower-is-better`；准确率、指数、ELO、胜率和任务成功率为 `higher-is-better`。没有明确方向的未知指标不参与冠军计算，直到适配器补充定义。

## 6. 快照与接口设计

`AiDashboardSnapshot` 新增独立的 `sources.benchmarks` 状态，避免把 Benchmark 新鲜度混入 OpenRouter Token 排名状态。`benchmarks` 增加：

- `models`：每个厂商最新模型；
- `metrics`：标准化指标定义；
- `winners`：按稳定指标键生成的冠军；
- `asOf`、`sourceMode` 和 `coverage`；
- `attributions`：实际使用的数据源及引用。

现有 `POST /api/ai-dashboard/refresh` 支持请求体：

```json
{
  "sources": ["benchmarks"],
  "force": false
}
```

未提供 `sources` 时保持全量刷新。服务端只接受白名单来源，忽略或拒绝未知值。`force: true` 仅用于显式手动刷新；普通页签进入使用新鲜度判断。

快照继续采用原子写入。在线同步必须先完成模型目录和 Benchmark 数据的完整校验，再一次性替换 Benchmark 切片，不能发布半张矩阵。

## 7. 刷新行为

- 进入 Benchmark 页签：前端请求一次 Benchmark 刷新；服务端若最近 15 分钟内已有成功数据则直接返回当前快照，否则同步在线数据。
- 短时间重复切换页签：共用同一个进行中的刷新 Promise，避免重复请求和页面闪烁。
- 顶部“刷新数据”：对 Benchmark 使用 `force: true`，同时按现有规则刷新其他来源。
- 后台任务：每日刷新一次 Benchmark。
- 页面首次进入总览：不额外阻塞在 Benchmark 网络请求上，仍先读取 last-good 快照。

OpenRouter 官方限制为每个密钥每分钟 30 次、每个账号每天 500 次；15 分钟新鲜度窗口和请求合并可显著低于该限制。

## 8. 页面设计

Benchmark 页签保持“左侧冠军摘要 + 右侧完整矩阵”的主结构：

- 页签顶部显示在线来源状态、数据日期、覆盖厂商数、覆盖指标数和刷新状态；
- 左侧继续展示每个可比较分项的冠军，标注来源与高值/低值优先；
- 右侧每家厂商只显示最新模型；
- 指标列按 Artificial Analysis、OpenRouter Evals、Design Arena 分组；
- 单元格显示分数、单位和必要的样本量提示，悬浮显示来源、评测日期及配置；
- 最新模型没有评测时显示“尚未评测”，而不是改用该厂商旧模型；
- 在线数据失败时展示 last-good/飞书回退提示，但矩阵继续可读。

页面不提供“全部历史模型”切换器。

## 9. 错误处理与边界

- 未配置 `OPENROUTER_API_KEY`：继续展示飞书或 last-good 数据，并显示“在线 Benchmark 待授权”；
- HTTP 401/403：标记授权失败，不循环重试；
- HTTP 429/5xx/超时：保留 last-good，记录简短错误并等待下一次触发；
- 数据结构异常或返回空集合：视为失败，不覆盖 last-good；
- 模型目录存在最新模型但无 Benchmark：这是有效状态，不视为同步失败；
- Benchmark 统一响应缺少已声明来源或结构异常：整次在线同步失败并保留 last-good，不发布来源残缺的混合矩阵；
- OpenRouter 未覆盖的厂商：保留飞书中的该厂商最新模型，但明确标记来源为飞书。

## 10. 性能与安全

- 模型目录和统一 Benchmark 请求并行获取；
- 所有外部请求设置超时；
- 服务端对同时发生的自动刷新、手动刷新和页签刷新进行串行化/去重；
- API Key 只存在服务器环境变量中；
- 前端只接收标准化快照，不接收上游原始响应；
- 不在用户请求链路中调用任何付费推理模型。

## 11. 验收与测试

自动测试覆盖：

- OpenRouter 客户端正确发送 API Key、处理超时和无效响应；
- Artificial Analysis、Design Arena、OpenRouter 自有评测正确标准化；
- 每个厂商只选择最新规范模型，免费变体不重复占行；
- 最新模型无分数时显示未评测，不回退到旧模型；
- 同名不同口径指标不合并；
- 高值/低值优先、并列冠军以及 Fable/Mythos 排除规则正确；
- 15 分钟新鲜度、进行中请求去重和 `force` 刷新正确；
- 在线失败保留 last-good，并可回退飞书；
- 进入 Benchmark 页签触发刷新，其他页签不触发；
- 桌面端、移动端、亮色和暗色模式矩阵可读；
- 最终通过完整单元测试、API 测试、lint 和生产构建。

## 12. 已知限制

“最全面”定义为 OpenRouter 统一 API 当前公开的全部可比较来源和指标，而不是抓取互联网上每一张厂商宣传表。OpenRouter 尚未收录或尚未评测的最新模型会明确显示覆盖缺口。这样可以保证数据可追溯、可定期刷新，并避免把不同版本、不同工具配置或厂商自报分数错误混算。
