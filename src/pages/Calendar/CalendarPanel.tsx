import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Alert,
  Button,
  Drawer,
  Segmented,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CaretLeftOutlined,
  CaretRightOutlined,
  LeftOutlined,
  LinkOutlined,
  ReloadOutlined,
  RightOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { API_BASE } from '../../config/api';
import { useTheme } from '../../hooks/useTheme';
import { normalizeCalendarResponse } from './calendarData';
import type { CalendarEvent, CalendarTrack } from './types';
import './CalendarPanel.css';

const { Text, Title } = Typography;

const TRACK_META: Record<CalendarTrack, { title: string; source: string }> = {
  macro: { title: '宏观', source: '官方 + 金十' },
  earnings: { title: '美股财报', source: 'Nasdaq + EarningsHub' },
  'a-share': { title: 'A股事件', source: 'A股投资日历' },
};

const TRACK_ORDER: CalendarTrack[] = ['macro', 'earnings', 'a-share'];
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MONTH_WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
type CalendarView = 'week' | 'month';
type RefreshNotice = { type: 'success' | 'warning'; title: string };

const getMonday = (value: Dayjs): Dayjs => {
  const offset = (value.day() + 6) % 7;
  return value.startOf('day').subtract(offset, 'day');
};

const getMonthGridStart = (value: Dayjs): Dayjs => getMonday(value.startOf('month'));

const getMonthGridEnd = (value: Dayjs): Dayjs => {
  const monthEnd = value.endOf('month');
  return getMonday(monthEnd).add(6, 'day');
};

const getCalendarVariables = (theme: 'light' | 'dark'): CSSProperties => {
  if (theme === 'dark') {
    return {
      '--calendar-page': '#101112',
      '--calendar-surface': '#171819',
      '--calendar-surface-raised': '#1c1d1f',
      '--calendar-surface-soft': '#202225',
      '--calendar-border': '#3a3c40',
      '--calendar-border-soft': '#2d2f33',
      '--calendar-text': '#f0f0f0',
      '--calendar-muted': '#b6b8bd',
      '--calendar-subtle': '#85888f',
      '--calendar-blue': '#1677ff',
      '--calendar-blue-soft': 'rgba(22, 119, 255, 0.13)',
      '--calendar-red': '#ff4d4f',
      '--calendar-orange': '#f59e0b',
      '--calendar-tag': '#182235',
    } as CSSProperties;
  }
  return {
    '--calendar-page': '#f5f7fa',
    '--calendar-surface': '#ffffff',
    '--calendar-surface-raised': '#ffffff',
    '--calendar-surface-soft': '#f6f8fb',
    '--calendar-border': '#d9dee6',
    '--calendar-border-soft': '#edf0f4',
    '--calendar-text': '#1f2937',
    '--calendar-muted': '#596273',
    '--calendar-subtle': '#8b95a5',
    '--calendar-blue': '#1677ff',
    '--calendar-blue-soft': 'rgba(22, 119, 255, 0.09)',
    '--calendar-red': '#e5484d',
    '--calendar-orange': '#d97706',
    '--calendar-tag': '#eef5ff',
  } as CSSProperties;
};

const formatUpdateTime = (value: Date): string =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);

const formatBeijingDate = (value: string): string => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return byType.year && byType.month && byType.day
    ? `${byType.year}-${byType.month}-${byType.day}`
    : '';
};

const eventDisplayDate = (event: CalendarEvent): string => (
  event.startAt ? formatBeijingDate(event.startAt) || event.date : event.date
);

const safeSourceUrl = (url?: string): string | undefined =>
  url && /^https?:\/\//i.test(url) ? url : undefined;

const eventMetricLabel = (event: CalendarEvent): string => {
  if (event.track === 'earnings') {
    return [
      event.epsEstimate ? 'EPS ' + event.epsEstimate : '',
      event.revenueEstimate ? '营收 ' + event.revenueEstimate : '',
    ].filter(Boolean).join(' · ');
  }
  if (event.track === 'macro') {
    return [
      event.time,
      event.actual
        ? '公布 ' + event.actual
        : event.forecast ? '预测 ' + event.forecast : '',
    ].filter(Boolean).join(' · ');
  }
  return event.category || event.time || '';
};

const eventDisplayTime = (event: CalendarEvent): string => {
  if (event.track === 'earnings') return event.timing || event.time || '待定';
  if (/^\d{1,2}:\d{2}$/.test(event.time || '')) return event.time || '';
  return event.time || '全天';
};

const eventSortMinutes = (event: CalendarEvent): number => {
  const time = event.track === 'earnings' ? event.timing || event.time || '' : event.time || '';
  if (time === '盘前') return 7 * 60;
  if (time === '盘后') return 21 * 60;
  if (time === '全天' || /月\d+日/.test(time)) return -1;
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 24 * 60 + 1;
  return Number(match[1]) * 60 + Number(match[2]);
};

const compareCalendarEvents = (left: CalendarEvent, right: CalendarEvent): number => {
  const timeDelta = eventSortMinutes(left) - eventSortMinutes(right);
  if (timeDelta !== 0) return timeDelta;
  const displayTimeDelta = eventDisplayTime(left).localeCompare(eventDisplayTime(right), 'zh-CN');
  if (displayTimeDelta !== 0) return displayTimeDelta;
  const trackDelta = TRACK_ORDER.indexOf(left.track) - TRACK_ORDER.indexOf(right.track);
  if (trackDelta !== 0) return trackDelta;
  return left.title.localeCompare(right.title, 'zh-CN');
};

const eventCountry = (event: CalendarEvent): { flag: string; label: string } => {
  if (event.track === 'earnings') return { flag: '🇺🇸', label: '美国' };
  if (event.track === 'a-share') return { flag: '🇨🇳', label: '中国' };
  const country = (event.country || '全球').trim();
  const normalized = country.toLowerCase();
  const countries: Array<[RegExp, string, string]> = [
    [/中国|china|^cn$/, '🇨🇳', '中国'],
    [/美国|united states|^us$|^usa$/, '🇺🇸', '美国'],
    [/英国|united kingdom|^uk$|^gb$/, '🇬🇧', '英国'],
    [/新加坡|singapore|^sg$/, '🇸🇬', '新加坡'],
    [/澳大利亚|australia|^au$/, '🇦🇺', '澳大利亚'],
    [/日本|japan|^jp$/, '🇯🇵', '日本'],
    [/德国|germany|^de$/, '🇩🇪', '德国'],
    [/欧元区|eurozone|euro area|^eu$/, '🇪🇺', '欧元区'],
  ];
  const match = countries.find(([pattern]) => pattern.test(normalized));
  return match ? { flag: match[1], label: match[2] } : { flag: '🌐', label: country };
};

const eventStatusTheme = (event: CalendarEvent): { label: string; tone: string } => {
  const explicit = event.impact?.trim();
  if (explicit) {
    if (/利多|正面|positive|bullish/i.test(explicit)) return { label: explicit, tone: 'positive' };
    if (/利空|负面|negative|bearish/i.test(explicit)) return { label: explicit, tone: 'negative' };
    if (/较小|有限|neutral/i.test(explicit)) return { label: explicit, tone: 'muted' };
    return { label: explicit, tone: 'info' };
  }
  if (event.status === 'cancelled') return { label: '已取消', tone: 'negative' };
  if (event.track === 'a-share') return { label: event.category || '主题事件', tone: 'theme' };
  if (event.track === 'earnings') return { label: '财报', tone: 'info' };
  if (event.actual) return { label: '已公布', tone: 'released' };
  if (event.status === 'released') {
    return /发布会|讲话|听证会|会议|报告|褐皮书/.test(event.title)
      ? { label: '已结束', tone: 'released' }
      : { label: '已公布', tone: 'released' };
  }
  if (event.status === 'estimated') return { label: '待确认', tone: 'muted' };
  const eventTime = event.startAt ? Date.parse(event.startAt) : Number.NaN;
  if (Number.isFinite(eventTime) && eventTime < Date.now()) {
    return /发布会|讲话|听证会|会议|报告|褐皮书/.test(event.title)
      ? { label: '已结束', tone: 'released' }
      : { label: '待更新', tone: 'muted' };
  }
  return { label: '待公布', tone: 'muted' };
};

const eventForecastValue = (event: CalendarEvent): string => {
  if (event.track !== 'earnings') return event.forecast || '—';
  return [
    event.epsEstimate ? `EPS ${event.epsEstimate}` : '',
    event.revenueEstimate ? `营收 ${event.revenueEstimate}` : '',
  ].filter(Boolean).join(' · ') || '—';
};

const eventSubtitle = (event: CalendarEvent): string => {
  if (event.track === 'a-share') return event.category || 'A股主题事件';
  return '';
};

const buildEventsByDate = (
  days: Dayjs[],
  events: CalendarEvent[],
): Map<string, CalendarEvent[]> => {
  const groups = new Map<string, CalendarEvent[]>();
  for (const date of days) groups.set(date.format('YYYY-MM-DD'), []);
  for (const event of events) {
    const displayDate = eventDisplayDate(event);
    const firstDay = dayjs(displayDate);
    const lastDay = dayjs(event.startAt ? displayDate : event.endDate || displayDate);
    if (!firstDay.isValid() || !lastDay.isValid()) continue;
    for (
      let cursor = firstDay;
      cursor.valueOf() <= lastDay.valueOf();
      cursor = cursor.add(1, 'day')
    ) {
      groups.get(cursor.format('YYYY-MM-DD'))?.push(event);
    }
  }
  for (const dayEvents of groups.values()) dayEvents.sort(compareCalendarEvents);
  return groups;
};

interface OverflowTooltipTextProps {
  text: string;
  className: string;
}

const OverflowTooltipText = ({ text, className }: OverflowTooltipTextProps) => {
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = textRef.current;
    if (!element) return undefined;
    const update = () => {
      setOverflowing(
        element.scrollWidth > element.clientWidth + 1
        || element.scrollHeight > element.clientHeight + 1,
      );
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [text]);

  return (
    <Tooltip
      title={overflowing ? <span className="calendar-overflow-tooltip-content">{text}</span> : null}
      mouseEnterDelay={0.25}
    >
      <span ref={textRef} className={className}>{text}</span>
    </Tooltip>
  );
};

interface AgendaTableProps {
  events: CalendarEvent[];
  onOpenEvent: (event: CalendarEvent) => void;
}

const isAllDayEvent = (event: CalendarEvent): boolean => eventSortMinutes(event) < 0;

const eventAgendaTimeLabel = (event: CalendarEvent): string => {
  if (!isAllDayEvent(event)) return eventDisplayTime(event);
  const displayDate = eventDisplayDate(event);
  return event.endDate && event.endDate !== displayDate ? '进行中' : '全天';
};

const CalendarAgendaTable = ({
  events,
  onOpenEvent,
}: AgendaTableProps) => {
  return (
    <section className="calendar-agenda-shell" aria-label="按时间排序的日历事件">
      <div className="calendar-agenda-table" role="table" aria-label="日历事件表格">
      <div className="calendar-agenda-header" role="row">
        <span role="columnheader">时间</span>
        <span role="columnheader">事件</span>
        <span role="columnheader">前值</span>
        <span role="columnheader">预测值</span>
        <span role="columnheader">公布值</span>
        <span role="columnheader">状态/主题</span>
      </div>
      <div role="rowgroup">
        {events.length > 0 ? events.map((event, index) => {
          const displayTime = eventAgendaTimeLabel(event);
          const previousTime = index > 0 ? eventAgendaTimeLabel(events[index - 1]) : '';
          const country = eventCountry(event);
          const statusTheme = eventStatusTheme(event);
          const subtitle = eventSubtitle(event);
          const showTime = index === 0 || displayTime !== previousTime;
          return (
            <div
              className={[
                'calendar-agenda-row',
                'calendar-agenda-row--' + event.track,
                isAllDayEvent(event) ? 'calendar-agenda-row--all-day' : '',
              ].filter(Boolean).join(' ')}
              role="row"
              key={event.id}
            >
              <div className="calendar-agenda-time" role="cell" aria-label={`时间 ${displayTime}`}>
                {showTime ? displayTime : ''}
              </div>
              <div className="calendar-agenda-event" role="cell">
                <button
                  type="button"
                  className="calendar-agenda-event-button"
                  onClick={() => onOpenEvent(event)}
                  aria-label={`查看${event.title}详情`}
                >
                  <span className="calendar-agenda-identity">
                    <span className="calendar-agenda-flag" aria-label={country.label}>{country.flag}</span>
                    <span className={'calendar-agenda-type calendar-agenda-type--' + event.track}>
                      {TRACK_META[event.track].title}
                    </span>
                    <span className="calendar-agenda-title">{event.title}</span>
                    <RightOutlined className="calendar-agenda-chevron" />
                  </span>
                  {subtitle ? (
                    <span className="calendar-agenda-subtitle">{subtitle}</span>
                  ) : null}
                </button>
              </div>
              <div className="calendar-agenda-value" role="cell" data-label="前值">
                {event.track === 'macro' ? event.previous || '—' : '—'}
              </div>
              <div className="calendar-agenda-value" role="cell" data-label="预测值">
                {eventForecastValue(event)}
              </div>
              <div
                className={'calendar-agenda-value' + (event.actual ? ' calendar-agenda-value--actual' : '')}
                role="cell"
                data-label="公布值"
              >
                {event.track === 'macro' ? event.actual || '—' : '—'}
              </div>
              <div className="calendar-agenda-impact-cell" role="cell" data-label="状态/主题">
                <span className={'calendar-impact calendar-impact--' + statusTheme.tone}>{statusTheme.label}</span>
              </div>
            </div>
          );
        }) : (
          <div className="calendar-agenda-empty">当前日期暂无事件</div>
        )}
      </div>
      </div>
    </section>
  );
};

interface MonthEventProps {
  event: CalendarEvent;
  onOpen: (event: CalendarEvent) => void;
}

const CalendarMonthEvent = ({ event, onOpen }: MonthEventProps) => {
  const metric = eventMetricLabel(event);
  const country = eventCountry(event);
  const companyTitle = event.track === 'earnings'
    ? [event.code, event.title.replace(/\s+\d{4}\s+Q\d财报$/i, '')].filter(Boolean).join(' · ')
    : event.title;

  return (
    <button
      type="button"
      className={'calendar-month-event calendar-month-event--' + event.track}
      onClick={() => onOpen(event)}
      aria-label={[companyTitle, metric].filter(Boolean).join('，')}
    >
      <span className="calendar-month-event-heading">
        <span className="calendar-month-event-flag" aria-label={country.label}>{country.flag}</span>
        <OverflowTooltipText text={companyTitle} className="calendar-month-event-title" />
      </span>
      {metric ? <OverflowTooltipText text={metric} className="calendar-month-event-metric" /> : null}
    </button>
  );
};

interface MonthGridProps {
  month: Dayjs;
  days: Dayjs[];
  eventsByDate: Map<string, CalendarEvent[]>;
  onOpenEvent: (event: CalendarEvent) => void;
}

const CalendarMonthGrid = ({ month, days, eventsByDate, onOpenEvent }: MonthGridProps) => (
  <section className="calendar-month-shell" aria-label={month.format('YYYY年M月') + '月历'}>
    <div className="calendar-month-weekdays" aria-hidden="true">
      {MONTH_WEEKDAY_LABELS.map((label) => <span key={label}>{label}</span>)}
    </div>
    <div className="calendar-month-grid">
      {days.map((date) => {
        const dateKey = date.format('YYYY-MM-DD');
        const dayEvents = eventsByDate.get(dateKey) || [];
        const outsideMonth = date.month() !== month.month();
        const today = date.isSame(dayjs(), 'day');
        return (
          <div
            className={[
              'calendar-month-day',
              outsideMonth ? 'calendar-month-day--outside' : '',
              today ? 'calendar-month-day--today' : '',
            ].filter(Boolean).join(' ')}
            key={dateKey}
          >
            <div className="calendar-month-date-row">
              <time dateTime={dateKey} className="calendar-month-date">
                {date.date() === 1 ? date.format('M月D日') : date.format('D')}
              </time>
            </div>
            <div className="calendar-month-events">
              {dayEvents.map((event) => (
                <CalendarMonthEvent key={event.id + '-' + dateKey} event={event} onOpen={onOpenEvent} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  </section>
);

const CalendarMonthLoading = () => (
  <div className="calendar-month-shell calendar-month-loading" aria-label="月历数据加载中">
    <Skeleton active title paragraph={{ rows: 12 }} />
  </div>
);

interface EventDrawerProps {
  event?: CalendarEvent;
  onClose: () => void;
}

const CalendarEventDrawer = ({ event, onClose }: EventDrawerProps) => {
  const sourceUrl = safeSourceUrl(event?.url);
  const statusTheme = event ? eventStatusTheme(event) : undefined;
  return (
    <Drawer
      open={Boolean(event)}
      onClose={onClose}
      size={420}
      getContainer={false}
      title={event?.track === 'earnings' ? event.code || '财报详情' : TRACK_META[event?.track || 'macro'].title}
      className="calendar-event-drawer"
    >
      {event ? (
        <div className="calendar-drawer-content">
          <div className={'calendar-drawer-accent calendar-drawer-accent--' + event.track} />
          <Title level={3}>{event.title}</Title>
          <Text className="calendar-drawer-date">
            {dayjs(eventDisplayDate(event)).format('YYYY年M月D日')} · {event.timing || event.time || '全天'}
          </Text>
          {event.track === 'earnings' ? (
            <div className="calendar-drawer-estimates">
              <div><span>股票代码</span><strong>{event.code || '—'}</strong></div>
              <div><span>报告期</span><strong>{event.period || '—'}</strong></div>
              <div><span>EPS 预期</span><strong>{event.epsEstimate || '—'}</strong></div>
              <div><span>营收预期</span><strong>{event.revenueEstimate || '—'}</strong></div>
            </div>
          ) : event.track === 'macro' ? (
            <div className="calendar-drawer-estimates">
              <div><span>前值</span><strong>{event.previous || '—'}</strong></div>
              <div><span>预测</span><strong>{event.forecast || '—'}</strong></div>
              <div><span>公布</span><strong>{event.actual || '待公布'}</strong></div>
              <div><span>状态</span><strong>{statusTheme?.label || '—'}</strong></div>
            </div>
          ) : (
            <div className="calendar-drawer-estimates">
              <div><span>分类</span><strong>{event.category || '主题事件'}</strong></div>
              <div><span>时间</span><strong>{event.time || '全天'}</strong></div>
              <div><span>主题</span><strong>{statusTheme?.label || '—'}</strong></div>
              <div><span>地区</span><strong>中国</strong></div>
            </div>
          )}
          {event.description ? <Text className="calendar-drawer-description">{event.description}</Text> : null}
          {event.subsets?.length ? (
            <div className="calendar-drawer-subsets">
              <Text type="secondary">关联子集</Text>
              {event.subsets.map((subset) => <Tag key={subset}>{subset}</Tag>)}
            </div>
          ) : null}
          <div className="calendar-drawer-source">
            <Text type="secondary">来源：{event.source || TRACK_META[event.track].source}</Text>
            {sourceUrl ? (
              <Button type="link" href={sourceUrl} target="_blank" rel="noreferrer" icon={<LinkOutlined />}>
                查看来源
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
};

const CalendarAgendaLoading = () => (
  <div className="calendar-agenda-shell calendar-agenda-loading" aria-label="日历数据加载中">
    <Skeleton active title={false} paragraph={{ rows: 8 }} />
  </div>
);

export const CalendarPanel = () => {
  const { theme } = useTheme();
  const [view, setView] = useState<CalendarView>('week');
  const [weekStart, setWeekStart] = useState<Dayjs>(() => getMonday(dayjs()));
  const [monthAnchor, setMonthAnchor] = useState<Dayjs>(() => dayjs().startOf('month'));
  const [selectedDate, setSelectedDate] = useState(() => dayjs().format('YYYY-MM-DD'));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [drawerEvent, setDrawerEvent] = useState<CalendarEvent>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [apiError, setApiError] = useState<string>();
  const [refreshNotice, setRefreshNotice] = useState<RefreshNotice>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [dataUpdatedAt, setDataUpdatedAt] = useState<Date>();
  const [activeMonthTracks, setActiveMonthTracks] = useState<CalendarTrack[]>(() => [...TRACK_ORDER]);

  const weekEndKey = weekStart.add(6, 'day').format('YYYY-MM-DD');
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => weekStart.add(index, 'day')),
    [weekStart],
  );
  const monthGridStart = useMemo(() => getMonthGridStart(monthAnchor), [monthAnchor]);
  const monthGridEnd = useMemo(() => getMonthGridEnd(monthAnchor), [monthAnchor]);
  const monthDays = useMemo(() => {
    const dayCount = monthGridEnd.diff(monthGridStart, 'day') + 1;
    return Array.from({ length: dayCount }, (_, index) => monthGridStart.add(index, 'day'));
  }, [monthGridEnd, monthGridStart]);
  const requestStartKey = view === 'week'
    ? weekStart.subtract(1, 'day').format('YYYY-MM-DD')
    : monthGridStart.subtract(1, 'day').format('YYYY-MM-DD');
  const requestEndKey = view === 'week' ? weekEndKey : monthGridEnd.format('YYYY-MM-DD');

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const loadCalendar = async () => {
      setLoading(true);
      setApiError(undefined);
      const query = new URLSearchParams({ start: requestStartKey, end: requestEndKey });

      try {
        const response = await fetch(API_BASE + '/api/calendar?' + query.toString(), {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const payload: unknown = await response.json();
        const normalized = normalizeCalendarResponse(payload);
        if (!active) return;
        setEvents(normalized);
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const updatedAt = (payload as Record<string, unknown>).updatedAt;
          const parsedUpdatedAt = typeof updatedAt === 'string' ? new Date(updatedAt) : undefined;
          setDataUpdatedAt(
            parsedUpdatedAt && Number.isFinite(parsedUpdatedAt.getTime())
              ? parsedUpdatedAt
              : undefined,
          );
        }
      } catch (error) {
        if (controller.signal.aborted || !active) return;
        setEvents([]);
        setApiError(
          error instanceof Error
            ? '日历接口暂不可用，请稍后重试。'
            : '日历加载失败，请稍后重试。',
        );
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadCalendar();
    return () => {
      active = false;
      controller.abort();
    };
  }, [refreshVersion, requestEndKey, requestStartKey]);

  const visibleDays = view === 'week' ? weekDays : monthDays;
  const eventsByDate = useMemo(
    () => buildEventsByDate(visibleDays, events),
    [events, visibleDays],
  );
  const monthEventsByDate = useMemo(() => {
    const activeTracks = new Set(activeMonthTracks);
    return new Map(
      [...eventsByDate.entries()].map(([date, dayEvents]) => [
        date,
        dayEvents.filter((event) => activeTracks.has(event.track)),
      ]),
    );
  }, [activeMonthTracks, eventsByDate]);
  const selectedDayEvents = useMemo(
    () => [...(eventsByDate.get(selectedDate) || [])].sort(compareCalendarEvents),
    [eventsByDate, selectedDate],
  );

  const selectDay = useCallback((date: Dayjs) => {
    setSelectedDate(date.format('YYYY-MM-DD'));
    setDrawerEvent(undefined);
  }, []);

  const changeWeek = useCallback((weekDelta: number) => {
    const nextWeek = weekStart.add(weekDelta, 'week');
    setWeekStart(nextWeek);
    setSelectedDate(nextWeek.format('YYYY-MM-DD'));
    setDrawerEvent(undefined);
  }, [weekStart]);

  const changeMonth = useCallback((monthDelta: number) => {
    setMonthAnchor((current) => current.add(monthDelta, 'month').startOf('month'));
    setDrawerEvent(undefined);
  }, []);

  const returnToCurrentMonth = useCallback(() => {
    setMonthAnchor(dayjs().startOf('month'));
    setDrawerEvent(undefined);
  }, []);

  const changeView = useCallback((nextView: CalendarView) => {
    setView(nextView);
    setDrawerEvent(undefined);
    if (nextView === 'month') {
      setMonthAnchor(dayjs(selectedDate).startOf('month'));
    }
  }, [selectedDate]);

  const toggleMonthTrack = useCallback((track: CalendarTrack) => {
    setActiveMonthTracks((current) => {
      if (current.length === TRACK_ORDER.length) return [track];
      if (current.includes(track)) {
        if (current.length === 1) return [...TRACK_ORDER];
        return current.filter((item) => item !== track);
      }
      return TRACK_ORDER.filter((item) => current.includes(item) || item === track);
    });
  }, []);

  const reload = useCallback(() => {
    setRefreshVersion((version) => version + 1);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setApiError(undefined);
    setRefreshNotice(undefined);
    const query = new URLSearchParams({ start: requestStartKey, end: requestEndKey });
    try {
      const response = await fetch(API_BASE + '/api/calendar/refresh?' + query.toString(), {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const payload: unknown = await response.json();
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const payloadRecord = payload as Record<string, unknown>;
        if (Array.isArray(payloadRecord.events)) {
          setEvents(normalizeCalendarResponse(payload));
        } else {
          reload();
        }
        const parsedUpdatedAt = typeof payloadRecord.updatedAt === 'string'
          ? new Date(payloadRecord.updatedAt)
          : undefined;
        if (parsedUpdatedAt && Number.isFinite(parsedUpdatedAt.getTime())) {
          setDataUpdatedAt(parsedUpdatedAt);
        }
        const refreshed = payloadRecord.refreshed;
        if (refreshed && typeof refreshed === 'object' && !Array.isArray(refreshed)) {
          const refreshedRecord = refreshed as Record<string, unknown>;
          const results = refreshedRecord.results;
          const sourceLabels: Record<string, string> = {
            macro: '宏观',
            earnings: '美股财报',
            aShare: 'A股事件',
          };
          const failed = results && typeof results === 'object' && !Array.isArray(results)
            ? Object.entries(results as Record<string, unknown>)
              .filter(([, value]) => value && typeof value === 'object'
                && !Array.isArray(value)
                && (value as Record<string, unknown>).status === 'failed')
              .map(([key]) => sourceLabels[key] || key)
            : [];
          if (failed.length > 0) {
            setRefreshNotice({
              type: 'warning',
              title: `刷新完成，但${failed.join('、')}联网失败；失败部分保留上次数据。`,
            });
          } else if (refreshedRecord.coverageComplete === false) {
            setRefreshNotice({
              type: 'warning',
              title: '官方宏观实际值和美股财报已刷新；金十宏观日程与A股题材沿用已人工核验快照。',
            });
          } else {
            setRefreshNotice({ type: 'success', title: '日历数据刷新完成。' });
          }
        }
      }
    } catch {
      setApiError('手动刷新失败，当前仍显示上一次成功更新的数据。');
    } finally {
      setRefreshing(false);
    }
  }, [reload, requestEndKey, requestStartKey]);

  return (
    <div className="calendar-panel" style={getCalendarVariables(theme)}>
      <header className="calendar-page-header">
        <div className="calendar-page-title">
          <Title level={2}>日历</Title>
          <Text>宏观 · 美股财报 · A股事件</Text>
        </div>
        <div className="calendar-header-actions">
          <Segmented<CalendarView>
            size="small"
            value={view}
            options={[
              { label: '本周', value: 'week' },
              { label: '本月', value: 'month' },
            ]}
            onChange={changeView}
          />
          <Text className="calendar-data-updated">
            上次刷新 {dataUpdatedAt ? formatUpdateTime(dataUpdatedAt) : '—'}
          </Text>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={loading || refreshing}
            onClick={() => void refresh()}
          >
            刷新
          </Button>
        </div>
      </header>

      {view === 'week' ? (
        <div className="calendar-week-window">
          <Tooltip title="上一周">
            <Button
              type="text"
              className="calendar-week-window-arrow calendar-week-window-arrow--previous"
              icon={<CaretLeftOutlined />}
              aria-label="上一周"
              onClick={() => changeWeek(-1)}
            />
          </Tooltip>
          <div className="calendar-date-strip-scroll">
            <div className="calendar-date-strip" role="tablist" aria-label="选择日期">
              {weekDays.map((date) => {
                const dateKey = date.format('YYYY-MM-DD');
                const selected = dateKey === selectedDate;
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={'calendar-date-tab' + (selected ? ' calendar-date-tab--selected' : '')}
                    key={dateKey}
                    onClick={() => selectDay(date)}
                  >
                    <span className="calendar-date-label">{date.format('M月D日')}</span>
                    <span className="calendar-weekday-label">{WEEKDAY_LABELS[date.day()]}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <Tooltip title="下一周">
            <Button
              type="text"
              className="calendar-week-window-arrow calendar-week-window-arrow--next"
              icon={<CaretRightOutlined />}
              aria-label="下一周"
              onClick={() => changeWeek(1)}
            />
          </Tooltip>
        </div>
      ) : null}

      {view === 'month' ? (
        <div className="calendar-toolbar">
          <Space.Compact>
            <Tooltip title="上个月">
              <Button
                icon={<LeftOutlined />}
                aria-label="上个月"
                onClick={() => changeMonth(-1)}
              />
            </Tooltip>
            <Button
              className="calendar-month-button"
              onClick={returnToCurrentMonth}
            >
              {monthAnchor.format('YYYY年M月')}
            </Button>
            <Tooltip title="下个月">
              <Button
                icon={<RightOutlined />}
                aria-label="下个月"
                onClick={() => changeMonth(1)}
              />
            </Tooltip>
          </Space.Compact>
          <div className="calendar-legend" role="group" aria-label="按事件类型筛选">
            {TRACK_ORDER.map((track) => {
              const active = activeMonthTracks.includes(track);
              return (
                <button
                  type="button"
                  key={track}
                  aria-pressed={active}
                  className={[
                    'calendar-legend-button',
                    'calendar-legend-button--' + track,
                    active ? 'calendar-legend-button--active' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => toggleMonthTrack(track)}
                >
                  {TRACK_META[track].title}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {apiError ? (
        <Alert
          showIcon
          type="warning"
          title={apiError}
          className="calendar-api-alert"
          action={<Button size="small" onClick={reload}>重试</Button>}
        />
      ) : null}

      {refreshNotice ? (
        <Alert
          showIcon
          closable
          type={refreshNotice.type}
          title={refreshNotice.title}
          className="calendar-api-alert"
          onClose={() => setRefreshNotice(undefined)}
        />
      ) : null}

      {loading ? (
        view === 'week' ? <CalendarAgendaLoading /> : <CalendarMonthLoading />
      ) : view === 'week' ? (
        <CalendarAgendaTable events={selectedDayEvents} onOpenEvent={setDrawerEvent} />
      ) : (
        <CalendarMonthGrid
          month={monthAnchor}
          days={monthDays}
          eventsByDate={monthEventsByDate}
          onOpenEvent={setDrawerEvent}
        />
      )}

      <CalendarEventDrawer event={drawerEvent} onClose={() => setDrawerEvent(undefined)} />
    </div>
  );
};

export default CalendarPanel;
