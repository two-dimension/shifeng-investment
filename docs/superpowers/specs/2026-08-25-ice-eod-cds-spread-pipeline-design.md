# ICE EOD CDS Price 转 5Y Spread 每日管道设计

日期：2026-08-25

## 1. 目标

在 AI 投资看板的“融资与债务”页签中，把当前混合了截图取样历史和 DTCC 成交估算的 CDS 曲线，替换为一条来源、合约和计算口径一致的 5Y CDS spread 序列。

新管道以 ICE Clear Credit 公布的单名 CDS EOD Price 为原始输入，使用 ISDA CDS Standard Model 将 clean price 换算为 par spread（bp），每日保存原始值、计算输入、计算结果和验证状态。页面继续采用用户截图中的摘要卡片、1日/7日/1月变化和历史曲线布局。

一期免费模式不自动抓取 ICE 公共网页。用户从 ICE 公共页面取得当日记录后，通过受控的表格粘贴或 CSV 导入写入本地；导入后的合约选择、换算、校验、存档和图表更新全部自动完成。若以后配置 ICE/S&P 授权接口，同一管道切换为全自动采集，不改变下游数据结构。

## 2. 成功标准与“1%”定义

### 2.1 主验收指标

当同一结算日、同一参考实体、同一币种、同一优先级、同一重组条款和同一 5Y 合约存在官方 spread 基准时，定义：

```text
relativeSpreadError = abs(calculatedSpreadBp - officialSpreadBp) / officialSpreadBp
```

发布为“已验证”的记录必须满足：

- `relativeSpreadError <= 1%`；
- `absoluteSpreadErrorBp <= min(2 bp, officialSpreadBp * 1%)`；
- 将计算结果反算回 clean price 后，`absolutePriceResidual <= 0.005` price point。

前两项验证与 ICE 官方 spread 的一致性；第三项只验证计算器内部自洽，不能单独证明相对 ICE 官方 spread 的误差小于 1%。

### 2.2 无官方 spread 基准时

免费公共页面只提供 EOD Price 时，系统可以生成 `model-derived` spread，但不能把它标为“已通过 1% 官方基准验证”。页面必须显示“ICE EOD Price · ISDA 换算值”，并在悬浮说明中展示换算参数和验证状态。

如果“每日展示值必须被保证在官方 spread 的 1% 内”是硬要求，唯一可接受的数据输入是 ICE/S&P 授权 spread 字段，或同等权威且允许使用的官方 spread 基准。未取得基准时系统不得用 DTCC 值、截图取样或自洽残差代替该验收。

### 2.3 上线门槛

在替换现有页面前，七家公司至少并行验证 20 个 ICE 结算日：

- 预期公司覆盖率 100%；
- 原始数据完整率 100%；
- 合约唯一识别率 100%；
- 所有存在官方 spread 基准的记录满足主验收指标；
- 无跨来源拼接、无缺失值补零、无非交易日伪造数据。

## 3. 来源与输入方式

### 3.1 原始来源

权威原始来源固定为 ICE Clear Credit Settlement Prices 的 `Markit - Single Name Instruments`。每条记录保留：

- `clearingDate`；
- `name`；
- `instrumentName`；
- `eodPrice`；
- `sourceUrl`；
- `retrievedAt`；
- `inputMethod`：`manual-paste`、`csv-import` 或 `licensed-api`。

原始记录只追加、不原地改写。复核或修正使用新版本并保留前一版本和原因。

### 3.2 免费模式

AI 看板新增“导入 ICE 当日数据”入口，支持：

1. 粘贴 ICE 表格中七家公司的相关行；
2. 上传具有固定列名的 CSV；
3. 先预览识别结果，再确认写入。

系统拒绝未知列、非数字 EOD Price、未来结算日、重复主键冲突和不在公司注册表内的实体。用户只需要提供 ICE 页面显示的原始行，不需要手工选择合约或计算 spread。

### 3.3 授权模式

预留 `IceSettlementSource` 接口。配置授权凭证后，定时任务在每个 ICE 结算日发布完成后拉取当日数据，并复用与免费模式完全相同的校验、计算和存储流程。凭证只存在服务端环境变量中。

## 4. 合约识别

服务端维护公司和合约注册表，至少覆盖 Oracle、CoreWeave、NVIDIA、Amazon、Alphabet、Microsoft 和 Meta。注册项包含规范公司名、ICE 名称别名、币种、债务优先级、重组条款、标准票息类别和允许的合约模式。

对每家公司按以下顺序选取目标记录：

1. 名称映射到唯一参考实体；
2. 固定币种、`SNRFOR` 等优先级和重组条款；
3. 解析 Instrument Name 中的票息和到期日；
4. 选择目标观察日对应的标准 5Y IMM 到期合约；
5. 投资级名称优先标准 100 bp 票息，高收益名称按注册表使用标准 500 bp 票息；
6. 多条候选或没有候选时停止发布，并在页面标记“合约识别异常”。

合约滚动必须产生显式事件。新旧 5Y 合约不得无说明地拼成一条序列；页面变化计算使用当天被注册表认定的标准 5Y 合约，但原始合约 ID 始终可追溯。

## 5. Price 到 Spread 的换算

### 5.1 计算输入

每次换算必须保存完整输入：

- ICE clean EOD Price；
- 固定票息；
- trade/step-in/cash-settlement 日期；
- IMM 到期日；
- 工作日日历和日计数规则；
- 同日 USD SOFR 或 EUR €STR 贴现曲线及曲线来源；
- recovery rate 及其来源；
- ISDA CDS Standard Model 版本；
- 计算时间和代码版本。

不得继续使用当前 DTCC 估算器中的固定 4% 无风险利率和未分层的固定参数来冒充 ICE 换算口径。

贴现曲线由独立 `DiscountCurveSource` 提供，生产记录必须保存完整期限节点，不能用单个隔夜 SOFR 数值代替整条曲线。免费模式可导入经过复核的当日 OIS 曲线 CSV；授权模式可接入允许使用的 ICE 或其他机构曲线。曲线来源、日期或期限节点不完整时，记录进入 `needs-review`，不得标记为 `validated`。

回收率默认值只用于生成 `model-derived` 结果。只有回收率来自同一官方数据包，或结果已经通过官方 spread 基准验证时，记录才有资格进入 `validated`。

### 5.2 计算过程

1. 由标准模型计算 clean price 对应的 upfront；
2. 使用贴现曲线、回收率和标准 CDS 现金流规则求解 hazard curve；
3. 计算目标 5Y par spread；
4. 将 par spread 反算为 clean price；
5. 保存 spread、反算价格、价格残差和模型诊断信息。

求解失败、非有限值、负 spread、价格残差超阈值或参数缺失时，该记录不进入已发布序列。

## 6. 数据结构、Excel 档案与网页快照

Excel 是面向用户的长期数据档案和审计交付物，文件名固定为 `ice-cds-history.xlsx`。网页不在请求期间直接读取 Excel，而是读取由同一批已校验数据生成的 `snapshot.json`，避免 Excel 文件锁、局部写入或公式兼容问题影响页面。

工作簿包含：

1. `Raw EOD Prices`：不可变原始 ICE 行、来源 URL、录入方式、录入时间和修订版本；
2. `Derived 5Y Spreads`：目标合约、模型输入、计算 spread、反算价格、误差和质量状态；
3. `Daily Dashboard`：七家公司每日 spread、1日/7日/1月绝对变化及最新状态；
4. `Discount Curves`：按曲线日期保存期限节点、零利率和来源；
5. `Contract Registry`：公司别名、币种、优先级、重组条款、票息和合约选择规则；
6. `Validation Log`：导入批次、缺失项、重复项、价格残差、官方基准误差和发布决定；
7. `Methodology`：指标定义、ISDA 模型版本、更新时间及来源链接。

原始输入使用类型化日期和数值单元格。所有可以在 Excel 中审计的变化、误差和状态判断使用清晰公式；复杂的 ISDA 数值求解由服务端完成，并把完整输入、输出、模型版本和反算结果写入工作簿。工作簿中不得用静态文本伪装公式结果。

后端以标准化记录为单次更新的内存事实源，同时生成两份一致输出：

1. `ice-cds-history.xlsx`：完整历史、计算和审计记录；
2. `snapshot.json` 中的 `creditRisk.cds5y`：只包含通过发布规则、供页面快速读取的数据。

派生记录的唯一键为：

```text
clearingDate + canonicalCompany + instrumentName + modelVersion + curveId + recoveryRate
```

Excel 与 JSON 使用同一批次 ID，并分别采用临时文件加原子替换。只有两份输出都成功生成并通过校验时才提交批次；任何一步失败都保留上一版 Excel 和 JSON，避免两者出现不同日期或不同数值。任何一家公司失败时，其他公司可以更新；失败公司保留上一结算日的 last-good，并明确显示日期和 stale 状态。不同来源的数据永远不合并进同一历史序列。

每次成功更新后保留最近 30 个按日期命名的 Excel 备份，超出部分移入归档目录而不是直接删除。页面提供最新工作簿下载入口，用户可随时在 Excel 中查看和留存完整历史。

## 7. 每日更新流程

### 7.1 免费模式

1. ICE 新结算价发布后，用户粘贴或上传当天七家公司原始行；
2. 服务端显示解析预览、候选合约和拒绝原因；
3. 用户确认后，原始行原子写入；
4. 系统加载当日贴现曲线和回收率配置；
5. 运行 ISDA 换算及反算校验；
6. 通过发布规则的公司追加当天点；
7. 重新计算真实结算日口径的 1 日、7 日和 1 月变化；
8. 更新快照并记录审计日志。

### 7.2 授权模式

步骤 1 至 3 由服务端定时采集替代，其余完全相同。定时任务按 ICE 交易日历运行，设置延迟重试；超过新鲜度窗口仍无新数据时只标记 stale，不复制前日值为新日期。

## 8. 变化计算与页面

- “1日”使用上一个有效 ICE 结算日，不使用自然日前一日；
- “7日”使用目标日期前 7 个自然日或之前最近的有效 ICE 结算日；
- “1月”使用目标日期前 1 个日历月或之前最近的有效 ICE 结算日；
- 所有变化均为绝对 bp 变化；
- 找不到参照点时显示“—”，不得错误地使用更早点却仍标成 1 日；
- 摘要卡显示当前 spread、bp 单位和三个变化；
- 图表副标题显示 `ICE ICC EOD Price · ISDA 换算`；
- tooltip 显示原始 EOD Price、合约、票息、模型版本、回收率、曲线日期和验证状态。

当前 `DTCC CDS` 页签改名为 `5Y CDS`。原截图取样历史和 DTCC 序列保留为内部迁移证据，但不再由生产 API 返回，也不再与 ICE 序列绘制在同一图中。

## 9. API 与权限

保留现有只读接口，并新增：

- `POST /api/ai-dashboard/cds/import/preview`：解析但不写入；
- `POST /api/ai-dashboard/cds/import`：确认后写入和计算；
- `GET /api/ai-dashboard/cds/import-status`：返回最近结算日、缺失公司和验证状态。
- `GET /api/ai-dashboard/cds/export.xlsx`：下载最近一次成功批次的完整 Excel 工作簿。

接口只接受 CSV 或结构化表格行，不接受任意网页 URL。限制文件大小、行数和字段类型，拒绝公式单元格及路径字段。导入权限沿用看板部署环境的内部访问边界；服务端记录导入时间和输入方式，不保存不必要的用户信息。

## 10. 错误处理与质量监控

每日质量检查覆盖：

- 完整性：七家公司是否都有目标合约；
- 唯一性：结算日、公司和目标合约是否唯一；
- 有效性：价格、票息、日期、币种和 spread 范围；
- 一致性：Instrument Name 与注册表、曲线日期与结算日；
- 时效性：最后 ICE 结算日及数据到达延迟；
- 模型自洽：反算 price residual；
- 基准一致性：存在官方 spread 时的 relative/absolute error；
- 时间异常：使用中位数绝对偏差识别突变，但异常只触发复核，不自动篡改市场值。

质量状态为 `validated`、`model-derived`、`needs-review`、`stale` 或 `unavailable`。页面不得把后四种状态显示成“官方 spread 已同步”。

## 11. 测试与验收

自动测试使用固定 ICE 表格夹具和确定性贴现曲线，不依赖实时网络，覆盖：

- 粘贴和 CSV 解析；
- 公司别名和 Instrument Name 解析；
- 5Y IMM 合约及 100/500 bp 票息选择；
- 多候选、缺失候选和滚动事件；
- ISDA 现金流日期、应计、price-to-spread 和 spread-to-price；
- 价格残差与 1% 基准误差判定；
- 交易日口径的 1 日、7 日、1 月变化；
- 重复导入幂等、修订审计和原子写入；
- Excel 七张工作表、类型化单元格、公式、来源链接和批次 ID；
- Excel 与 JSON 快照数值逐项一致；
- Excel 写入失败时两份输出都回退到上一成功批次；
- 工作簿公式错误扫描和所有工作表视觉检查；
- 单公司失败保留 last-good；
- DTCC 与截图取样数据不进入 ICE 序列；
- API 文件限制和异常输入；
- 桌面端、移动端、亮色和暗色模式；
- 全量单元测试、API 测试、lint 和生产构建。

上线验收逐家公司核对原始 EOD Price、Instrument Name、计算输入、spread 和变化值，并完成 20 个结算日并行验证。没有官方 spread 基准的记录只能验收为 `model-derived`，不得签署“误差保证低于 1%”。

## 12. 分阶段交付

1. 原始数据导入、注册表、来源隔离和 Excel 工作簿骨架；
2. ISDA 换算器、贴现曲线接口及反算校验；
3. Excel 历史/公式/审计写入、JSON 快照及批次一致性；
4. 变化计算、快照迁移、Excel 下载和截图样式页面；
5. 20 日并行验证、阈值调校和质量状态；
6. 可选 ICE/S&P 授权源适配器及全自动定时采集。

任何阶段都不得把 DTCC 成交估算、截图取样或未通过校验的模型值标成 ICE 官方 spread。

## 13. 方法依据

- ICE Clear Credit 公共 EOD 页面：https://www.ice.com/cds-settlement-prices/icc/single-name-instruments
- ICE EOD Price Discovery 说明：https://www.ice.com/cds-settlement-prices/disclaimer/price-discovery
- ICE Clear Europe 披露框架（说明使用 ISDA Standard Model 在 spread 与 clean price 之间换算）：https://uat2.ice.com/publicdocs/clear_europe/ICE_Clear_Europe_Disclosure_Framework.pdf
- ISDA CDS Standard Model 入口：https://www.isda.org/1985/01/01/credit-derivatives-credit-default-swaps/
- New York Fed SOFR 数据：https://www.newyorkfed.org/markets/reference-rates/sofr

New York Fed 公布的隔夜 SOFR 只作为日期和市场基准校验材料，不被当作完整 OIS 贴现曲线。
