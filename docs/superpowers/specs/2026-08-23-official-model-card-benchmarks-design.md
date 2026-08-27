# AI 看板官网模型卡 Benchmark 设计

日期：2026-08-23

## 1. 目标

将 AI 看板 Benchmark 从聚合来源改为厂商第一方模型卡体系。看板只跟踪 Anthropic、OpenAI、Gemini、智谱、MiniMax、Qwen、Mimo、DeepSeek、Kimi、Meta、Tencent 和 xAI，每家保留最新发布的一个文本模型。

页面按具体 test name 展示成绩与冠军，不再以“飞书口径”“Artificial Analysis”“Design Arena”或“OpenRouter Evals”作为指标分组。能力分类按 Agent、Coding、Search & Tool Use、Reasoning & Knowledge、Multimodal、其他排列；Agent 位于首位，Terminal-Bench 系列在 Agent 中置顶并获得最醒目的摘要。

本设计取代 `2026-08-23-live-ai-benchmarks-design.md` 中关于 Benchmark 数据源、分组和回退的定义。OpenRouter 仍用于公开 Token 流量排名，不再作为 Benchmark 数据源。

## 2. 权威来源与范围

### 2.1 允许的数据源

每条 Benchmark 分数必须直接来自以下第一方材料之一：

1. 厂商官网模型卡或系统卡；
2. 厂商官网技术报告；
3. 厂商官方发布页或官方文档；
4. 厂商控制的官方 GitHub、Hugging Face 组织或论文页面，且页面能够确认模型与发布主体。

不再使用以下来源生成 Benchmark 分数或冠军：

- 飞书“模型基准测试”工作表；
- Artificial Analysis；
- Design Arena；
- OpenRouter Benchmark API；
- 第三方榜单、媒体转述或无法确认发布主体的汇总表。

Terminal-Bench 也遵守同一规则：只有厂商第一方模型卡或技术材料明确公布的成绩才进入矩阵。官网没有公布时显示“未披露”，不使用 Terminal-Bench 官方榜单或第三方榜单补齐。

### 2.2 官网模型卡注册表

服务端维护一个只读厂商注册表。每个厂商适配器声明：

- 规范厂商名及别名；
- 官方模型目录、发布索引或稳定入口；
- 当前模型卡发现规则；
- 允许访问的官方域名；
- 支持的 HTML、Markdown、JSON 或 PDF 提取器；
- 模型名、发布日期和 Benchmark 表格的校验规则。

刷新时先从官方目录发现当前最新文本模型，再读取对应模型卡。若厂商没有稳定、可机器发现的官方目录，则使用已登记的官方模型卡 URL，并把该厂商标记为“模型卡发现需人工维护”；页面不得把此状态描述为自动确认最新。

运行时不调用通用搜索引擎、不调用付费模型推理，也不接受前端传入任意抓取 URL。

## 3. 最新模型规则

每家厂商最终只显示一个模型：

1. 仅考虑厂商明确发布、以文本输出为主要能力的通用或旗舰模型；
2. 排除图像、视频、语音、Embedding、重排、翻译专用模型及路由/价格变体；
3. 同一模型的 `fast`、`free`、托管路由或上下文扩展变体不视为新模型，除非厂商模型卡将其定义为独立模型；
4. 以厂商第一方发布日期选择最新模型；
5. 同日发布多个候选时，优先厂商明确标注的旗舰模型，其次使用稳定模型 ID 排序；
6. 新模型未公布任何 Benchmark 时仍替换旧模型进入矩阵，所有分项显示“未披露”；
7. 旧模型成绩不得顶替最新模型。

厂商面向页面的名称固定为 Anthropic、OpenAI、Gemini、智谱、MiniMax、Qwen、Mimo、DeepSeek、Kimi、Meta、Tencent 和 xAI。

## 4. 分数与测试口径

### 4.1 标准化记录

每条分数标准化为：

- `vendor`、`model`、`modelVersion`；
- `category`：能力分类；
- `testName`：模型卡中的具体测试名；
- `testFamily`：用于系列归类，例如 `Terminal-Bench`；
- `testVersion`：例如 `2.0`、`2.1`、`Verified`、`Pro`；
- `split`：公开集、隐藏集、Airline、Retail 等子集；
- `scoreName`：Accuracy、Pass@1、Resolution Rate、Elo 等；
- `value`、`unit`、`direction`；
- 可选 `agent`、`harness`、`effort`、`shots`、`passK`、`tools` 和其他运行配置；
- `modelCardUrl`、`sourceLabel`、`publishedAt`、`retrievedAt`；
- 可选原表注释和可比性说明。

页面展示的主标签使用完整具体名称，例如：

- `Terminal-Bench 2.1 · Accuracy`；
- `SWE-bench Verified · Pass@1`；
- `τ²-bench · Airline · Accuracy`。

Agent、Harness 和推理强度不隐藏在 test name 中，而是作为紧邻标签和悬浮详情展示，例如 `Claude Code · xhigh`。

### 4.2 可比性键

冠军只在完全相同的比较键中生成：

```text
category + testName + testVersion + split + scoreName
+ agent/harness compatibility + effort + shots/passK + tool policy
```

以下情况不得合并：

- Terminal-Bench 2.0 与 2.1；
- SWE-bench Verified 与 SWE-bench Pro；
- Pass@1 与 Pass@5；
- 不同 Agent/Harness 且官方材料未声明结果可直接比较；
- 不同推理强度、工具权限或测试子集；
- 百分比与 Elo、成本等不同单位。

如果配置缺失，记录仍可进入矩阵，但标记“配置不完整”，不参与冠军计算。并列第一完整保留。缺失值永远不显示成 0。

## 5. 能力分类与排序

分类顺序固定为：

1. `Agent`
2. `Coding`
3. `Search & Tool Use`
4. `Reasoning & Knowledge`
5. `Multimodal`
6. `其他`

规则按具体 test name 匹配，而不是按来源匹配：

- Agent：Terminal-Bench、τ-bench/τ²-bench、GAIA、OSWorld、MCP、ToolBench 等端到端代理或工具执行测试；
- Coding：SWE-bench、LiveCodeBench、Aider Polyglot、HumanEval、MBPP 等代码生成与修复测试；
- Search & Tool Use：BrowseComp、Search、WebArena 及明确以检索/浏览为目标的测试；
- Reasoning & Knowledge：GPQA、MMLU、MMLU-Pro、AIME、HLE、ARC 等；
- Multimodal：MMMU、MathVista、ChartQA、VideoMME 等；
- 其他：无法安全映射的新测试，保留具体 test name 并等待规则补充。

同一分类内排序：Terminal-Bench 系列最先，其余按配置完整度、官方模型卡顺序和 test name 稳定排序。分类器无法识别的新 test 不得静默丢弃。

## 6. 页面设计

Benchmark 页签保持“左侧冠军摘要 + 右侧完整矩阵”，但改为能力驱动：

### 6.1 Terminal-Bench 重点区

- 左侧第一块固定为 Terminal-Bench 系列；
- 每个具体版本/配置单独一行；
- 显示冠军模型、成绩、Agent/Harness、推理强度和来源日期；
- 没有可比较成绩时显示“最新模型官网未披露可比成绩”，不展示旧模型或第三方结果。

### 6.2 各分项最强模型

- 按 Agent、Coding、Search & Tool Use、Reasoning & Knowledge、Multimodal、其他分组；
- 每一行以具体 test name 为标题，而不是来源名称；
- 同行显示冠军模型、冠军分数、单位及并列状态；
- 来源和完整运行配置放入悬浮详情；
- 不再显示“排除 Fable/Mythos”标签，因为矩阵只含 12 家白名单厂商的最新模型。

### 6.3 Benchmark 矩阵

- 列按能力分类分组，Terminal-Bench 系列位于最左侧的 Agent 分组；
- 二级列标题使用具体 test name 与版本；
- 单元格显示正确的百分比、分数、排名或成本单位；
- 冠军单元格高亮；
- “未披露”“配置不完整”“抓取失败”使用不同状态，不混成一个空横线；
- 悬浮详情显示模型卡名称、官方链接、发布日期、抓取日期和评测配置。

## 7. 数据结构与接口

`AiDashboardSnapshot.benchmarks` 调整为：

- `models`：12 家厂商的最新模型及官网模型卡状态；
- `metrics`：具体测试定义、能力分类、排序和可比性信息；
- `winners`：按可比性键生成的冠军及成绩；
- `vendorSources`：逐厂商的模型卡 URL、发现状态、抓取状态和日期；
- `coverage`：厂商数、已披露厂商数、测试数、可比较测试数；
- `asOf`、`sourceMode: "official-model-cards"`；
- `attributions`：实际使用的 12 家厂商第一方来源。

现有 `GET /api/ai-dashboard` 和 `POST /api/ai-dashboard/refresh` 路径不变。进入 Benchmark 页签继续使用 15 分钟新鲜度窗口；手动刷新使用 `force: true`。

OpenRouter Benchmark 客户端和飞书 Benchmark 适配器不再参与新快照生成。迁移后只允许上一次成功的官网模型卡快照作为回退，避免重新显示旧聚合口径。

## 8. 同步、回退与安全

- 12 家适配器并发受限执行，每个请求设置超时、响应大小上限和官方域名白名单；
- 重定向后的最终域名也必须在白名单内，防止 SSRF 和官网链接被劫持；
- HTML、Markdown、JSON 和 PDF 提取器先完成结构校验，再生成标准化记录；
- 单一厂商失败时保留该厂商上一次成功模型卡数据，并将其标记为 `stale`；
- 新旧厂商切片合成后一次性原子写入快照；
- 从未成功的厂商显示“官网模型卡暂不可读”，不注入样例数据；
- 页面顶部同时展示整体日期和逐厂商新鲜度，避免把部分成功描述成全量成功；
- 原始官网正文不写入对外 API，只保存必要字段、短注释和官方 URL。

## 9. 测试与验收

自动测试使用保存的第一方页面夹具，不依赖实时网络，并覆盖：

- 12 家厂商名称与别名归一化；
- 官方域名白名单和重定向校验；
- HTML、Markdown、JSON、PDF 模型卡提取；
- 最新通用文本/旗舰模型选择，专用模型和路由变体排除；
- test name、版本、split、scoreName 和配置字段保留；
- Terminal-Bench 系列归入 Agent、置顶且不与不同版本混算；
- SWE-bench 等测试归入 Coding；
- 未识别测试进入“其他”而不丢失；
- 只有完全可比记录计算冠军，高值/低值优先和并列正确；
- 百分比以百分比显示，不显示为小数；
- 旧模型成绩不顶替最新模型；
- 单厂商失败保留其 last-good 并标记过期；
- 所有聚合来源和飞书 Benchmark 不再进入新快照；
- 桌面端、移动端、亮色和暗色模式下 Terminal-Bench 重点区、冠军摘要和矩阵可读；
- 完整单元测试、API 测试、lint 和生产构建通过。

上线验收还需对 12 家当前最新模型执行一次真实官网读取，并逐项核对模型名、发布日期、官方链接、test name、配置与页面值。任何无法从第一方材料确认的成绩必须留空并记录覆盖缺口。

## 10. 已知限制

- 厂商官网模型卡结构不统一，部分页面依赖 JavaScript 或仅提供 PDF，适配器需要分别维护；
- 某些厂商没有稳定的最新模型目录，无法保证完全自动发现新模型，此时必须显式显示人工维护状态；
- 最新模型的第一方模型卡可能没有 Terminal-Bench 或其他关键测试，矩阵会比聚合榜单稀疏；
- 厂商自报结果可能使用不同 Harness、推理强度、工具权限或测试版本，因此“最强模型”只在严格可比配置内生成；
- 本看板展示厂商公布值及其来源，不代表独立复现结果。
