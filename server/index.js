import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import tmtMarginRouter from './api/tmt_margin.js';
import researchRouter from './api/research.js';
import calendarRouter from './api/calendar.js';
import etfMonitorRouter from './api/etf_monitor.js';
import { syncResearch } from './lib/researchSync.js';
import { markSyncResultCompletions } from './lib/researchCompletion.js';
import { fetchBlsCpiNews, fetchNewsIntelligence } from './lib/newsIntelligence.js';
import {
  isExactMissingOptionalModuleError,
  validateQuantStrategyExports,
} from './lib/validateQuantStrategy.js';

const quantStrategyModuleUrl = new URL('./lib/quantStrategy.js', import.meta.url).href;
let quantStrategy;
try {
  quantStrategy = await import('./lib/quantStrategy.js');
} catch (error) {
  if (!isExactMissingOptionalModuleError(error, quantStrategyModuleUrl)) throw error;
  const unavailable = () => {
    throw new Error('Quant strategy module is unavailable in this checkout');
  };
  quantStrategy = {
    getQuantExperiments: unavailable,
    getQuantOverview: unavailable,
    runQuantBacktest: unavailable,
    runQuantHistoryBackfill: unavailable,
    runQuantIteration: unavailable,
  };
  console.warn('[quant] server/lib/quantStrategy.js is missing; quant endpoints are unavailable');
}
validateQuantStrategyExports(quantStrategy);
const {
  getQuantExperiments,
  getQuantOverview,
  runQuantBacktest,
  runQuantHistoryBackfill,
  runQuantIteration,
} = quantStrategy;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const NEWS_FILE = path.join(__dirname, 'data', 'news.json');
const TUNGSTEN_HISTORY_FILE = path.join(__dirname, 'data', 'tungsten-price-history.json');
const FUNDS_FILE = path.join(__dirname, 'data', 'funds.json');
const BUILD_META_FILE = path.join(__dirname, '../dist/build-meta.json');
const MACD_SCRIPT = path.join(__dirname, '../macd screener/macd_screener.py');
const CTIA_TUNGSTEN_IMAGE_SCRIPT = process.env.CTIA_TUNGSTEN_IMAGE_SCRIPT
  || path.join(process.env.HOME || '', 'Documents', '新闻资讯', 'scripts', 'extract_ctia_tungsten_prices.py');
const DRAM_SPOT_ROOT = process.env.DRAM_SPOT_ROOT || path.join(process.env.HOME || '', 'Documents', 'DRAM_Spot_Price_Tracking');
const NAND_SPOT_ROOT = process.env.NAND_SPOT_ROOT || path.join(process.env.HOME || '', 'Documents', 'NAND_Spot_Price_Tracking');
const NAND_PRODUCT_CHART_SCRIPT = path.join(__dirname, 'scripts', 'render_nand_product_chart.py');
const R32_PRICE_URL = 'https://www.sci99.com/monitor-1572-0.html';
const R32_PRICE_API = 'https://www.sci99.com/priceMonitor/listProductPagePrice?oldId=1572&type=0';
const HAFNIUM_PRICE_URL = 'https://strategicmetalsinvest.com/hafnium-prices/';
const Q5500_PRICE_URL = 'https://www.cctd.com.cn/index.php?m=content&c=index&a=lists&catid=747&data=%BB%B7%B2%B3%BA%A3%B2%CE%BF%BC%BC%DB&tagle=13176&datatype=Z0194&name=%BB%B7%B2%B3%BA%A3%B2%CE%BF%BC%BC%DB';
const Q5500_PRICE_API = 'https://www.cctd.com.cn/Echarts/data/HBHCKJ.php';
const MACD_CACHE_TTL_MS = 5 * 60 * 1000;
const MACD_CACHE_FILE = path.join(__dirname, 'data', 'macd_cache.json');
const NEWS_RESPONSE_DEFAULT_LIMIT = 240;
const NEWS_RESPONSE_MAX_LIMIT = 1000;
const NEWS_AUTO_REFRESH_INTERVAL_MS = Math.max(5 * 60 * 1000, Number(process.env.NEWS_AUTO_REFRESH_INTERVAL_MS || 30 * 60 * 1000));
const NEWS_AUTO_REFRESH_STALE_MS = Math.max(5 * 60 * 1000, Number(process.env.NEWS_AUTO_REFRESH_STALE_MS || 30 * 60 * 1000));
let macdCache = null;
let macdInFlight = null;
let researchSyncInFlight = false;
let lastAutoSyncDate = '';

function loadPersistedMacdCache() {
  try {
    if (!fs.existsSync(MACD_CACHE_FILE)) {
      return null;
    }
    const raw = fs.readFileSync(MACD_CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.data)) {
      return null;
    }
    return {
      data: parsed.data,
      generatedAt: parsed.generatedAt || new Date().toISOString(),
      generatedAtMs: parsed.generatedAtMs || Date.now(),
    };
  } catch (error) {
    console.error('Load macd cache failed:', error);
    return null;
  }
}

function persistMacdCache(cache) {
  try {
    fs.writeFileSync(MACD_CACHE_FILE, JSON.stringify(cache), 'utf-8');
  } catch (error) {
    console.error('Persist macd cache failed:', error);
  }
}

macdCache = loadPersistedMacdCache();

const decodeXmlEntities = (value = '') => String(value)
  .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");

const stripHtml = (value = '') => decodeXmlEntities(value)
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

async function fetchTextWithTimeout(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timeout);
  }
}

const parseRssItems = (xml, sourceName) => {
  const items = [];
  const itemMatches = String(xml || '').match(/<item[\s\S]*?<\/item>/g) || [];
  for (const raw of itemMatches.slice(0, 12)) {
    const title = stripHtml(raw.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
    const link = decodeXmlEntities(raw.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim();
    const description = stripHtml(raw.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '');
    const pubDate = stripHtml(raw.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '');
    if (title && link) {
      items.push({ title, url: link, source: sourceName, summary: description, publishedAt: pubDate });
    }
  }
  return items;
};

const getPriceMoveDirection = (change, text = '') => {
  const numeric = Number(String(change || '').replace(/,/g, ''));
  if (Number.isFinite(numeric) && numeric < 0) return '下跌';
  if (Number.isFinite(numeric) && numeric > 0) return '上涨';
  if (/下跌|下降|降价|跌价|回落|偏弱|承压|下调/i.test(text)) return '下跌';
  if (/上涨|上调|涨价|提价|反弹|上移|偏强/i.test(text)) return '上涨';
  return '持平';
};

const parseChinaDateToIso = (value, fallbackHour = 12) => {
  const raw = String(value || '').trim();
  const isoDate = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoDate) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}T${String(fallbackHour).padStart(2, '0')}:00:00+08:00`;
  const zhDate = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (zhDate) {
    const month = String(zhDate[2]).padStart(2, '0');
    const day = String(zhDate[3]).padStart(2, '0');
    return `${zhDate[1]}-${month}-${day}T${String(fallbackHour).padStart(2, '0')}:00:00+08:00`;
  }
  return new Date().toISOString();
};

const TUNGSTEN_HISTORY_PRODUCTS = {
  'wolframite-65': { label: '黑钨精矿≧65%', unit: '元/吨' },
  'waste-tungsten-bar': { label: '废钨棒材', unit: '元/千克' },
  'tungsten-powder': { label: '钨粉', unit: '元/千克' },
  r32: { label: 'R32', unit: '元/吨' },
  hafnium: { label: '金属铪', unit: '美元/千克' },
  q5500: { label: 'Q5500动力煤', unit: '元/吨' },
};

const getChinaDateKey = (value) => {
  const raw = String(value || '');
  const direct = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(parsed);
};

const previousCalendarDate = (date) => {
  const parsed = new Date(`${date}T12:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return '';
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return getChinaDateKey(parsed.toISOString());
};

const createEmptyTungstenHistory = () => ({
  version: 1,
  updatedAt: null,
  series: {
    'wolframite-65': [],
    'waste-tungsten-bar': [],
    'tungsten-powder': [],
    r32: [],
    hafnium: [],
    q5500: [],
  },
});

const addTungstenHistoryPoint = (history, productKey, point) => {
  const value = Number(point?.value);
  const date = getChinaDateKey(point?.date);
  if (!TUNGSTEN_HISTORY_PRODUCTS[productKey] || !date || !Number.isFinite(value)) return false;
  history.series = history.series || {};
  const series = Array.isArray(history.series[productKey]) ? history.series[productKey] : [];
  const normalized = {
    date,
    value,
    source: point.source || '',
    url: point.url || '',
  };
  const existingIndex = series.findIndex((item) => item.date === date);
  if (existingIndex >= 0) {
    const existing = series[existingIndex];
    if (existing.value === normalized.value && existing.source === normalized.source && existing.url === normalized.url) return false;
    series[existingIndex] = normalized;
  } else {
    series.push(normalized);
  }
  history.series[productKey] = series
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-500);
  return true;
};

const seedTungstenHistoryFromNews = (history) => {
  let changed = false;
  const hafniumStart = new Date('2026-06-10T12:00:00+08:00');
  const hafniumEnd = new Date('2026-07-10T12:00:00+08:00');
  for (const cursor = new Date(hafniumStart); cursor <= hafniumEnd; cursor.setDate(cursor.getDate() + 1)) {
    const point = { date: getChinaDateKey(cursor), value: 12508.2 };
    changed = addTungstenHistoryPoint(history, 'hafnium', {
      ...point,
      source: 'Strategic Metals Invest',
      url: HAFNIUM_PRICE_URL,
    }) || changed;
  }
  if (!fs.existsSync(NEWS_FILE)) return changed;
  try {
    const archive = JSON.parse(fs.readFileSync(NEWS_FILE, 'utf8'));
    (archive.entries || []).forEach((entry) => {
      (entry.news || []).forEach((item) => {
        if (item.sourceId !== 'tungsten-price-watch') return;
        const text = `${item.title || ''} ${item.snippet || ''}`;
        const date = getChinaDateKey(item.priceSourceUpdatedAt || item.time || entry.createdAt);
        if (/黑钨精矿/.test(text)) {
          const value = Number(String(item.priceLatestValue || text.match(/均价\s*([0-9,]+)/)?.[1] || '').replace(/,/g, ''));
          changed = addTungstenHistoryPoint(history, 'wolframite-65', {
            date,
            value,
            source: item.source,
            url: item.url,
          }) || changed;
          const move = Number(String(item.priceMoveValue || text.match(/涨跌\s*([+-]?[0-9,]+)/)?.[1] || '0').replace(/,/g, ''));
          if (Number.isFinite(value) && Number.isFinite(move) && move !== 0) {
            changed = addTungstenHistoryPoint(history, 'wolframite-65', {
              date: previousCalendarDate(date),
              value: value - move,
              source: '根据SMM日涨跌反推',
              url: item.url,
            }) || changed;
          }
        }
        if (/废钨棒材/.test(text)) {
          const value = Number(String(item.priceLatestValue || text.match(/价格\s*([0-9,.]+)/)?.[1] || '').replace(/,/g, ''));
          changed = addTungstenHistoryPoint(history, 'waste-tungsten-bar', {
            date,
            value,
            source: item.source,
            url: item.url,
          }) || changed;
        }
      });
    });
  } catch (error) {
    console.warn('[tungsten-price-history] archive seed failed:', error.message);
  }
  return changed;
};

const writeTungstenPriceHistory = (history) => {
  history.updatedAt = new Date().toISOString();
  const tempFile = `${TUNGSTEN_HISTORY_FILE}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  fs.renameSync(tempFile, TUNGSTEN_HISTORY_FILE);
};

const readTungstenPriceHistory = () => {
  let history = createEmptyTungstenHistory();
  if (fs.existsSync(TUNGSTEN_HISTORY_FILE)) {
    try {
      history = { ...history, ...JSON.parse(fs.readFileSync(TUNGSTEN_HISTORY_FILE, 'utf8')) };
      history.series = { ...createEmptyTungstenHistory().series, ...(history.series || {}) };
    } catch (error) {
      console.warn('[tungsten-price-history] cache read failed:', error.message);
    }
  }
  if (seedTungstenHistoryFromNews(history) || !fs.existsSync(TUNGSTEN_HISTORY_FILE)) {
    writeTungstenPriceHistory(history);
  }
  return history;
};

const recordTungstenPricePoint = (productKey, point, inferredPrevious = null) => {
  const history = readTungstenPriceHistory();
  let changed = false;
  if (inferredPrevious) changed = addTungstenHistoryPoint(history, productKey, inferredPrevious) || changed;
  changed = addTungstenHistoryPoint(history, productKey, point) || changed;
  if (changed) writeTungstenPriceHistory(history);
};

const escapeSvgText = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const renderTungstenPriceChart = (productKey) => {
  const meta = TUNGSTEN_HISTORY_PRODUCTS[productKey];
  if (!meta) return '';
  const history = readTungstenPriceHistory();
  const series = (history.series?.[productKey] || [])
    .filter((point) => point?.date && Number.isFinite(Number(point.value)))
    .slice(-120);
  if (!series.length) return '';

  const width = 720;
  const height = 360;
  const margin = { top: 60, right: 34, bottom: 56, left: 86 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = series.map((point) => Number(point.value));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * 0.15, Math.abs(rawMax || 1) * 0.02, 1);
  const minValue = rawMin - padding;
  const maxValue = rawMax + padding;
  const xFor = (index) => series.length === 1
    ? margin.left + plotWidth / 2
    : margin.left + (index / (series.length - 1)) * plotWidth;
  const yFor = (value) => margin.top + ((maxValue - value) / (maxValue - minValue)) * plotHeight;
  const numberFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  const points = series.map((point, index) => `${xFor(index).toFixed(1)},${yFor(Number(point.value)).toFixed(1)}`).join(' ');
  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const value = maxValue - ratio * (maxValue - minValue);
    const y = margin.top + ratio * plotHeight;
    return `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/><text x="${margin.left - 12}" y="${y + 4}" text-anchor="end" font-size="12" fill="#6b7280">${numberFormatter.format(value)}</text>`;
  }).join('');
  const labelIndexes = Array.from(new Set([0, Math.floor((series.length - 1) / 2), series.length - 1]));
  const xLabels = labelIndexes.map((index) => `<text x="${xFor(index)}" y="${height - 24}" text-anchor="middle" font-size="12" fill="#6b7280">${escapeSvgText(series[index].date.slice(5))}</text>`).join('');
  const circles = series.map((point, index) => `<circle cx="${xFor(index)}" cy="${yFor(Number(point.value))}" r="4" fill="#b45309"><title>${escapeSvgText(point.date)}  ${numberFormatter.format(point.value)} ${escapeSvgText(meta.unit)}</title></circle>`).join('');
  const latest = series.at(-1);
  const subtitle = series.length === 1 ? '已开始本地累计，后续刷新自动追加' : `共 ${series.length} 个本地历史点`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" rx="12" fill="#ffffff"/>
  <text x="${margin.left}" y="30" font-size="20" font-weight="700" fill="#111827">${escapeSvgText(meta.label)}历史价格</text>
  <text x="${margin.left}" y="49" font-size="12" fill="#6b7280">${escapeSvgText(subtitle)} · 最新 ${numberFormatter.format(latest.value)} ${escapeSvgText(meta.unit)}</text>
  ${yTicks}
  <line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${width - margin.right}" y2="${margin.top + plotHeight}" stroke="#9ca3af"/>
  <polyline points="${points}" fill="none" stroke="#b45309" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
  ${circles}
  ${xLabels}
  <text x="18" y="${margin.top + plotHeight / 2}" transform="rotate(-90 18 ${margin.top + plotHeight / 2})" text-anchor="middle" font-size="12" fill="#6b7280">${escapeSvgText(meta.unit)}</text>
</svg>`;
};

const fetchSmmTrackedTungstenPrices = async () => {
  const url = 'https://hq.smm.cn/h5/tungsten-ore-price';
  try {
    const productId = '201308090016';
    const endDate = getChinaDateKey(new Date());
    const beginDateValue = new Date(`${endDate}T12:00:00+08:00`);
    beginDateValue.setDate(beginDateValue.getDate() - 35);
    const beginDate = getChinaDateKey(beginDateValue);
    const latestApi = `https://platform.smm.cn/aggdatacenter/user/v1/agg_data/latest_price?product_ids=${productId}`;
    const historyApi = `https://platform.smm.cn/aggdatacenter/user/v1/agg_data/history_price?product_ids=${productId}&begin_date=${beginDate}&end_date=${endDate}`;
    const fetchSmmPayload = async (apiUrl) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(apiUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            Referer: 'https://hq.smm.cn/',
            Origin: 'https://hq.smm.cn',
          },
        });
        if (!response.ok) throw new Error(`SMM API HTTP ${response.status}`);
        return response.json();
      } finally {
        clearTimeout(timer);
      }
    };
    const [latestPayload, historyPayload] = await Promise.all([
      fetchSmmPayload(latestApi),
      fetchSmmPayload(historyApi),
    ]);
    const latest = latestPayload?.data?.[0];
    const historyPoints = historyPayload?.data?.[0]?.price_detail || [];
    const rawHistoryLatest = Number(historyPoints.at(-1)?.average);
    const latestValue = Number(latest?.average);
    if (!latest?.renew_date || !Number.isFinite(latestValue) || !Number.isFinite(rawHistoryLatest)) {
      throw new Error('SMM structured price payload incomplete');
    }
    const scale = rawHistoryLatest / latestValue;
    historyPoints.forEach((point) => {
      const rawValue = Number(point?.average);
      if (!point?.renew_date || !Number.isFinite(rawValue)) return;
      recordTungstenPricePoint('wolframite-65', {
        date: point.renew_date,
        value: Math.round((rawValue / scale) * 2) / 2,
        source: '上海有色网SMM',
        url,
      });
    });
    const change = Number(latest.vchange) || 0;
    return [{
      title: `SMM黑钨精矿≥65%价格${change > 0 ? '上涨' : change < 0 ? '下跌' : '持平'}`,
      url,
      source: '上海有色网SMM',
      summary: `黑钨精矿≥65%均价${latestValue}元/标吨，涨跌${change}元/标吨；价格范围${latest.low}-${latest.high}元/标吨，日期${latest.renew_date}。`,
      publishedAt: parseChinaDateToIso(latest.renew_date, 10),
      query: 'SMM tungsten tracked daily price',
      sourceId: 'tungsten-price-watch',
      collectionChannel: 'price-watch',
      priceProduct: '黑钨精矿≧65%',
      priceLatestValue: String(latestValue),
      priceMoveValue: String(change),
      priceDisplayUnit: '元/吨',
      priceChartUrl: '/api/news/price-chart?kind=tungsten&product=wolframite-65',
      priceSourceUpdatedAt: latest.renew_date,
    }];
  } catch (error) {
    console.warn('[tungsten-price-watch] SMM structured API failed, using page fallback:', error.message);
  }
  const html = await fetchTextWithTimeout(url, 20000);
  const text = stripHtml(html).replace(/\s+/g, ' ');
  try {
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      const nextData = JSON.parse(nextDataMatch[1]);
      const chartBlock = nextData?.props?.pageProps?.datas?.WOREP02?.data?.[0]?.data
        ?.find((item) => String(item?.product_id) === '201308090016');
      const historyPoints = Array.isArray(chartBlock?.price_detail) ? chartBlock.price_detail : [];
      const latestEmbedded = Number(historyPoints.at(-1)?.average);
      const currentRowHtml = html.match(/<tr data-row-key="201308090016"[\s\S]*?<\/tr>/)?.[0] || '';
      const rowValues = [...currentRowHtml.matchAll(/<span class="(?:green|red)">([^<]+)<\/span>/g)]
        .map((match) => Number(String(match[1]).replace(/,/g, '').trim()))
        .filter(Number.isFinite);
      const latestVisible = rowValues[1];
      const scale = Number.isFinite(latestVisible) && latestVisible !== 0 && Number.isFinite(latestEmbedded)
        ? latestEmbedded / latestVisible
        : 1;
      historyPoints.forEach((point) => {
        const embedded = Number(point?.average);
        if (!point?.renew_date || !Number.isFinite(embedded)) return;
        const normalized = Math.round((embedded / scale) * 2) / 2;
        recordTungstenPricePoint('wolframite-65', {
          date: point.renew_date,
          value: normalized,
          source: '上海有色网SMM',
          url,
        });
      });
    }
  } catch (error) {
    console.warn('[tungsten-price-history] SMM history backfill failed:', error.message);
  }
  const trackedRows = [
    {
      displayName: '黑钨精矿≧65%',
      pattern: /黑钨精矿[≥≧]\s*65%价格\s*([0-9,]+)\s*-\s*([0-9,]+)\s+([0-9,]+)\s*([+-]?\d+(?:\.\d+)?)\s*(元\/标吨)\s*(\d{4}-\d{2}-\d{2})/i,
    },
  ];

  return trackedRows.flatMap(({ displayName, pattern }) => {
    const match = text.match(pattern);
    if (!match) return [];

    const [, low, high, avg, changeRaw, unit, date] = match;
    const change = Number(String(changeRaw).replace(/,/g, ''));
    const latestValue = Number(String(avg).replace(/,/g, ''));
    const direction = getPriceMoveDirection(changeRaw);
    const absChange = Number.isFinite(change) ? Math.abs(change) : changeRaw;
    const changeText = direction === '持平' ? '持平' : `${direction}${absChange}${unit}`;

    recordTungstenPricePoint('wolframite-65', {
      date,
      value: latestValue,
      source: '上海有色网SMM',
      url,
    }, Number.isFinite(change) && change !== 0 ? {
      date: previousCalendarDate(date),
      value: latestValue - change,
      source: '根据SMM日涨跌反推',
      url,
    } : null);

    return [{
      title: `SMM${displayName}价格${changeText}`,
      url,
      source: '上海有色网SMM',
      summary: `${displayName}均价${avg}${unit}，涨跌${changeRaw}；价格范围${low}-${high}${unit}，日期${date}。`,
      publishedAt: parseChinaDateToIso(date, 10),
      query: 'SMM tungsten tracked daily price',
      priceProduct: displayName,
      priceLatestValue: String(latestValue),
      priceMoveValue: String(Number.isFinite(change) ? change : 0),
      priceDisplayUnit: '元/吨',
      priceChartUrl: '/api/news/price-chart?kind=tungsten&product=wolframite-65',
      priceSourceUpdatedAt: date,
    }];
  });
};

const extractCtiaArticleLinks = (html) => {
  const links = [];
  const seen = new Set();
  const anchorMatches = [...String(html || '').matchAll(/<a[^>]+href=["']([^"']*\/news\/\d+\.html)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  anchorMatches.forEach((match) => {
    const href = match[1].startsWith('http') ? match[1] : new URL(match[1], 'https://www.ctia.com.cn/').href;
    const title = stripHtml(match[2]);
    if (!title || !title.includes('钨') || seen.has(href)) return;
    seen.add(href);
    links.push({ href, title });
  });
  return links.slice(0, 8);
};

const runCtiaTungstenImageExtraction = async () => {
  if (!fs.existsSync(CTIA_TUNGSTEN_IMAGE_SCRIPT)) return null;

  return new Promise((resolve) => {
    const proc = spawn('python3', [CTIA_TUNGSTEN_IMAGE_SCRIPT], {
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 45000);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        if (stderr.trim()) console.warn('[tungsten-price-watch] CTIA image OCR failed:', stderr.trim());
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        console.warn('[tungsten-price-watch] CTIA image OCR parse failed:', error.message);
        resolve(null);
      }
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      console.warn('[tungsten-price-watch] CTIA image OCR process failed:', error.message);
      resolve(null);
    });
  });
};

const buildCtiaWasteBarSignal = (extracted) => {
  if (!extracted?.price) return null;
  const change = Number(String(extracted.change || '0').replace(/,/g, ''));
  const direction = Number.isFinite(change) && change < 0
    ? `下跌${Math.abs(change)}${extracted.unit || '元/千克'}`
    : Number.isFinite(change) && change > 0
      ? `上涨${change}${extracted.unit || '元/千克'}`
      : '持平';
  const title = `中钨在线废钨棒材价格${direction}`;
  const publishedAt = extracted.publishedAt || new Date().toISOString();
  const date = getChinaDateKey(publishedAt);
  const latestValue = Number(String(extracted.price).replace(/,/g, ''));
  recordTungstenPricePoint('waste-tungsten-bar', {
    date,
    value: latestValue,
    source: '中钨在线',
    url: extracted.articleUrl,
  });
  const summary = [
    `废钨棒材价格${extracted.price}${extracted.unit || '元/千克'}，涨跌${Number.isFinite(change) ? change : extracted.change || '0'}。`,
    extracted.pretaxReference ? `不含税参考${extracted.pretaxReference}。` : '',
    extracted.articleTitle ? `来源文章：${extracted.articleTitle}` : '',
  ].filter(Boolean).join('');

  return {
    title,
    url: extracted.articleUrl,
    source: '中钨在线',
    summary,
    publishedAt,
    query: 'CTIA WeChat tungsten quote table image OCR',
    priceProduct: '废钨棒材',
    priceLatestValue: String(latestValue),
    priceMoveValue: String(Number.isFinite(change) ? change : 0),
    priceDisplayUnit: '元/千克',
    priceChartUrl: '/api/news/price-chart?kind=tungsten&product=waste-tungsten-bar',
    priceSourceUpdatedAt: date,
  };
};

const fetchCtiaTrackedTungstenPrices = async () => {
  try {
    const after = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    const apiUrl = `https://www.ctia.com.cn/wp-json/wp/v2/posts?categories=11&after=${encodeURIComponent(after)}&per_page=100&_fields=date,link,title,content`;
    const posts = JSON.parse(await fetchTextWithTimeout(apiUrl, 9000));
    const tracked = {
      'tungsten-powder': [],
      'waste-tungsten-bar': [],
    };
    for (const post of Array.isArray(posts) ? posts : []) {
      const html = String(post?.content?.rendered || '');
      if (!html.includes('钨市场行情')) continue;
      const date = getChinaDateKey(post?.date);
      const url = post?.link || 'https://www.ctia.com.cn/';
      const powderMatch = html.match(/钨粉价格(?:报|维持|探至|反弹至)?\s*([0-9,.]+)\s*元\/(?:公斤|千克)/);
      const wasteMatch = html.match(/废钨棒材价格(?:报|维持|探至|反弹至)?\s*([0-9,.]+)\s*元\/(?:公斤|千克)/);
      if (powderMatch) tracked['tungsten-powder'].push({ date, value: Number(powderMatch[1].replace(/,/g, '')), url });
      if (wasteMatch) tracked['waste-tungsten-bar'].push({ date, value: Number(wasteMatch[1].replace(/,/g, '')), url });
    }

    const buildSignal = (productKey, product, points) => {
      const valid = points
        .filter((point) => point.date && Number.isFinite(point.value))
        .sort((a, b) => a.date.localeCompare(b.date));
      valid.forEach((point) => recordTungstenPricePoint(productKey, {
        ...point,
        source: '中钨在线',
      }));
      const latest = valid.at(-1);
      if (!latest) return null;
      const previous = valid.at(-2);
      const move = previous ? latest.value - previous.value : 0;
      return {
        title: `${product}价格${move > 0 ? '上涨' : move < 0 ? '下跌' : '持平'}`,
        url: latest.url,
        source: '中钨在线',
        summary: `${product}最新价格${latest.value}元/千克，较上一更新日${move > 0 ? `上涨${move}` : move < 0 ? `下跌${Math.abs(move)}` : '持平'}。`,
        publishedAt: parseChinaDateToIso(latest.date, 15),
        query: `CTIA ${product} tracked daily price`,
        sourceId: 'tungsten-price-watch',
        collectionChannel: 'price-watch',
        priceProduct: product,
        priceLatestValue: String(latest.value),
        priceMoveValue: String(move),
        priceDisplayUnit: '元/千克',
        priceChartUrl: `/api/news/price-chart?kind=tungsten&product=${productKey}`,
        priceSourceUpdatedAt: latest.date,
      };
    };
    const signals = [
      buildSignal('tungsten-powder', '钨粉', tracked['tungsten-powder']),
      buildSignal('waste-tungsten-bar', '废钨棒材', tracked['waste-tungsten-bar']),
    ].filter(Boolean);
    if (signals.length) return signals;
  } catch (error) {
    console.warn('[tungsten-price-watch] CTIA API failed, using article fallback:', error.message);
  }

  const imageExtracted = await runCtiaTungstenImageExtraction();
  const imageSignal = buildCtiaWasteBarSignal(imageExtracted);
  if (imageSignal) return [imageSignal];

  const homeUrl = 'https://www.ctia.com.cn/';
  const homeHtml = await fetchTextWithTimeout(homeUrl, 7000);
  const candidates = extractCtiaArticleLinks(homeHtml);

  for (const candidate of candidates) {
    try {
      const articleHtml = await fetchTextWithTimeout(candidate.href, 7000);
      const text = stripHtml(articleHtml).replace(/\s+/g, ' ');
      if (!/废钨棒材/.test(text)) continue;

      const dateText = text.match(/发布日期：\s*(\d{4}年\d{1,2}月\d{1,2}日)/)?.[1]
        || text.match(/(\d{4}年\d{1,2}月\d{1,2}日)钨市场行情/)?.[1];
      const barMatch = text.match(/废钨棒材价格(?:报|维持|探至|反弹至)?\s*([0-9,.]+)\s*元\/(?:千克|公斤)([^。]*)。/);
      if (!barMatch) continue;

      const value = barMatch[1].replace(/,/g, '');
      const trendText = barMatch[2] || '';
      const direction = getPriceMoveDirection(0, `${trendText} ${candidate.title}`);
      const titleMove = direction === '持平' ? '持平' : `${direction}至${value}元/千克`;
      const publishedAt = parseChinaDateToIso(dateText, 12);
      const date = getChinaDateKey(publishedAt);
      recordTungstenPricePoint('waste-tungsten-bar', {
        date,
        value: Number(value),
        source: '中钨在线',
        url: candidate.href,
      });

      return [{
        title: `中钨在线废钨棒材价格${titleMove}`,
        url: candidate.href,
        source: '中钨在线',
        summary: `废钨棒材价格${value}元/千克${trendText ? `，${trendText.replace(/^，/, '')}` : ''}。来源文章：${candidate.title}`,
        publishedAt,
        query: 'CTIA waste tungsten bar tracked daily price',
        priceProduct: '废钨棒材',
        priceLatestValue: value,
        priceMoveValue: '0',
        priceDisplayUnit: '元/千克',
        priceChartUrl: '/api/news/price-chart?kind=tungsten&product=waste-tungsten-bar',
        priceSourceUpdatedAt: date,
      }];
    } catch (error) {
      console.warn('[tungsten-price-watch] CTIA article failed:', candidate.href, error.message);
    }
  }

  return [];
};

const fetchTungstenIndustrySignals = async () => {
  const results = await Promise.allSettled([
    fetchSmmTrackedTungstenPrices(),
    fetchCtiaTrackedTungstenPrices(),
  ]);

  return results.flatMap((result) => {
    if (result.status === 'fulfilled') return result.value;
    console.warn('[tungsten-price-watch] source failed:', result.reason?.message || result.reason);
    return [];
  });
};

const getLatestArchivedPriceValue = (sourceId) => {
  try {
    const archive = JSON.parse(fs.readFileSync(NEWS_FILE, 'utf8'));
    const matches = (archive.entries || [])
      .flatMap((entry) => entry.news || [])
      .filter((item) => item.sourceId === sourceId && Number.isFinite(Number(item.priceLatestValue)))
      .sort((a, b) => Date.parse(b.time || '') - Date.parse(a.time || ''));
    return matches.length ? Number(matches[0].priceLatestValue) : null;
  } catch {
    return null;
  }
};

const buildFixedPriceWatchItem = ({
  sourceId,
  product,
  latestValue,
  movePercent,
  unit,
  date,
  url,
  source,
  query,
  priceChartUrl,
}) => {
  const latest = Number(latestValue);
  const move = Number(movePercent);
  if (!Number.isFinite(latest) || !date) return null;
  const normalizedMove = Number.isFinite(move) ? move : 0;
  const direction = normalizedMove > 0
    ? `上涨${normalizedMove.toFixed(2)}%`
    : normalizedMove < 0
      ? `下跌${Math.abs(normalizedMove).toFixed(2)}%`
      : '持平';
  return {
    title: `${product}价格${direction}`,
    url,
    source,
    summary: `${product}最新价格${latest}${unit}，涨跌幅${normalizedMove.toFixed(2)}%，日期${date}。`,
    publishedAt: parseChinaDateToIso(date, 15),
    query,
    sourceId,
    collectionChannel: 'price-watch',
    priceProduct: product,
    priceLatestValue: String(latest),
    priceMoveValue: String(normalizedMove),
    priceDisplayUnit: unit,
    priceChartUrl,
    priceSourceUpdatedAt: date,
  };
};

const fetchR32TrackedPrice = async () => {
  const payload = JSON.parse(await fetchTextWithTimeout(R32_PRICE_API, 7000));
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const latest = rows[0];
  if (!latest) return [];
  rows.slice().reverse().forEach((row) => recordTungstenPricePoint('r32', {
    date: row.dateRange,
    value: Number(row.mdataValue),
    source: '卓创资讯',
    url: R32_PRICE_URL,
  }));
  const item = buildFixedPriceWatchItem({
    sourceId: 'r32-price-watch',
    product: 'R32',
    latestValue: latest.mdataValue,
    movePercent: String(latest.changeRate || '').replace('%', ''),
    unit: '元/吨',
    date: latest.dateRange,
    url: R32_PRICE_URL,
    source: '卓创资讯',
    query: '卓创资讯 R32 全国主流市场均价',
    priceChartUrl: '/api/news/price-chart?kind=tungsten&product=r32',
  });
  return item ? [item] : [];
};

const fetchHafniumTrackedPrice = async () => {
  const html = await fetchTextWithTimeout(HAFNIUM_PRICE_URL, 9000);
  const priceMatch = html.match(/Current Hafnium price:\s*\$([0-9,.]+)\s*per kg/i);
  const dateMatch = html.match(/Price as of\s+([A-Z][a-z]{2}\s+\d{1,2}\s+\d{4})/i);
  if (!priceMatch || !dateMatch) return [];
  const latestValue = Number(priceMatch[1].replace(/,/g, ''));
  const parsedDate = new Date(`${dateMatch[1]} 12:00:00 GMT+0800`);
  if (!Number.isFinite(latestValue) || Number.isNaN(parsedDate.getTime())) return [];
  const date = parsedDate.toISOString().slice(0, 10);
  [
    { date: '2026-06-19', value: 12508.2 },
    { date: '2026-06-30', value: 12508.2 },
  ].forEach((point) => recordTungstenPricePoint('hafnium', {
    ...point,
    source: 'Strategic Metals Invest',
    url: HAFNIUM_PRICE_URL,
  }));
  recordTungstenPricePoint('hafnium', {
    date,
    value: latestValue,
    source: 'Strategic Metals Invest',
    url: HAFNIUM_PRICE_URL,
  });
  const previousValue = getLatestArchivedPriceValue('hafnium-price-watch');
  const movePercent = previousValue && previousValue !== latestValue
    ? ((latestValue - previousValue) / previousValue) * 100
    : 0;
  const item = buildFixedPriceWatchItem({
    sourceId: 'hafnium-price-watch',
    product: '金属铪',
    latestValue,
    movePercent,
    unit: '美元/千克',
    date,
    url: HAFNIUM_PRICE_URL,
    source: 'Strategic Metals Invest',
    query: 'Strategic Metals Invest hafnium price',
    priceChartUrl: '/api/news/price-chart?kind=tungsten&product=hafnium',
  });
  return item ? [item] : [];
};

const fetchQ5500TrackedPrice = async () => {
  const rows = JSON.parse(await fetchTextWithTimeout(Q5500_PRICE_API, 9000));
  if (!Array.isArray(rows) || !rows.length) return [];
  const sortedRows = rows
    .filter((row) => row?.name && Number.isFinite(Number(row.age)))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const latest = sortedRows.at(-1);
  const previous = sortedRows.at(-2);
  if (!latest) return [];
  const cutoff = Date.now() - 35 * 24 * 60 * 60 * 1000;
  sortedRows.forEach((row) => {
    const timestamp = Date.parse(`${row.name}T00:00:00+08:00`);
    if (Number.isFinite(timestamp) && timestamp >= cutoff) {
      recordTungstenPricePoint('q5500', {
        date: row.name,
        value: Number(row.age),
        source: '中国煤炭市场网CCTD',
        url: Q5500_PRICE_URL,
      });
    }
  });
  const latestValue = Number(latest.age);
  const previousValue = Number(previous?.age);
  const movePercent = Number.isFinite(previousValue) && previousValue !== 0
    ? ((latestValue - previousValue) / previousValue) * 100
    : 0;
  const item = buildFixedPriceWatchItem({
    sourceId: 'q5500-price-watch',
    product: 'Q5500动力煤',
    latestValue,
    movePercent,
    unit: '元/吨',
    date: latest.name,
    url: Q5500_PRICE_URL,
    source: '中国煤炭市场网CCTD',
    query: 'CCTD 环渤海动力煤现货参考价 Q5500',
    priceChartUrl: '/api/news/price-chart?kind=tungsten&product=q5500',
  });
  return item ? [item] : [];
};

const fetchAdditionalTrackedPrices = async () => {
  const results = await Promise.allSettled([
    fetchR32TrackedPrice(),
    fetchHafniumTrackedPrice(),
    fetchQ5500TrackedPrice(),
  ]);
  return results.flatMap((result) => {
    if (result.status === 'fulfilled') return result.value;
    console.warn('[industry-price-watch] source failed:', result.reason?.message || result.reason);
    return [];
  });
};

const parseLocalChinaTimestamp = (value) => {
  const raw = String(value || '').trim();
  const match = raw.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}T${String(match[4]).padStart(2, '0')}:${match[5]}:00+08:00`;
  }
  return new Date().toISOString();
};

const parseSpotMoveValue = (value) => {
  const text = String(value || '');
  const match = text.match(/([+-]?\d+(?:\.\d+)?)/);
  if (!match) return 0;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) return 0;
  if (/▼/.test(text) && numeric > 0) return -numeric;
  return numeric;
};

const spotDirectionLabel = (move) => {
  if (move > 0) return `上涨${move}%`;
  if (move < 0) return `下跌${Math.abs(move)}%`;
  return '持平';
};

const readSpotTodayJson = (root) => {
  const file = path.join(root, 'state', 'today.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    console.warn('[price-watch] read spot today failed:', file, error.message);
    return null;
  }
};

const buildSpotPriceSignals = (kind, root) => {
  const payload = readSpotTodayJson(root);
  if (!payload?.rows?.length) return [];

  const label = kind === 'dram' ? 'DRAM' : 'NAND';
  const publishedAt = parseLocalChinaTimestamp(payload.update_ts);
  return payload.rows.map((row) => {
    const product = String(row['项目'] || '').trim();
    const avg = String(row['盘平均'] || '').trim();
    const move = parseSpotMoveValue(row['盘涨跌幅']);
    const direction = spotDirectionLabel(move);
    return {
      title: `${label} ${product}现货价${direction}`,
      url: `local://${kind}-spot-price`,
      source: `${label} Spot Price Tracking`,
      sourceId: `${kind}-spot-price-watch`,
      collectionChannel: 'price-watch',
      summary: `${product}盘平均${avg}美元，涨跌${move}；更新时间${payload.update_ts}。`,
      publishedAt,
      query: `${label} spot price local tracker`,
      priceProduct: product,
      priceLatestValue: avg,
      priceMoveValue: String(move),
      priceDisplayUnit: '美元',
      priceChartUrl: `/api/news/price-chart?kind=${kind}&product=${encodeURIComponent(product)}`,
      priceSourceUpdatedAt: payload.update_ts,
    };
  });
};

const fetchMemorySpotPriceSignals = async () => [
  ...buildSpotPriceSignals('dram', DRAM_SPOT_ROOT),
  ...buildSpotPriceSignals('nand', NAND_SPOT_ROOT),
];

const findDramChartFile = (product = '') => {
  const chartDir = path.join(DRAM_SPOT_ROOT, 'state', 'charts');
  if (!fs.existsSync(chartDir)) return null;
  const rules = [
    [/DDR5.*16Gb.*4800/i, 'DDR5_16Gb_4800-5600'],
    [/DDR5.*16Gb.*eTT/i, 'DDR5_16Gb_eTT'],
    [/DDR4.*16Gb.*3200/i, 'DDR4_16Gb_3200'],
    [/DDR4.*16Gb.*eTT/i, 'DDR4_16Gb_eTT'],
    [/DDR4.*8Gb.*3200/i, 'DDR4_8Gb_3200'],
    [/DDR4.*8Gb.*eTT/i, 'DDR4_8Gb_eTT'],
    [/DDR3.*4Gb/i, 'DDR3_4Gb_1600-1866'],
  ];
  const matched = rules.find(([pattern]) => pattern.test(product));
  const key = matched?.[1];
  const files = fs.readdirSync(chartDir)
    .filter((name) => name.endsWith('.png') && name.includes('历史') && (!key || name.includes(key)))
    .map((name) => path.join(chartDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || path.join(chartDir, 'charts_summary.png');
};

const safeChartName = (value = '') => String(value)
  .replace(/[^0-9A-Za-z\u4e00-\u9fff_.-]+/g, '_')
  .replace(/^_+|_+$/g, '') || 'nand_product';

const renderNandProductChart = (product = '') => {
  if (!product || !fs.existsSync(NAND_PRODUCT_CHART_SCRIPT)) return null;
  const output = path.join(NAND_SPOT_ROOT, 'state', 'product_charts', `${safeChartName(product)}_history.png`);
  const xlsx = path.join(NAND_SPOT_ROOT, 'state', 'nand_spot.xlsx');
  if (fs.existsSync(output) && fs.existsSync(xlsx) && fs.statSync(output).mtimeMs >= fs.statSync(xlsx).mtimeMs) {
    return output;
  }

  const result = spawnSync('python3', [NAND_PRODUCT_CHART_SCRIPT, '--root', NAND_SPOT_ROOT, '--product', product], {
    encoding: 'utf-8',
    timeout: 45000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (result.status !== 0) {
    console.warn('[price-chart] render NAND product chart failed:', result.stderr || result.stdout);
    return null;
  }
  return fs.existsSync(output) ? output : null;
};

const findNandChartFile = (product = '') => {
  const productText = String(product || '');
  const directCandidates = [
    /MLC\s*64Gb/i.test(productText) ? path.join(NAND_SPOT_ROOT, 'state', 'chart_mlc_64gb.png') : '',
    /MLC\s*32Gb/i.test(productText) ? path.join(NAND_SPOT_ROOT, 'state', 'chart_mlc_32gb.png') : '',
  ].filter(Boolean);
  const directMatch = directCandidates.find((file) => fs.existsSync(file));
  if (directMatch) return directMatch;

  const productChart = renderNandProductChart(product);
  if (productChart) return productChart;
  const candidates = [
    path.join(NAND_SPOT_ROOT, 'state', 'charts_per_product.png'),
    path.join(NAND_SPOT_ROOT, 'state', 'charts_summary.png'),
    path.join(NAND_SPOT_ROOT, 'state', 'today.png'),
  ];
  return candidates.find((file) => fs.existsSync(file)) || null;
};

const findSpotChartFile = (kind, product) => {
  if (kind === 'dram') return findDramChartFile(product);
  if (kind === 'nand') return findNandChartFile(product);
  return null;
};

const uniqueByUrlOrTitle = (items) => {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = item.url || item.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
};

const isRecentAnomalySource = (source, days = 3) => {
  if (!source?.publishedAt) return false;
  const publishedAt = new Date(source.publishedAt).getTime();
  if (!Number.isFinite(publishedAt)) return false;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return publishedAt >= cutoff && publishedAt <= Date.now() + 60 * 60 * 1000;
};

const buildAnomalyQueries = ({ fundName, market, stock, dailyReturn, mode }) => {
  const direction = Number(dailyReturn) >= 0 ? '上涨' : '下跌';
  const marketLabel = market === 'a' ? 'A股' : market === 'hk' ? '港股' : market === 'us' ? '美股' : market === 'jp' ? '日股' : market === 'kr' ? '韩股' : '';
  const cleanFundName = String(fundName || '').replace(/^(美股|日股|韩国|韩股|港股|A股)/, '');
  const stockName = stock?.name || '';
  const stockCode = stock?.code || '';
  const themeAliases = [];
  if (cleanFundName.includes('燃机')) {
    themeAliases.push('燃气轮机', 'gas turbine', 'GE Vernova', 'power turbine');
  }
  if (cleanFundName.includes('机器人')) {
    themeAliases.push('宇树', 'Unitree', 'humanoid robot');
  }
  if (cleanFundName.toLowerCase().includes('hbm') || cleanFundName.includes('存储')) {
    themeAliases.push('HBM', 'DRAM', 'Samsung', 'SK Hynix');
  }

  if (mode === 'theme' || !stockName) {
    return [
      `${marketLabel} ${cleanFundName} ${direction} 原因 今日`,
      `${cleanFundName} 板块 ${direction} 催化 今日`,
      ...themeAliases.map((alias) => `${alias} ${direction} catalyst today`),
      `${cleanFundName} news catalyst today`,
    ].filter(Boolean);
  }

  return [
    `${stockName} ${stockCode} ${direction} 原因 今日`,
    `${stockName} ${cleanFundName} ${direction} 催化`,
    ...themeAliases.slice(0, 2).map((alias) => `${stockName} ${alias} ${direction} reason`),
    `${stockName} ${stockCode} news catalyst today`,
  ].filter(Boolean);
};

const getAnomalySearchTerms = ({ fundName, stock }) => {
  const fund = String(fundName || '');
  const cleanFundName = fund.replace(/^(美股|日股|韩国|韩股|港股|A股)/, '');
  const terms = [
    cleanFundName,
    String(stock?.name || ''),
    String(stock?.code || ''),
  ];
  if (cleanFundName.includes('燃机')) terms.push('燃气轮机', 'gas turbine', 'GE Vernova', 'power turbine', 'AIDC', '算力能源');
  if (cleanFundName.includes('钨')) terms.push('钨', '钨精矿', '黑钨', '白钨', 'SMM', '上海有色');
  if (cleanFundName.includes('机器人')) terms.push('宇树', 'Unitree', 'humanoid robot', '具身智能');
  if (cleanFundName.toLowerCase().includes('hbm') || cleanFundName.includes('存储')) terms.push('HBM', 'DRAM', 'Samsung', 'SK Hynix', 'memory');
  return terms
    .map((term) => String(term || '').trim().toLowerCase())
    .filter((term) => term.length >= 2);
};

const rankAnomalySources = (payload, sources) => {
  const terms = getAnomalySearchTerms(payload);
  const noisePatterns = [
    '主力净流入',
    '主力净流出',
    '主力资金',
    '资金流向',
    '成交额',
    '换手率',
    '涨幅',
    '跌幅',
    '涨停',
    '跌停',
    '收盘涨',
    '收盘跌',
    '收涨',
    '收跌',
    '盘中上涨',
    '盘中下跌',
    '今日主力',
  ];
  const cleanedSources = sources.filter((source) => {
    const text = `${source.title || ''} ${source.summary || ''}`.toLowerCase();
    return !noisePatterns.some((pattern) => text.includes(pattern.toLowerCase()));
  });
  const scored = cleanedSources.map((source) => {
    const text = `${source.title || ''} ${source.summary || ''}`.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
    return { source, score };
  });
  const relevant = scored.filter((item) => item.score > 0);
  return relevant
    .sort((a, b) => b.score - a.score)
    .map((item) => item.source);
};

const classifyAnomalyResult = (queryPayload, sources) => {
  const stockName = String(queryPayload.stock?.name || '').toLowerCase();
  const stockCode = String(queryPayload.stock?.code || '').toLowerCase();
  const fundName = String(queryPayload.fundName || '');
  const cleanFundName = fundName.replace(/^(美股|日股|韩国|韩股|港股|A股)/, '').toLowerCase();
  const sourceText = sources.map((item) => `${item.title} ${item.summary || ''}`).join(' ').toLowerCase();
  const hasDirect = !!stockName && (sourceText.includes(stockName) || (!!stockCode && sourceText.includes(stockCode)));
  const level = hasDirect ? 'company' : sources.length > 0 ? 'theme' : 'unknown';

  if (hasDirect) {
    const first = sources[0];
    return {
      level,
      confidence: '中',
      reason: first?.title ? `主动搜索到公司相关线索：${first.title}` : `主动搜索到${queryPayload.stock.name}相关公开信息，可能解释今日异动。`,
    };
  }
  if (sources.length > 0) {
    const first = sources[0];
    return {
      level,
      confidence: '中',
      reason: first?.title ? `主题/板块催化：${first.title}` : `${cleanFundName || fundName}出现相关主题/板块新闻，可能是今日异动催化。`,
    };
  }
  return {
    level,
    confidence: '低',
    reason: '主动搜索暂未找到明确公开原因，需要继续观察后续新闻、公告和成交结构。',
  };
};

app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));

// Reject impossible NAV points before any API route persists them. A quote
// outage must leave a gap in the series, never a false crash to zero.
const sanitizeIncomingNavHistory = (value) => {
  if (Array.isArray(value)) {
    value.forEach(sanitizeIncomingNavHistory);
    return;
  }
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value.navHistory)) {
    value.navHistory = value.navHistory.filter((entry) => {
      const nav = Number(entry?.nav);
      const hasMarketValue = Object.prototype.hasOwnProperty.call(entry ?? {}, 'marketValue');
      const marketValue = Number(entry?.marketValue);
      return Number.isFinite(nav) && nav > 0 &&
        (!hasMarketValue || (Number.isFinite(marketValue) && marketValue > 0));
    });
  }

  Object.values(value).forEach(sanitizeIncomingNavHistory);
};

app.use((req, _res, next) => {
  sanitizeIncomingNavHistory(req.body);
  next();
});

app.use(express.static(path.join(__dirname, '../dist'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    }
  },
}));

app.post('/api/export-workbook', (req, res) => {
  const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  if (!localAddresses.has(req.ip)) {
    return res.status(403).json({ success: false, error: 'Local export only' });
  }

  try {
    const requestedName = path.basename(String(req.body?.fileName || ''));
    const encodedData = String(req.body?.data || '');
    if (!requestedName.endsWith('.xlsx') || requestedName.length > 120 || !encodedData) {
      return res.status(400).json({ success: false, error: 'Invalid workbook payload' });
    }

    const workbookBuffer = Buffer.from(encodedData, 'base64');
    if (workbookBuffer.length < 4 || workbookBuffer[0] !== 0x50 || workbookBuffer[1] !== 0x4b) {
      return res.status(400).json({ success: false, error: 'Invalid XLSX content' });
    }

    const downloadsDir = path.join(os.homedir(), 'Downloads');
    fs.mkdirSync(downloadsDir, { recursive: true });
    const extension = '.xlsx';
    const baseName = requestedName.slice(0, -extension.length);
    let outputName = requestedName;
    let outputPath = path.join(downloadsDir, outputName);
    let suffix = 1;
    while (fs.existsSync(outputPath)) {
      outputName = `${baseName} (${suffix})${extension}`;
      outputPath = path.join(downloadsDir, outputName);
      suffix += 1;
    }
    fs.writeFileSync(outputPath, workbookBuffer, { flag: 'wx' });
    return res.json({ success: true, fileName: outputName });
  } catch (error) {
    console.error('Workbook export failed:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readNews() {
  try {
    if (fs.existsSync(NEWS_FILE)) {
      const data = fs.readFileSync(NEWS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error reading news:', error);
  }
  return { entries: [], lastUpdated: null };
}

function writeNews(data) {
  try {
    fs.writeFileSync(NEWS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error('Error writing news:', error);
    return false;
  }
}

function canonicalizeNewsEventToken(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w.-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function getCanonicalNewsEventSubject(text = '') {
  const rules = [
    [/openai|chatgpt/i, 'openai'],
    [/anthropic|claude/i, 'anthropic'],
    [/xai|x\.ai|grok/i, 'xai'],
    [/google|gemini|deepmind|\$?googl\b/i, 'google'],
    [/meta|zuckerberg|\$?meta\b/i, 'meta'],
    [/microsoft|\$?msft\b/i, 'microsoft'],
    [/amazon|aws|\$?amzn\b/i, 'amazon'],
    [/deepseek/i, 'deepseek'],
    [/minimax/i, 'minimax'],
    [/kimi|moonshot/i, 'kimi'],
    [/nvidia|英伟达|\$?nvda\b/i, 'nvidia'],
    [/tsmc|台积电|\$?tsm\b/i, 'tsmc'],
    [/samsung|三星/i, 'samsung'],
    [/sk hynix|海力士/i, 'sk-hynix'],
    [/micron|美光|\$?mu\b/i, 'micron'],
    [/china|中国|beijing|北京|alibaba|阿里|bytedance|字节|头部ai|ai firms?/i, 'china-ai-firms'],
  ];
  const match = rules.find(([pattern]) => pattern.test(text));
  return match ? match[1] : '';
}

function getCanonicalNewsEventObject(text = '') {
  const rules = [
    [/\bH200\b/i, 'nvidia-h200', 'NVIDIA H200'],
    [/\b(?:GB200|B200|H100)\b/i, 'nvidia-ai-gpu', 'NVIDIA AI GPU'],
    [/\bGPT[-\s]?\d[\w.-]*/i, '', ''],
    [/\bGrok\s*\d[\w.-]*/i, '', ''],
    [/\bClaude\s+[A-Z]?\w+(?:[-\s.]\w+)*/i, '', ''],
    [/\bGemini\s+[A-Z]?\w+(?:[-\s.]\w+)*/i, '', ''],
    [/\bLlama\s*\d[\w.-]*/i, '', ''],
    [/\bDeepSeek[-\s]?\w+/i, '', ''],
    [/\bQwen\s*\d[\w.-]*/i, '', ''],
    [/\bMiniMax\s*M\d+(?:[-\w.]*)?\b/i, '', ''],
    [/hbm/i, 'hbm', 'HBM'],
    [/dram|ddr/i, 'dram', 'DRAM'],
    [/nand|flash/i, 'nand-flash', 'NAND Flash'],
    [/mlcc|积层陶瓷电容/i, 'mlcc', 'MLCC'],
    [/cowos|先进封装/i, 'cowos', 'CoWoS先进封装'],
    [/gpu|算力卡|ai\s*chip/i, 'gpu', 'GPU'],
    [/钨精矿|黑钨精矿|钨矿|tungsten/i, 'tungsten', '钨矿'],
    [/废钨棒材/i, 'waste-tungsten-bar', '废钨棒材'],
    [/data center|datacenter|数据中心/i, 'data-center', '数据中心'],
    [/robot|机器人/i, 'robot', '机器人'],
  ];
  for (const [pattern, key, label] of rules) {
    const match = String(text).match(pattern);
    if (match) {
      const raw = label || match[0].replace(/\s+/g, ' ').trim();
      return { key: key || canonicalizeNewsEventToken(raw), label: raw };
    }
  }
  return null;
}

function getCanonicalNewsEventAction(text = '', objectLabel = '') {
  const hasModelObject = /gpt|grok|claude|gemini|llama|deepseek|qwen|minimax|kimi/i.test(objectLabel);
  if (
    /approved|approve|批准|获批|plans?\s+to\s+let|allow|permit|greenlight|放行|允许|拟允许|计划允许/i.test(text)
    && /buy|purchase|采购|购买|h200|gpu|chip|芯片|算力/i.test(text)
  ) return 'purchase-approval';
  if (/发布|推出|上线|launch|release|announc|unveil|roll out|introduce|open[-\s]?source|开源/i.test(text) && hasModelObject) return 'model-launch';
  if (/涨价|提价|喊涨|调涨|价格上涨|报价上涨|asp|price\s*(increase|hike)|raise\s+prices?/i.test(text)) return 'price-up';
  if (/降价|下跌|跌价|回落|下降|price\s*(drop|decline|cut)|lower\s+prices?/i.test(text)) return 'price-down';
  if (/供需|短缺|供不应求|供应紧张|产能紧张|tight supply|shortage|constraint|bottleneck/i.test(text)) return 'supply-tight';
  if (/需求改善|需求回升|需求强劲|订单|采购|客户|出货|销量|交付|demand|orders?|shipments?|deliveries/i.test(text)) return 'demand-improve';
  if (/capex|capital expenditure|资本开支/i.test(text)) return 'capex';
  if (/funding|financing|loan|raise|valuation|融资|贷款|估值/i.test(text)) return 'funding';
  return '';
}

function getGenericNewsEventKey(rawText = '') {
  const text = String(rawText).replace(/\s+/g, ' ').trim();
  const subjectKey = getCanonicalNewsEventSubject(text);
  const object = getCanonicalNewsEventObject(text);
  if (!object) return '';
  const actionKey = getCanonicalNewsEventAction(text, object.label);
  if (!actionKey) return '';
  if (actionKey === 'model-launch' && !subjectKey) return '';
  if (['purchase-approval', 'capex', 'funding'].includes(actionKey) && !subjectKey) return '';
  return `event:${subjectKey || object.key}:${actionKey}:${object.key}`;
}

function getNewsEventKey(item) {
  const rawText = `${item?.title || ''} ${item?.snippet || ''} ${item?.summary || ''}`;
  const text = rawText.toLowerCase();
  if (
    /china|中国|beijing|北京/.test(text)
    && /approved|approve|批准|获批|plans?\s+to\s+let|allow|permit|greenlight|放行|允许|拟允许|计划允许/.test(text)
    && /deepseek|bytedance|字节|alibaba|阿里|top\s+ai\s+firms?|ai\s+firms?|major\s+ai\s+companies|头部ai|ai公司/.test(text)
    && /h200|nvidia|英伟达/.test(text)
  ) {
    return 'event:china-ai-companies-approved-nvidia-h200-purchases';
  }
  if (
    /xai|x\.ai|spacexai|space\s*x\s*ai|grok/.test(text)
    && (
      /grok\s*4\.?5|grok4\.?5|grok-4\.?5/.test(text)
      || /new\s+model.*cursor|cursor.*new\s+model|available.*cursor|try\s+out.*cursor|try\s+out.*vercel/.test(text)
    )
  ) {
    return 'event:xai-grok-4-5-launch';
  }
  return getGenericNewsEventKey(rawText);
}

function mergeDuplicateNewsCandidate(existing, candidate) {
  if (!existing) return candidate;
  const existingSources = new Set(Array.isArray(existing.__sources) ? existing.__sources : [existing.source].filter(Boolean));
  const candidateSources = new Set(Array.isArray(candidate.__sources) ? candidate.__sources : [candidate.source].filter(Boolean));
  candidateSources.forEach((source) => existingSources.add(source));

  const sourceCount = existingSources.size || 1;
  const sourceBoost = Math.min(24, Math.max(0, sourceCount - 1) * 6);
  const existingBase = Number(existing.__baseScore ?? existing.score ?? 0);
  const candidateBase = Number(candidate.__baseScore ?? candidate.score ?? 0);
  const stronger = candidateBase > existingBase
    || (candidateBase === existingBase && candidate.__sortTime > existing.__sortTime)
    ? candidate
    : existing;

  return {
    ...stronger,
    score: Math.round(Math.max(existingBase, candidateBase) + sourceBoost),
    sourceCount,
    __baseScore: Math.max(existingBase, candidateBase),
    __sources: Array.from(existingSources),
    __sortTime: Math.max(existing.__sortTime || 0, candidate.__sortTime || 0),
  };
}

function getNewsItemKey(item) {
  const eventKey = getNewsEventKey(item);
  if (eventKey) return eventKey;
  if (item?.collectionChannel === 'price-watch' || item?.sourceId === 'tungsten-price-watch') {
    const dateKey = String(item.time || '').slice(0, 10);
    const text = `${item.title || ''} ${item.snippet || ''}`;
    const productKey = /废钨棒材/.test(text)
      ? 'waste-tungsten-bar'
      : /黑钨精矿.*65|黑钨精矿[≥≧]\s*65/.test(text)
        ? 'wolframite-65'
        : /DDR|DRAM|NAND|MLC|SLC/i.test(text)
          ? String(item.sourceId || item.source || 'memory').toLowerCase().replace(/\s+/g, '') + ':' + String(item.priceProduct || item.title || '').toLowerCase().replace(/\s+/g, '')
          : String(item.title || '').toLowerCase().replace(/\s+/g, '');
    return `price-watch:${item.sourceId || item.source || 'price'}:${dateKey}:${productKey}`;
  }
  const urlKey = item.url ? String(item.url).trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/$/, '') : '';
  if (urlKey) return `url:${urlKey}`;
  return `title:${String(item.title || '').toLowerCase().replace(/\s+/g, '').replace(/[^\w\u4e00-\u9fff]/g, '')}`;
}

function stableNewsHash(input = '') {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) % 100000;
  }
  return hash;
}

function getNewsDisplayRecencyBoost(sortTime) {
  if (!Number.isFinite(sortTime)) return 0;
  const hoursOld = (Date.now() - sortTime) / 3600000;
  if (hoursOld <= 2) return 10;
  if (hoursOld <= 6) return 8;
  if (hoursOld <= 12) return 5;
  if (hoursOld <= 24) return 3;
  return 0;
}

function isXNewsSource(item) {
  const sourceText = String(item?.source || item?.sourceName || '');
  const sourceCategory = String(item?.sourceCategory || item?.source_type || '').trim();
  const channel = String(item?.collectionChannel || item?.collection_channel || '').trim();
  return channel === 'x'
    || sourceCategory === 'social'
    || /^X\/|^X\/Twitter|^Twitter/i.test(sourceText);
}

function getXWeightedEngagement(item) {
  const likes = Number(item?.metrics?.likes ?? 0);
  const reposts = Number(item?.metrics?.retweets ?? item?.metrics?.reposts ?? 0);
  const replies = Number(item?.metrics?.replies ?? 0);
  const weighted = likes + reposts * 3 + replies * 1.25;
  if (weighted > 0) return weighted;
  return Math.max(0, Number(item?.engagement ?? 0));
}

function getXEngagementVelocity(item, sortTime, now = Date.now()) {
  const ageHours = Math.max(0.5, (now - sortTime) / 3600000);
  return getXWeightedEngagement(item) / Math.pow(ageHours, 0.65);
}

function buildXEngagementContext(entries) {
  const byAccount = new Map();
  const global = [];
  const now = Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;

  entries.forEach((entry) => {
    (entry.news || []).forEach((item) => {
      if (!isXNewsSource(item)) return;
      const sortTime = getArchiveNewsSortTime(item, entry);
      if (!Number.isFinite(sortTime) || sortTime < cutoff) return;
      const velocity = getXEngagementVelocity(item, sortTime, now);
      const account = String(item?.sourceId || item?.source || 'x-unknown').toLowerCase();
      if (!byAccount.has(account)) byAccount.set(account, []);
      byAccount.get(account).push(velocity);
      global.push(velocity);
    });
  });

  byAccount.forEach((values) => values.sort((a, b) => a - b));
  global.sort((a, b) => a - b);
  return { byAccount, global, now };
}

function getXRelativeEngagementBoost(item, sortTime, context) {
  if (!isXNewsSource(item)) return 0;
  const account = String(item?.sourceId || item?.source || 'x-unknown').toLowerCase();
  const accountSamples = context?.byAccount?.get(account) || [];
  const samples = accountSamples.length >= 5 ? accountSamples : (context?.global || []);
  if (samples.length === 0) return 18;
  const velocity = getXEngagementVelocity(item, sortTime, context?.now || Date.now());
  const notHigher = samples.reduce((count, sample) => count + (sample <= velocity ? 1 : 0), 0);
  const percentile = Math.max(0, Math.min(1, notHigher / samples.length));
  return Math.round(5 + percentile * 35);
}

function getNewsItemScore(item, sortTime, scoringContext = null) {
  const directScore = Number(item?.normalizedEngagementScore ?? item?.score);
  const fallbackScore = 62 + (stableNewsHash(`${item?.title || ''}${item?.source || ''}`) % 29);
  const baseScore = Number.isFinite(directScore) ? directScore : fallbackScore;
  const sourceText = String(item?.source || item?.sourceName || '');
  const sourceCategory = String(item?.sourceCategory || item?.source_type || '').trim();
  const channel = String(item?.collectionChannel || item?.collection_channel || '').trim();

  if (item?.collectionChannel === 'price-watch') return baseScore;

  const category = item?.investmentCategory || item?.investment_category || '';
  const signalType = item?.signalType || item?.signal_type || '';
  const text = [
    item?.title,
    item?.snippet,
    item?.summary,
    sourceText,
    category,
    signalType,
  ].filter(Boolean).join(' ');
  const noisePattern = /村民|棍棒|赶蛇|蛇毒|血清|救治需求|空调|省电|天气|民生|高铁|站房|绿道|景区|婚恋|宠物|养生|病例|医院/i;
  const marketNoisePattern = /A股|午评|ETF|基金|指数|沪指|创业板|恒指|港股|美股|股票|股价|涨\d+(?:\.\d+)?%|price target|目标价|评级|买入|增持|估值|市值|IPO|券商/i;
  const hardInvestmentPattern = /AI|人工智能|算力|GPU|HBM|DRAM|DDR|NAND|SSD|MLCC|PCB|CCL|CoWoS|芯片|半导体|服务器|数据中心|光模块|铜箔|玻纤布|钨|钨矿|金属|涨价|提价|降价|报价|均价|ASP|price|shortage|tight supply|订单|客户|出货|产能|库存|供给|供应|需求|景气|capex|资本开支|收入|利润|销量|交付|零售|电商|汽车|家电|白酒|餐饮|旅游|美妆|OpenAI|ChatGPT|Codex|Anthropic|Claude|GPT|Gemini|DeepSeek|Qwen|LLM|Agent|智能体|用户数|活跃用户|付费用户|使用量|调用量|MAU|DAU|users?|usage|downloads?|subscribers?|并购|收购|acqui/i;
  const demandContextPattern = /订单|客户|出货|销量|交付|下游|景气|复苏|回暖|需求改善|需求回升|需求强劲|需求增长|库存去化|供需|产能|收入|利润|业绩/i;
  const productAdoptionPattern = /(?:OpenAI|ChatGPT|Codex|Anthropic|Claude|Gemini|DeepSeek|Qwen|Grok|AI).{0,80}(?:用户数|活跃用户|付费用户|使用量|调用量|下载量|开发者|MAU|DAU|users?|active users?|paid users?|usage|downloads?|developers?|subscribers?)/i;
  const scaleNumberPattern = /(?:\d+(?:\.\d+)?\s*(?:万|亿|million|billion|[mk])\b|\d{1,3}(?:,\d{3})+)/i;
  const priceFactPattern = /(?:DRAM|NAND|SLC|MLC|HBM|SSD|MLCC|PCB|CCL|钨|铜|铝|存储|内存).{0,100}(?:涨价|提价|降价|价格|ASP|rise|increase|hike|drop|decline|forecast)/i;
  const capacityFactPattern = /(?:产能|扩产|晶圆厂|工厂|fab|capacity|production).{0,100}(?:提升|增加|扩张|新建|build|increase|expand|ramp|wafer)/i;
  const earningsFactPattern = /(?:业绩|营收|收入|利润|指引|earnings|revenue|profit|guidance)/i;
  const dealFactPattern = /(?:订单|合同|供货|收购|并购|融资|估值|order|contract|supply deal|acqui|funding|financing|valuation)/i;
  const majorMacroPattern = /(?:CPI|PPI|PCE|非农|FOMC|GDP|PMI|美联储|央行|消费者价格指数|生产者价格指数)/i;
  const materialFactPattern = productAdoptionPattern.test(text)
    || priceFactPattern.test(text)
    || capacityFactPattern.test(text)
    || earningsFactPattern.test(text)
    || dealFactPattern.test(text)
    || majorMacroPattern.test(text);
  const socialChatterPattern = /(?:what do you|what should|should we|thank you|worth trying|do you love|scrolling twitter|looking for feedback|i just want to say|你喜欢|大家觉得|征集反馈)/i;
  const strippedSocialText = text.replace(/https?:\/\/\S+/g, '').replace(/@\w+/g, '').trim();

  const promotionalGiveawayPattern = /(?:福利|抽奖|免费抽|参与抽奖|扫码(?:参与|领取|抽奖)|奖品|一等奖|二等奖|三等奖|赠品|关注有礼|下载有礼|报名(?:即送|领取)|AirPods.{0,20}(?:抽|送)|订阅.{0,20}(?:抽奖|领奖))/i;
  if (promotionalGiveawayPattern.test(text)) {
    return 0;
  }
  if ((noisePattern.test(text) || marketNoisePattern.test(text)) && !hardInvestmentPattern.test(text)) {
    return Math.min(baseScore, 72);
  }

  const categoryBoost = {
    'AI 涨价': 24,
    硬件: 20,
    软件: 16,
    宏观: 14,
    消费: 14,
  }[category] || 0;
  const signalBoost = {
    利好涨价: 30,
    利空降价: 28,
    供需紧张: 26,
    需求放缓: 22,
    需求改善: 20,
    宏观政策: 22,
    重大宏观数据: 28,
    订单客户突破: 24,
    capex上修: 24,
    capex下修: 24,
  }[signalType] || 0;
  const sourceBoost = {
    official: 20,
    media: 15,
    wechat: 18,
    newsletter: 16,
    academic: 11,
    developer: 9,
    policy: 12,
  }[sourceCategory] || (channel === 'wechat' ? 18 : channel === 'newsletter' ? 16 : isXNewsSource(item) ? 8 : 9);
  const contextBoost = hardInvestmentPattern.test(text) ? 10 : 0;
  const demandQualityBoost = signalType === '需求改善' && demandContextPattern.test(text) ? 8 : 0;
  const weakDemandPenalty = signalType === '需求改善' && !demandContextPattern.test(text) ? 16 : 0;
  const adoptionBoost = productAdoptionPattern.test(text) && scaleNumberPattern.test(text) ? 30 : 0;
  const materialityBoost = adoptionBoost > 0
    ? 0
    : priceFactPattern.test(text) || capacityFactPattern.test(text) || earningsFactPattern.test(text) || dealFactPattern.test(text) || majorMacroPattern.test(text)
      ? 28
      : 0;
  const quantifiedBoost = /(?:\d+(?:\.\d+)?%|\$\s?\d|€\s?\d|£\s?\d|\d+(?:\.\d+)?\s*(?:万|亿|million|billion|[mk])\b|\d{1,3}(?:,\d{3})+)/i.test(text) ? 12 : 0;
  const relativeAttentionBoost = getXRelativeEngagementBoost(item, sortTime, scoringContext);
  const weakSocialPenalty = isXNewsSource(item) && socialChatterPattern.test(text) && !materialFactPattern ? 55 : 0;
  const linkOnlyPenalty = isXNewsSource(item) && strippedSocialText.length < 12 ? 65 : 0;
  const modelScore = Math.round(
    35
    + categoryBoost
    + signalBoost
    + sourceBoost
    + contextBoost
    + demandQualityBoost
    + adoptionBoost
    + materialityBoost
    + quantifiedBoost
    + relativeAttentionBoost
    + getNewsDisplayRecencyBoost(sortTime)
    - weakDemandPenalty
    - weakSocialPenalty
    - linkOnlyPenalty,
  );

  const comparableScore = isXNewsSource(item) ? modelScore : Math.max(Math.min(baseScore, 135), modelScore);
  return Math.max(0, Math.min(200, comparableScore));
}

function getLatestNewsArchiveTime(data, refreshStatus = null) {
  const times = [
    Date.parse(data?.lastCheckedAt || ''),
    Date.parse(data?.lastUpdated || ''),
    Date.parse(data?.refreshStatus?.lastFinishedAt || ''),
    Date.parse(refreshStatus?.lastFinishedAt || ''),
    refreshStatus?.updating ? Date.parse(refreshStatus?.lastStartedAt || '') : NaN,
  ].filter(Number.isFinite);
  if (times.length === 0) return new Date().toISOString();
  return new Date(Math.max(...times)).toISOString();
}

function getNewsRefreshStatusForResponse(data) {
  const archived = data?.refreshStatus || null;
  const live = newsRefreshStatus || null;

  if (live?.updating) {
    return {
      ...(archived || {}),
      ...live,
      updating: true,
    };
  }

  if (!archived) return live || null;
  if (!live) return archived;

  const archivedTime = Date.parse(archived.lastFinishedAt || archived.lastStartedAt || '');
  const liveTime = Date.parse(live.lastFinishedAt || live.lastStartedAt || '');
  if (Number.isFinite(liveTime) && (!Number.isFinite(archivedTime) || liveTime > archivedTime)) {
    return live;
  }

  return archived;
}

function isBlockedNewsItem(item) {
  const source = String(item?.source || item?.source_name || '').trim();
  const title = String(item?.title || '').trim();
  const text = `${source} ${title} ${item?.snippet || ''}`;
  if (/Last Week in AI/i.test(source) || /^(Last Week in AI|Editorials)$/i.test(title)) return true;
  if (/村民|棍棒|赶蛇|蛇毒|血清|救治需求/.test(text)) return true;
  return false;
}

function parseArchiveNewsTime(value, archiveCreatedAt) {
  const raw = String(value || '').trim();
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;

  const archiveTime = Date.parse(archiveCreatedAt || '');
  if (!Number.isFinite(archiveTime)) return null;

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

  return archiveTime;
}

function getArchiveNewsSortTime(item, entry) {
  return parseArchiveNewsTime(item?.time, entry?.createdAt) || Date.parse(entry?.createdAt || '') || Date.now();
}

function flattenNewsForResponse(data, options = {}) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const limit = options.limit || NEWS_RESPONSE_DEFAULT_LIMIT;
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0;
  const flattenedByKey = new Map();
  const scoringContext = buildXEngagementContext(entries);

  entries.forEach((entry) => {
    (entry.news || []).forEach((item) => {
      if (!item?.title) return;
      if (isBlockedNewsItem(item)) return;
      const sortTime = getArchiveNewsSortTime(item, entry);
      const score = getNewsItemScore(item, sortTime, scoringContext);
      if (score < minScore) return;

      const key = getNewsItemKey(item);
      if (!key) return;

      const candidate = {
        ...item,
        time: new Date(sortTime).toISOString(),
        score,
        sourceCount: 1,
        __baseScore: score,
        __sources: item.source ? [item.source] : [],
        __sortTime: sortTime,
      };
      const existing = flattenedByKey.get(key);
      flattenedByKey.set(key, mergeDuplicateNewsCandidate(existing, candidate));
    });
  });

  const flattened = Array.from(flattenedByKey.values())
    .sort((a, b) => b.__sortTime - a.__sortTime);
  const limited = flattened.slice(0, limit);
  const limitedKeys = new Set(limited.map((item) => getNewsItemKey(item)));
  const latestPriceWatchByProduct = new Map();

  flattened
    .filter((item) => item.collectionChannel === 'price-watch')
    .forEach((item) => {
      const text = `${item.priceProduct || ''} ${item.title || ''} ${item.snippet || ''}`;
      const productKey = /废钨棒材/.test(text)
        ? 'waste-tungsten-bar'
        : /黑钨精矿.*65|黑钨精矿[≥≧]\s*65/.test(text)
          ? 'wolframite-65'
          : `${item.sourceId || item.source || 'price'}:${item.priceProduct || item.title || ''}`.toLowerCase().replace(/\s+/g, '');
      const existing = latestPriceWatchByProduct.get(productKey);
      if (!existing || item.__sortTime > existing.__sortTime) {
        latestPriceWatchByProduct.set(productKey, item);
      }
    });

  const pinnedPriceWatch = Array.from(latestPriceWatchByProduct.values())
    .filter((item) => !limitedKeys.has(getNewsItemKey(item)));
  const responseItems = [...limited, ...pinnedPriceWatch]
    .sort((a, b) => b.__sortTime - a.__sortTime);

  return {
    total: flattened.length,
    news: responseItems.map(({ __sortTime, __baseScore, __sources, ...item }) => item),
  };
}

let newsRefreshInFlight = null;
let priceWatchRefreshInFlight = null;
let newsRefreshStatus = {
  updating: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  added: 0,
  fetched: 0,
  skipped: 0,
  error: null,
};

function collectNewsKeys(data) {
  const keys = new Set();
  (data.entries || []).forEach((entry) => {
    (entry.news || []).forEach((item) => {
      const key = getNewsItemKey(item);
      if (key) keys.add(key);
    });
  });
  return keys;
}

function getNewsIncrementalSince(data) {
  const lastSuccessfulRefresh = data?.lastCheckedAt || data?.lastUpdated;
  const lastMs = Date.parse(lastSuccessfulRefresh || '');
  if (!Number.isFinite(lastMs)) return '24h';

  const diffMs = Date.now() - lastMs;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return '1h';

  const overlapMs = 10 * 60 * 1000;
  const lookbackMs = diffMs + overlapMs;
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;

  if (lookbackMs < dayMs) {
    return `${Math.max(1, Math.ceil(lookbackMs / hourMs))}h`;
  }

  return `${Math.min(7, Math.max(1, Math.ceil(lookbackMs / dayMs)))}d`;
}

async function runNewsIncrementalRefresh(options = {}) {
  const startedAt = new Date().toISOString();
  const mode = options.mode === 'quick' ? 'quick' : 'full';
  newsRefreshStatus = {
    ...newsRefreshStatus,
    updating: true,
    lastStartedAt: startedAt,
    mode,
    error: null,
  };

  try {
    const currentData = readNews();
    currentData.entries = currentData.entries || [];
    const incrementalSince = options.since || getNewsIncrementalSince(currentData);

    const { news, meta } = await fetchNewsIntelligence({
      since: incrementalSince,
      mode,
      limit: options.limit,
      outputPerSource: options.outputPerSource,
    });
    const trackedPriceSignals = mode === 'quick'
      ? await fetchMemorySpotPriceSignals()
      : [
          ...(await fetchTungstenIndustrySignals()).map((item) => ({
            ...item,
            sourceId: 'tungsten-price-watch',
            collectionChannel: 'price-watch',
          })),
          ...(await fetchAdditionalTrackedPrices()),
          ...(await fetchMemorySpotPriceSignals()),
        ];
    const trackedPriceNews = normalizeMacroNewsItems(trackedPriceSignals, {
      collectionChannel: 'price-watch',
    });
    const fetchedNews = [...(news || []), ...trackedPriceNews];

    const existingKeys = collectNewsKeys(currentData);
    const newItems = [];

    fetchedNews.forEach((item) => {
      const key = getNewsItemKey(item);
      if (!key || existingKeys.has(key)) return;
      existingKeys.add(key);
      newItems.push(item);
    });

    const finishedAt = new Date().toISOString();
    let newEntry = null;

    if (newItems.length > 0) {
      newEntry = {
        id: Date.now().toString(),
        type: 'news-intelligence',
        news: newItems,
        meta: {
          ...meta,
          incremental: true,
          mode,
          since: incrementalSince,
          fetchedCount: fetchedNews.length,
          rawFetchedCount: (news || []).length,
          tungstenPriceCount: trackedPriceNews.filter((item) => item.sourceId === 'tungsten-price-watch').length,
          memorySpotPriceCount: trackedPriceNews.filter((item) => /spot-price-watch/.test(item.sourceId || '')).length,
          addedCount: newItems.length,
          skippedCount: fetchedNews.length - newItems.length,
        },
        createdAt: finishedAt,
      };
      currentData.entries.unshift(newEntry);
      if (currentData.entries.length > 50) {
        currentData.entries = currentData.entries.slice(0, 50);
      }
      currentData.lastUpdated = finishedAt;
    }

    currentData.lastCheckedAt = finishedAt;
    currentData.refreshStatus = {
      updating: false,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      added: newItems.length,
      fetched: fetchedNews.length,
      skipped: fetchedNews.length - newItems.length,
      since: incrementalSince,
      mode,
      error: null,
    };
    writeNews(currentData);

    newsRefreshStatus = currentData.refreshStatus;
    return { entry: newEntry, archive: currentData, meta };
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const currentData = readNews();
    currentData.lastCheckedAt = finishedAt;
    currentData.refreshStatus = {
      updating: false,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      added: 0,
      fetched: 0,
      skipped: 0,
      error: err.message,
      mode,
    };
    writeNews(currentData);
    newsRefreshStatus = currentData.refreshStatus;
    console.error('News incremental refresh error:', err);
    return { entry: null, archive: currentData, meta: null, error: err.message };
  } finally {
    newsRefreshInFlight = null;
  }
}

function ensureNewsIncrementalRefresh(options = {}) {
  if (!newsRefreshInFlight) {
    newsRefreshInFlight = runNewsIncrementalRefresh(options);
    return { started: true, promise: newsRefreshInFlight };
  }
  return { started: false, promise: newsRefreshInFlight };
}

function inferMacroSignalType(item) {
  const text = [item.title, item.summary, item.query, item.source].filter(Boolean).join(' ');
  if (/下跌|下降|降价|跌价|price\s*(drop|decline|cut)|lower\s+price/i.test(text)) return '利空降价';
  if (/上涨|上调|涨价|提价|price\s*(increase|hike)|raise\s+price/i.test(text)) return '利好涨价';
  if (/供不应求|供应紧张|缺货|shortage|tight\s+supply/i.test(text)) return '供需紧张';
  return '异动归因';
}

function scoreMacroNewsItem(item) {
  const text = [item.title, item.summary, item.query, item.source].filter(Boolean).join(' ');
  let score = 80;

  if (/SMM|上海有色/i.test(text)) score += 10;
  if (/钨|钨矿|钨精矿|tungsten|有色|金属/i.test(text)) score += 12;
  if (/价格|均价|涨跌|报价|price|ASP/i.test(text)) score += 10;
  if (/上涨|上调|涨价|提价|下跌|下降|降价|跌价|price\s*(increase|hike|drop|decline|cut)/i.test(text)) score += 8;

  const changeMatches = [...text.matchAll(/涨跌\s*([+-]?\d+(?:\.\d+)?)/g)].map((match) => Math.abs(Number(match[1])));
  const titleMoveMatch = text.match(/(?:上涨|下跌|上调|下降|涨价|降价)(\d+(?:\.\d+)?)/);
  if (titleMoveMatch) changeMatches.push(Math.abs(Number(titleMoveMatch[1])));
  const maxMove = Math.max(0, ...changeMatches.filter(Number.isFinite));
  if (maxMove >= 5000) score += 10;
  else if (maxMove >= 1000) score += 6;

  return Math.min(score, 130);
}

function normalizeMacroNewsItems(items, overrides = {}) {
  return (items || [])
    .filter((item) => item?.title)
    .map((item) => ({
      category: '宏观',
      sourceCategory: 'macro',
      collectionChannel: overrides.collectionChannel || item.collectionChannel || 'anomaly-research',
      sourceId: overrides.sourceId || item.sourceId || item.source || 'anomaly-research',
      investmentCategory: '宏观',
      signalType: inferMacroSignalType(item),
      title: item.title,
      source: item.source || '异动归因',
      time: item.publishedAt || new Date().toISOString(),
      url: item.url,
      snippet: item.summary || item.query || '',
      language: /[a-zA-Z]/.test(item.title) ? 'mixed' : 'zh',
      score: scoreMacroNewsItem(item),
      priceProduct: item.priceProduct,
      priceLatestValue: item.priceLatestValue,
      priceMoveValue: item.priceMoveValue,
      priceDisplayUnit: item.priceDisplayUnit,
      priceChartUrl: item.priceChartUrl,
      priceSourceUpdatedAt: item.priceSourceUpdatedAt,
    }));
}

function upsertMacroNewsItems(items, type = 'anomaly-research', overrides = {}) {
  const normalizedItems = normalizeMacroNewsItems(items, {
    collectionChannel: overrides.collectionChannel || type,
    sourceId: overrides.sourceId,
  });

  if (normalizedItems.length === 0) return null;

  const currentData = readNews();
  currentData.entries = currentData.entries || [];
  const existingKeys = new Set();
  currentData.entries.forEach((entry) => {
    (entry.news || []).forEach((item) => existingKeys.add(getNewsItemKey(item)));
  });

  const updatedKeys = new Set();
  normalizedItems.forEach((item) => {
    if (item.collectionChannel !== 'price-watch') return;
    const key = getNewsItemKey(item);
    if (!key) return;
    currentData.entries.forEach((entry) => {
      entry.news = (entry.news || []).map((existing) => {
        if (getNewsItemKey(existing) !== key) return existing;
        updatedKeys.add(key);
        return { ...existing, ...item };
      });
    });
  });

  const newItems = normalizedItems.filter((item) => {
    const key = getNewsItemKey(item);
    if (updatedKeys.has(key)) return false;
    if (!key || existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  });

  if (newItems.length === 0) {
    if (updatedKeys.size > 0) {
      currentData.lastUpdated = new Date().toISOString();
      writeNews(currentData);
      return { id: `${Date.now()}-${type}-updated`, type, news: [], updated: updatedKeys.size };
    }
    return null;
  }

  const newEntry = {
    id: `${Date.now()}-${type}`,
    type,
    news: newItems,
    meta: { source: 'active-anomaly-attribution' },
    createdAt: new Date().toISOString(),
  };

  currentData.entries.unshift(newEntry);
  if (currentData.entries.length > 50) {
    currentData.entries = currentData.entries.slice(0, 50);
  }
  currentData.lastUpdated = new Date().toISOString();
  writeNews(currentData);
  return newEntry;
}

function hydrateCachedTungstenPriceWatch() {
  const data = readNews();
  let changed = false;
  (data.entries || []).forEach((entry) => {
    entry.news = (entry.news || []).map((item) => {
      if (item.sourceId !== 'tungsten-price-watch') return item;
      const text = `${item.title || ''} ${item.snippet || ''}`;
      const date = getChinaDateKey(item.priceSourceUpdatedAt || item.time || entry.createdAt);
      let patch = null;
      if (/黑钨精矿/.test(text)) {
        const latest = Number(String(item.priceLatestValue || text.match(/均价\s*([0-9,]+)/)?.[1] || '').replace(/,/g, ''));
        const move = Number(String(item.priceMoveValue || text.match(/涨跌\s*([+-]?[0-9,]+)/)?.[1] || '0').replace(/,/g, ''));
        if (Number.isFinite(latest)) {
          patch = {
            priceProduct: '黑钨精矿≧65%',
            priceLatestValue: String(latest),
            priceMoveValue: String(Number.isFinite(move) ? move : 0),
            priceDisplayUnit: '元/吨',
            priceChartUrl: '/api/news/price-chart?kind=tungsten&product=wolframite-65',
            priceSourceUpdatedAt: date,
          };
        }
      } else if (/废钨棒材/.test(text)) {
        const latest = Number(String(item.priceLatestValue || text.match(/价格\s*([0-9,.]+)/)?.[1] || '').replace(/,/g, ''));
        const move = Number(String(item.priceMoveValue || text.match(/涨跌\s*([+-]?[0-9,.]+)/)?.[1] || '0').replace(/,/g, ''));
        if (Number.isFinite(latest)) {
          patch = {
            priceProduct: '废钨棒材',
            priceLatestValue: String(latest),
            priceMoveValue: String(Number.isFinite(move) ? move : 0),
            priceDisplayUnit: '元/千克',
            priceChartUrl: '/api/news/price-chart?kind=tungsten&product=waste-tungsten-bar',
            priceSourceUpdatedAt: date,
          };
        }
      }
      if (!patch) return item;
      const next = { ...item, ...patch };
      if (JSON.stringify(next) !== JSON.stringify(item)) changed = true;
      return next;
    });
  });
  if (changed) writeNews(data);
  readTungstenPriceHistory();
}

async function refreshFixedPriceWatch() {
  const sources = [
    ...(await fetchTungstenIndustrySignals()).map((item) => ({
      ...item,
      sourceId: 'tungsten-price-watch',
      collectionChannel: 'price-watch',
    })),
    ...(await fetchAdditionalTrackedPrices()),
    ...(await fetchMemorySpotPriceSignals()),
  ];
  const entry = upsertMacroNewsItems(sources, 'price-watch', {
    collectionChannel: 'price-watch',
  });
  return {
    checked: sources.length,
    added: entry?.news?.length || 0,
  };
}

function ensureFixedPriceWatchRefresh() {
  if (priceWatchRefreshInFlight) return priceWatchRefreshInFlight;
  priceWatchRefreshInFlight = refreshFixedPriceWatch()
    .catch((error) => {
      console.error('[price-watch] background refresh failed:', error.message);
      return { checked: 0, added: 0, error: error.message };
    })
    .finally(() => {
      priceWatchRefreshInFlight = null;
    });
  return priceWatchRefreshInFlight;
}

async function runMacdScript() {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [MACD_SCRIPT, '--api']);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('MACD script timeout'));
    }, 300000);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(stderr || `MACD script exited with code ${code}`));
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function ensureMacdRefreshInFlight() {
  if (macdInFlight) {
    return macdInFlight;
  }

  macdInFlight = runMacdScript()
    .then((data) => {
      const newCache = {
        data,
        generatedAt: new Date().toISOString(),
        generatedAtMs: Date.now(),
      };
      macdCache = newCache;
      persistMacdCache(newCache);
      return newCache;
    })
    .catch((error) => {
      console.error('MACD refresh failed:', error);
      return null;
    })
    .finally(() => {
      macdInFlight = null;
    });

  return macdInFlight;
}

async function loadMacdData(forceRefresh = false, asyncOnly = false) {
  const now = Date.now();
  const freshCache = macdCache && (now - macdCache.generatedAtMs < MACD_CACHE_TTL_MS);

  if (!forceRefresh && freshCache) {
    return { ...macdCache, cached: true, stale: false, updating: false };
  }

  if (macdCache && !forceRefresh) {
    ensureMacdRefreshInFlight();
    return { ...macdCache, cached: true, stale: true, updating: true };
  }

  if (forceRefresh && asyncOnly && macdCache) {
    ensureMacdRefreshInFlight();
    return { ...macdCache, cached: true, stale: !freshCache, updating: true };
  }

  if (macdInFlight) {
    const data = await macdInFlight;
    return data ? { ...data, cached: false, stale: false, updating: false } : { data: [], cached: false, stale: false, updating: false, generatedAt: new Date().toISOString(), generatedAtMs: Date.now() };
  }

  const data = await ensureMacdRefreshInFlight();
  if (!data) {
    throw new Error('MACD script returned no data');
  }
  return { ...data, cached: false, stale: false, updating: false };
}

const priceTracking = await import('./lib/priceTracking.js');

app.get('/api/prices', (req, res) => {
  res.json({ ...priceTracking.readCache(), refreshStatus: priceTracking.getStatus() });
});

app.post('/api/prices/refresh', (req, res) => {
  const { started } = priceTracking.triggerRefresh({ collect: true });
  res.json({ success: true, started, updating: true, refreshStatus: priceTracking.getStatus() });
});

app.get('/api/news', (req, res) => {
  const data = readNews();
  const requestedLimit = Number(req.query.limit);
  const requestedMinScore = Number(req.query.minScore);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.floor(requestedLimit), 1), NEWS_RESPONSE_MAX_LIMIT)
    : NEWS_RESPONSE_DEFAULT_LIMIT;
  const minScore = Number.isFinite(requestedMinScore) ? requestedMinScore : 0;
  const flattened = flattenNewsForResponse(data, { limit, minScore });
  const refreshStatus = getNewsRefreshStatusForResponse(data);
  const latestArchiveTime = getLatestNewsArchiveTime(data, refreshStatus);
  const priceRefreshStatus = priceTracking.getStatus();
  const combinedRefreshStatus = {
    ...(refreshStatus || {}),
    updating: Boolean(refreshStatus?.updating || priceRefreshStatus.updating),
    price: priceRefreshStatus,
  };
  const combinedLatestTime = [latestArchiveTime, priceRefreshStatus.generatedAt]
    .filter((value) => Number.isFinite(Date.parse(value || '')))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || latestArchiveTime;

  const mergedNews = priceTracking.mergeWithNews(flattened.news);
  res.json({
    id: 'news-archive-flat',
    type: 'news-archive',
    news: mergedNews,
    createdAt: combinedLatestTime,
    lastUpdated: combinedLatestTime,
    lastCheckedAt: combinedLatestTime,
    refreshStatus: combinedRefreshStatus,
    responseMode: 'flat',
    total: flattened.total + Math.max(0, mergedNews.length - flattened.news.length),
    returned: mergedNews.length,
  });
});

app.get('/api/news/price-chart', (req, res) => {
  const kind = String(req.query.kind || '').toLowerCase();
  const product = String(req.query.product || '');
  if (kind === 'price-total') {
    const svg = priceTracking.renderChart(product);
    if (!svg) {
      res.status(404).json({ error: 'price history not found' });
      return;
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.type('image/svg+xml').send(svg);
    return;
  }
  if (kind === 'tungsten') {
    const svg = renderTungstenPriceChart(product);
    if (!svg) {
      res.status(404).json({ error: 'tungsten price history not found' });
      return;
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.type('image/svg+xml').send(svg);
    return;
  }
  const file = findSpotChartFile(kind, product);
  if (!file || !fs.existsSync(file)) {
    res.status(404).json({ error: 'price chart not found' });
    return;
  }
  res.sendFile(file);
});

app.post('/api/news', (req, res) => {
  const { news, type } = req.body;

  if (!news || !Array.isArray(news)) {
    return res.status(400).json({ error: 'Invalid news data. Expected { news: [...] }' });
  }

  const currentData = readNews();
  const newEntry = {
    id: Date.now().toString(),
    type: type || 'morning',
    news: news,
    createdAt: new Date().toISOString(),
  };

  currentData.entries = currentData.entries || [];
  currentData.entries.unshift(newEntry);

  if (currentData.entries.length > 50) {
    currentData.entries = currentData.entries.slice(0, 50);
  }

  currentData.lastUpdated = new Date().toISOString();

  if (writeNews(currentData)) {
    res.json({ success: true, entry: newEntry });
  } else {
    res.status(500).json({ error: 'Failed to save news' });
  }
});

app.get('/api/news/latest', (req, res) => {
  const data = readNews();
  const entries = data.entries || [];
  const latest = entries[0] || null;
  res.json(latest);
});

app.delete('/api/news', (req, res) => {
  if (writeNews({ entries: [], lastUpdated: new Date().toISOString() })) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Failed to clear news' });
  }
});

// 按 /Users/rayw/Documents/新闻资讯/news-intelligence skill 的来源与算法刷新新闻
app.post('/api/news/refresh', async (req, res) => {
  const requestedMode = typeof req.query.mode === 'string' ? req.query.mode : undefined;
  const mode = requestedMode === 'full' ? 'full' : 'quick';
  const options = {
    mode,
    since: typeof req.query.since === 'string' ? req.query.since : mode === 'quick' ? '1h' : undefined,
    limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : mode === 'quick' ? 2 : undefined,
    outputPerSource: typeof req.query.outputPerSource === 'string' ? Number(req.query.outputPerSource) : undefined,
  };
  const shouldWait = req.query.wait === '1' || req.query.wait === 'true';
  const effectiveSince = options.since || getNewsIncrementalSince(readNews());
  options.since = effectiveSince;

  const { started, promise } = ensureNewsIncrementalRefresh(options);
  const priceRefresh = priceTracking.triggerRefresh({ collect: true, manual: true });
  if (shouldWait) {
    const [result] = await Promise.all([promise, priceRefresh.promise]);
    const latestData = readNews();
    res.json({
      success: true,
      updating: false,
      started: started || priceRefresh.started,
      newsStarted: started,
      priceStarted: priceRefresh.started,
      since: effectiveSince,
      mode,
      refreshStatus: {
        ...(latestData.refreshStatus || result?.archive?.refreshStatus || newsRefreshStatus),
        price: priceTracking.getStatus(),
      },
      error: result?.error || null,
    });
    return;
  }
  res.json({
    success: true,
    updating: true,
    started: started || priceRefresh.started,
    newsStarted: started,
    priceStarted: priceRefresh.started,
    since: effectiveSince,
    mode,
    refreshStatus: {
      ...newsRefreshStatus,
      updating: true,
      price: priceTracking.getStatus(),
    },
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/build-meta', (req, res) => {
  try {
    const data = fs.readFileSync(BUILD_META_FILE, 'utf-8');
    res.type('application/json').send(data);
  } catch {
    res.json({
      buildId: 'unknown',
      builtAt: null,
      git: null,
      runId: null,
    });
  }
});

// MACD选股接口 - 调用Python脚本获取MACD数据
app.get('/api/macd', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    const asyncOnly = req.query.async === '1';
    const result = await loadMacdData(forceRefresh, asyncOnly);
    res.json({
      success: true,
      data: result.data,
      generatedAt: result.generatedAt,
      cached: result.cached,
      stale: result.stale,
      updating: result.updating,
    });
  } catch (err) {
    console.error('MACD API error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/quant/overview', async (req, res) => {
  try {
    res.json({ success: true, data: await getQuantOverview({ includeSignals: req.query.signals === '1' }) });
  } catch (err) {
    console.error('Quant overview error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/quant/backtest', async (req, res) => {
  try {
    res.json({ success: true, data: await runQuantBacktest(req.body || {}) });
  } catch (err) {
    console.error('Quant backtest error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/quant/iterate', async (req, res) => {
  try {
    res.json({ success: true, data: await runQuantIteration() });
  } catch (err) {
    console.error('Quant iteration error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/quant/experiments', (req, res) => {
  try {
    res.json({ success: true, data: getQuantExperiments() });
  } catch (err) {
    console.error('Quant experiments error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/quant/history-backfill', async (req, res) => {
  try {
    const payload = req.body || {};
    res.json({
      success: true,
      data: await runQuantHistoryBackfill({
        maxCodes: Number(payload.maxCodes) || 5,
        delay: Number(payload.delay) || 2,
      }),
    });
  } catch (err) {
    console.error('Quant history backfill error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// TMT两融集中度接口
app.use('/api/tmt-margin', tmtMarginRouter);
app.use('/api/etf-monitor', etfMonitorRouter);
app.use('/api/research', researchRouter);
app.use('/api/calendar', calendarRouter);

// 研究报告（cninfo/earnings）的原始文件 xlsx/pdf 静态服务
const REPORTS_DIR = process.env.RESEARCH_REPORTS_DIR || path.join(__dirname, 'public/reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
app.use('/reports', express.static(REPORTS_DIR));

// Single stock quote
app.get('/api/quote', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    const QUOTE_BASE = process.env.QUOTE_SERVICE_URL || 'http://localhost:3001';
    const response = await fetch(`${QUOTE_BASE}/quotes?code=${code}`);
    res.json(await response.json());
  } catch {
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

// Stock quote sync - calls Python quote service on port 3001
	app.post('/api/sync', async (req, res) => {
	  const { fundId, codes } = req.body;
	  if (!codes || !Array.isArray(codes)) {
	    return res.status(400).json({ success: false, error: 'codes required' });
	  }
	  try {
	    const https = await import('https');
	    const SINA_QUOTE = 'https://hq.sinajs.cn/list=';
	    const HEADERS_SINA = {
	      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
	      'Referer': 'https://finance.sina.com.cn'
	    };
	    const prices = {};
	    const normalized = codes.map(c => {
	      if (c.match(/^(sh|sz|hk|us|bj)/)) return c;
	      // 北交所代码：4xx/8xx/9xx/83xxxx/92xxxx 等均以 bj 前缀
	      if (c.startsWith('4') || c.startsWith('8') || c.startsWith('9')) return 'bj' + c;
	      if (c.match(/^(0|3|002|003)/)) return 'sz' + c;
	      return 'sh' + c;
	    });
	    for (let i = 0; i < normalized.length; i += 50) {
	      const batch = normalized.slice(i, i + 50);
	      const url = SINA_QUOTE + batch.join(',');
	      try {
	        const raw = await new Promise((resolve, reject) => {
	          const r = https.get(url, { headers: HEADERS_SINA }, (resp) => {
	            let d = '';
	            resp.on('data', c => d += c);
	            resp.on('end', () => resolve(d));
	          });
	          r.on('error', reject);
	          r.setTimeout(10000, () => { r.destroy(); reject(new Error('timeout')); });
	        });
	        const lines = raw.toString('gbk').split('\n');
	        for (const line of lines) {
	          if (!line.includes('hq_str_') || !line.includes('="')) continue;
	          try {
	            const codeKey = line.split('hq_str_')[1].split('=')[0].trim();
	            const dataStr = line.split('"')[1];
	            const parts = dataStr.split(',');
	            if (parts.length < 6) continue;
	            prices[codeKey] = {
	              currentPrice: parseFloat(parts[3]),
	              prevClose: parseFloat(parts[2]),
	              pctChg: parseFloat(parts[2]) > 0 ? ((parseFloat(parts[3]) - parseFloat(parts[2])) / parseFloat(parts[2]) * 100) : 0
	            };
	            // Also store by original code (before normalization) so frontend lookup works
	            const origCode = codeKey.replace(/^(sh|sz|bj|hk|us)/, '');
	            prices[origCode] = prices[codeKey];
	          } catch (e) {}
	        }
	      } catch (e) { console.error('Sina batch error:', i, e.message); }
	    }
	    const today = new Date().toISOString().split('T')[0];
	    console.log(`/api/sync: ${Object.keys(prices).length} prices`);
	    res.json({ success: true, tradeDate: today, prices });
	  } catch (err) {
	    res.json({ success: false, error: err.message });
	  }
	});


// HK stock quote sync via Yahoo Finance
app.post('/api/sync/hk', async (req, res) => {
  const { codes } = req.body;
  if (!codes || !Array.isArray(codes)) {
    return res.status(400).json({ success: false, error: 'codes required' });
  }
  try {
    const prices = {};
    await Promise.all(codes.map(async (code) => {
      try {
        const symbol = code.endsWith('.HK') ? code : `${code}.HK`;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
        });
        const json = await resp.json();
        const result = json?.chart?.result?.[0];
        if (result) {
          const meta = result.meta;
          const currentPrice = meta.regularMarketPrice;
          const prevClose = meta.chartPreviousClose;
          const pctChg = prevClose > 0 ? ((currentPrice - prevClose) / prevClose * 100) : 0;
          prices[code] = { currentPrice, prevClose, pctChg };
        }
      } catch (e) { /* skip failed code */ }
    }));
    const today = new Date().toISOString().split('T')[0];
    res.json({ success: true, tradeDate: today, prices });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// US stock quote sync via Yahoo Finance
app.post('/api/sync/us', async (req, res) => {
  const { codes } = req.body;
  if (!codes || !Array.isArray(codes)) {
    return res.status(400).json({ success: false, error: 'codes required' });
  }
  try {
    const prices = {};
    await Promise.all(codes.map(async (code) => {
      try {
        const symbol = encodeURIComponent(code);
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
        });
        const json = await resp.json();
        const result = json?.chart?.result?.[0];
        if (result) {
          const meta = result.meta;
          const currentPrice = meta.regularMarketPrice;
          const prevClose = meta.chartPreviousClose;
          const pctChg = prevClose > 0 ? ((currentPrice - prevClose) / prevClose * 100) : 0;
          prices[code] = { currentPrice, prevClose, pctChg };
        }
      } catch (e) { /* skip failed code */ }
    }));
    const today = new Date().toISOString().split('T')[0];
    res.json({ success: true, tradeDate: today, prices });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Japan stock quote sync via Yahoo Finance
app.post('/api/sync/jp', async (req, res) => {
  const { codes } = req.body;
  if (!codes || !Array.isArray(codes)) {
    return res.status(400).json({ success: false, error: 'codes required' });
  }
  try {
    const prices = {};
    await Promise.all(codes.map(async (code) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}?interval=1d&range=1d`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
        });
        const json = await resp.json();
        const result = json?.chart?.result?.[0];
        if (result) {
          const meta = result.meta;
          const currentPrice = meta.regularMarketPrice;
          const prevClose = meta.chartPreviousClose;
          const pctChg = prevClose > 0 ? ((currentPrice - prevClose) / prevClose * 100) : 0;
          prices[code] = { currentPrice, prevClose, pctChg };
        }
      } catch (e) { /* skip failed code */ }
    }));
    const today = new Date().toISOString().split('T')[0];
    res.json({ success: true, tradeDate: today, prices });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Korea stock quote sync via Yahoo Finance
app.post('/api/sync/kr', async (req, res) => {
  const { codes } = req.body;
  if (!codes || !Array.isArray(codes)) {
    return res.status(400).json({ success: false, error: 'codes required' });
  }
  try {
    const prices = {};
    await Promise.all(codes.map(async (code) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}?interval=1d&range=1d`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
        });
        const json = await resp.json();
        const result = json?.chart?.result?.[0];
        if (result) {
          const meta = result.meta;
          const currentPrice = meta.regularMarketPrice;
          const prevClose = meta.chartPreviousClose;
          const pctChg = prevClose > 0 ? ((currentPrice - prevClose) / prevClose * 100) : 0;
          prices[code] = { currentPrice, prevClose, pctChg };
        }
      } catch (e) { /* skip failed code */ }
    }));
    const today = new Date().toISOString().split('T')[0];
    res.json({ success: true, tradeDate: today, prices });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

const MARKET_INDICES = {
  a: [
    { code: '000001.SS', name: '上证指数', emSecid: '1.000001' },
    { code: '399001.SZ', name: '深证成指', emSecid: '0.399001' },
    { code: '000300.SS', name: '沪深300', emSecid: '1.000300' },
    { code: '000905.SS', name: '中证500', emSecid: '1.000905' },
    { code: '000852.SS', name: '中证1000', emSecid: '1.000852' },
    { code: '000688.SS', name: '科创50', emSecid: '1.000688' },
    { code: '399006.SZ', name: '创业板指', emSecid: '0.399006' },
    { code: '899050.BJ', name: '北证50', emSecid: '0.899050' },
  ],
  hk: [
    { code: '^HSI', name: '恒生指数' },
    { code: '3033.HK', name: '恒生科技' },
    { code: '^HSCE', name: '国企指数' },
    { code: '2800.HK', name: '盈富基金' },
  ],
  us: [
    { code: '^NDX', name: '纳斯达克100' },
    { code: '^GSPC', name: '标普500' },
    { code: '^DJI', name: '道琼斯' },
    { code: 'NQ=F', name: '纳指期货' },
    { code: 'ES=F', name: '标普期货' },
    { code: 'YM=F', name: '道指期货' },
    { code: '^SOX', name: '费城半导体' },
    { code: '^RUT', name: '罗素2000' },
    { code: '^VIX', name: 'VIX' },
    { code: 'DX-Y.NYB', name: '美元指数' },
    { code: 'TLT', name: '美债长债' },
  ],
  jp: [
    { code: '^N225', name: '日经225' },
    { code: '^TPX', name: 'TOPIX' },
    { code: '1306.T', name: 'TOPIX ETF' },
    { code: '285A.T', name: 'Kioxia' },
    { code: '8035.T', name: '东京电子' },
    { code: '6981.T', name: '村田制作所' },
  ],
  kr: [
    { code: '^KS11', name: 'KOSPI' },
    { code: '^KQ11', name: 'KOSDAQ' },
    { code: '005930.KS', name: '三星电子' },
    { code: '000660.KS', name: 'SK海力士' },
  ],
};

const fetchEastmoneyIndices = async (indices) => {
  const secids = indices.map((index) => index.emSecid).filter(Boolean).join(',');
  if (!secids) {
    return indices.map((index) => ({ ...index, currentPrice: null, prevClose: null, pctChg: null }));
  }

  const fields = 'f12,f14,f2,f3,f18';
  const hosts = [
    'https://push2delay.eastmoney.com',
    'https://push2.eastmoney.com',
    'https://82.push2.eastmoney.com',
  ];

  let quotes = [];
  let lastError = null;

  for (const host of hosts) {
    try {
      const url = `${host}/api/qt/ulist.np/get?fltt=2&fields=${fields}&secids=${encodeURIComponent(secids)}`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Referer: 'https://quote.eastmoney.com/',
        },
      });
      const json = await resp.json();
      quotes = json?.data?.diff || [];
      if (Array.isArray(quotes) && quotes.length > 0) break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!Array.isArray(quotes) || quotes.length === 0) {
    console.warn('[market-indices] Eastmoney A-share quote failed:', lastError?.message || 'empty response');
  }

  const quoteByCode = new Map(quotes.map((quote) => [String(quote.f12), quote]));

  return indices.map((index) => {
    const emCode = index.emSecid?.split('.')?.[1];
    const quote = quoteByCode.get(emCode);
    const currentPrice = Number(quote?.f2);
    const pctChg = Number(quote?.f3);
    const prevClose = Number(quote?.f18);

    return {
      ...index,
      currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
      prevClose: Number.isFinite(prevClose) ? prevClose : null,
      pctChg: Number.isFinite(pctChg) ? pctChg : null,
    };
  });
};

const fetchJsonWithTimeout = async (url, options = {}, timeoutMs = 4500) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
};

const fetchYahooIndexQuote = async (index) => {
  const encodedCode = encodeURIComponent(index.code);
  const hosts = [
    'https://query1.finance.yahoo.com',
    'https://query2.finance.yahoo.com',
  ];
  let lastError = null;

  for (const host of hosts) {
    try {
      const url = `${host}/v8/finance/chart/${encodedCode}?interval=1d&range=1d`;
      const json = await fetchJsonWithTimeout(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      });
      const meta = json?.chart?.result?.[0]?.meta;
      const currentPrice = Number(meta?.regularMarketPrice);
      const prevClose = Number(meta?.chartPreviousClose ?? meta?.previousClose ?? currentPrice);
      const pctChg = prevClose > 0 ? ((currentPrice - prevClose) / prevClose * 100) : null;

      return {
        ...index,
        currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
        prevClose: Number.isFinite(prevClose) ? prevClose : null,
        pctChg: Number.isFinite(pctChg) ? pctChg : null,
      };
    } catch (err) {
      lastError = err;
    }
  }

  console.warn(`[market-indices] Yahoo quote failed for ${index.code}:`, lastError?.message || 'empty response');
  return { ...index, currentPrice: null, prevClose: null, pctChg: null };
};

// Market index overview
app.get('/api/market-indices', async (req, res) => {
  const market = req.query.market;
  const allIndices = MARKET_INDICES[market] || MARKET_INDICES.a;
  const requestedCodes = typeof req.query.codes === 'string'
    ? req.query.codes.split(',').map((code) => code.trim()).filter(Boolean)
    : [];
  const indices = requestedCodes.length > 0
    ? requestedCodes.map((code) => allIndices.find((index) => index.code === code) || { code, name: code }).slice(0, 4)
    : allIndices.slice(0, 4);
  try {
    if (market === 'a') {
      const results = await fetchEastmoneyIndices(indices);
      res.json({ success: true, market, indices: results });
      return;
    }

    const results = await Promise.all(indices.map(fetchYahooIndexQuote));
    res.json({ success: true, market, indices: results });
  } catch (err) {
    res.json({ success: false, error: err.message, market, indices: [] });
  }
});

// K-line historical data proxy
app.get('/api/kline', async (req, res) => {
  const { code, period, count } = req.query;
  if (!code) {
    return res.status(400).json({ success: false, error: 'code required' });
  }
  try {
    const QUOTE_BASE = process.env.QUOTE_SERVICE_URL || 'http://localhost:3001';
    const response = await fetch(`${QUOTE_BASE}/kline?code=${code}&period=${period || 'daily'}&count=${count || '60'}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch kline' });
  }
});

// Funds portfolio persistence
function readFunds() {
  try {
    if (fs.existsSync(FUNDS_FILE)) {
      const data = fs.readFileSync(FUNDS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error reading funds:', error);
  }
  return { funds: [], lastUpdated: null };
}

function writeFunds(data) {
  try {
    fs.writeFileSync(FUNDS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error('Error writing funds:', error);
    return false;
  }
}

app.post('/api/anomaly/research', async (req, res) => {
  const payload = req.body || {};
  const queries = buildAnomalyQueries(payload).slice(0, 3);

  try {
    const allSources = [];
    const cleanFundName = String(payload.fundName || '').replace(/^(美股|日股|韩国|韩股|港股|A股)/, '');
    if (cleanFundName.includes('钨')) {
      allSources.push(...await fetchTungstenIndustrySignals());
    }
    for (const query of queries) {
      const encoded = encodeURIComponent(query);
      const urls = [
        {
          source: 'Google News',
          url: `https://news.google.com/rss/search?q=${encoded}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`,
        },
        {
          source: 'Bing News',
          url: `https://www.bing.com/news/search?q=${encoded}&format=rss`,
        },
      ];

      const batches = await Promise.all(urls.map(async ({ source, url }) => {
        try {
          const xml = await fetchTextWithTimeout(url, 7000);
          return parseRssItems(xml, source).map((item) => ({ ...item, query }));
        } catch (error) {
          console.warn(`[anomaly-research] ${source} failed for ${query}:`, error.message);
          return [];
        }
      }));
      allSources.push(...batches.flat());
    }

    const sources = rankAnomalySources(
      payload,
      uniqueByUrlOrTitle(allSources).filter((source) => isRecentAnomalySource(source, 3))
    ).slice(0, 8);
    const summary = classifyAnomalyResult(payload, sources);
    const newsEntry = upsertMacroNewsItems(sources, 'anomaly-research');
    res.json({
      success: true,
      version: 'active-anomaly-v2',
      queries,
      ...summary,
      sources,
      newsPublished: !!newsEntry,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[anomaly-research] failed:', error);
    res.status(500).json({ success: false, error: error.message, queries, sources: [] });
  }
});

// Funds API endpoints
app.get('/api/funds', (req, res) => {
  res.json(readFunds());
});

app.post('/api/funds', (req, res) => {
  const { funds } = req.body;
  if (!Array.isArray(funds)) {
    return res.status(400).json({ error: 'Invalid funds data. Expected { funds: [...] }' });
  }
  if (writeFunds({ funds, lastUpdated: new Date().toISOString() })) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Failed to save funds' });
  }
});

// Refresh all fund positions with fresh quotes from Sina
app.post('/api/funds/refresh', async (req, res) => {
  try {
    const fundsData = readFunds();
    const { spawn } = await import('child_process');
    const https = await import('https');

    // Collect all unique stock codes (ensure sh/sz prefix)
    const allCodes = new Set();
    for (const fund of fundsData.funds) {
      for (const pos of fund.positions) {
        let c = pos.code;
        if (!c.match(/^(sh|sz|hk|us|bj)/)) {
          if (c.startsWith('4') || c.startsWith('8') || c.startsWith('9')) c = 'bj' + c;
          else if (c.match(/^(0|3|002|003)/)) c = 'sz' + c;
          else c = 'sh' + c;
        }
        allCodes.add(c);
      }
    }

    // Fetch all quotes from Sina in parallel batches
    const SINA_QUOTE = 'https://hq.sinajs.cn/list=';
    const HEADERS_SINA = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': 'https://finance.sina.com.cn'
    };

    const quotes = {};
    const codeArr = Array.from(allCodes);

    for (let i = 0; i < codeArr.length; i += 50) {
      const batch = codeArr.slice(i, i + 50);
      const url = SINA_QUOTE + batch.join(',');
      try {
        const raw = await new Promise((resolve, reject) => {
          const req = https.get(url, { headers: HEADERS_SINA }, (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => resolve(d));
          });
          req.on('error', reject);
          req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
        });
        const lines = raw.toString('gbk').split('\n');
        for (const line of lines) {
          if (!line.includes('hq_str_') || !line.includes('="')) continue;
          try {
            const codePart = line.split('hq_str_')[1].split('=')[0].trim();
            const dataStr = line.split('"')[1];
            const parts = dataStr.split(',');
            if (parts.length < 6) continue;
            quotes[codePart] = {
              current: parseFloat(parts[3]),
              prevClose: parseFloat(parts[2]),
            };
          } catch (e) { /* skip bad line */ }
        }
      } catch (e) {
        console.error('Batch error:', i, e.message);
      }
    }

    // Update each position's currentPrice and prevClose
    for (const fund of fundsData.funds) {
      let totalPrevValue = 0;
      let totalCurrValue = 0;
      let activePositionCount = 0;
      let freshQuoteCount = 0;
      for (const pos of fund.positions) {
        const shares = Number(pos.shares);
        if (!Number.isFinite(shares) || shares <= 0) continue;
        activePositionCount += 1;
        let c = pos.code;
        if (!c.match(/^(sh|sz|hk|us|bj)/)) {
          if (c.startsWith('4') || c.startsWith('8') || c.startsWith('9')) c = 'bj' + c;
          else if (c.match(/^(0|3|002|003)/)) c = 'sz' + c;
          else c = 'sh' + c;
        }
        const q = quotes[c];
        if (q && Number.isFinite(q.current) && q.current > 0 && Number.isFinite(q.prevClose) && q.prevClose > 0) {
          pos.prevClose = q.prevClose;
          pos.currentPrice = q.current;
          freshQuoteCount += 1;
        }
        const mv = shares * Number(pos.currentPrice);
        const prevMv = shares * Number(pos.prevClose);
        totalCurrValue += mv;
        totalPrevValue += prevMv;
      }
      const minimumFreshQuotes = Math.max(1, Math.ceil(activePositionCount * 0.8));
      // Never persist a partial/invalid NAV when a quote provider is unavailable.
      // Keeping the previous valid point is safer than drawing a false crash.
      if (
        activePositionCount === 0 ||
        freshQuoteCount < minimumFreshQuotes ||
        !Number.isFinite(totalCurrValue) ||
        !Number.isFinite(totalPrevValue) ||
        totalCurrValue <= 0 ||
        totalPrevValue <= 0
      ) {
        console.warn(`[NAV] Skip unreliable snapshot for ${fund.name}: quotes=${freshQuoteCount}/${activePositionCount}, current=${totalCurrValue}, previous=${totalPrevValue}`);
        continue;
      }

      const navToday = totalCurrValue / totalPrevValue;
      const today = new Date().toISOString().split('T')[0];
      const existingIdx = fund.navHistory.findIndex(h => h.date === today);
      const entry = {
        date: today,
        nav: parseFloat((navToday * (fund.navHistory[fund.navHistory.length - 1]?.nav || 1)).toFixed(6)),
        cumulativeNav: parseFloat((navToday * (fund.navHistory[fund.navHistory.length - 1]?.cumulativeNav || 1)).toFixed(6)),
        marketValue: Math.round(totalCurrValue * 100) / 100,
      };
      if (existingIdx >= 0) fund.navHistory[existingIdx] = entry;
      else fund.navHistory.push(entry);
    }

    fundsData.lastUpdated = new Date().toISOString();
    writeFunds(fundsData);
    res.json({ success: true, count: Object.keys(quotes).length });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// SPA fallback - only for non-API, non-file routes
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.includes('.')) {
    return next();
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

function getDailySyncKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'Asia/Shanghai' });
}

function getNextResearchSyncDelay(targetTime) {
  const [hourStr, minuteStr] = targetTime.split(':');
  const targetHour = Number(hourStr);
  const targetMinute = Number(minuteStr);
  const now = new Date();
  const next = new Date(now);
  next.setHours(targetHour, targetMinute, 0, 0);

  if (Number.isNaN(targetHour) || Number.isNaN(targetMinute)
      || targetHour < 0 || targetHour > 23 || targetMinute < 0 || targetMinute > 59) {
    throw new Error(`Invalid RESEARCH_AUTO_SYNC_TIME: ${targetTime}`);
  }

  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
}

function isAfterDailyTarget(targetTime) {
  const [hourStr, minuteStr] = targetTime.split(':');
  const targetHour = Number(hourStr);
  const targetMinute = Number(minuteStr);

  if (Number.isNaN(targetHour) || Number.isNaN(targetMinute)
      || targetHour < 0 || targetHour > 23 || targetMinute < 0 || targetMinute > 59) {
    throw new Error(`Invalid RESEARCH_AUTO_SYNC_TIME: ${targetTime}`);
  }

  const now = new Date();
  const target = new Date(now);
  target.setHours(targetHour, targetMinute, 0, 0);
  return now.getTime() >= target.getTime();
}

function startDailyResearchAutoSync() {
  const targetTime = process.env.RESEARCH_AUTO_SYNC_TIME || '22:10';
  let firstDelay;

  try {
    firstDelay = getNextResearchSyncDelay(targetTime);
  } catch (error) {
    console.error('[research-sync] invalid RESEARCH_AUTO_SYNC_TIME:', error.message);
    return;
  }

  const run = async () => {
    const todayKey = getDailySyncKey();
    if (researchSyncInFlight) return;
    if (lastAutoSyncDate === todayKey) return;

    researchSyncInFlight = true;
    try {
      const result = await syncResearch({ kind: 'all', days: 14, force: false });
      markSyncResultCompletions(result, 'daily-auto-sync');
      lastAutoSyncDate = todayKey;
      const totals = result.totals;
      console.log(
        `[research-sync] auto run for ${todayKey} -> changed=${totals.changedDates}, copied=${totals.filesCopied}, failed=${totals.failed}`,
      );
    } catch (error) {
      console.error('[research-sync] auto sync failed:', error.message);
    } finally {
      researchSyncInFlight = false;
    }
  };

  setTimeout(() => {
    run();
    setInterval(run, 24 * 60 * 60 * 1000);
  }, firstDelay);

  if (isAfterDailyTarget(targetTime) && lastAutoSyncDate !== getDailySyncKey()) {
    setTimeout(() => {
      run();
    }, 1500);
  }

  console.log(`[research-sync] scheduled at ${targetTime} daily`);
}

function startNewsAutoRefresh() {
  hydrateCachedTungstenPriceWatch();
  const shouldRefresh = () => {
    const data = readNews();
    const lastMs = Date.parse(data.lastCheckedAt || data.lastUpdated || '');
    if (!Number.isFinite(lastMs)) return true;
    return Date.now() - lastMs >= NEWS_AUTO_REFRESH_STALE_MS;
  };

  const run = () => {
    if (newsRefreshInFlight || !shouldRefresh()) return;
    const since = getNewsIncrementalSince(readNews());
    console.log(`[news-refresh] auto full refresh since=${since}`);
    ensureNewsIncrementalRefresh({ since, mode: 'full' });
  };

  setTimeout(run, 5000);
  setInterval(run, NEWS_AUTO_REFRESH_INTERVAL_MS);
  setTimeout(() => ensureFixedPriceWatchRefresh(), 2000);
  setInterval(() => ensureFixedPriceWatchRefresh(), NEWS_AUTO_REFRESH_INTERVAL_MS);
  const pollBlsReleaseWindow = async () => {
    const now = new Date();
    const shanghaiHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(now));
    const shanghaiMinute = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', minute: '2-digit' }).format(now));
    if (shanghaiHour !== 20 || shanghaiMinute < 25) return;
    try {
      const items = await fetchBlsCpiNews();
      upsertMacroNewsItems(items.map((item) => ({
        title: item.title,
        source: item.source_name,
        publishedAt: item.published_at,
        url: item.url,
        summary: item.content_snippet,
      })), 'macro-official', { sourceId: 'bls-cpi' });
    } catch (error) {
      console.warn(`[news-refresh] BLS CPI check failed: ${error.message}`);
    }
  };
  setInterval(pollBlsReleaseWindow, 60 * 1000);
  console.log(`[news-refresh] scheduled every ${Math.round(NEWS_AUTO_REFRESH_INTERVAL_MS / 60000)} min, stale after ${Math.round(NEWS_AUTO_REFRESH_STALE_MS / 60000)} min`);
}

app.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   🏢 石锋资产投研平台 - API 服务已启动                    ║
║                                                          ║
║   API 地址: http://localhost:${PORT}                       ║
║                                                          ║
║   接口列表:                                              ║
║   • GET  /api/news        - 获取所有新闻                  ║
║   • GET  /api/news/latest - 获取最新新闻                  ║
║   • POST /api/news        - 添加新闻 { news: [...] }      ║
║   • DELETE/api/news       - 清空新闻                      ║
║   • GET  /api/health      - 健康检查                      ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`);
  if (process.env.DISABLE_BACKGROUND_JOBS !== '1') {
    startDailyResearchAutoSync();
    startNewsAutoRefresh();
    priceTracking.startAutoRefresh();
  }
});
