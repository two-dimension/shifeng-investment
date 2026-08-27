import { useState, useEffect, useCallback, useRef } from 'react';
import { message } from 'antd';
import { API_BASE } from '../config/api';

export interface NewsItem {
  category: string;
  sourceCategory?: string;
  collectionChannel?: string;
  sourceId?: string;
  investmentCategory?: string;
  signalType?: string;
  title: string;
  source: string;
  time?: string;
  url?: string;
  snippet?: string;
  language?: string;
  score?: number;
  followers?: number;
  engagement?: number;
  engagementRate?: number | null;
  normalizedEngagementScore?: number;
  priceProduct?: string;
  priceLatestValue?: string;
  priceMoveValue?: string;
  priceDisplayUnit?: string;
  priceGroup?: string;
  priceStale?: boolean;
  priceChartUrl?: string;
  priceSourceUpdatedAt?: string;
  priceRefreshPending?: boolean;
  priceRefreshFailed?: boolean;
  priceLoginRequired?: boolean;
  priceRefreshMessage?: string;
  metrics?: {
    likes?: number;
    retweets?: number;
    replies?: number;
  };
}

export interface NewsEntry {
  id: string;
  type: string;
  news: NewsItem[];
  createdAt: string;
}

interface NewsArchive {
  entries?: NewsEntry[];
  lastUpdated?: string;
  lastCheckedAt?: string;
  refreshStatus?: {
    updating?: boolean;
    lastStartedAt?: string | null;
    lastFinishedAt?: string | null;
    added?: number;
    fetched?: number;
    skipped?: number;
    since?: string;
    error?: string | null;
    price?: {
      updating?: boolean;
      generatedAt?: string | null;
      collectorStatus?: {
        failedSources?: string[];
      } | null;
    };
  };
}

interface UseNewsFeedReturn {
  news: NewsItem[];
  lastUpdated: string | null;
  loading: boolean;
  apiStatus: 'checking' | 'online' | 'offline';
  error: string | null;
  isMockData: boolean;
  refresh: () => Promise<void>;
}

const MOCK_NEWS: NewsItem[] = [
  {
    category: '公司官方',
    sourceCategory: 'official',
    investmentCategory: '软件',
    title: 'OpenAI Blog / Anthropic News 等官方信源将在刷新后显示最新条目',
    source: 'news-intelligence',
    snippet: '离线样例：真实刷新会按 skill 的官方、媒体、学术、开发者社区信源抓取。',
  },
  {
    category: '行业媒体',
    sourceCategory: 'media',
    investmentCategory: '宏观',
    title: 'The Verge AI、TechCrunch AI、CoinDesk 等媒体信源将在刷新后进入列表',
    source: 'news-intelligence',
    snippet: '离线样例：后端不可用时显示，避免旧分类误导。',
  },
  {
    category: '学术平台',
    sourceCategory: 'academic',
    investmentCategory: '软件',
    title: 'arXiv / Hugging Face Daily Papers 等学术来源将在刷新后显示',
    source: 'news-intelligence',
    snippet: '离线样例：真实内容来自 skill 配置的 RSS/API 信源。',
  },
  {
    category: '微信公众号',
    sourceCategory: 'wechat',
    collectionChannel: 'wechat',
    investmentCategory: '软件',
    title: '机器之心、新智元等公众号内容将在登录可用后进入列表',
    source: 'news-intelligence',
    snippet: '离线样例：新版 skill 已支持微信公众号链路。',
  },
  {
    category: '开发者社区',
    sourceCategory: 'developer',
    investmentCategory: '软件',
    title: 'Hacker News AI 热帖将在刷新后按热度进入候选',
    source: 'news-intelligence',
    snippet: '离线样例：刷新会调用 Hacker News API。',
  },
];

const POLL_INTERVAL = 60000;
const MAX_CONSECUTIVE_FAILURES = 3;
const HISTORY_ITEM_LIMIT = 1000;
const NEWS_FETCH_LIMIT = 600;
const NEWS_FETCH_MIN_SCORE = 0;
const REFRESH_POLL_INTERVAL_MS = 4000;
const REFRESH_SETTLE_TIMEOUT_MS = 20 * 60 * 1000;

const parseNewsTime = (value?: string) => {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
};

const parseNewsTimeWithArchiveBase = (value?: string, archiveCreatedAt?: string) => {
  const raw = (value || '').trim();
  const direct = parseNewsTime(raw);
  if (direct) return direct;

  const archiveTime = parseNewsTime(archiveCreatedAt);
  if (!archiveTime) return null;

  const base = new Date(archiveTime);
  const hourMinute = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (hourMinute) {
    const date = new Date(base);
    date.setHours(Number(hourMinute[1]), Number(hourMinute[2]), 0, 0);
    return date.getTime();
  }

  const minutesAgo = raw.match(/(\d+)\s*分钟/);
  if (minutesAgo) return archiveTime - Number(minutesAgo[1]) * 60 * 1000;

  const hoursAgo = raw.match(/(\d+)\s*小时/);
  if (hoursAgo) return archiveTime - Number(hoursAgo[1]) * 60 * 60 * 1000;

  return null;
};

const getNewsSortTime = (item: NewsItem, entry: NewsEntry) => {
  return parseNewsTimeWithArchiveBase(item.time, entry.createdAt) || parseNewsTime(entry.createdAt) || Date.now();
};

const getNewsKey = (item: NewsItem) => {
  if (item.collectionChannel === 'price-watch' || item.sourceId === 'tungsten-price-watch') {
    const text = `${item.title || ''} ${item.snippet || ''}`;
    const productKey = /钨粉/.test(text)
      ? 'tungsten-powder'
      : /废钨棒材/.test(text)
      ? 'waste-tungsten-bar'
      : /黑钨精矿.*65|黑钨精矿[≥≧]\s*65/.test(text)
        ? 'wolframite-65'
        : /DDR|DRAM|NAND|MLC|SLC/i.test(text)
          ? `${item.sourceId || item.source || 'memory'}:${item.priceProduct || item.title}`.toLowerCase().replace(/\s+/g, '')
          : item.title.toLowerCase().replace(/\s+/g, '');
    return `price-watch:${item.sourceId || item.source || 'price'}:${String(item.time || '').slice(0, 10)}:${productKey}`;
  }
  const urlKey = item.url?.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/$/, '');
  if (urlKey) return `url:${urlKey}`;
  return `title:${item.title.toLowerCase().replace(/\s+/g, '').replace(/[^\w\u4e00-\u9fff]/g, '')}`;
};

const flattenNewsPayload = (payload: NewsEntry | NewsArchive | null) => {
  if (!payload) return { news: [] as NewsItem[], lastUpdated: new Date().toISOString() };

  const entries = Array.isArray((payload as NewsArchive).entries)
    ? (payload as NewsArchive).entries || []
    : Array.isArray((payload as NewsEntry).news)
      ? [payload as NewsEntry]
      : [];

  const flattenedByKey = new Map<string, NewsItem & { __sortTime: number }>();

  entries.forEach((entry) => {
    (entry.news || []).forEach((item) => {
      if (!item?.title) return;
      const sortTime = getNewsSortTime(item, entry);
      const key = getNewsKey(item);
      const candidate = {
        ...item,
        time: new Date(sortTime).toISOString(),
        __sortTime: sortTime,
      };
      const existing = flattenedByKey.get(key);
      if (!existing || sortTime > existing.__sortTime) {
        flattenedByKey.set(key, candidate);
      } else if (sortTime === existing.__sortTime && (item.score || 0) > (existing.score || 0)) {
        flattenedByKey.set(key, candidate);
      }
    });
  });

  const flattened = Array.from(flattenedByKey.values());
  flattened.sort((a, b) => b.__sortTime - a.__sortTime);

  return {
    news: flattened.slice(0, HISTORY_ITEM_LIMIT).map(({ __sortTime, ...item }) => item),
    lastUpdated: (payload as NewsArchive).lastCheckedAt || (payload as NewsArchive).lastUpdated || entries[0]?.createdAt || new Date().toISOString(),
  };
};

export function useNewsFeed(): UseNewsFeedReturn {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiStatus, setApiStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [error, setError] = useState<string | null>(null);
  const [isMockData, setIsMockData] = useState(false);

  const consecutiveFailures = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const followUpTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const checkApiStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/health?t=${Date.now()}`, { cache: 'no-store' });
      if (response.ok) {
        setApiStatus('online');
        consecutiveFailures.current = 0;
        return true;
      }
      setApiStatus('offline');
      return false;
    } catch {
      setApiStatus('offline');
      return false;
    }
  }, []);

  const applyNewsPayload = useCallback((payload: NewsEntry | NewsArchive | null, showOfflineAlert = false) => {
    const flattened = flattenNewsPayload(payload);
    if (flattened.news.length > 0) {
      setNews(flattened.news);
      setLastUpdated(flattened.lastUpdated);
      setIsMockData(false);
      setApiStatus('online');
      consecutiveFailures.current = 0;
      return;
    }

    setNews(MOCK_NEWS);
    setLastUpdated(new Date().toISOString());
    setIsMockData(true);
    if (showOfflineAlert) {
      message.warning('当前无可用新闻，已切换到本地离线数据');
    }
  }, []);

  const clearFollowUpTimers = useCallback(() => {
    followUpTimersRef.current.forEach((timer) => clearTimeout(timer));
    followUpTimersRef.current = [];
  }, []);

  const scheduleFollowUpFetch = useCallback((fetcher: () => Promise<NewsArchive | null>) => {
    clearFollowUpTimers();
    [5000, 15000, 30000, 60000].forEach((delay) => {
      const timer = window.setTimeout(() => {
        fetcher();
      }, delay);
      followUpTimersRef.current.push(timer);
    });
  }, [clearFollowUpTimers]);

  const fetchNews = useCallback(async (showOfflineAlert = false, silent = false): Promise<NewsArchive | null> => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/news?limit=${NEWS_FETCH_LIMIT}&minScore=${NEWS_FETCH_MIN_SCORE}&t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: NewsArchive = await response.json();
      applyNewsPayload(data, showOfflineAlert);
      return data;
    } catch (err) {
      consecutiveFailures.current += 1;
      const msg = err instanceof Error ? err.message : '获取新闻失败';

      // 连续失败后使用 mock 数据
      if (consecutiveFailures.current >= MAX_CONSECUTIVE_FAILURES) {
        setNews(MOCK_NEWS);
        setLastUpdated(new Date().toISOString());
        setIsMockData(true);
        setApiStatus('offline');
        if (showOfflineAlert) {
          message.warning('后端服务不可用，显示离线数据');
        }
      }
      setError(msg);
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, [applyNewsPayload]);

  const waitForRefreshToSettle = useCallback(async () => {
    const startedAt = Date.now();
    let latestPayload: NewsArchive | null = null;

    while (Date.now() - startedAt < REFRESH_SETTLE_TIMEOUT_MS) {
      latestPayload = await fetchNews(false, true);
      if (!latestPayload?.refreshStatus?.updating) {
        return latestPayload;
      }
      await new Promise((resolve) => window.setTimeout(resolve, REFRESH_POLL_INTERVAL_MS));
    }

    return latestPayload;
  }, [fetchNews]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/news/refresh?t=${Date.now()}`, { method: 'POST', cache: 'no-store' });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (payload?.success) {
        setLoading(false);
        message.info(payload.started
          ? '已开始刷新新闻与价格，页面会随本地缓存更新'
          : '新闻与价格刷新正在进行，页面会自动更新');
        waitForRefreshToSettle().then((latestPayload) => {
          const added = latestPayload?.refreshStatus?.added;
          const failedPriceSources = latestPayload?.refreshStatus?.price?.collectorStatus?.failedSources || [];
          if (latestPayload?.refreshStatus?.error) {
            message.warning(`刷新完成，但部分信源失败：${latestPayload.refreshStatus.error}`);
          } else if (failedPriceSources.length > 0) {
            message.warning(`新闻已更新；价格源暂未更新：${failedPriceSources.join('、')}`);
          } else {
            message.success(`新闻与价格已更新${typeof added === 'number' ? `，新增 ${added} 条新闻` : ''}`);
          }
        });
        return;
      }

      throw new Error(payload?.error || '刷新接口返回异常');
    } catch (err) {
      console.error('Refresh error:', err);
      const msg = err instanceof Error ? err.message : '刷新新闻失败';
      setError(msg);
      message.error(msg);
      setApiStatus('offline');
    }
    await fetchNews(true);
  }, [fetchNews, waitForRefreshToSettle]);

  // 初始加载 + 轮询
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      if (!mounted) return;
      const online = await checkApiStatus();
      if (!mounted) return;
      if (online) {
        const payload = await fetchNews(false);
        if (payload?.refreshStatus?.updating) {
          scheduleFollowUpFetch(() => fetchNews(false, true));
        }
      } else {
        setNews(MOCK_NEWS);
        setLastUpdated(new Date().toISOString());
        setIsMockData(true);
      }
    };

    init();

    intervalRef.current = setInterval(async () => {
      if (!mounted) return;
      const online = await checkApiStatus();
      if (!mounted) return;
      if (online) {
        const payload = await fetchNews(false, true);
        if (payload?.refreshStatus?.updating) {
          scheduleFollowUpFetch(() => fetchNews(false, true));
        }
      } else {
        consecutiveFailures.current += 1;
        if (consecutiveFailures.current >= MAX_CONSECUTIVE_FAILURES) {
          if (news.length === 0) {
            setNews(MOCK_NEWS);
            setLastUpdated(new Date().toISOString());
            setIsMockData(true);
          }
        }
      }
    }, POLL_INTERVAL);

    return () => {
      mounted = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
      clearFollowUpTimers();
    };
  }, [checkApiStatus, fetchNews, news.length, scheduleFollowUpFetch, clearFollowUpTimers]);

  return {
    news,
    lastUpdated,
    loading,
    apiStatus,
    error,
    isMockData,
    refresh,
  };
}
