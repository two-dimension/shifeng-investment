import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  List,
  Tag,
  Space,
  Typography,
  Spin,
  Empty,
  Button,
  DatePicker,
  Divider,
  Table,
  Input,
  Segmented,
  Drawer,
  Modal,
  Tooltip,
  Badge,
  message,
} from 'antd';
// Segmented 用于业绩预告明细筛选

import type { ColumnsType } from 'antd/es/table';
import {
  FileProtectOutlined,
  RiseOutlined,
  DownloadOutlined,
  FileExcelOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  CalendarOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  SearchOutlined,
  EyeOutlined,
  LinkOutlined,
  SyncOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
// 顶部显示更新时间，并支持手动触发本地产物同步
import {
  useResearchLatest,
  useResearchHistory,
  useResearchSummary,
} from '../../hooks/useResearch';
import {
  formatScore,
  formatFileSize,
  scoreColor,
  forecastTypeColor,
  RESEARCH_GOOD_COLOR,
  RESEARCH_BAD_COLOR,
  RESEARCH_GOOD_TAG_COLOR,
  RESEARCH_BAD_TAG_COLOR,
} from '../../types/research';
import type {
  ResearchKind,
  ResearchTopEntry,
  EarningsItem,
  ResearchFile,
} from '../../types/research';
import { useTheme } from '../../hooks/useTheme';
import './ResearchPanel.css';

const { Text, Title, Paragraph } = Typography;

const KIND_META: Record<ResearchKind, { label: string; icon: React.ReactNode }> = {
  cninfo: { label: '公告研判', icon: <FileProtectOutlined /> },
  earnings: { label: '业绩预告', icon: <RiseOutlined /> },
  'earnings-report': { label: '业绩报告', icon: <FileTextOutlined /> },
  risk: { label: '风险提示', icon: <WarningOutlined /> },
};

function isEarningsKind(kind: ResearchKind): kind is 'earnings' | 'earnings-report' {
  return kind === 'earnings' || kind === 'earnings-report';
}

interface ResearchSyncResponse {
  success: boolean;
  error?: string;
  totals?: {
    attempted: number;
    succeeded: number;
    failed: number;
    changedDates: number;
    filesCopied: number;
    filesSkipped: number;
  };
}

async function postResearchSync(kind: ResearchKind, date: string | null): Promise<ResearchSyncResponse> {
  const res = await fetch('/api/research/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind,
      date: date || undefined,
      days: date ? undefined : 14,
      force: false,
    }),
  });
  const payload = await res.json().catch(() => ({})) as ResearchSyncResponse;
  if (!res.ok) {
    throw new Error(payload.error || `同步失败: HTTP ${res.status}`);
  }
  return payload;
}

function formatWanForDisplay(low?: number | null, high?: number | null): string {
  const hasLow = typeof low === 'number' && Number.isFinite(low);
  const hasHigh = typeof high === 'number' && Number.isFinite(high);
  if (!hasLow && !hasHigh) return '';

  const formatValue = (value: number) =>
    value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

  if (hasLow && hasHigh && low !== high) {
    return `${formatValue(low)} ~ ${formatValue(high)}`;
  }

  const value = hasHigh ? high : low;
  return typeof value === 'number' ? formatValue(value) : '';
}

function isDisplayablePctRange(low?: number | null, high?: number | null): boolean {
  const hasLow = typeof low === 'number' && Number.isFinite(low);
  const hasHigh = typeof high === 'number' && Number.isFinite(high);
  if (!hasLow && !hasHigh) return false;
  return !((low ?? 0) === 0 && (high ?? 0) === 0);
}

function formatPctForDisplay(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatPctRangeForDisplay(low?: number | null, high?: number | null): string {
  const hasLow = typeof low === 'number' && Number.isFinite(low);
  const hasHigh = typeof high === 'number' && Number.isFinite(high);
  if (hasLow && hasHigh && low !== high) return `${formatPctForDisplay(low)} ~ ${formatPctForDisplay(high)}`;
  const value = hasHigh ? high : low;
  return typeof value === 'number' ? formatPctForDisplay(value) : '';
}

function splitScopeValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => splitScopeValue(item));
  }
  if (typeof value !== 'string') return [];
  return value
    .split(/[;；,，、/|｜\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatResearchScopeLabels(source: unknown, fallback = '其他'): string[] {
  const record = source && typeof source === 'object' && !Array.isArray(source)
    ? source as Record<string, unknown>
    : { subset: source };
  const subsetFields = [
    '所属子集',
    'subset',
    'subsets',
    'subsetName',
    'subsetNames',
    'matchedSubset',
    'matchedSubsets',
    'watchlistName',
    'watchlistNames',
    'watchlist',
    'portfolio',
    'concepts',
    'concept',
    '概念',
  ];
  const industryFields = ['行业', 'industry', 'industries', 'sector', 'sectors', '板块'];
  const ordered = [...subsetFields, ...industryFields]
    .flatMap((field) => splitScopeValue(record[field]))
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const realLabels = ordered.filter((label) => label !== '其他');
  const labels = realLabels.length > 0 ? realLabels : ordered;
  if (labels.length > 0) return labels.slice(0, 3);
  return fallback ? [fallback] : [];
}

function formatTopCompanyNames(entries: ResearchTopEntry[]): string {
  const names = entries
    .slice(0, 5)
    .map((entry) => entry.name?.trim())
    .filter(Boolean);
  return names.length > 0 ? names.join('、') : '无';
}

function getResearchColors(theme: 'light' | 'dark') {
  const isDark = theme === 'dark';
  return {
    pageTitle: isDark ? '#f0f0f0' : '#262626',
    primaryText: isDark ? '#f0f0f0' : '#262626',
    secondaryText: isDark ? '#c7c7c7' : '#595959',
    tertiaryText: isDark ? '#a6a6a6' : '#8c8c8c',
    cardBg: isDark ? '#202020' : '#ffffff',
    panelBg: isDark ? '#292929' : '#f8fafc',
    hoverBg: isDark ? '#303030' : '#f3f6fa',
    border: isDark ? '#454545' : '#d9e0e9',
    divider: isDark ? '#363636' : '#e9edf2',
    rowAlt: isDark ? '#252525' : '#f8fafc',
    shadow: isDark
      ? '0 1px 2px rgba(0, 0, 0, 0.42)'
      : '0 1px 3px rgba(31, 45, 61, 0.08)',
    logicBg: isDark ? '#262626' : '#fafafa',
    logicBorder: isDark ? '#3a3a3a' : '#f0f0f0',
    goodSummaryText: isDark ? '#ff9999' : '#cf1322',
    goodSummaryBg: isDark ? 'rgba(255, 77, 79, 0.16)' : '#fff1f0',
    goodSummaryBorder: isDark ? 'rgba(255, 120, 117, 0.55)' : '#ffa39e',
    badSummaryText: isDark ? '#95de64' : '#389e0d',
    badSummaryBg: isDark ? 'rgba(82, 196, 26, 0.15)' : '#f6ffed',
    badSummaryBorder: isDark ? 'rgba(115, 209, 61, 0.55)' : '#b7eb8f',
  };
}

const ResearchPanel: React.FC = () => {
  const { theme } = useTheme();
  const colors = getResearchColors(theme);
  const [kind, setKind] = useState<ResearchKind>('cninfo');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);
  const previousLatestDateRef = useRef<string | null>(null);

  const { data: history, loading: historyLoading, refetch: refetchHistory } = useResearchHistory(kind);
  const { data: latest, refetch: refetchLatest } = useResearchLatest(kind);
  const activeHistory = history?.kind === kind ? history : null;
  const activeLatest = latest?.kind === kind ? latest : null;

  // 默认跟随最新可用报告；用户手动点历史日期后，不强行跳回最新。
  useEffect(() => {
    if (!activeLatest?.date) return;

    const previousLatestDate = previousLatestDateRef.current;
    previousLatestDateRef.current = activeLatest.date;

    if (!selectedDate || selectedDate === previousLatestDate) {
      setSelectedDate(activeLatest.date);
    }
  }, [activeLatest?.date, selectedDate]);

  const handleKindChange = useCallback((nextKind: ResearchKind) => {
    previousLatestDateRef.current = null;
    setSelectedDate(null);
    setKind(nextKind);
  }, []);

  const updatedAt = activeLatest?.generatedAt
    ? dayjs(activeLatest.generatedAt).format('MM-DD HH:mm')
    : '暂无';
  const availableDateSet = useMemo(
    () => new Set(activeHistory?.dates || []),
    [activeHistory?.dates],
  );
  const hasSelectedDate = Boolean(selectedDate && availableDateSet.has(selectedDate));
  const selectedDateValue = hasSelectedDate && selectedDate ? dayjs(selectedDate) : null;
  const handleSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await postResearchSync(kind, null);
      await Promise.all([refetchHistory(), refetchLatest()]);
      setDetailVersion((v) => v + 1);

      const totals = result.totals;
      if (!result.success && totals?.failed) {
        message.warning(`同步完成，但有 ${totals.failed} 个日期失败`);
      } else {
        message.success(
          totals
            ? `同步完成：更新 ${totals.changedDates} 天，复制 ${totals.filesCopied} 个文件`
            : '同步完成',
        );
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '同步失败');
    } finally {
      setSyncing(false);
    }
  }, [kind, refetchHistory, refetchLatest, syncing]);

  const detailContent = historyLoading ? (
    <div style={{ textAlign: 'center', padding: 80 }}>
      <Spin />
    </div>
  ) : hasSelectedDate && selectedDate ? (
    <ResearchDetail
      key={`${kind}-${selectedDate}-${detailVersion}`}
      kind={kind}
      date={selectedDate}
    />
  ) : (
    <Empty description="暂无可选日期" style={{ marginTop: 80 }} />
  );

  return (
    <div
      className={`research-workspace research-workspace--${theme}`}
      style={{
        '--research-border': colors.border,
        '--research-divider': colors.divider,
        '--research-panel': colors.cardBg,
        '--research-panel-soft': colors.panelBg,
        '--research-row-alt': colors.rowAlt,
        '--research-hover': colors.hoverBg,
        '--research-shadow': colors.shadow,
        '--research-text': colors.primaryText,
        '--research-text-secondary': colors.secondaryText,
      } as React.CSSProperties}
    >
      <div className="research-workspace__toolbar">
        <Title level={4} className="research-workspace__title" style={{ color: colors.pageTitle }}>
          公告监控
        </Title>

        <Segmented
          className="research-workspace__tabs"
          value={kind}
          onChange={(value) => handleKindChange(value as ResearchKind)}
          options={(['cninfo', 'earnings', 'earnings-report', 'risk'] as ResearchKind[]).map((key) => ({
            value: key,
            label: (
              <span className="research-workspace__tab-label">
                {KIND_META[key].icon}
                {KIND_META[key].label}
              </span>
            ),
          }))}
        />

        <div className="research-workspace__controls">
          <Space wrap>
            <CalendarOutlined />
            <Text strong style={{ color: colors.primaryText }}>历史日期</Text>
            <DatePicker
              size="small"
              allowClear={false}
              inputReadOnly
              value={selectedDateValue}
              format="YYYY-MM-DD"
              disabled={historyLoading || !activeHistory?.dates.length}
              disabledDate={(current) => !current || !availableDateSet.has(current.format('YYYY-MM-DD'))}
              onChange={(value) => {
                if (value) setSelectedDate(value.format('YYYY-MM-DD'));
              }}
            />
            <Text style={{ fontSize: 12, color: colors.secondaryText }}>
              共 {activeHistory?.dates.length || 0} 天
            </Text>
          </Space>
          <Tooltip title="刷新最近 14 天本地产物">
            <Button size="small" icon={<SyncOutlined />} onClick={handleSync} loading={syncing}>
              刷新
            </Button>
          </Tooltip>
          <Text style={{ fontSize: 12, color: colors.secondaryText, whiteSpace: 'nowrap' }}>
            更新时间：{updatedAt}
          </Text>
        </div>
      </div>

      <div className="research-workspace__body">
        {detailContent}
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────
// 详情面板
// ──────────────────────────────────────────────
const ResearchDetail: React.FC<{ kind: ResearchKind; date: string }> = ({ kind, date }) => {
  const { theme } = useTheme();
  const colors = getResearchColors(theme);
  const { data, loading, error } = useResearchSummary(kind, date);
  const [filePreview, setFilePreview] = useState<ResearchFile | null>(null);

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 80 }}><Spin /></div>;
  }

  if (error || !data) {
    return <Empty description={error || '数据加载失败'} style={{ marginTop: 80 }} />;
  }

  const goodCount = data.stats.goodCount ?? 0;
  const badCount = data.stats.badCount ?? 0;
  const majorRiskCount = data.stats.majorRiskCount ?? 0;

  const filesSection = data.files.length > 0 ? (
    <>
      <Divider style={{ margin: '24px 0 16px' }}>原始报告下载</Divider>
      <Space wrap>
        {data.files.map((file) => (
          <Space.Compact key={file.filename}>
            <Button
              icon={file.type === 'xlsx' ? <FileExcelOutlined /> : <FilePdfOutlined />}
              href={file.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Space>
                <span>{file.filename}</span>
                <Text style={{ fontSize: 11, color: colors.secondaryText }}>
                  ({formatFileSize(file.size)})
                </Text>
              </Space>
            </Button>
            <Button
              icon={<EyeOutlined />}
              onClick={() => setFilePreview(file)}
              title="在线预览"
            />
          </Space.Compact>
        ))}
      </Space>
    </>
  ) : null;

  return (
    <div className={`cninfo-workbench research-workbench--${kind}`}>
      <ResearchBriefing
        kind={kind}
        date={date}
        coverage={data.coverage}
        generatedAt={data.generatedAt}
        totalCount={data.totalCount}
        watchlistHits={data.watchlistHits}
        goodCount={goodCount}
        badCount={badCount}
        majorRiskCount={majorRiskCount}
        riskCompanyCount={data.stats.riskCompanyCount}
        topGood={data.topGood}
        topBad={data.topBad}
      />

      <ResearchSignalBoard
        kind={kind}
        topGood={data.topGood}
        topBad={data.topBad}
      />

      {kind === 'cninfo' && data.allGood && data.allBad && (
        data.allGood.length > 5 || data.allBad.length > 5 ? (
          <FullLists allGood={data.allGood} allBad={data.allBad} />
        ) : null
      )}

      {isEarningsKind(kind) && data.allItems && data.allItems.length > 0 && (
        <EarningsFullTable kind={kind} items={data.allItems} />
      )}

      {kind === 'risk' && data.allBad && data.allBad.length > 5 && (
        <FullLists
          allGood={[]}
          allBad={data.allBad}
          badLabel="全部风险"
          badDrawerTitle="全部风险提示"
          kindForScore="risk"
        />
      )}

      {filesSection}
      <FilePreviewModal file={filePreview} onClose={() => setFilePreview(null)} />
    </div>
  );
};

// ──────────────────────────────────────────────
// 统一公告监控工作台
// ──────────────────────────────────────────────
const ResearchBriefing: React.FC<{
  kind: ResearchKind;
  date: string;
  coverage: string;
  generatedAt: string;
  totalCount: number;
  watchlistHits: number;
  goodCount: number;
  badCount: number;
  majorRiskCount: number;
  riskCompanyCount?: number;
  topGood: ResearchTopEntry[];
  topBad: ResearchTopEntry[];
}> = ({
  kind,
  date,
  coverage,
  generatedAt,
  totalCount,
  watchlistHits,
  goodCount,
  badCount,
  majorRiskCount,
  riskCompanyCount,
  topGood,
  topBad,
}) => {
  const { theme } = useTheme();
  const colors = getResearchColors(theme);
  const isRisk = kind === 'risk';
  const nameRows = isRisk
    ? [{ key: 'risk', label: '风险：', entries: topBad, color: RESEARCH_BAD_COLOR }]
    : [
      { key: 'good', label: '利好：', entries: topGood, color: RESEARCH_GOOD_COLOR },
      { key: 'bad', label: '利空：', entries: topBad, color: RESEARCH_BAD_COLOR },
    ];
  const metrics: Array<{ key: string; label: React.ReactNode; value: React.ReactNode }> = [
    { key: 'total', label: '公告总数', value: `${totalCount} 条` },
    { key: 'watchlist', label: '自选命中', value: `${watchlistHits} 条` },
    isRisk
      ? {
        key: 'risk-balance',
        label: <b style={{ color: RESEARCH_BAD_COLOR }}>风险 / 高风险</b>,
        value: <b style={{ color: RESEARCH_BAD_COLOR }}>{badCount} / {majorRiskCount}</b>,
      }
      : {
        key: 'balance',
        label: (
          <>
            <b style={{ color: RESEARCH_GOOD_COLOR }}>利好</b>
            {' / '}
            <b style={{ color: RESEARCH_BAD_COLOR }}>利空</b>
          </>
        ),
        value: (
          <>
            <b style={{ color: RESEARCH_GOOD_COLOR }}>{goodCount}</b>
            <i> / </i>
            <b style={{ color: RESEARCH_BAD_COLOR }}>{badCount}</b>
          </>
        ),
      },
  ];
  if (isRisk && riskCompanyCount !== undefined) {
    metrics.push({
      key: 'risk-companies',
      label: <b style={{ color: RESEARCH_BAD_COLOR }}>风险公司</b>,
      value: <b style={{ color: RESEARCH_BAD_COLOR }}>{riskCompanyCount} 家</b>,
    });
  }

  return (
    <section className="cninfo-briefing" aria-label={`${KIND_META[kind].label}摘要`}>
      <div className="cninfo-briefing__date">
        <Title level={2} style={{ margin: 0, color: colors.primaryText }}>{date}</Title>
        <Text style={{ fontSize: 14, color: colors.secondaryText }}>
          {dayjs(date).format('dddd')}
        </Text>
        <div className="cninfo-briefing__kind">
          {KIND_META[kind].icon}
          {KIND_META[kind].label}
        </div>
        <div className="cninfo-briefing__coverage">
          <span>扫描覆盖：{coverage}</span>
          <span>生成时间：{dayjs(generatedAt).format('YYYY-MM-DD HH:mm')}</span>
        </div>
      </div>

      <div className="cninfo-briefing__names">
        {nameRows.map((row) => (
          <div key={row.key} className="cninfo-briefing__name-row" style={{ color: row.color }}>
            <strong>{row.label}</strong>
            <span>{formatTopCompanyNames(row.entries)}</span>
          </div>
        ))}
      </div>

      <div
        className={`cninfo-briefing__metrics cninfo-briefing__metrics--${metrics.length}`}
        aria-label="公告统计"
      >
        {metrics.map((metric) => (
          <div className="cninfo-briefing__metric" key={metric.key}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
};

const ResearchSignalBoard: React.FC<{
  kind: ResearchKind;
  topGood: ResearchTopEntry[];
  topBad: ResearchTopEntry[];
}> = ({ kind, topGood, topBad }) => {
  if (kind === 'risk') {
    return (
      <section className="cninfo-signal-board cninfo-signal-board--single" aria-label="风险提示榜单">
        <ResearchSignalColumn title="风险 TOP5" entries={topBad} kind={kind} positive={false} />
      </section>
    );
  }

  return (
    <section className="cninfo-signal-board" aria-label={`${KIND_META[kind].label}榜单`}>
      <ResearchSignalColumn title="利好 TOP5" entries={topGood} kind={kind} positive />
      <ResearchSignalColumn title="利空 TOP5" entries={topBad} kind={kind} positive={false} />
    </section>
  );
};

const ResearchSignalColumn: React.FC<{
  title: string;
  entries: ResearchTopEntry[];
  kind: ResearchKind;
  positive: boolean;
}> = ({ title, entries, kind, positive }) => {
  const { theme } = useTheme();
  const colors = getResearchColors(theme);
  const semanticColor = positive ? RESEARCH_GOOD_COLOR : RESEARCH_BAD_COLOR;
  const contentHeader = isEarningsKind(kind)
    ? `${kind === 'earnings-report' ? '报告' : '预告'}期间 / 净利润 / 核心摘要`
    : kind === 'risk'
      ? '公告标题 / 风险摘要'
      : '公告标题 / 研判摘要';
  const scoreHeader = isEarningsKind(kind) ? '同比 / 操作' : '评分 / 操作';

  return (
    <div className="cninfo-signal-column">
      <div className="cninfo-signal-column__title" style={{ color: semanticColor }}>
        {positive ? <ArrowUpOutlined /> : kind === 'risk' ? <WarningOutlined /> : <ArrowDownOutlined />}
        <strong>{title}</strong>
      </div>

      <div className="cninfo-signal-column__header" aria-hidden="true">
        <span>#</span>
        <span>公司 / 代码 / 子集</span>
        <span>{contentHeader}</span>
        <span>{scoreHeader}</span>
      </div>

      {entries.length === 0 ? (
        <div className="cninfo-signal-column__empty">本交易日无相关公告</div>
      ) : entries.map((item) => {
        const scopeLabels = formatResearchScopeLabels(item, '');
        const profitWanLabel = isEarningsKind(kind)
          ? formatWanForDisplay(item.lowWan, item.highWan)
          : '';
        return (
          <article className="cninfo-signal-row" key={`${item.code}-${item.rank}`}>
            <div className="cninfo-signal-row__rank">{item.rank}</div>

            <div className="cninfo-signal-row__company">
              <div className="cninfo-signal-row__identity">
                <Text strong style={{ color: colors.primaryText }}>{item.name}</Text>
                <Text style={{ fontSize: 11, color: colors.secondaryText }}>{item.code}</Text>
                {item.annCount && item.annCount > 1 && (
                  <Tooltip title={`当日公告数：${item.annCount} 条`}>
                    <Badge count={item.annCount} size="small" style={{ backgroundColor: '#1890ff' }} />
                  </Tooltip>
                )}
              </div>
              {scopeLabels.length > 0 && (
                <div className="cninfo-signal-row__tags">
                  {scopeLabels.map((label) => (
                    <Tag key={label}>{label}</Tag>
                  ))}
                </div>
              )}
            </div>

            <div className="cninfo-signal-row__content">
              <div className="cninfo-signal-row__announcement">{item.title}</div>
              {profitWanLabel && (
                <div className="cninfo-signal-row__metric">
                  {item.metric || '净利润'}（万元）：<strong>{profitWanLabel}</strong>
                </div>
              )}
              {item.summary && (
                <div className="cninfo-signal-row__summary" style={{ color: semanticColor }}>
                  {item.summary}
                </div>
              )}
            </div>

            <div className="cninfo-signal-row__action">
              <div className="cninfo-signal-row__score" style={{ color: semanticColor }}>
                {item.scoreLabel || formatScore(item.score, kind)}
              </div>
              {item.url && (
                <Tooltip title="查看原公告">
                  <Button
                    type="link"
                    size="small"
                    icon={<LinkOutlined />}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    原公告
                  </Button>
                </Tooltip>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
};

// ──────────────────────────────────────────────
// cninfo 全量列表（>5 条时显示）
// ──────────────────────────────────────────────
const FullLists: React.FC<{
  allGood: ResearchTopEntry[];
  allBad: ResearchTopEntry[];
  cardBg?: string;
  borderColor?: string;
  goodLabel?: string;
  badLabel?: string;
  goodDrawerTitle?: string;
  badDrawerTitle?: string;
  kindForScore?: ResearchKind;
}> = ({
  allGood,
  allBad,
  goodLabel = '全部利好',
  badLabel = '全部利空',
  goodDrawerTitle = '全部利好公告',
  badDrawerTitle = '全部利空公告',
  kindForScore = 'cninfo',
}) => {
  const { theme } = useTheme();
  const colors = getResearchColors(theme);
  const [drawerType, setDrawerType] = useState<'good' | 'bad' | null>(null);
  const entries = drawerType === 'good' ? allGood : drawerType === 'bad' ? allBad : [];

  return (
    <>
      <Divider style={{ margin: '24px 0 16px' }}>查看全部</Divider>
      <Space wrap>
        {allGood.length > 5 && (
          <Button onClick={() => setDrawerType('good')}>
            <Badge count={allGood.length} offset={[8, -2]} color={RESEARCH_GOOD_TAG_COLOR}>
              <span style={{ paddingRight: 8 }}>{goodLabel} ({allGood.length})</span>
            </Badge>
          </Button>
        )}
        {allBad.length > 5 && (
          <Button onClick={() => setDrawerType('bad')}>
            <Badge count={allBad.length} offset={[8, -2]} color={RESEARCH_BAD_TAG_COLOR}>
              <span style={{ paddingRight: 8 }}>{badLabel} ({allBad.length})</span>
            </Badge>
          </Button>
        )}
      </Space>

      <Drawer
        title={drawerType === 'good' ? goodDrawerTitle : badDrawerTitle}
        open={drawerType !== null}
        onClose={() => setDrawerType(null)}
        width={720}
      >
        <List
          dataSource={entries}
          renderItem={(item) => (
            <List.Item style={{ padding: '12px 0' }}>
              <List.Item.Meta
                title={
                  <Space size={6} wrap>
                    <Tag color={drawerType === 'good' ? RESEARCH_GOOD_TAG_COLOR : RESEARCH_BAD_TAG_COLOR} style={{ fontWeight: 600 }}>
                      #{item.rank}
                    </Tag>
                    <Text strong style={{ color: colors.primaryText }}>{item.name}</Text>
                    <Text style={{ fontSize: 11, color: colors.secondaryText }}>{item.code}</Text>
                    <Text style={{ fontSize: 16, fontWeight: 700, color: scoreColor(item.score, kindForScore) }}>
                      {item.scoreLabel || formatScore(item.score, kindForScore)}
                    </Text>
                  </Space>
                }
                description={
                  <div style={{ marginTop: 4 }}>
                    <div style={{ fontSize: 12, marginBottom: 4, color: colors.secondaryText }}>{item.title}</div>
                    {item.summary && (
                      <Paragraph style={{ fontSize: 11, marginBottom: 0, color: colors.secondaryText }} ellipsis={{ rows: 2, expandable: true }}>
                        {item.summary}
                      </Paragraph>
                    )}
                  </div>
                }
              />
            </List.Item>
          )}
        />
      </Drawer>
    </>
  );
};

// ──────────────────────────────────────────────
// earnings 全量表格（带搜索/筛选）
// ──────────────────────────────────────────────
const EarningsFullTable: React.FC<{
  kind: 'earnings' | 'earnings-report';
  items: EarningsItem[];
}> = ({ kind, items }) => {
  const { theme } = useTheme();
  const colors = getResearchColors(theme);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (search) {
        const q = search.toLowerCase();
        if (!it.name.toLowerCase().includes(q) && !it.code.toLowerCase().includes(q)) {
          return false;
        }
      }
      if (typeFilter !== 'all' && it.forecastType !== typeFilter) return false;
      return true;
    });
  }, [items, search, typeFilter]);

  const typeOptions = useMemo(() => {
    const types = Array.from(new Set(items.map((i) => i.forecastType))).filter(Boolean);
    return [
      { label: `全部 (${items.length})`, value: 'all' },
      ...types.map((t) => ({
        label: `${t} (${items.filter((i) => i.forecastType === t).length})`,
        value: t,
      })),
    ];
  }, [items]);

  const columns: ColumnsType<EarningsItem> = [
    {
      title: '股票',
      key: 'stock',
      width: 130,
      fixed: 'left',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Text strong style={{ fontSize: 12, color: colors.primaryText }}>{r.name}</Text>
          <Text style={{ fontSize: 11, color: colors.secondaryText }}>{r.code}</Text>
        </Space>
      ),
    },
    {
      title: '所属子集',
      key: 'subset',
      width: 170,
      render: (_, r) => {
        const subsets = formatResearchScopeLabels(r);
        if (!subsets.length || subsets.every((subset) => subset === '其他')) {
          return <Text style={{ fontSize: 11, color: colors.secondaryText }}>其他</Text>;
        }

        return (
          <Tooltip title={subsets.join('；')}>
            <Space size={4} wrap>
              {subsets.map((subset) => (
                <Tag
                  key={subset}
                  color={r.focusHit ? 'blue' : 'default'}
                  style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}
                >
                  {subset}
                </Tag>
              ))}
            </Space>
          </Tooltip>
        );
      },
    },
    {
      title: kind === 'earnings-report' ? '报告类型' : '预告类型',
      dataIndex: 'forecastType',
      key: 'type',
      width: 80,
      filters: Array.from(new Set(items.map((i) => i.forecastType))).map((t) => ({ text: t, value: t })),
      onFilter: (val, r) => r.forecastType === val,
      render: (t: string) => <Tag color={forecastTypeColor(t)}>{t}</Tag>,
    },
    {
      title: kind === 'earnings-report' ? '报告期间' : '预告期间',
      dataIndex: 'forecastPeriod',
      key: 'period',
      width: 170,
      render: (p: string) => <Text style={{ fontSize: 11, color: colors.secondaryText }}>{p}</Text>,
    },
    {
      title: kind === 'earnings-report' ? '归母同比' : '同比区间',
      key: 'pct',
      width: 130,
      sorter: (a, b) => (a.highPct ?? 0) - (b.highPct ?? 0),
      render: (_, r) => {
        if (!isDisplayablePctRange(r.lowPct, r.highPct)) {
          return <Text style={{ color: colors.secondaryText }}>-</Text>;
        }
        const pctForColor = r.highPct ?? r.lowPct ?? 0;
        const color = pctForColor >= 0 ? RESEARCH_GOOD_COLOR : RESEARCH_BAD_COLOR;
        return (
          <Text style={{ fontSize: 12, fontWeight: 600, color }}>
            {formatPctRangeForDisplay(r.lowPct, r.highPct)}
          </Text>
        );
      },
    },
    {
      title: kind === 'earnings-report' ? '归母净利润 (万元)' : '净利润 (万元)',
      key: 'profit',
      width: 160,
      render: (_, r) => {
        const profitWanLabel = formatWanForDisplay(r.lowWan, r.highWan);
        if (!profitWanLabel) return <Text style={{ color: colors.secondaryText }}>-</Text>;
        return (
          <Text style={{ fontSize: 11, color: colors.secondaryText }}>
            {profitWanLabel}
          </Text>
        );
      },
    },
    {
      title: kind === 'earnings-report' ? '核心指标' : '原因摘要',
      dataIndex: 'reason',
      key: 'reason',
      ellipsis: true,
      render: (s: string) => <Text style={{ fontSize: 11, color: colors.secondaryText }}>{s}</Text>,
    },
    {
      title: '原公告',
      key: 'source',
      width: 90,
      fixed: 'right',
      render: (_, r) =>
        r.url ? (
          <Tooltip title={r.announcementTitle || '查看原公告'}>
            <Button
              type="link"
              size="small"
              icon={<LinkOutlined />}
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ padding: 0, fontSize: 11 }}
            >
              原公告
            </Button>
          </Tooltip>
        ) : (
          <Text style={{ fontSize: 11, color: colors.tertiaryText }}>-</Text>
        ),
    },
  ];

  return (
    <>
      <Divider style={{ margin: '24px 0 16px' }}>
        全部{kind === 'earnings-report' ? '业绩报告' : '业绩预告'}明细 ({items.length} 家)
      </Divider>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input
          prefix={<SearchOutlined />}
          placeholder="搜索股票名/代码"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 220 }}
          allowClear
        />
        <Segmented
          value={typeFilter}
          onChange={(v) => setTypeFilter(v as string)}
          options={typeOptions}
        />
        <Text style={{ fontSize: 12, color: colors.secondaryText }}>
          显示 {filtered.length} / {items.length}
        </Text>
      </Space>
      <Table
        dataSource={filtered}
        columns={columns}
        rowKey={(r) => `${r.code}-${r.forecastPeriod}`}
        size="small"
        pagination={{ pageSize: 10, showSizeChanger: false }}
        scroll={{ x: 1170 }}
      />
    </>
  );
};

// ──────────────────────────────────────────────
// 文件预览弹窗 (PDF 用 iframe, XLSX 提示下载)
// ──────────────────────────────────────────────
const FilePreviewModal: React.FC<{
  file: ResearchFile | null;
  onClose: () => void;
}> = ({ file, onClose }) => {
  const { theme } = useTheme();
  const colors = getResearchColors(theme);

  if (!file) return null;
  const isPdf = file.type === 'pdf';
  return (
    <Modal
      open={!!file}
      onCancel={onClose}
      width="90vw"
      style={{ top: 20 }}
      title={
        <Space>
          {isPdf ? <FilePdfOutlined style={{ color: '#ff4d4f' }} /> : <FileExcelOutlined style={{ color: '#52c41a' }} />}
          <span style={{ color: colors.primaryText }}>{file.filename}</span>
          <Text style={{ fontSize: 12, color: colors.secondaryText }}>({formatFileSize(file.size)})</Text>
        </Space>
      }
      footer={[
        <Button key="download" icon={<DownloadOutlined />} href={file.url} target="_blank" rel="noopener noreferrer">
          下载
        </Button>,
        <Button key="close" onClick={onClose}>关闭</Button>,
      ]}
      destroyOnClose
    >
      {isPdf ? (
        <iframe
          src={file.url}
          style={{ width: '100%', height: '75vh', border: 'none' }}
          title={file.filename}
        />
      ) : (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <FileExcelOutlined style={{ fontSize: 64, color: '#52c41a' }} />
          <Title level={4} style={{ marginTop: 16, color: colors.primaryText }}>Excel 文件</Title>
          <Paragraph style={{ color: colors.secondaryText }}>
            浏览器暂不支持直接预览 Excel，请下载后用 Excel/WPS 打开。
          </Paragraph>
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            href={file.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ marginTop: 12 }}
          >
            下载 {file.filename}
          </Button>
        </div>
      )}
    </Modal>
  );
};

export default ResearchPanel;
