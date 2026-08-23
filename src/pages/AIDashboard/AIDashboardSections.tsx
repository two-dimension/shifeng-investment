import React, { useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import {
  Alert,
  Card,
  Col,
  Descriptions,
  Empty,
  Flex,
  Grid,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  BankOutlined,
  LineChartOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useTheme } from '../../hooks/useTheme';
import type {
  AiDashboardSnapshot,
  ArrCompanyMetric,
  BenchmarkMetricDefinition,
  BenchmarkModel,
  ComputeRentalQuote,
  TokenPrice,
} from './types';
import {
  formatBenchmarkValue,
  formatCacheHitRange,
  formatMultiple,
  formatTokenCount,
  formatUsd,
} from './viewModel';

const { Text, Title, Paragraph } = Typography;

type DashboardProps = { data: AiDashboardSnapshot };

function compactNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function safeTokenNumber(value: string): number {
  try {
    return Number(BigInt(value));
  } catch {
    return 0;
  }
}

function dateLabel(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : '—';
}

function changeNode(value: number | null) {
  if (value === null || Math.abs(value) < 0.000001) return <Text type="secondary">—</Text>;
  const positive = value > 0;
  return (
    <Text className={positive ? 'ai-change-up' : 'ai-change-down'}>
      {positive ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {formatUsd(Math.abs(value), 3)}
    </Text>
  );
}

function ChartCard({ title, extra, children, className = '' }: React.PropsWithChildren<{ title: React.ReactNode; extra?: React.ReactNode; className?: string }>) {
  return <Card className={`ai-section-card ${className}`} title={title} extra={extra}>{children}</Card>;
}

function NoData({ description = '暂无可展示数据' }: { description?: string }) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description} />;
}

function useChartPalette() {
  const { theme } = useTheme();
  return useMemo(() => ({
    text: theme === 'dark' ? '#c7c7c7' : '#595959',
    line: theme === 'dark' ? '#3a3a3a' : '#e8e8e8',
    blue: theme === 'dark' ? '#3c9ae8' : '#1677ff',
    cyan: '#13c2c2',
    orange: '#fa8c16',
    red: '#f5222d',
  }), [theme]);
}

function ArrChart({ metric, height = 320 }: { metric: ArrCompanyMetric | null; height?: number }) {
  const palette = useChartPalette();
  const screens = Grid.useBreakpoint();
  const compact = !screens.sm;
  const option = useMemo(() => {
    if (!metric) return {};
    const months = [...new Set([...metric.actualPoints, ...metric.forecastPoints].map((point) => point.month))].sort();
    const actualByMonth = new Map(metric.actualPoints.map((point) => [point.month, point.value]));
    const forecastByMonth = new Map(metric.forecastPoints.map((point) => [point.month, point.value]));
    return {
      animationDuration: 350,
      color: [palette.blue, palette.orange],
      tooltip: { trigger: 'axis' },
      legend: { top: 0, textStyle: { color: palette.text }, data: ['实测 ARR', '月底预测'] },
      grid: { left: compact ? 42 : 64, right: compact ? 8 : 24, top: 44, bottom: 42 },
      xAxis: { type: 'category', data: months, axisLabel: { color: palette.text, fontSize: compact ? 9 : 12 }, axisLine: { lineStyle: { color: palette.line } } },
      yAxis: { type: 'value', name: compact ? '' : '亿美元', nameTextStyle: { color: palette.text }, axisLabel: { color: palette.text, fontSize: compact ? 9 : 12 }, splitLine: { lineStyle: { color: palette.line } } },
      series: [
        {
          name: '实测 ARR',
          type: 'line',
          smooth: true,
          symbolSize: 7,
          data: months.map((month) => actualByMonth.get(month) ?? null),
          label: {
            show: true,
            position: 'top',
            color: palette.text,
            formatter: (params: { dataIndex: number }) => {
              const point = metric.actualPoints.find((item) => item.month === months[params.dataIndex]);
              return point?.momAbsolute === null || point?.momAbsolute === undefined ? '' : `${point.momAbsolute >= 0 ? '+' : ''}${compactNumber(point.momAbsolute)}`;
            },
          },
        },
        {
          name: '月底预测',
          type: 'line',
          symbol: 'emptyCircle',
          lineStyle: { type: 'dashed', width: 2 },
          data: months.map((month) => forecastByMonth.get(month) ?? null),
        },
      ],
    };
  }, [compact, metric, palette]);
  if (!metric) return <NoData description="暂无 ARR 数据" />;
  return <ReactECharts option={option} style={{ height }} notMerge />;
}

function OpenRouterTopChart({ data, height = 350 }: { data: AiDashboardSnapshot['openRouter']; height?: number }) {
  const palette = useChartPalette();
  const screens = Grid.useBreakpoint();
  const compact = !screens.sm;
  const option = useMemo(() => {
    const models = data.topModels.map((item) => item.model).reverse();
    const values = data.topModels.map((item) => safeTokenNumber(item.totalTokens)).reverse();
    return {
      animationDuration: 350,
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (value: number) => formatTokenCount(String(Math.round(value))) },
      grid: { left: compact ? 112 : 238, right: compact ? 14 : 70, top: 12, bottom: 28 },
      xAxis: { type: 'value', axisLabel: { color: palette.text, fontSize: compact ? 8 : 12, formatter: (value: number) => formatTokenCount(String(Math.round(value))) }, splitLine: { lineStyle: { color: palette.line } } },
      yAxis: {
        type: 'category',
        data: models,
        axisLabel: { color: palette.text, width: compact ? 100 : 215, overflow: 'break', lineHeight: compact ? 11 : 15, fontSize: compact ? 8 : 12, interval: 0 },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      series: [{
        type: 'bar',
        data: values,
        barMaxWidth: 20,
        itemStyle: { color: palette.blue, borderRadius: [0, 3, 3, 0] },
        label: { show: !compact, position: 'right', color: palette.text, formatter: (params: { value: number }) => formatTokenCount(String(Math.round(params.value))) },
      }],
    };
  }, [compact, data.topModels, palette]);
  if (data.topModels.length === 0) return <NoData description="暂无 OpenRouter 排名" />;
  return <ReactECharts option={option} style={{ height }} notMerge />;
}

function OpenRouterHistoryChart({ data }: { data: AiDashboardSnapshot['openRouter'] }) {
  const palette = useChartPalette();
  const screens = Grid.useBreakpoint();
  const compact = !screens.sm;
  const option = useMemo(() => ({
    tooltip: { trigger: 'axis', valueFormatter: (value: number) => formatTokenCount(String(Math.round(value))) },
    grid: { left: compact ? 45 : 72, right: compact ? 8 : 24, top: 28, bottom: 42 },
    xAxis: { type: 'category', data: data.history.map((item) => item.endDate), axisLabel: { color: palette.text, rotate: 30, fontSize: compact ? 8 : 12 }, axisLine: { lineStyle: { color: palette.line } } },
    yAxis: { type: 'value', axisLabel: { color: palette.text, fontSize: compact ? 8 : 12, formatter: (value: number) => formatTokenCount(String(Math.round(value))) }, splitLine: { lineStyle: { color: palette.line } } },
    series: [{ type: 'line', smooth: true, symbolSize: 7, areaStyle: { opacity: 0.08 }, data: data.history.map((item) => safeTokenNumber(item.totalTokens)), itemStyle: { color: palette.cyan }, lineStyle: { width: 3, color: palette.cyan } }],
  }), [compact, data.history, palette]);
  if (data.history.length === 0) return <NoData description="暂无 12 周历史" />;
  return <ReactECharts option={option} style={{ height: 320 }} notMerge />;
}

function latestArrCompany(data: AiDashboardSnapshot) {
  return data.arrAndValuation.companies.toSorted((left, right) => (right.latestActual?.observedAt || '').localeCompare(left.latestActual?.observedAt || ''))[0] || null;
}

export function OverviewSection({ data }: DashboardProps) {
  const arr = latestArrCompany(data);
  const debt = data.debtFinancing[0];
  const valuation = data.arrAndValuation.valuations[0];
  return (
    <div className="ai-section-stack">
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ai-kpi-card">
            <Statistic title={`最新 ARR${arr ? ` · ${arr.company}` : ''}`} value={arr?.latestActual?.value ?? '—'} suffix={arr ? '亿美元' : undefined} precision={arr ? 2 : undefined} prefix={<LineChartOutlined />} />
            <Text type="secondary">三月斜率：{arr?.slope3m === null || arr?.slope3m === undefined ? '不足三期' : `${compactNumber(arr.slope3m)} 亿美元/月`}</Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ai-kpi-card">
            <Statistic title="OpenRouter 周 Token" value={formatTokenCount(data.openRouter.weekTotalTokens)} prefix={<ThunderboltOutlined />} />
            <Text type="secondary">{data.openRouter.weekTotalTokens === null ? '全平台合计需 Data API 授权' : `${dateLabel(data.openRouter.startDate)} 至 ${dateLabel(data.openRouter.endDate)} · 完整 UTC 日`}</Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ai-kpi-card ai-debt-kpi">
            <Statistic title={`最新融资规模${debt ? ` · ${debt.company}` : ''}`} value={debt ? `${debt.currency} ${compactNumber(debt.amount)}` : '—'} prefix={<BankOutlined />} />
            <Text strong>{debt?.method || '暂无债务融资事件'}</Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ai-kpi-card">
            <Statistic title={`最新 P/ARR${valuation ? ` · ${valuation.company}` : ''}`} value={valuation ? formatMultiple(valuation.parrLow, valuation.parrHigh) : '—'} />
            <Text type="secondary">估值日 {dateLabel(valuation?.asOf)} · ARR 匹配 {dateLabel(valuation?.arrAsOf)}</Text>
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <ChartCard title="ARR 斜率与实测值" extra={arr?.stale ? <Tag color="warning">超过 18 天未更新</Tag> : <Tag color="success">实测有效</Tag>}>
            <ArrChart metric={arr} height={340} />
          </ChartCard>
        </Col>
        <Col xs={24} xl={12}>
          <ChartCard title="OpenRouter Top 10 · 周公开 Token" extra={<Text type="secondary">含量级，不代表模型质量</Text>}>
            <OpenRouterTopChart data={data.openRouter} height={340} />
          </ChartCard>
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <ChartCard title="最新债务融资" extra={<Text type="secondary">手段与规模优先展示</Text>}>
            {debt ? (
              <Descriptions bordered column={{ xs: 1, sm: 2 }} size="small">
                <Descriptions.Item label="融资手段"><Text strong className="ai-emphasis-value">{debt.method}</Text></Descriptions.Item>
                <Descriptions.Item label="融资规模"><Text strong className="ai-emphasis-value">{debt.currency} {compactNumber(debt.amount)}</Text></Descriptions.Item>
                <Descriptions.Item label="公司">{debt.company}</Descriptions.Item>
                <Descriptions.Item label="日期">{dateLabel(debt.asOf)}</Descriptions.Item>
                <Descriptions.Item label="点评" span="filled">{debt.note || '—'}</Descriptions.Item>
              </Descriptions>
            ) : <NoData description="暂无结构化债务融资数据" />}
          </ChartCard>
        </Col>
        <Col xs={24} xl={12}>
          <ChartCard title="P/ARR 估值配对">
            <ValuationTable data={data.arrAndValuation.valuations.slice(0, 6)} compact />
          </ChartCard>
        </Col>
      </Row>
    </div>
  );
}

function ValuationTable({ data, compact = false }: { data: AiDashboardSnapshot['arrAndValuation']['valuations']; compact?: boolean }) {
  return (
    <Table
      rowKey={(row) => `${row.company}-${row.asOf}`}
      size="small"
      pagination={compact ? false : { pageSize: 10 }}
      scroll={{ x: 820 }}
      locale={{ emptyText: <NoData description="暂无估值数据" /> }}
      dataSource={data}
      columns={[
        { title: '公司', dataIndex: 'company', fixed: 'left', width: 130 },
        { title: '估值日期', dataIndex: 'asOf', width: 112, render: dateLabel },
        { title: '估值（亿美元）', width: 140, render: (_, row) => row.valuationLow === row.valuationHigh ? compactNumber(row.valuationLow) : `${compactNumber(row.valuationLow)}–${compactNumber(row.valuationHigh)}` },
        { title: '匹配 ARR', width: 115, render: (_, row) => row.arrValue === null ? '—' : compactNumber(row.arrValue) },
        { title: 'ARR 日期', dataIndex: 'arrAsOf', width: 112, render: dateLabel },
        { title: 'P/ARR', width: 110, render: (_, row) => <Text strong>{formatMultiple(row.parrLow, row.parrHigh)}</Text> },
        { title: '点评', dataIndex: 'note', ellipsis: { showTitle: false }, render: (value) => <Tooltip title={value}><span>{value || '—'}</span></Tooltip> },
      ]}
    />
  );
}

export function ArrValuationSection({ data }: DashboardProps) {
  const [company, setCompany] = useState(data.arrAndValuation.companies[0]?.company);
  const metric = data.arrAndValuation.companies.find((item) => item.company === company) || data.arrAndValuation.companies[0] || null;
  return (
    <div className="ai-section-stack">
      <ChartCard
        title="ARR 实测、月度绝对增长与三月斜率"
        extra={data.arrAndValuation.companies.length > 0 ? <Select value={metric?.company} style={{ minWidth: 170 }} options={data.arrAndValuation.companies.map((item) => ({ value: item.company, label: item.company }))} onChange={setCompany} /> : undefined}
      >
        <Row gutter={[20, 12]}>
          <Col xs={24} lg={18}><ArrChart metric={metric} height={370} /></Col>
          <Col xs={24} lg={6}>
            <Flex vertical gap={14} className="ai-arr-aside">
              <Statistic title="最新实测 ARR" value={metric?.latestActual?.value ?? '—'} precision={metric ? 2 : undefined} suffix={metric ? '亿美元' : undefined} />
              <Statistic title="最近三实测月斜率" value={metric?.slope3m ?? '—'} precision={metric?.slope3m !== null ? 2 : undefined} suffix={metric?.slope3m !== null ? '亿美元/月' : undefined} />
              {metric?.stale && <Alert type="warning" showIcon title="Yipit 更新提醒" description="最新实测值已超过 18 天。" />}
              <Paragraph type="secondary">月底预测仅用虚线展示，不参与绝对环比、斜率或 P/ARR 计算。</Paragraph>
            </Flex>
          </Col>
        </Row>
      </ChartCard>
      <ChartCard title="月度 ARR 明细" extra={<Text type="secondary">仅显示绝对增长，不提供环比百分比或同比</Text>}>
        <Table
          size="small"
          rowKey={(row) => `${row.company}-${row.month}`}
          pagination={false}
          scroll={{ x: 760 }}
          locale={{ emptyText: <NoData description="暂无 ARR 实测数据" /> }}
          dataSource={metric?.actualPoints || []}
          columns={[
            { title: '月份', dataIndex: 'month', width: 110 },
            { title: '实测 ARR（亿美元）', dataIndex: 'value', width: 165, render: compactNumber },
            { title: '月度绝对增长（亿美元）', dataIndex: 'momAbsolute', width: 205, render: (value: number | null) => value === null ? '—' : <Text className={value >= 0 ? 'ai-change-up' : 'ai-change-down'}>{value >= 0 ? '+' : ''}{compactNumber(value)}</Text> },
            { title: '实测日期', dataIndex: 'observedAt', width: 112 },
            { title: '来源', dataIndex: 'sourceLabel', width: 110 },
            { title: 'Yipit 点评', dataIndex: 'note', render: (value) => value || '—' },
          ]}
        />
      </ChartCard>
      <ChartCard title="估值与 P/ARR"><ValuationTable data={data.arrAndValuation.valuations} /></ChartCard>
    </div>
  );
}

export function OpenRouterSection({ data }: DashboardProps) {
  return (
    <div className="ai-section-stack">
      <Alert
        type="info"
        showIcon
        title="口径说明"
        description={data.openRouter.weekTotalTokens === null
          ? '当前展示 OpenRouter 公开榜单的最近七日 Top 10（页面显示值为约数）。全平台总量与 12 周趋势需 Data API 授权；不等同于全行业使用量、请求次数或模型质量。'
          : '这里展示 OpenRouter 最近七个完整 UTC 日的公开 Token 流量（保留 other 计入平台总量），不等同于全行业使用量、请求次数或模型质量。'}
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}><ChartCard title="Top 10 模型 · 周 Token"><OpenRouterTopChart data={data.openRouter} height={430} /></ChartCard></Col>
        <Col xs={24} xl={10}><ChartCard title="平台周 Token 总量 · 12 周"><OpenRouterHistoryChart data={data.openRouter} /></ChartCard></Col>
      </Row>
      <ChartCard title="周排名表" extra={<Text type="secondary">{data.openRouter.weekTotalTokens === null ? '平台合计待 Data API 授权' : `平台合计 ${formatTokenCount(data.openRouter.weekTotalTokens)}`}</Text>}>
        <Table
          size="small"
          rowKey="model"
          pagination={false}
          locale={{ emptyText: <NoData description="暂无 OpenRouter 数据" /> }}
          dataSource={data.openRouter.topModels}
          columns={[
            { title: '排名', dataIndex: 'rank', width: 72 },
            { title: '模型', dataIndex: 'model', className: 'ai-model-name', render: (value) => <Tooltip title={value}><span>{value}</span></Tooltip> },
            { title: '七日公开 Token', dataIndex: 'totalTokens', width: 180, align: 'right', render: (value, row) => <Text strong>{row.approximate ? '≈' : ''}{formatTokenCount(value)}</Text> },
          ]}
        />
        <Text type="secondary" className="ai-attribution">{data.openRouter.attribution}</Text>
      </ChartCard>
    </div>
  );
}

function TokenPriceCharts({ prices }: { prices: TokenPrice[] }) {
  const palette = useChartPalette();
  const screens = Grid.useBreakpoint();
  const compact = !screens.sm;
  const priceOption = useMemo(() => {
    const rows = prices.slice(0, 24).toReversed();
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (value: number) => formatUsd(value, 3) },
      legend: { top: 0, textStyle: { color: palette.text } },
      grid: { left: compact ? 105 : 220, right: compact ? 10 : 35, top: 44, bottom: 28 },
      xAxis: { type: 'value', name: compact ? '' : 'USD / 1M Tokens', nameTextStyle: { color: palette.text }, axisLabel: { color: palette.text, fontSize: compact ? 8 : 12 }, splitLine: { lineStyle: { color: palette.line } } },
      yAxis: { type: 'category', data: rows.map((row) => row.model), axisLabel: { color: palette.text, fontSize: compact ? 8 : 12, lineHeight: compact ? 11 : 15, width: compact ? 94 : 195, overflow: 'break', interval: 0 }, axisTick: { show: false } },
      series: [
        { name: '输入', type: 'bar', data: rows.map((row) => row.inputPrice), itemStyle: { color: palette.blue } },
        { name: '缓存读取', type: 'bar', data: rows.map((row) => row.cacheReadPrice), itemStyle: { color: palette.cyan } },
        { name: '输出', type: 'bar', data: rows.map((row) => row.outputPrice), itemStyle: { color: palette.orange } },
      ],
    };
  }, [compact, prices, palette]);
  const rangeRows = prices.filter((row) => row.cacheRangeValid).slice(0, 24).toReversed();
  const cacheOption = useMemo(() => ({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (params: Array<{ axisValue: string; seriesName: string; value: number }>) => {
      const visible = params.find((item) => item.seriesName === '命中率区间');
      const base = params.find((item) => item.seriesName === '下限');
      return `${params[0]?.axisValue || ''}<br/>缓存命中率：${base?.value ?? 0}%–${(base?.value ?? 0) + (visible?.value ?? 0)}%`;
    } },
    grid: { left: compact ? 105 : 220, right: compact ? 10 : 35, top: 20, bottom: 28 },
    xAxis: { type: 'value', min: 0, max: 100, axisLabel: { color: palette.text, fontSize: compact ? 8 : 12, formatter: '{value}%' }, splitLine: { lineStyle: { color: palette.line } } },
    yAxis: { type: 'category', data: rangeRows.map((row) => row.model), axisLabel: { color: palette.text, fontSize: compact ? 8 : 12, lineHeight: compact ? 11 : 15, width: compact ? 94 : 195, overflow: 'break', interval: 0 }, axisTick: { show: false } },
    series: [
      { name: '下限', type: 'bar', stack: 'range', data: rangeRows.map((row) => row.cacheHitLow), itemStyle: { color: 'transparent' }, emphasis: { disabled: true } },
      { name: '命中率区间', type: 'bar', stack: 'range', barWidth: 12, data: rangeRows.map((row) => (row.cacheHitHigh ?? 0) - (row.cacheHitLow ?? 0)), itemStyle: { color: palette.blue, borderRadius: 6 } },
    ],
  }), [compact, rangeRows, palette]);
  if (prices.length === 0) return <NoData description="暂无 API Token 价格" />;
  const height = Math.max(320, Math.min(720, prices.slice(0, 24).length * 32 + 90));
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={14}><ChartCard title="输入 / 缓存读取 / 输出价格"><ReactECharts option={priceOption} style={{ height }} notMerge /></ChartCard></Col>
      <Col xs={24} xl={10}><ChartCard title="实际缓存命中率区间"><ReactECharts option={cacheOption} style={{ height }} notMerge /></ChartCard></Col>
    </Row>
  );
}

function TokenPricing({ data }: DashboardProps) {
  const invalidCount = data.modelPricing.token.filter((row) => !row.cacheRangeValid && (row.cacheHitLow !== null || row.cacheHitHigh !== null)).length;
  return (
    <div className="ai-section-stack">
      {invalidCount > 0 && <Alert type="warning" showIcon title={`${invalidCount} 行缓存命中率区间异常`} description="异常行保留在表格中并标记，不进入区间图。有效范围需满足 0 ≤ 下限 ≤ 上限 ≤ 100。" />}
      <TokenPriceCharts prices={data.modelPricing.token} />
      <ChartCard title="API Token 价格明细" extra={<Text type="secondary">统一单位：USD / 1M Tokens</Text>}>
        <Table
          rowKey={(row) => `${row.vendor}-${row.model}-${row.asOf}`}
          size="small"
          pagination={{ pageSize: 15, showSizeChanger: false }}
          scroll={{ x: 1200 }}
          locale={{ emptyText: <NoData description="暂无 API Token 价格" /> }}
          dataSource={data.modelPricing.token}
          columns={[
            { title: '厂商', dataIndex: 'vendor', fixed: 'left', width: 110 },
            { title: '模型', dataIndex: 'model', fixed: 'left', width: 230, className: 'ai-model-name' },
            { title: '输入', dataIndex: 'inputPrice', width: 110, align: 'right', render: (value) => formatUsd(value, 3) },
            { title: '缓存读取', dataIndex: 'cacheReadPrice', width: 110, align: 'right', render: (value) => formatUsd(value, 3) },
            { title: '输出', dataIndex: 'outputPrice', width: 110, align: 'right', render: (value) => formatUsd(value, 3) },
            {
              title: '缓存命中率',
              width: 155,
              render: (_, row) => row.cacheRangeValid
                ? formatCacheHitRange(row.cacheHitLow, row.cacheHitHigh, true)
                : <Tag color={row.cacheHitLow === null && row.cacheHitHigh === null ? 'default' : 'error'}>{formatCacheHitRange(row.cacheHitLow, row.cacheHitHigh, false)}</Tag>,
            },
            { title: '日期', dataIndex: 'asOf', width: 112, render: dateLabel },
            { title: '来源', dataIndex: 'sourceLabel', width: 120 },
            { title: '点评', dataIndex: 'note' },
          ]}
        />
      </ChartCard>
    </div>
  );
}

function VideoPricing({ data }: DashboardProps) {
  return (
    <ChartCard title="视频模型价格" extra={<Text type="secondary">独立口径：USD / 秒</Text>}>
      <Table
        rowKey={(row) => `${row.vendor}-${row.model}-${row.mode}-${row.resolution}-${row.durationTier}`}
        size="small"
        pagination={{ pageSize: 15, showSizeChanger: false }}
        scroll={{ x: 900 }}
        locale={{ emptyText: <NoData description="暂无视频模型价格，请在飞书新表录入" /> }}
        dataSource={data.modelPricing.video}
        columns={[
          { title: '厂商', dataIndex: 'vendor', fixed: 'left', width: 120 },
          { title: '模型', dataIndex: 'model', width: 200, className: 'ai-model-name' },
          { title: '生成模式', dataIndex: 'mode', width: 150 },
          { title: '分辨率', dataIndex: 'resolution', width: 130 },
          { title: '时长档', dataIndex: 'durationTier', width: 130 },
          { title: 'USD / 秒', dataIndex: 'pricePerSecond', width: 120, align: 'right', render: (value) => <Text strong>{formatUsd(value, 4)}</Text> },
          { title: '日期', dataIndex: 'asOf', width: 112, render: dateLabel },
          { title: '来源', dataIndex: 'sourceLabel' },
        ]}
      />
    </ChartCard>
  );
}

function CodingPlanPricing({ data }: DashboardProps) {
  return (
    <ChartCard title="Coding Plan 价格" extra={<Text type="secondary">套餐价格与额度限制分开记录</Text>}>
      <Table
        rowKey={(row) => `${row.vendor}-${row.plan}`}
        size="small"
        pagination={{ pageSize: 15, showSizeChanger: false }}
        scroll={{ x: 980 }}
        locale={{ emptyText: <NoData description="暂无 Coding Plan 价格，请在飞书新表录入" /> }}
        dataSource={data.modelPricing.codingPlans}
        columns={[
          { title: '厂商', dataIndex: 'vendor', fixed: 'left', width: 120 },
          { title: '套餐', dataIndex: 'plan', width: 180 },
          { title: '月付', dataIndex: 'monthlyPrice', width: 115, align: 'right', render: (value) => formatUsd(value) },
          { title: '年付折算/月', dataIndex: 'annualMonthlyPrice', width: 145, align: 'right', render: (value) => formatUsd(value) },
          { title: '额度限制', dataIndex: 'limits', width: 250 },
          { title: '超量计费', dataIndex: 'overage', width: 220 },
          { title: '日期', dataIndex: 'asOf', width: 112, render: dateLabel },
          { title: '来源', dataIndex: 'sourceLabel' },
        ]}
      />
    </ChartCard>
  );
}

export function ModelPricingSection({ data }: DashboardProps) {
  return <Tabs className="ai-inner-tabs" items={[
    { key: 'token', label: 'API Token', children: <TokenPricing data={data} /> },
    { key: 'video', label: '视频模型', children: <VideoPricing data={data} /> },
    { key: 'coding', label: 'Coding Plan', children: <CodingPlanPricing data={data} /> },
  ]} />;
}

function benchmarkMetrics(models: BenchmarkModel[]) {
  return [...new Set(models.flatMap((model) => Object.keys(model.scores || {})))];
}

function legacyMetricDefinition(key: string, models: BenchmarkModel[]): BenchmarkMetricDefinition {
  const score = models.find((model) => model.scores?.[key])?.scores?.[key];
  return {
    key,
    label: key,
    group: '飞书历史口径',
    unit: score && Number.isFinite(score.value) && Math.abs(score.value) <= 1 ? 'percent' : (score?.metric || 'number'),
    direction: score?.direction === 'lower' ? 'lower' : 'higher',
    source: score?.source || 'feishu',
    sourceUrl: score?.sourceUrl,
  };
}

function BenchmarkScoreTooltip({ score, metric }: {
  score: BenchmarkModel['scores'][string];
  metric: BenchmarkMetricDefinition;
}) {
  return (
    <Space direction="vertical" size={2}>
      <Text>{metric.label} · {metric.direction === 'lower' ? 'lower-is-better' : 'higher-is-better'}</Text>
      <Text>来源：{score.source || metric.source}</Text>
      {score.asOf && <Text>数据日期：{dateLabel(score.asOf)}</Text>}
      {score.sampleSize !== undefined && <Text>样本数：{score.sampleSize}</Text>}
      {score.standardDeviation !== undefined && <Text>标准差：{score.standardDeviation}</Text>}
      {(score.sourceUrl || metric.sourceUrl) && <a href={score.sourceUrl || metric.sourceUrl} target="_blank" rel="noreferrer">查看来源</a>}
    </Space>
  );
}

export function BenchmarkSection({ data, refreshing = false }: DashboardProps & { refreshing?: boolean }) {
  const metrics = data.benchmarks.metrics?.length
    ? data.benchmarks.metrics
    : benchmarkMetrics(data.benchmarks.models).map((key) => legacyMetricDefinition(key, data.benchmarks.models));
  const matrixRows = data.benchmarks.models.map((model) => ({ ...model, key: `${model.vendor}-${model.model}` }));
  const metricsByGroup = metrics.reduce<Map<string, BenchmarkMetricDefinition[]>>((groups, metric) => {
    groups.set(metric.group, [...(groups.get(metric.group) || []), metric]);
    return groups;
  }, new Map());
  const metricByKey = new Map(metrics.map((metric) => [metric.key, metric]));
  const coverage = data.benchmarks.coverage || {
    vendors: matrixRows.length,
    evaluatedVendors: matrixRows.filter((model) => Object.keys(model.scores || {}).length > 0).length,
    metrics: metrics.length,
  };
  return (
    <div className="ai-section-stack">
      <Alert
        type={data.benchmarks.sourceMode === 'openrouter' ? 'info' : 'warning'}
        showIcon
        title={`${coverage.vendors} 个厂商的最新文本模型 · ${coverage.evaluatedVendors} 个已评测 · ${coverage.metrics} 个分项`}
        description={(
          <Flex gap={8} wrap>
            <Text type="secondary">数据日期 {dateLabel(data.benchmarks.asOf)}</Text>
            <Tag color={data.benchmarks.sourceMode === 'openrouter' ? 'blue' : 'default'}>{data.benchmarks.sourceMode === 'openrouter' ? 'OpenRouter 统一 Benchmark API' : '飞书 / 上一版'}</Tag>
            {refreshing && <Tag color="processing">正在检查最新数据…</Tag>}
          </Flex>
        )}
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={7}>
          <ChartCard title="各分项最强模型" extra={<Tag>排除 Fable / Mythos</Tag>}>
            {Object.keys(data.benchmarks.winners).length === 0 ? <NoData description="暂无冠军摘要" /> : (
              <div className="ai-winner-list">
                {Object.entries(data.benchmarks.winners).map(([metricKey, winners]) => {
                  const metric = metricByKey.get(metricKey) || legacyMetricDefinition(metricKey, data.benchmarks.models);
                  return (
                    <div className="ai-winner-row" key={metricKey}>
                      <div><Text strong>{metric.label}</Text> <Tag variant="filled">{metric.direction === 'lower' ? '越低越好' : '越高越好'}</Tag></div>
                      <Text type="secondary">{metric.group}</Text>
                      <Text className="ai-winner-name">{winners.join(' / ')}</Text>
                    </div>
                  );
                })}
              </div>
            )}
          </ChartCard>
        </Col>
        <Col xs={24} xl={17}>
          <ChartCard title="各厂商最新模型 Benchmark 矩阵" extra={<Text type="secondary">旧模型得分不顶替最新模型 · 并列第一完整保留</Text>}>
            <Table
              rowKey="key"
              size="small"
              pagination={false}
              scroll={{ x: Math.max(960, 500 + metrics.length * 150) }}
              locale={{ emptyText: <NoData description="暂无 Benchmark 数据" /> }}
              dataSource={matrixRows}
              columns={[
                { title: '厂商', dataIndex: 'vendor', fixed: 'left', width: 115 },
                { title: '最新文本模型', dataIndex: 'model', fixed: 'left', width: 220, className: 'ai-model-name' },
                { title: '发布日期', dataIndex: 'releasedAt', width: 112, render: dateLabel },
                {
                  title: '评测状态',
                  width: 105,
                  render: (_: unknown, row: BenchmarkModel) => Object.keys(row.scores || {}).length > 0
                    ? <Tag color="success">已评测</Tag>
                    : <Tag>尚未评测</Tag>,
                },
                ...[...metricsByGroup.entries()].map(([group, groupMetrics]) => ({
                  title: group,
                  children: groupMetrics.map((metric) => ({
                    title: <Tooltip title={`${metric.direction === 'lower' ? 'lower' : 'higher'}-is-better · ${metric.source}`}>{metric.label}</Tooltip>,
                    width: 150,
                    align: 'right' as const,
                    render: (_: unknown, row: BenchmarkModel) => {
                      const score = row.scores?.[metric.key];
                      const champion = data.benchmarks.winners[metric.key]?.includes(row.model);
                      if (!score) return <Text type="secondary">—</Text>;
                      return (
                        <Tooltip title={<BenchmarkScoreTooltip score={score} metric={metric} />}>
                          <Text strong={champion} className={champion ? 'ai-benchmark-winner' : ''}>{formatBenchmarkValue(score, metric)}</Text>
                        </Tooltip>
                      );
                    },
                  })),
                })),
              ]}
            />
            {data.benchmarks.attributions?.length > 0 && (
              <Flex className="ai-benchmark-attributions" gap={10} wrap>
                <Text type="secondary">数据来源：</Text>
                {data.benchmarks.attributions.map((source) => source.url
                  ? <a key={source.source} href={source.url} target="_blank" rel="noreferrer">{source.label}</a>
                  : <Text key={source.source}>{source.label}</Text>)}
              </Flex>
            )}
          </ChartCard>
        </Col>
      </Row>
    </div>
  );
}

function ComputeLatestChart({ quotes }: { quotes: ComputeRentalQuote[] }) {
  const palette = useChartPalette();
  const screens = Grid.useBreakpoint();
  const compact = !screens.sm;
  const rows = quotes.toReversed();
  const option = useMemo(() => ({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (value: number) => formatUsd(value, 3) },
    legend: { top: 0, textStyle: { color: palette.text } },
    grid: { left: compact ? 100 : 180, right: compact ? 8 : 32, top: 44, bottom: 32 },
    xAxis: { type: 'value', name: compact ? '' : 'USD / GPU / 小时', axisLabel: { color: palette.text, fontSize: compact ? 8 : 12 }, splitLine: { lineStyle: { color: palette.line } } },
    yAxis: { type: 'category', data: rows.map((row) => `${row.platform} · ${row.gpu}`), axisLabel: { color: palette.text, fontSize: compact ? 8 : 12, width: compact ? 90 : 160, overflow: 'break' }, axisTick: { show: false } },
    series: [
      { name: 'On-demand', type: 'bar', data: rows.map((row) => row.onDemand), itemStyle: { color: palette.blue } },
      { name: 'Preemptible', type: 'bar', data: rows.map((row) => row.preemptible), itemStyle: { color: palette.cyan } },
    ],
  }), [compact, rows, palette]);
  if (quotes.length === 0) return <NoData description="暂无最新租赁报价" />;
  return <ReactECharts option={option} style={{ height: Math.max(340, rows.length * 36 + 90) }} notMerge />;
}

function ComputeHistoryChart({ quotes }: { quotes: ComputeRentalQuote[] }) {
  const palette = useChartPalette();
  const screens = Grid.useBreakpoint();
  const compact = !screens.sm;
  const dates = [...new Set(quotes.map((row) => row.asOf))].sort();
  const groups = new Map<string, ComputeRentalQuote[]>();
  for (const row of quotes) {
    const key = `${row.platform} · ${row.gpu}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const series = [...groups.entries()].flatMap(([key, rows]) => {
    const byDate = new Map(rows.map((row) => [row.asOf, row]));
    return [
      { name: `${key} On-demand`, type: 'line', showSymbol: false, connectNulls: true, data: dates.map((date) => byDate.get(date)?.onDemand ?? null) },
      { name: `${key} Preemptible`, type: 'line', showSymbol: false, connectNulls: true, lineStyle: { type: 'dashed' }, data: dates.map((date) => byDate.get(date)?.preemptible ?? null) },
    ];
  });
  const option = useMemo(() => ({
    tooltip: { trigger: 'axis', valueFormatter: (value: number) => formatUsd(value, 3) },
    legend: { type: 'scroll', top: 0, textStyle: { color: palette.text } },
    grid: { left: compact ? 44 : 70, right: compact ? 8 : 24, top: 64, bottom: 44 },
    xAxis: { type: 'category', data: dates, axisLabel: { color: palette.text, fontSize: compact ? 8 : 12 }, axisLine: { lineStyle: { color: palette.line } } },
    yAxis: { type: 'value', name: compact ? '' : 'USD/GPU/h', axisLabel: { color: palette.text, fontSize: compact ? 8 : 12 }, splitLine: { lineStyle: { color: palette.line } } },
    series,
  }), [compact, dates, series, palette]);
  if (quotes.length === 0) return <NoData description="暂无租赁历史" />;
  return <ReactECharts option={option} style={{ height: 400 }} notMerge />;
}

export function ComputeRentalSection({ data }: DashboardProps) {
  const latest = data.computeRental.filter((row) => row.latest);
  return (
    <div className="ai-section-stack">
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}><ChartCard title="最新租赁价格横向对比"><ComputeLatestChart quotes={latest} /></ChartCard></Col>
        <Col xs={24} xl={12}><ChartCard title="租赁价格历史趋势"><ComputeHistoryChart quotes={data.computeRental} /></ChartCard></Col>
      </Row>
      <ChartCard title="最新报价、绝对涨跌与折价比例">
        <Table
          rowKey={(row) => `${row.platform}-${row.gpu}-${row.asOf}`}
          size="small"
          pagination={false}
          scroll={{ x: 1050 }}
          locale={{ emptyText: <NoData description="暂无算力租赁数据" /> }}
          dataSource={latest}
          columns={[
            { title: '平台', dataIndex: 'platform', fixed: 'left', width: 140 },
            { title: 'GPU', dataIndex: 'gpu', fixed: 'left', width: 130 },
            { title: '日期', dataIndex: 'asOf', width: 112 },
            { title: 'On-demand', dataIndex: 'onDemand', width: 130, align: 'right', render: (value) => formatUsd(value, 3) },
            { title: '绝对涨跌', dataIndex: 'onDemandChange', width: 120, align: 'right', render: changeNode },
            { title: 'Preemptible', dataIndex: 'preemptible', width: 130, align: 'right', render: (value) => formatUsd(value, 3) },
            { title: '绝对涨跌', dataIndex: 'preemptibleChange', width: 120, align: 'right', render: changeNode },
            { title: 'Preemptible / On-demand', dataIndex: 'preemptibleRatio', width: 205, align: 'right', render: (value) => value === null ? '—' : `${(value * 100).toFixed(1)}%` },
            { title: '来源', dataIndex: 'sourceLabel' },
          ]}
        />
      </ChartCard>
    </div>
  );
}

export function DebtFinancingSection({ data }: DashboardProps) {
  const latest = data.debtFinancing[0];
  return (
    <div className="ai-section-stack">
      <ChartCard title="最新债务融资事件" className="ai-debt-highlight">
        {latest ? (
          <Row gutter={[24, 20]} align="middle">
            <Col xs={24} md={7}><Text type="secondary">公司 / 日期</Text><Title level={3}>{latest.company}</Title><Text>{dateLabel(latest.asOf)}</Text></Col>
            <Col xs={24} md={8}><Text type="secondary">融资手段</Text><Title level={2} className="ai-emphasis-value">{latest.method}</Title></Col>
            <Col xs={24} md={9}><Text type="secondary">融资规模</Text><Title level={2} className="ai-emphasis-value">{latest.currency} {compactNumber(latest.amount)}</Title></Col>
            <Col span={24}><Paragraph>{latest.note || '暂无点评'}</Paragraph><Text type="secondary">来源：{latest.sourceLabel} · 更新于 {dateLabel(latest.updatedAt)}</Text></Col>
          </Row>
        ) : <NoData description="暂无结构化债务融资事件，请在飞书新表录入" />}
      </ChartCard>
      <ChartCard title="债务融资明细">
        <Table
          rowKey={(row) => `${row.company}-${row.asOf}-${row.method}`}
          size="middle"
          pagination={{ pageSize: 15, showSizeChanger: false }}
          scroll={{ x: 1080 }}
          locale={{ emptyText: <NoData description="暂无债务融资数据" /> }}
          dataSource={data.debtFinancing}
          columns={[
            { title: '公司', dataIndex: 'company', fixed: 'left', width: 150 },
            { title: '日期', dataIndex: 'asOf', width: 112, render: dateLabel },
            { title: '融资手段', dataIndex: 'method', width: 220, render: (value) => <Text strong className="ai-emphasis-value">{value}</Text> },
            { title: '融资规模', width: 190, render: (_, row) => <Text strong className="ai-emphasis-value">{row.currency} {compactNumber(row.amount)}</Text> },
            { title: '点评', dataIndex: 'note', width: 280 },
            { title: '来源', dataIndex: 'sourceLabel', width: 130 },
            { title: '更新时间', dataIndex: 'updatedAt', width: 112, render: dateLabel },
          ]}
        />
      </ChartCard>
    </div>
  );
}
