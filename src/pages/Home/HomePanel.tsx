import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Card, Row, Col, Tag, Statistic, Space, Typography, Button, Grid, Tooltip } from 'antd';
import {
  PieChartOutlined,
  LineChartOutlined,
  RiseOutlined,
  ArrowRightOutlined,
  ClockCircleOutlined,
  FundProjectionScreenOutlined,
  ReloadOutlined,
  BellOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { useTheme } from '../../hooks/useTheme';
import { useNewsFeed } from '../../hooks/useNewsFeed';
import { useResearchLatest } from '../../hooks/useResearch';
import { useFundPortfolio } from '../../hooks/useFundPortfolio';
import { scoreColor, formatScore } from '../../types/research';
import { API_BASE } from '../../config/api';
import {
  compactSourceName,
  enrichNewsItems,
  formatNewsTime,
  getDisplayBody,
  getDisplayBodyLabel,
  getDisplayTitle,
  inferSignalBucket,
  selectTodayHotNewsItems,
  SIGNAL_TONE,
  type EnrichedNewsItem,
} from '../News/NewsPanel';

const { Text, Title } = Typography;
const { useBreakpoint } = Grid;

const CATEGORY_COLORS: Record<string, string> = {
  '宏观': 'blue',
  '大宗商品': 'orange',
  '加密货币': 'gold',
  '软件/AI大模型': 'purple',
  'AI涨价': 'red',
  '硬件': 'cyan',
  '消费': 'pink',
};

const UP_COLOR = '#ff4d4f';
const DOWN_COLOR = '#52c41a';
const WARNING_COLOR = '#faad14';
const SYSTEM_BLUE = '#67a4ff';
const LOGO_SRC = '/shifeng-logo.jpg';
const STANDARD_TMT_DEFINITION_ID = 'sw2021_l1_tmt_v1';

type MarketKey = 'a' | 'hk' | 'us' | 'jp' | 'kr';
type ResearchView = '公告研判' | '业绩预告' | '风险提示';
type AnnouncementFilter = '全部' | '利好' | '利空';
type EarningsFilter = '全部' | '预增' | '预减';

const MARKET_TABS: Array<{ key: MarketKey; label: string }> = [
  { key: 'a', label: 'A股' },
  { key: 'hk', label: '港股' },
  { key: 'us', label: '美股' },
  { key: 'jp', label: '日股' },
  { key: 'kr', label: '韩股' },
];

const RESEARCH_TABS: ResearchView[] = ['公告研判', '业绩预告', '风险提示'];

interface MACDRow {
  股票代码: string;
  股票名称: string;
  日K_DIF: number;
  日K_DEA: number;
  日K_MACD: number;
  信号等级?: '强信号' | '拐点观察' | '趋势延续' | '趋势跟踪' | '转弱风险' | '无信号';
  信号分?: number;
  是否候选?: boolean;
  观察理由?: string;
}

interface TMTDataResponse {
  date?: string;
  definition_id?: string;
  definition_name?: string;
  classification_asof?: string;
  membership_mode?: string;
  tmt_universe_count?: number;
  tmt_margin_count?: number;
  tmt_turnover_pct?: number | null;
  tmt_yy: number;
  market_yy: number;
  pct: number;
  tmt_buy: number;
  market_buy: number;
  tmt_buy_pct: number;
  incr_pct_3d: number | null;
  trend?: Array<{
    date: string;
    tmt_turnover_pct?: number | null;
    pct?: number;
  }>;
}

interface FundPosition {
  code: string;
  name: string;
  shares: number;
  avgCost: number;
  currentPrice?: number;
  prevClose?: number;
}

interface FundData {
  id: string;
  name: string;
  market: MarketKey;
  positions: FundPosition[];
}

interface MacdApiResponse {
  success: boolean;
  data: MACDRow[];
  generatedAt?: string;
  cached?: boolean;
  stale?: boolean;
  updating?: boolean;
}

interface TmtApiResponse {
  success: boolean;
  data?: TMTDataResponse;
  error?: string;
  stale?: boolean;
  needsMarginRefresh?: boolean;
  marginDataDate?: string | null;
  expectedMarginDataDate?: string | null;
  marginLagTradingDays?: number;
  marginFreshnessReason?: string | null;
}

interface TmtFreshnessMeta {
  stale: boolean;
  needsMarginRefresh: boolean;
  marginDataDate: string;
  expectedMarginDataDate: string;
  marginLagTradingDays: number;
  reason: string;
}

interface FundPerf {
  name: string;
  change: number;
  todayMV: number;
}

interface FundPerformance {
  topGainers: FundPerf[];
  topLosers: FundPerf[];
  gainCount: number;
  lossCount: number;
  flatCount: number;
  averageChange: number;
}

interface HomePalette {
  pageBg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  borderSoft: string;
  text: string;
  muted: string;
  subtle: string;
  chipBg: string;
  headerBg: string;
  segmentedActiveBg: string;
  segmentedActiveText: string;
}

interface FocusItem {
  label: string;
  title: string;
  meta: string;
  accent: string;
  path: string;
}

function getHomePalette(theme: 'light' | 'dark'): HomePalette {
  if (theme === 'dark') {
    return {
      pageBg: '#0f141b',
      surface: '#171e27',
      surfaceAlt: '#121922',
      border: '#2b3542',
      borderSoft: '#24303d',
      text: '#edf2f8',
      muted: '#a8b2c1',
      subtle: '#778498',
      chipBg: '#111822',
      headerBg: '#151c25',
      segmentedActiveBg: '#2b3b52',
      segmentedActiveText: '#edf2f8',
    };
  }

  return {
    pageBg: '#f5f7fa',
    surface: '#ffffff',
    surfaceAlt: '#f9fbff',
    border: '#e1e7f0',
    borderSoft: '#edf1f6',
    text: '#1f2937',
    muted: '#5d6878',
    subtle: '#8b96a7',
    chipBg: '#f7f9fc',
    headerBg: '#f8fafd',
    segmentedActiveBg: '#1677ff',
    segmentedActiveText: '#ffffff',
  };
}

function computeFundPerformance(funds: FundData[]): FundPerformance {
  const perf: FundPerf[] = [];
  for (const fund of funds) {
    if (!fund.positions || fund.positions.length === 0) continue;
    let todayMV = 0;
    let yesterdayMV = 0;
    let hasPrice = false;
    for (const position of fund.positions) {
      if (position.currentPrice && position.shares) {
        todayMV += position.shares * position.currentPrice;
        yesterdayMV += position.shares * (position.prevClose ?? position.currentPrice);
        hasPrice = true;
      }
    }
    if (!hasPrice || yesterdayMV === 0) continue;
    perf.push({
      name: fund.name,
      todayMV,
      change: ((todayMV - yesterdayMV) / yesterdayMV) * 100,
    });
  }

  const ordered = [...perf].sort((a, b) => b.change - a.change);
  const gainers = ordered.filter((item) => item.change > 0);
  const losers = ordered.filter((item) => item.change < 0).sort((a, b) => a.change - b.change);
  const flatCount = ordered.filter((item) => item.change === 0).length;
  const averageChange = ordered.length > 0
    ? ordered.reduce((sum, item) => sum + item.change, 0) / ordered.length
    : 0;

  return {
    topGainers: gainers.slice(0, 5),
    topLosers: losers.slice(0, 5),
    gainCount: gainers.length,
    lossCount: losers.length,
    flatCount,
    averageChange,
  };
}

function formatSigned(value: number, digits = 2): string {
  if (value > 0) return `+${value.toFixed(digits)}`;
  return value.toFixed(digits);
}

function formatDateTime(value?: string): string {
  if (!value) return '-';
  return dayjs(value).format('MM-DD HH:mm');
}

function formatCompactTime(value?: string): string {
  if (!value) return '--:--';
  const parsed = dayjs(value);
  if (parsed.isValid()) {
    if (value.includes('T') || /\d{2}:\d{2}/.test(value)) return parsed.format('HH:mm');
    return parsed.format('MM-DD');
  }
  return value.length > 5 ? value.slice(0, 5) : value;
}

function formatReportDate(value?: string): string {
  if (!value) return '-';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('MM-DD') : value;
}

function valueColor(value: number): string {
  if (value > 0) return UP_COLOR;
  if (value < 0) return DOWN_COLOR;
  return '#8c8c8c';
}

function displayCode(code?: string): string {
  if (!code) return '-';
  return code.replace(/\.(SH|SZ|BJ|HK|US)$/i, '');
}

function splitScopeValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => splitScopeValue(item));
  }
  if (typeof value !== 'string') return [];
  return value
    .split(/[;；,，、/|｜\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatResearchScopes(item: unknown, fallback = '其他'): string {
  const source = (item || {}) as Record<string, unknown>;
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
  const orderedValues = [...subsetFields, ...industryFields].flatMap((field) => splitScopeValue(source[field]));
  const uniqueValues = orderedValues.filter((value, index) => orderedValues.indexOf(value) === index);
  const realValues = uniqueValues.filter((value) => value !== '其他');
  return (realValues.length > 0 ? realValues : uniqueValues).slice(0, 3).join('；') || fallback;
}

function inferForecastType(item: { score: number; scoreLabel?: string; conclusion?: string; summary?: string }): string {
  const summaryType = item.summary?.match(/【([^】]+)】/)?.[1];
  if (summaryType) return summaryType;
  if (item.conclusion) return item.conclusion;
  if (item.score > 0) return '预增';
  if (item.score < 0) return '预减';
  return '预告';
}

function getBalancedRows<T>(positiveRows: T[], negativeRows: T[], positiveTarget = 3, negativeTarget = 2, limit = 5): T[] {
  if (negativeRows.length === 0) return positiveRows.slice(0, limit);
  const negativeTake = Math.min(negativeTarget, negativeRows.length, limit);
  const positiveTake = Math.min(positiveTarget + Math.max(0, negativeTarget - negativeTake), positiveRows.length, limit - negativeTake);
  const rows = [
    ...positiveRows.slice(0, positiveTake),
    ...negativeRows.slice(0, negativeTake),
  ];
  if (rows.length < limit) {
    rows.push(...positiveRows.slice(positiveTake, positiveTake + limit - rows.length));
  }
  if (rows.length < limit) {
    rows.push(...negativeRows.slice(negativeTake, negativeTake + limit - rows.length));
  }
  return rows.slice(0, limit);
}

const TerminalCard: React.FC<{
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  accent?: string;
  actionText?: string;
  onClick?: () => void;
  tabs?: string[];
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  palette: HomePalette;
  children: React.ReactNode;
  minHeight?: number;
}> = ({ title, subtitle, icon, accent = SYSTEM_BLUE, actionText, onClick, tabs, activeTab, onTabChange, palette, children, minHeight }) => (
  <Card
    hoverable={Boolean(onClick)}
    onClick={onClick}
    style={{
      height: '100%',
      minHeight,
      borderRadius: 8,
      border: `1px solid ${palette.border}`,
      background: palette.surface,
      overflow: 'hidden',
      cursor: onClick ? 'pointer' : 'default',
      boxShadow: 'none',
      display: 'flex',
      flexDirection: 'column',
    }}
    styles={{ body: { padding: 0, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } }}
  >
    <div
      style={{
        minHeight: 42,
        padding: '10px 14px',
        borderBottom: `1px solid ${palette.borderSoft}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <Space size={8} style={{ minWidth: 0 }}>
        {icon && <span style={{ color: accent, fontSize: 15 }}>{icon}</span>}
        <Text strong style={{ color: palette.text, fontSize: 15, whiteSpace: 'nowrap' }}>{title}</Text>
        {subtitle && <Text style={{ color: palette.subtle, fontSize: 12, whiteSpace: 'nowrap' }}>{subtitle}</Text>}
      </Space>
      <Space size={10} style={{ flexShrink: 0 }}>
        {tabs && (
          <Space size={0} style={{ border: `1px solid ${palette.borderSoft}`, borderRadius: 6, overflow: 'hidden' }}>
            {tabs.map((tab, index) => (
              <button
                key={tab}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onTabChange?.(tab);
                }}
                style={{
                  border: 'none',
                  padding: '3px 12px',
                  fontSize: 12,
                  color: (activeTab || tabs[0]) === tab ? palette.segmentedActiveText : palette.subtle,
                  background: (activeTab || tabs[0]) === tab ? palette.segmentedActiveBg : palette.chipBg,
                  borderRight: index === tabs.length - 1 ? 'none' : `1px solid ${palette.borderSoft}`,
                  cursor: onTabChange ? 'pointer' : 'default',
                  font: 'inherit',
                  lineHeight: 1.2,
                }}
              >
                {tab}
              </button>
            ))}
          </Space>
        )}
        {onClick && (
          <Space size={4} style={{ color: SYSTEM_BLUE, fontSize: 12 }}>
            <span>{actionText || '全部'}</span>
            <ArrowRightOutlined style={{ fontSize: 11 }} />
          </Space>
        )}
      </Space>
    </div>
    <div style={{ padding: '10px 14px 12px', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>{children}</div>
  </Card>
);

const InlineStats: React.FC<{
  items: Array<{ label: string; value: React.ReactNode; color?: string; active?: boolean; onClick?: () => void }>;
  palette: HomePalette;
}> = ({ items, palette }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: '6px 14px',
      minHeight: 24,
      marginBottom: 8,
      color: palette.subtle,
      fontSize: 12,
      lineHeight: '20px',
    }}
  >
    {items.map((item) => {
      const content = (
        <>
          <span>{item.label}</span>
          <Text
            strong
            style={{
              color: item.active ? palette.segmentedActiveText : (item.color || palette.text),
              lineHeight: '20px',
              fontSize: 12,
            }}
          >
            {item.value}
          </Text>
        </>
      );
      if (item.onClick) {
        return (
          <button
            key={item.label}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              item.onClick?.();
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              minHeight: 22,
              padding: '0 7px',
              borderRadius: 6,
              border: `1px solid ${item.active ? palette.segmentedActiveBg : palette.borderSoft}`,
              background: item.active ? palette.segmentedActiveBg : palette.chipBg,
              color: item.active ? palette.segmentedActiveText : palette.subtle,
              cursor: 'pointer',
              font: 'inherit',
              lineHeight: '20px',
            }}
          >
            {content}
          </button>
        );
      }
      return (
        <span key={item.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {content}
        </span>
      );
    })}
  </div>
);

const TableHeader: React.FC<{ columns: string[]; template: string; palette: HomePalette }> = ({ columns, template, palette }) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: template,
      gap: 10,
      color: palette.subtle,
      fontSize: 12,
      padding: '3px 0 6px',
      borderBottom: `1px solid ${palette.borderSoft}`,
    }}
  >
    {columns.map((column) => <span key={column}>{column}</span>)}
  </div>
);

const TableRow: React.FC<{
  cells: React.ReactNode[];
  template: string;
  palette: HomePalette;
  last?: boolean;
  wrapColumns?: number[];
}> = ({ cells, template, palette, last, wrapColumns = [] }) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: template,
      gap: 10,
      alignItems: 'center',
      minHeight: 26,
      borderBottom: last ? 'none' : `1px solid ${palette.borderSoft}`,
      color: palette.text,
      fontSize: 12,
    }}
  >
    {cells.map((cell, index) => (
      <div
        key={index}
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: wrapColumns.includes(index) ? 'normal' : 'nowrap',
          lineHeight: wrapColumns.includes(index) ? 1.45 : undefined,
        }}
      >
        {cell}
      </div>
    ))}
  </div>
);

const HomeHotNewsRow: React.FC<{
  idx: number;
  item: EnrichedNewsItem;
  palette: HomePalette;
  theme: 'light' | 'dark';
  last?: boolean;
}> = ({ idx, item, palette, theme, last }) => {
  const signalBucket = inferSignalBucket(item);
  const tone = SIGNAL_TONE[signalBucket];
  const displayTitle = getDisplayTitle(item);
  const bodyLabel = getDisplayBodyLabel(item);
  const bodyText = getDisplayBody(item);
  const sourceName = compactSourceName(item.source);

  return (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.stopPropagation();
        if (!item.url || item.url.startsWith('local://')) event.preventDefault();
      }}
      style={{ color: 'inherit', textDecoration: 'none' }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '30px minmax(0, 1fr) 118px',
          gap: 10,
          alignItems: 'start',
          minHeight: 62,
          padding: '8px 0',
          borderBottom: last ? 'none' : `1px solid ${palette.borderSoft}`,
        }}
      >
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: 5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            background: 'linear-gradient(180deg, #f59e0b, #c96a00)',
            fontWeight: 800,
            lineHeight: 1,
            fontSize: 12,
          }}
        >
          {idx + 1}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <Text
              style={{
                display: 'block',
                color: item.url ? palette.text : palette.muted,
                fontWeight: 800,
                fontSize: 13,
                lineHeight: 1.35,
                minWidth: 0,
              }}
              ellipsis={{ tooltip: displayTitle }}
            >
              {displayTitle}
            </Text>
            <Tag
              color={tone.color}
              style={{
                margin: 0,
                background: tone.bg,
                borderColor: tone.bg,
                fontSize: 11,
                lineHeight: '18px',
                flexShrink: 0,
              }}
            >
              {signalBucket}
            </Tag>
          </div>
          <Tooltip
            overlayStyle={{ maxWidth: 760 }}
            title={(
              <div
                style={{
                  maxWidth: 720,
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.6,
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 5,
                  overflow: 'hidden',
                }}
              >
                {bodyText}
              </div>
            )}
          >
            <div
              style={{
                marginTop: 4,
                color: theme === 'dark' ? '#9ca3af' : '#4b5563',
                fontSize: 12,
                lineHeight: 1.42,
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 2,
                overflow: 'hidden',
                cursor: 'help',
              }}
            >
              <span style={{ color: palette.subtle }}>{bodyLabel}</span>
              <span>{bodyText}</span>
            </div>
          </Tooltip>
        </div>
        <div style={{ minWidth: 0, textAlign: 'right', paddingTop: 1 }}>
          <Space size={5}>
            <Text type="secondary" style={{ fontSize: 12 }}>热度</Text>
            <Text style={{ color: palette.text, fontSize: 12, fontWeight: 700 }}>{item.score}</Text>
          </Space>
          <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 5 }} ellipsis={{ tooltip: sourceName }}>
            来源: {sourceName}
          </Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 3 }}>
            {formatNewsTime(item.time)}
          </Text>
        </div>
      </div>
    </a>
  );
};

const MiniSparkline: React.FC<{ color: string; variant?: number }> = ({ color, variant = 0 }) => {
  const paths = [
    'M2 19 L12 16 L22 18 L32 12 L42 15 L52 8 L62 10 L72 4',
    'M2 10 L12 13 L22 9 L32 15 L42 12 L52 18 L62 16 L72 20',
    'M2 16 L12 14 L22 15 L32 10 L42 12 L52 7 L62 8 L72 5',
  ];
  return (
    <svg width="78" height="24" viewBox="0 0 78 24" aria-hidden="true" style={{ display: 'block' }}>
      <path d={paths[variant % paths.length]} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

const FocusTicker: React.FC<{
  items: FocusItem[];
  palette: HomePalette;
  onNavigate: (path: string) => void;
  compact?: boolean;
}> = ({ items, palette, onNavigate, compact = false }) => (
  <div
    style={{
      border: `1px solid ${palette.border}`,
      background: palette.surface,
      borderRadius: 8,
      padding: compact ? '8px 14px' : '9px 14px 11px',
      marginBottom: 10,
    }}
  >
    <div
      style={{
        display: compact ? 'grid' : 'block',
        gridTemplateColumns: compact ? 'auto minmax(0, 1fr) auto' : undefined,
        alignItems: compact ? 'center' : undefined,
        gap: compact ? 10 : undefined,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: compact ? 0 : 8 }}>
        <Space size={8}>
          <BellOutlined style={{ color: WARNING_COLOR, fontSize: 14 }} />
          <Text strong style={{ color: palette.text, fontSize: 14 }}>今日重点</Text>
          <Text style={{ color: UP_COLOR, fontSize: 12 }}>{items.length} 条未读</Text>
        </Space>
        {!compact && (
          <Space size={4} style={{ color: SYSTEM_BLUE, fontSize: 12 }}>
            <span>全部</span>
            <ArrowRightOutlined style={{ fontSize: 11 }} />
          </Space>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 8, minWidth: 0 }}>
      {items.map((item) => (
        <button
          key={`${item.label}-${item.path}`}
          type="button"
          onClick={() => onNavigate(item.path)}
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr) auto',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
            height: compact ? 32 : 36,
            padding: '0 10px',
            borderRadius: 6,
            border: `1px solid ${palette.borderSoft}`,
            background: palette.chipBg,
            color: palette.text,
            cursor: 'pointer',
            font: 'inherit',
            textAlign: 'left',
          }}
        >
          <Tag color={item.accent} style={{ margin: 0, lineHeight: '18px', fontSize: 11 }}>{item.label}</Tag>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{item.title}</span>
          <span style={{ color: palette.subtle, fontSize: 11 }}>{item.meta}</span>
        </button>
      ))}
      </div>
      {compact && (
        <Space size={4} style={{ color: SYSTEM_BLUE, fontSize: 12, justifySelf: 'end' }}>
          <span>全部</span>
          <ArrowRightOutlined style={{ fontSize: 11 }} />
        </Space>
      )}
    </div>
  </div>
);

const EmptyLine: React.FC<{ palette: HomePalette; text: string }> = ({ palette, text }) => (
  <div style={{ color: palette.subtle, fontSize: 12, padding: '10px 0' }}>{text}</div>
);

const LoadingRows: React.FC<{
  columns: string[];
  template: string;
  palette: HomePalette;
  rows?: number;
  label?: string;
}> = ({ columns, template, palette, rows = 5, label = '同步中' }) => {
  const widths = ['44px', '74%', '56%', '38%', '48%'];

  return (
    <>
      <TableHeader columns={columns} template={template} palette={palette} />
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <TableRow
          key={`loading-${rowIndex}`}
          template={template}
          palette={palette}
          last={rowIndex === rows - 1}
          cells={columns.map((column, columnIndex) => (
            <span
              key={`${column}-${columnIndex}`}
              style={{
                display: 'inline-block',
                width: rowIndex === 0 && columnIndex === 1 ? 72 : widths[columnIndex % widths.length],
                maxWidth: '100%',
                height: columnIndex === 1 && rowIndex === 0 ? 'auto' : 8,
                borderRadius: 99,
                background: columnIndex === 1 && rowIndex === 0 ? 'transparent' : palette.borderSoft,
                color: palette.subtle,
                lineHeight: 1.2,
              }}
            >
              {columnIndex === 1 && rowIndex === 0 ? label : ''}
            </span>
          ))}
        />
      ))}
    </>
  );
};

const HomePanel: React.FC = () => {
  const { theme } = useTheme();
  const screens = useBreakpoint();
  const navigate = useNavigate();
  const palette = useMemo(() => getHomePalette(theme), [theme]);
  const { news, loading: newsLoading, lastUpdated, apiStatus, isMockData } = useNewsFeed();
  const [macdData, setMacdData] = useState<MACDRow[]>([]);
  const [macdLoading, setMacdLoading] = useState(false);
  const [macdGeneratedAt, setMacdGeneratedAt] = useState<string>('');
  const [macdCached, setMacdCached] = useState<boolean | null>(null);
  const [macdUpdating, setMacdUpdating] = useState(false);
  const macdRefreshTimerRef = useRef<number | null>(null);
  const [tmtData, setTmtData] = useState<TMTDataResponse | null>(null);
  const [tmtLoading, setTmtLoading] = useState(false);
  const [tmtFreshness, setTmtFreshness] = useState<TmtFreshnessMeta>({
    stale: false,
    needsMarginRefresh: false,
    marginDataDate: '',
    expectedMarginDataDate: '',
    marginLagTradingDays: 0,
    reason: '',
  });
  const { data: cninfoLatest } = useResearchLatest('cninfo');
  const { data: earningsLatest } = useResearchLatest('earnings');
  const { data: riskLatest } = useResearchLatest('risk');
  const { funds, syncStatus } = useFundPortfolio();
  const [selectedFundMarket, setSelectedFundMarket] = useState<MarketKey>('a');
  const [selectedResearchView, setSelectedResearchView] = useState<ResearchView>('公告研判');
  const [announcementFilter, setAnnouncementFilter] = useState<AnnouncementFilter>('全部');
  const [earningsFilter, setEarningsFilter] = useState<EarningsFilter>('全部');

  const marketFunds = useMemo(
    () => funds.filter((fund) => fund.market === selectedFundMarket),
    [funds, selectedFundMarket]
  );
  const fundPerformance = useMemo(() => computeFundPerformance(marketFunds), [marketFunds]);
  const { topGainers, topLosers, gainCount, lossCount, flatCount, averageChange } = fundPerformance;
  const positionCount = useMemo(
    () => marketFunds.reduce((sum, fund) => sum + (fund.positions?.length || 0), 0),
    [marketFunds]
  );
  const selectedMarketLabel = MARKET_TABS.find((item) => item.key === selectedFundMarket)?.label || 'A股';

  const fetchMacdData = useCallback(async (forceRefresh = false) => {
    setMacdLoading(true);
    try {
      const query = forceRefresh ? '/api/macd?refresh=1&async=1' : '/api/macd';
      const macdRes = await fetch(query).then(r => r.json() as Promise<MacdApiResponse>);
      if (macdRes.success) {
        setMacdData(macdRes.data || []);
        setMacdGeneratedAt(macdRes.generatedAt || '');
        setMacdCached(macdRes.cached ?? null);
        setMacdUpdating(Boolean(macdRes.updating));

        if (macdRes.updating) {
          if (macdRefreshTimerRef.current) {
            window.clearTimeout(macdRefreshTimerRef.current);
          }
          macdRefreshTimerRef.current = window.setTimeout(() => {
            void fetchMacdData(false);
          }, 8000);
        } else if (macdRefreshTimerRef.current) {
          window.clearTimeout(macdRefreshTimerRef.current);
          macdRefreshTimerRef.current = null;
        }
      }
    } finally {
      setMacdLoading(false);
    }
  }, []);

  useEffect(() => () => {
    if (macdRefreshTimerRef.current) {
      window.clearTimeout(macdRefreshTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const fetchTmtData = async () => {
      setTmtLoading(true);
      try {
        const tmtRes = await fetch(`${API_BASE}/api/tmt-margin`).then(r => r.json() as Promise<TmtApiResponse>);
        const payload = tmtRes.data;
        setTmtFreshness({
          stale: Boolean(tmtRes.stale),
          needsMarginRefresh: Boolean(tmtRes.needsMarginRefresh),
          marginDataDate: tmtRes.marginDataDate || '',
          expectedMarginDataDate: tmtRes.expectedMarginDataDate || '',
          marginLagTradingDays: tmtRes.marginLagTradingDays || 0,
          reason: tmtRes.marginFreshnessReason || tmtRes.error || '',
        });
        if (tmtRes.success && payload?.definition_id === STANDARD_TMT_DEFINITION_ID && typeof payload.pct === 'number') {
          setTmtData(payload);
        } else {
          setTmtData(null);
        }
      } catch {
        // silent
      } finally {
        setTmtLoading(false);
      }
    };

    void fetchMacdData();
    void fetchTmtData();
  }, [fetchMacdData]);

  const latestNews = useMemo(
    () => selectTodayHotNewsItems(enrichNewsItems(news)),
    [news]
  );
  const macdCandidate = macdData.filter((row) => row.是否候选).length;
  const macdStrong = macdData.filter((row) => row.信号等级 === '强信号').length;
  const macdRisk = macdData.filter((row) => row.信号等级 === '转弱风险').length;
  const macdTopRows = useMemo(
    () => [...macdData].sort((a, b) => (b.信号分 || 0) - (a.信号分 || 0)).slice(0, 5),
    [macdData]
  );
  const tmtTurnoverSnapshot = useMemo(() => {
    const ordered = (tmtData?.trend || [])
      .filter((row): row is { date: string; tmt_turnover_pct: number; pct?: number } => typeof row.tmt_turnover_pct === 'number')
      .sort((a, b) => a.date.localeCompare(b.date));
    const latestFromTrend = ordered.length > 0 ? ordered[ordered.length - 1].tmt_turnover_pct : null;
    const latest = typeof tmtData?.tmt_turnover_pct === 'number' ? tmtData.tmt_turnover_pct : latestFromTrend;
    const previous = ordered.length > 1 ? ordered[ordered.length - 2].tmt_turnover_pct : null;
    return {
      latest,
      change: latest !== null && previous !== null ? latest - previous : null,
    };
  }, [tmtData]);
  const tmtMarginIsStale = tmtFreshness.needsMarginRefresh;
  // API 的 `stale` 还可能只表示独立的全A现货快照待刷新；
  // 标准TMT卡片只按两融自身的新鲜度着色，避免混淆两个口径。
  const tmtDataIsStale = tmtMarginIsStale;
  const tmtMarginDisplayDate = tmtFreshness.marginDataDate || tmtData?.date || '';
  const isMobile = !screens.md;

  const reconciliationText = syncStatus.backendReachable
    ? (syncStatus.localCount === syncStatus.backendCount
      ? `后端同步 ${syncStatus.backendCount} 只`
      : `后端 ${syncStatus.backendCount} / 本地 ${syncStatus.localCount}`)
    : (syncStatus.localCount > 0 ? `本地 ${syncStatus.localCount} 只，后端未连接` : '后端未连接');

  const focusItems = useMemo<FocusItem[]>(() => {
    const items: FocusItem[] = [];
    if (cninfoLatest) {
      const top = cninfoLatest.topGood[0] || cninfoLatest.topBad[0];
      items.push({
        label: '公告',
        title: top ? `${top.name}: ${top.title}` : `${cninfoLatest.watchlistHits} 条自选命中`,
        meta: formatCompactTime(top?.time || cninfoLatest.date),
        accent: 'red',
        path: '/research',
      });
    }
    if (earningsLatest) {
      const top = earningsLatest.topGood[0] || earningsLatest.topBad[0];
      items.push({
        label: '业绩',
        title: top ? `${top.name}: ${formatScore(top.score, 'earnings')}` : `${earningsLatest.totalCount} 家预告`,
        meta: earningsLatest.date,
        accent: 'green',
        path: '/research',
      });
    }
    if (latestNews[0]) {
      items.push({
        label: '新闻',
        title: latestNews[0].title,
        meta: latestNews[0].time || latestNews[0].source || '',
        accent: CATEGORY_COLORS[latestNews[0].category] || 'blue',
        path: '/news',
      });
    }
    if (tmtData) {
      items.push({
        label: '策略',
        title: `标准TMT成交占比 ${tmtTurnoverSnapshot.latest?.toFixed(1) ?? '-'}%，融资余额占比 ${tmtData.pct.toFixed(1)}%`,
        meta: tmtDataIsStale
          ? `${tmtMarginIsStale ? '两融数据滞后' : '数据待刷新'} · ${formatReportDate(tmtMarginDisplayDate)}`
          : (tmtData.classification_asof ? `分类截至 ${formatReportDate(tmtData.classification_asof)}` : '申万2021一级'),
        accent: 'blue',
        path: '/tmt-margin',
      });
    }
    return items.length > 0 ? items.slice(0, 4) : [{
      label: '状态',
      title: '等待今日数据同步',
      meta: dayjs().format('HH:mm'),
      accent: 'default',
      path: '/home',
    }];
  }, [cninfoLatest, earningsLatest, latestNews, tmtData, tmtDataIsStale, tmtMarginDisplayDate, tmtMarginIsStale, tmtTurnoverSnapshot.latest]);

  const announcementGoodRows = useMemo(
    () => cninfoLatest ? (cninfoLatest.allGood?.length ? cninfoLatest.allGood : cninfoLatest.topGood) : [],
    [cninfoLatest]
  );
  const announcementBadRows = useMemo(
    () => cninfoLatest ? (cninfoLatest.allBad?.length ? cninfoLatest.allBad : cninfoLatest.topBad) : [],
    [cninfoLatest]
  );
  const announcementRows = useMemo(() => {
    if (!cninfoLatest) return [];
    if (announcementFilter === '利好') return announcementGoodRows.slice(0, 5);
    if (announcementFilter === '利空') return announcementBadRows.slice(0, 5);
    return getBalancedRows(announcementGoodRows, announcementBadRows, 3, 2, 5);
  }, [announcementBadRows, announcementFilter, announcementGoodRows, cninfoLatest]);
  const earningsGoodRows = useMemo(
    () => earningsLatest ? (earningsLatest.allGood?.length ? earningsLatest.allGood : earningsLatest.topGood) : [],
    [earningsLatest]
  );
  const earningsBadRows = useMemo(
    () => earningsLatest ? (earningsLatest.allBad?.length ? earningsLatest.allBad : earningsLatest.topBad) : [],
    [earningsLatest]
  );
  const earningsRows = useMemo(() => {
    if (!earningsLatest) return [];
    if (earningsFilter === '预增') return earningsGoodRows.slice(0, 5);
    if (earningsFilter === '预减') return earningsBadRows.slice(0, 5);
    return getBalancedRows(earningsGoodRows, earningsBadRows, 3, 2, 5);
  }, [earningsBadRows, earningsFilter, earningsGoodRows, earningsLatest]);
  const earningsSubsetByCode = useMemo(() => {
    const subsets = new Map<string, string>();
    earningsLatest?.allItems?.forEach((item) => {
      const subset = formatResearchScopes(item, '');
      if (subset) subsets.set(item.code, subset);
    });
    return subsets;
  }, [earningsLatest]);
  const riskRows = useMemo(() => {
    if (riskLatest) {
      const directRows = (riskLatest.topBad.length > 0 ? riskLatest.topBad : (riskLatest.allBad || [])).slice(0, 5);
      return directRows.map((item) => ({
        date: formatReportDate(riskLatest.date),
        source: '风险',
        name: item.name,
        code: item.code,
        title: item.title,
        subset: formatResearchScopes(item, '其他'),
        score: item.score,
        kind: 'risk' as const,
      }));
    }

    const fallbackRows: Array<{
      date: string;
      source: string;
      name: string;
      code: string;
      title: string;
      subset: string;
      score: number;
      kind: 'risk' | 'cninfo' | 'earnings';
    }> = [
      ...(cninfoLatest?.topBad || []).slice(0, 3).map((item) => ({
        date: formatReportDate(cninfoLatest?.date),
        source: '公告',
        name: item.name,
        code: item.code,
        title: item.title,
        subset: formatResearchScopes(item, '其他'),
        score: item.score,
        kind: 'cninfo' as const,
      })),
      ...(earningsLatest?.topBad || []).slice(0, 2).map((item) => ({
        date: formatReportDate(earningsLatest?.date),
        source: '业绩',
        name: item.name,
        code: item.code,
        title: item.title,
        subset: formatResearchScopes(item, '其他'),
        score: item.score,
        kind: 'earnings' as const,
      })),
    ];

    return fallbackRows.slice(0, 5);
  }, [riskLatest, cninfoLatest, earningsLatest]);

  const announcementGoodCount = cninfoLatest?.stats.goodCount ?? announcementGoodRows.length;
  const announcementBadCount = cninfoLatest?.stats.badCount ?? announcementBadRows.length;
  const earningsGoodCount = earningsLatest?.typeDistribution?.['预增'] ?? earningsLatest?.stats.goodCount ?? earningsGoodRows.length;
  const earningsBadCount = earningsLatest?.typeDistribution?.['预减'] ?? earningsLatest?.stats.badCount ?? earningsBadRows.length;

  const pageStyle: React.CSSProperties = {
    minHeight: '100%',
    margin: isMobile ? -12 : -24,
    padding: isMobile ? 12 : 16,
    background: palette.pageBg,
  };

  const statusChipStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 26,
    padding: '0 10px',
    borderRadius: 6,
    background: palette.chipBg,
    border: `1px solid ${palette.borderSoft}`,
    color: palette.muted,
    fontSize: 12,
  };

  return (
    <div style={pageStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
          <img
            src={LOGO_SRC}
            alt="石锋资产"
            style={{
              width: 34,
              height: 34,
              display: 'block',
              objectFit: 'contain',
              borderRadius: 8,
              background: '#fff',
              padding: 3,
              border: `1px solid ${palette.borderSoft}`,
              flexShrink: 0,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
            <Title level={3} style={{ margin: 0, color: palette.text, fontSize: 22, lineHeight: 1.1 }}>
              石锋资产 · 投研首页
            </Title>
            <Text style={{ color: palette.muted, fontSize: 12 }}>
              {dayjs().format('YYYY-MM-DD dddd')} · {reconciliationText}
            </Text>
          </div>
        </div>
        <Space size={8} wrap>
          <span style={{ ...statusChipStyle, color: UP_COLOR }}>
            <CheckCircleOutlined /> A股交易日
          </span>
          <span style={statusChipStyle}>
            <ClockCircleOutlined /> 数据 {formatDateTime(lastUpdated || cninfoLatest?.generatedAt)}
          </span>
          <span style={{ ...statusChipStyle, color: apiStatus === 'online' ? DOWN_COLOR : WARNING_COLOR }}>
            <span style={{ width: 6, height: 6, borderRadius: 99, background: apiStatus === 'online' ? DOWN_COLOR : WARNING_COLOR }} />
            {isMockData ? '离线新闻' : apiStatus === 'online' ? '服务在线' : '服务检查中'}
          </span>
        </Space>
      </div>

      <FocusTicker items={focusItems} palette={palette} onNavigate={navigate} compact={!isMobile} />

      <Row gutter={[10, 10]}>
        <Col xs={24} xl={12}>
          <TerminalCard
            title="子集表现"
            subtitle="（我的子集）"
            icon={<PieChartOutlined />}
            accent={UP_COLOR}
            palette={palette}
            actionText="进入子集"
            onClick={() => navigate('/portfolio')}
            tabs={MARKET_TABS.map((item) => item.label)}
            activeTab={selectedMarketLabel}
            onTabChange={(tab) => {
              const market = MARKET_TABS.find((item) => item.label === tab);
              if (market) setSelectedFundMarket(market.key);
            }}
            minHeight={258}
          >
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>
              <div>
                <Text style={{ color: UP_COLOR, fontSize: 13, fontWeight: 700 }}>涨幅 TOP5</Text>
                <TableHeader columns={['名称', '市值', '涨跌幅']} template="minmax(0,1fr) 72px 68px" palette={palette} />
                {topGainers.length > 0 ? topGainers.map((fund, index) => (
                  <TableRow
                    key={fund.name}
                    template="minmax(0,1fr) 72px 68px"
                    palette={palette}
                    last={index === topGainers.length - 1}
                    cells={[
                      fund.name,
                      `${(fund.todayMV / 10000).toFixed(0)}万`,
                      <span style={{ color: UP_COLOR }}>{formatSigned(fund.change)}%</span>,
                    ]}
                  />
                )) : <EmptyLine palette={palette} text={`暂无${selectedMarketLabel}上涨子集`} />}
              </div>
              <div>
                <Text style={{ color: DOWN_COLOR, fontSize: 13, fontWeight: 700 }}>跌幅 TOP5</Text>
                <TableHeader columns={['名称', '市值', '涨跌幅']} template="minmax(0,1fr) 72px 68px" palette={palette} />
                {topLosers.length > 0 ? topLosers.map((fund, index) => (
                  <TableRow
                    key={fund.name}
                    template="minmax(0,1fr) 72px 68px"
                    palette={palette}
                    last={index === topLosers.length - 1}
                    cells={[
                      fund.name,
                      `${(fund.todayMV / 10000).toFixed(0)}万`,
                      <span style={{ color: DOWN_COLOR }}>{fund.change.toFixed(2)}%</span>,
                    ]}
                  />
                )) : <EmptyLine palette={palette} text={`暂无${selectedMarketLabel}下跌子集`} />}
              </div>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '6px 14px',
                minHeight: 28,
                paddingTop: 8,
                marginTop: 'auto',
                borderTop: `1px solid ${palette.borderSoft}`,
                color: palette.subtle,
                fontSize: 12,
                lineHeight: '20px',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center' }}>子集均涨跌幅：<Text style={{ color: valueColor(averageChange), lineHeight: '20px' }}>{formatSigned(averageChange)}%</Text></span>
              <span style={{ display: 'inline-flex', alignItems: 'center' }}>子集数：{marketFunds.length}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center' }}>持仓：{positionCount}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center' }}>上涨：<Text style={{ color: UP_COLOR, lineHeight: '20px' }}>{gainCount}</Text></span>
              <span style={{ display: 'inline-flex', alignItems: 'center' }}>下跌：<Text style={{ color: DOWN_COLOR, lineHeight: '20px' }}>{lossCount}</Text></span>
              <span style={{ display: 'inline-flex', alignItems: 'center' }}>持平：{flatCount}</span>
            </div>
          </TerminalCard>
        </Col>

        <Col xs={24} xl={12}>
          <TerminalCard
            title="公告监控"
            subtitle="（研判中心）"
            icon={<FundProjectionScreenOutlined />}
            accent={SYSTEM_BLUE}
            palette={palette}
            actionText="研判中心"
            onClick={() => navigate('/research')}
            tabs={RESEARCH_TABS}
            activeTab={selectedResearchView}
            onTabChange={(tab) => setSelectedResearchView(tab as ResearchView)}
            minHeight={258}
          >
            {selectedResearchView === '公告研判' && (cninfoLatest ? (
              <>
                <InlineStats
                  palette={palette}
                  items={[
                    { label: '公告', value: `${cninfoLatest.totalCount} 条`, active: announcementFilter === '全部', onClick: () => setAnnouncementFilter('全部') },
                    { label: '利好', value: `${announcementGoodCount} 家`, color: UP_COLOR, active: announcementFilter === '利好', onClick: () => setAnnouncementFilter('利好') },
                    { label: '利空', value: `${announcementBadCount} 家`, color: DOWN_COLOR, active: announcementFilter === '利空', onClick: () => setAnnouncementFilter('利空') },
                    { label: '中性', value: `${cninfoLatest.stats.neutralFiltered ?? 0} 家` },
                  ]}
                />
                <TableHeader columns={['日期', '类型', '公司', '标题', '所属子集']} template="58px 66px 86px minmax(0,0.9fr) minmax(128px,1fr)" palette={palette} />
                {announcementRows.map((item, index) => (
                  <TableRow
                    key={`${item.code}-${index}`}
                    template="58px 66px 86px minmax(0,0.9fr) minmax(128px,1fr)"
                    palette={palette}
                    last={index === announcementRows.length - 1}
                    wrapColumns={[4]}
                    cells={[
                      formatReportDate(cninfoLatest.date),
                      <Tag color={item.score >= 0 ? 'red' : 'green'} style={{ margin: 0, fontSize: 11, lineHeight: '18px' }}>
                        {item.score >= 0 ? `利好 +${item.score}` : `利空 ${item.score}`}
                      </Tag>,
                      <span title={item.name}>{item.name}</span>,
                      <span title={item.title}>{item.title}</span>,
                      <span title={formatResearchScopes(item, '其他')}>{formatResearchScopes(item, '其他')}</span>,
                    ]}
                  />
                ))}
              </>
            ) : <EmptyLine palette={palette} text="暂无公告研判数据" />)}

            {selectedResearchView === '业绩预告' && (earningsLatest ? (
              <>
                <InlineStats
                  palette={palette}
                  items={[
                    { label: '预告', value: `${earningsLatest.totalCount} 家`, active: earningsFilter === '全部', onClick: () => setEarningsFilter('全部') },
                    { label: '预增', value: `${earningsGoodCount} 家`, color: UP_COLOR, active: earningsFilter === '预增', onClick: () => setEarningsFilter('预增') },
                    { label: '预减', value: `${earningsBadCount} 家`, color: DOWN_COLOR, active: earningsFilter === '预减', onClick: () => setEarningsFilter('预减') },
                    { label: '关注命中', value: `${earningsLatest.watchlistHits ?? 0} 家`, color: WARNING_COLOR },
                  ]}
                />
                <TableHeader columns={['日期', '类型', '公司', '同比变动', '所属子集']} template="58px 48px 104px minmax(0,1fr) minmax(90px,0.7fr)" palette={palette} />
                {earningsRows.map((item, index) => (
                  <TableRow
                    key={`${item.code}-${index}`}
                    template="58px 48px 104px minmax(0,1fr) minmax(90px,0.7fr)"
                    palette={palette}
                    last={index === earningsRows.length - 1}
                    wrapColumns={[4]}
                    cells={[
                      formatReportDate(earningsLatest.date),
                      <Tag color={item.score >= 0 ? 'red' : 'green'} style={{ margin: 0, fontSize: 11, lineHeight: '18px' }}>
                        {inferForecastType(item)}
                      </Tag>,
                      <span title={item.name}>{item.name}</span>,
                      <span style={{ color: scoreColor(item.score, 'earnings') }}>{item.scoreLabel || formatScore(item.score, 'earnings')}</span>,
                      <span title={formatResearchScopes(item, earningsSubsetByCode.get(item.code) || '其他')}>{formatResearchScopes(item, earningsSubsetByCode.get(item.code) || '其他')}</span>,
                    ]}
                  />
                ))}
              </>
            ) : <EmptyLine palette={palette} text="暂无业绩预告数据" />)}

            {selectedResearchView === '风险提示' && (
              <>
                <InlineStats
                  palette={palette}
                  items={[
                    { label: '风险', value: `${riskLatest?.totalCount ?? riskRows.length} 条` },
                    { label: '高风险', value: `${riskLatest?.stats.majorRiskCount ?? riskRows.length} 条`, color: DOWN_COLOR },
                    { label: '风险公司', value: `${riskLatest?.stats.riskCompanyCount ?? riskRows.length} 家` },
                    { label: '自选命中', value: `${riskLatest?.watchlistHits ?? 0} 家`, color: WARNING_COLOR },
                  ]}
                />
                <TableHeader columns={['日期', '类型', '公司', '提示', '所属子集']} template="58px 68px 98px minmax(0,0.9fr) minmax(108px,0.8fr)" palette={palette} />
                {riskRows.length > 0 ? riskRows.map((item, index) => (
                  <TableRow
                    key={`${item.kind}-${item.code}-${index}`}
                    template="58px 68px 98px minmax(0,0.9fr) minmax(108px,0.8fr)"
                    palette={palette}
                    last={index === riskRows.length - 1}
                    wrapColumns={[4]}
                    cells={[
                      item.date,
                      <Tag color={item.kind === 'risk' ? 'orange' : item.kind === 'cninfo' ? 'blue' : 'green'} style={{ margin: 0, fontSize: 11, lineHeight: '18px' }}>
                        {item.source} {item.score}
                      </Tag>,
                      <span title={item.name}>{item.name}</span>,
                      <span title={item.title}>{item.title}</span>,
                      <span title={item.subset}>{item.subset}</span>,
                    ]}
                  />
                )) : <EmptyLine palette={palette} text="暂无风险提示" />}
              </>
            )}
          </TerminalCard>
        </Col>

        <Col xs={24} xl={12}>
          <TerminalCard
            title="新闻资讯"
            icon={<BellOutlined />}
            accent={SYSTEM_BLUE}
            palette={palette}
            actionText="全部新闻"
            onClick={() => navigate('/news')}
            minHeight={230}
          >
            {newsLoading && latestNews.length === 0 ? (
              <LoadingRows
                columns={['热度', '新闻摘要', '来源']}
                template="52px minmax(0,1fr) 76px"
                palette={palette}
                rows={3}
                label="新闻同步中"
              />
            ) : latestNews.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {latestNews.map((item, index) => (
                  <HomeHotNewsRow
                    key={`${item.title}-${index}`}
                    idx={index}
                    item={item}
                    palette={palette}
                    theme={theme}
                    last={index === latestNews.length - 1}
                  />
                ))}
              </div>
            ) : <EmptyLine palette={palette} text="暂无新闻" />}
          </TerminalCard>
        </Col>

        <Col xs={24} xl={12}>
          <TerminalCard
            title="MACD选股"
            subtitle="（多头信号）"
            icon={<LineChartOutlined />}
            accent={WARNING_COLOR}
            palette={palette}
            actionText="更多条件"
            onClick={() => navigate('/macd')}
            minHeight={230}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <Space size={14}>
                <span style={{ color: WARNING_COLOR, fontWeight: 700, fontSize: 18 }}>{macdCandidate} 只</span>
                <span style={{ color: palette.subtle, fontSize: 12 }}>强信号 <Text style={{ color: UP_COLOR }}>{macdStrong}</Text></span>
                <span style={{ color: palette.subtle, fontSize: 12 }}>转弱 <Text style={{ color: DOWN_COLOR }}>{macdRisk}</Text></span>
                <span style={{ color: palette.subtle, fontSize: 12 }}>{macdGeneratedAt ? dayjs(macdGeneratedAt).format('MM-DD HH:mm') : '-'}</span>
                {macdUpdating && <Tag color="processing" style={{ margin: 0 }}>后台更新</Tag>}
                {macdCached && <Tag style={{ margin: 0 }}>缓存</Tag>}
              </Space>
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                loading={macdLoading}
                onClick={(event) => {
                  event.stopPropagation();
                  void fetchMacdData(true);
                }}
                style={{ color: SYSTEM_BLUE }}
              >
                刷新
              </Button>
            </div>
            {macdTopRows.length > 0 ? (
              <>
                <TableHeader columns={['代码', '名称', '信号分', 'MACD', '形态', '子集']} template="70px minmax(0,1fr) 58px 92px 60px 48px" palette={palette} />
                {macdTopRows.map((row, index) => {
                  const rowColor = row.信号等级 === '转弱风险' ? DOWN_COLOR : UP_COLOR;
                  return (
                    <TableRow
                      key={`${row.股票代码}-${index}`}
                      template="70px minmax(0,1fr) 58px 92px 60px 48px"
                      palette={palette}
                      last={index === macdTopRows.length - 1}
                      cells={[
                        displayCode(row.股票代码),
                        row.股票名称,
                        <span style={{ color: rowColor }}>{typeof row.信号分 === 'number' ? row.信号分.toFixed(1) : '-'}</span>,
                        <MiniSparkline color={rowColor} variant={index} />,
                        row.信号等级 || '-',
                        row.是否候选 ? '候选' : '观察',
                      ]}
                    />
                  );
                })}
              </>
            ) : <EmptyLine palette={palette} text="暂无 MACD 信号" />}
          </TerminalCard>
        </Col>

        <Col xs={24} xl={12}>
          <TerminalCard
            title="标准TMT"
            subtitle="（申万一级）"
            icon={<RiseOutlined />}
            accent={SYSTEM_BLUE}
            palette={palette}
            actionText="更多"
            onClick={() => navigate('/tmt-margin')}
            minHeight={230}
          >
            {tmtData ? (
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '240px minmax(0,1fr)', gap: 18 }}>
                <div>
                  <Text style={{ color: palette.muted, fontSize: 12 }}>成交额占全A</Text>
                  <Space size={8} align="baseline" style={{ display: 'flex', marginTop: 6 }}>
                    <Statistic
                      value={tmtTurnoverSnapshot.latest ?? 0}
                      precision={1}
                      suffix="%"
                      formatter={() => tmtTurnoverSnapshot.latest == null ? '-' : tmtTurnoverSnapshot.latest.toFixed(1)}
                      styles={{ content: { fontSize: 32, fontWeight: 800, color: SYSTEM_BLUE, lineHeight: 1 } }}
                    />
                    <Tag color={tmtDataIsStale ? 'orange' : 'blue'} style={{ margin: 0 }}>
                      {tmtDataIsStale ? (tmtMarginIsStale ? '两融数据滞后' : '数据待刷新') : '标准口径'}
                    </Tag>
                  </Space>
                  <div style={{ color: palette.subtle, fontSize: 12, marginTop: 2 }}>
                    较前一日 {tmtTurnoverSnapshot.change == null ? '-' : `${formatSigned(tmtTurnoverSnapshot.change, 1)}pp`}
                  </div>
                  <div style={{ marginTop: 12, padding: '10px 12px', border: `1px solid ${palette.borderSoft}`, borderRadius: 6, background: palette.surfaceAlt }}>
                    <Text style={{ color: palette.text, fontSize: 12 }}>电子 / 计算机 / 通信 / 传媒</Text>
                    <div style={{ color: palette.subtle, fontSize: 12, marginTop: 4 }}>
                      分类截至 {tmtData.classification_asof ? formatReportDate(tmtData.classification_asof) : '-'}
                    </div>
                    <div style={{ color: tmtMarginIsStale ? WARNING_COLOR : palette.subtle, fontSize: 12, marginTop: 2 }}>
                      两融数据 {formatReportDate(tmtMarginDisplayDate)}
                      {tmtMarginIsStale && tmtFreshness.expectedMarginDataDate
                        ? ` · 预期 ${formatReportDate(tmtFreshness.expectedMarginDataDate)}`
                        : ''}
                    </div>
                  </div>
                </div>
                <div style={{ border: `1px solid ${palette.borderSoft}`, borderRadius: 6, padding: '10px 12px', background: palette.surfaceAlt }}>
                  <TableRow
                    template="minmax(0,1fr) 88px 66px"
                    palette={palette}
                    cells={[
                      '成交额占全A',
                      tmtTurnoverSnapshot.latest == null ? '-' : `${tmtTurnoverSnapshot.latest.toFixed(1)}%`,
                      <span style={{ color: tmtTurnoverSnapshot.change == null ? palette.subtle : valueColor(tmtTurnoverSnapshot.change) }}>
                        {tmtTurnoverSnapshot.change == null ? '-' : `${formatSigned(tmtTurnoverSnapshot.change, 1)}pp`}
                      </span>,
                    ]}
                  />
                  <TableRow
                    template="minmax(0,1fr) 88px 66px"
                    palette={palette}
                    cells={['融资余额占比', `${tmtData.pct.toFixed(1)}%`, <span style={{ color: SYSTEM_BLUE }}>{tmtData.tmt_yy.toFixed(0)}亿</span>]}
                  />
                  <TableRow
                    template="minmax(0,1fr) 88px 66px"
                    palette={palette}
                    cells={['融资买入额占比', `${tmtData.tmt_buy_pct.toFixed(1)}%`, <span style={{ color: SYSTEM_BLUE }}>{tmtData.tmt_buy.toFixed(1)}亿</span>]}
                  />
                  <TableRow
                    template="minmax(0,1fr) 88px 66px"
                    palette={palette}
                    last
                    cells={['两融覆盖/标准成分', `${tmtData.tmt_margin_count ?? '-'}只`, `${tmtData.tmt_universe_count ?? '-'}只`]}
                  />
                  <div style={{ color: tmtDataIsStale ? WARNING_COLOR : palette.subtle, fontSize: 12, marginTop: 8 }}>
                    {tmtMarginIsStale
                      ? `两融数据滞后${tmtFreshness.marginLagTradingDays ? ` ${tmtFreshness.marginLagTradingDays} 个交易日` : ''}；当前数值不是最新交易日。`
                      : '中性事实展示；标准口径历史阈值积累后再校准。'}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '240px minmax(0,1fr)', gap: 18 }}>
                <div>
                  <Text style={{ color: palette.muted, fontSize: 12 }}>标准TMT成交额占比</Text>
                  <Space size={8} align="baseline" style={{ display: 'flex', marginTop: 6 }}>
                    <span style={{ color: palette.subtle, fontSize: 30, fontWeight: 800, lineHeight: 1 }}>
                      {tmtLoading ? '--.-' : '暂无'}
                    </span>
                    <Tag style={{ margin: 0 }}>{tmtLoading ? '同步中' : '待同步'}</Tag>
                  </Space>
                  <div style={{ color: palette.subtle, fontSize: 12, marginTop: 2 }}>较前一日 -</div>
                  <div
                    style={{
                      height: 64,
                      marginTop: 8,
                      border: `1px solid ${palette.borderSoft}`,
                      borderRadius: 6,
                      background: palette.surfaceAlt,
                    }}
                  />
                </div>
                <div style={{ border: `1px solid ${palette.borderSoft}`, borderRadius: 6, padding: '10px 12px', background: palette.surfaceAlt }}>
                  <TableRow template="minmax(0,1fr) 88px 66px" palette={palette} cells={['成交额占全A', tmtLoading ? '同步中' : '-', '-']} />
                  <TableRow template="minmax(0,1fr) 88px 66px" palette={palette} cells={['融资余额占比', '-', '-']} />
                  <TableRow template="minmax(0,1fr) 88px 66px" palette={palette} cells={['融资买入额占比', '-', '-']} />
                  <TableRow template="minmax(0,1fr) 88px 66px" palette={palette} last cells={['两融覆盖/标准成分', '-', '-']} />
                  <div style={{ color: palette.subtle, fontSize: 12, marginTop: 8 }}>
                    {tmtFreshness.reason || '标准申万行业数据同步完成后显示分项指标'}
                  </div>
                </div>
              </div>
            )}
          </TerminalCard>
        </Col>
      </Row>
    </div>
  );
};

export default HomePanel;
