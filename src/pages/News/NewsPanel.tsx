import React, { useMemo, useState } from 'react';
import { Button, Card, Divider, Empty, Input, Space, Spin, Tabs, Tag, Tooltip, Typography } from 'antd';
import { ClockCircleOutlined, FireOutlined, QuestionCircleOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useTheme } from '../../hooks/useTheme';
import { useNewsFeed, type NewsItem } from '../../hooks/useNewsFeed';
import { API_BASE } from '../../config/api';

const { Text } = Typography;

const WEEKDAY_MAP = ['日', '一', '二', '三', '四', '五', '六'];
const TOPIC_OPTIONS = ['全部', '宏观', 'AI 涨价', '硬件', '软件', '消费'] as const;
const SIGNAL_BUCKETS = ['利好涨价', '利空降价', '供需紧张', '需求改善', '宏观政策', '其他信号'] as const;
const DISPLAY_TIME_ZONE = 'Asia/Shanghai';
const MIN_VISIBLE_SCORE = 100;
const isMajorMacroRelease = (item: Pick<NewsItem, 'title' | 'snippet' | 'source'>) =>
  /(?:CPI|PCE|非农|FOMC|消费者价格指数|美国劳工统计局|BLS)/i.test(`${item.title || ''} ${item.snippet || ''} ${item.source || ''}`);
const NEWS_PAGE_SIZE = 10;
const HOT_SIGNAL_WINDOW_MS = 8 * 60 * 60 * 1000;
const SIGNAL_VISIBILITY_EXCEPTIONS = new Set(['利好涨价', '利空降价', '供需紧张', '需求改善']);
const NON_INVESTABLE_NOISE_PATTERN = /村民|棍棒|赶蛇|蛇毒|血清|救治需求|空调|省电|天气|民生|高铁|站房|绿道|景区|婚恋|宠物|养生|病例|医院/i;
const PROMOTIONAL_GIVEAWAY_PATTERN = /(?:福利|抽奖|免费抽|参与抽奖|扫码(?:参与|领取|抽奖)|奖品|一等奖|二等奖|三等奖|赠品|关注有礼|下载有礼|报名(?:即送|领取)|AirPods.{0,20}(?:抽|送)|订阅.{0,20}(?:抽奖|领奖))/i;
const MARKET_TAPE_UPDATE_PATTERN = /(?:A股|港股|美股|沪指|深成指|创业板|科创50|北证50|上证指数|恒生指数|恒指|纳指|标普|道指).{0,24}(?:三大|四大)?(?:指数)?.{0,16}(?:集体)?(?:高开|低开|上涨|下跌|翻红|转跌|涨跌互现)|(?:三大|四大)(?:股指|指数).{0,12}(?:集体)?(?:高开|低开|上涨|下跌)|(?:A股|港股|美股)(?:午评|收评|开盘|盘中|尾盘)|盘面播报/i;
const MARKET_TAPE_CATALYST_PATTERN = /降息|加息|关税|制裁|监管|政策|央行|CPI|PCE|非农|PMI|战争|冲突|熔断|停牌|重大资产重组|并购|业绩预告/i;

const isPromotionalGiveaway = (item: {
  title?: string;
  summary?: string;
  snippet?: string;
  content?: string;
  originalText?: string;
}) => PROMOTIONAL_GIVEAWAY_PATTERN.test([
  item.title,
  item.summary,
  item.snippet,
  item.content,
  item.originalText,
].filter(Boolean).join(' '));
const isMarketTapeNoise = (item: { title?: string }) => {
  const title = item.title || '';
  return MARKET_TAPE_UPDATE_PATTERN.test(title) && !MARKET_TAPE_CATALYST_PATTERN.test(title);
};
const INVESTABLE_SIGNAL_CONTEXT_PATTERN = /ai|算力|gpu|hbm|dram|nand|ssd|mlcc|pcb|ccl|cowos|芯片|半导体|服务器|数据中心|光模块|铜箔|玻纤布|钨|钨矿|金属|涨价|降价|报价|均价|asp|订单|客户|出货|产能|库存|供给|供应|需求|景气|复苏|回暖|capex|资本开支|公司|收入|利润|销量|交付|消费|零售|电商|汽车|家电|白酒|餐饮|旅游|美妆/i;
const DEMAND_SIGNAL_CONTEXT_PATTERN = /订单|客户|采购|购买|批准|获批|h200|nvidia|英伟达|算力|出货|销量|交付|下游|景气|复苏|回暖|需求改善|需求回升|需求强劲|需求增长|库存去化|供需|产能|收入|利润|业绩/i;
export const SIGNAL_TONE: Record<SignalBucket, { color: string; bg: string; mark: string }> = {
  利好涨价: { color: '#dc2626', bg: '#fee2e2', mark: '↑' },
  利空降价: { color: '#16a34a', bg: '#dcfce7', mark: '↓' },
  供需紧张: { color: '#f97316', bg: '#ffedd5', mark: '!' },
  需求改善: { color: '#22c55e', bg: '#dcfce7', mark: 'D' },
  宏观政策: { color: '#2563eb', bg: '#dbeafe', mark: 'M' },
  其他信号: { color: '#6b7280', bg: '#f3f4f6', mark: '·' },
};

export type NewsTopic = (typeof TOPIC_OPTIONS)[number];
export type SignalBucket = (typeof SIGNAL_BUCKETS)[number];

const SOURCE_TYPE_TO_TOPIC: Record<string, NewsTopic> = {
  official: '软件',
  media: '宏观',
  academic: '软件',
  wechat: '软件',
  newsletter: '软件',
  social: '软件',
  x: '软件',
  policy: '宏观',
  developer: '软件',
  公司官方: '软件',
  行业媒体: '宏观',
  学术平台: '软件',
  微信公众号: '软件',
  开发者社区: '软件',
  社交媒体: '软件',
  政策法规: '宏观',
};

const INVESTMENT_CATEGORY_KEYWORDS: Record<Exclude<NewsTopic, '全部'>, string[]> = {
  'AI 涨价': [
    '涨价',
    '提价',
    '喊涨',
    '调涨',
    '价格上调',
    '价格上涨',
    '报价上涨',
    'price increase',
    'price hike',
    'asp hike',
    'raise prices',
    'contract price',
    'asp',
    'shortage',
    'tight supply',
    '供不应求',
    '供应紧张',
    '产能紧张',
    'hbm',
    'dram',
    'nand',
    'mlcc',
    'ccl',
    'pcb',
    '玻纤布',
    '铜箔',
    '光模块',
    'cowos',
    '先进封装',
  ],
  宏观: ['非农', 'cpi', 'ppi', 'pce', '通胀', '降息', '加息', '利率', '美联储', 'fed', 'gdp', 'pmi', '就业', '汇率', '关税', 'tariff', '地缘', '原油', '债券', '监管', '政策'],
  硬件: ['gpu', 'nvidia', '英伟达', '芯片', '半导体', 'tsmc', '台积电', 'broadcom', 'avgo', 'asic', 'hbm', 'dram', 'nand', '服务器', 'server', 'datacenter', '数据中心', 'cowos', '先进封装', '光模块', 'optical', 'photonics', 'pcb', 'ccl', 'mlcc', '晶圆', '机器人', 'robotics'],
  软件: ['openai', 'anthropic', 'claude', 'chatgpt', 'gpt', 'gemini', 'deepmind', 'llm', '大模型', '模型', 'agent', '智能体', 'api', 'saas', 'software', '软件', 'cloud', '开发者', 'github', 'hugging face', 'mcp', '应用', 'app'],
  消费: ['消费', 'retail', '零售', '电商', 'ecommerce', '品牌', '食品', '饮料', '餐饮', 'coffee', '咖啡', '美妆', '化妆品', '服装', '旅游', 'travel', '酒店', '家电', '汽车', 'auto', 'ev', 'tesla', 'model y', '白酒', '啤酒', '快消'],
};

export interface EnrichedNewsItem extends NewsItem {
  topic: NewsTopic;
  score: number;
  sourceCount: number;
  digest: string;
  dateLabel: string;
  dateSort: number;
  isNew: boolean;
}

type NewsDisplayLike = Pick<EnrichedNewsItem, 'title' | 'snippet' | 'source' | 'digest'>;

const normalizeTitle = (title: string) =>
  title
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/ai进化速递|快讯|更新|独家|突发|最新|今日|分钟前|小时前/g, '')
    .replace(/\s+/g, '')
    .replace(/[\u200b-\u200f\u00ad]/g, '')
    .replace(/[^\w\u4e00-\u9fff]/g, '');

const canonicalizeEventToken = (value: string) =>
  value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w.-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

const getCanonicalEventSubject = (text: string) => {
  const rules: Array<[RegExp, string, string]> = [
    [/openai|chatgpt/i, 'openai', 'OpenAI'],
    [/anthropic|claude/i, 'anthropic', 'Anthropic'],
    [/xai|x\.ai|grok/i, 'xai', 'xAI'],
    [/google|gemini|deepmind|\$?googl\b/i, 'google', 'Google'],
    [/meta|zuckerberg|\$?meta\b/i, 'meta', 'Meta'],
    [/microsoft|\$?msft\b/i, 'microsoft', 'Microsoft'],
    [/amazon|aws|\$?amzn\b/i, 'amazon', 'Amazon'],
    [/deepseek/i, 'deepseek', 'DeepSeek'],
    [/minimax/i, 'minimax', 'MiniMax'],
    [/kimi|moonshot/i, 'kimi', 'Kimi'],
    [/nvidia|英伟达|\$?nvda\b/i, 'nvidia', '英伟达'],
    [/tsmc|台积电|\$?tsm\b/i, 'tsmc', '台积电'],
    [/samsung|三星/i, 'samsung', '三星'],
    [/sk hynix|海力士/i, 'sk-hynix', 'SK海力士'],
    [/micron|美光|\$?mu\b/i, 'micron', '美光'],
    [/china|中国|beijing|北京|alibaba|阿里|bytedance|字节|头部ai|ai firms?/i, 'china-ai-firms', '中国头部AI公司'],
  ];
  const match = rules.find(([pattern]) => pattern.test(text));
  return match ? { key: match[1], label: match[2] } : null;
};

const getCanonicalEventObject = (text: string) => {
  const rules: Array<[RegExp, string, string]> = [
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
    [/钨粉/i, 'tungsten-powder', '钨粉'],
    [/钨精矿|黑钨精矿|钨矿|tungsten/i, 'tungsten', '钨矿'],
    [/废钨棒材/i, 'waste-tungsten-bar', '废钨棒材'],
    [/\bR32\b|制冷剂R32/i, 'r32', 'R32'],
    [/金属铪|hafnium/i, 'hafnium', '金属铪'],
    [/Q5500|动力煤/i, 'q5500', 'Q5500动力煤'],
    [/data center|datacenter|数据中心/i, 'data-center', '数据中心'],
    [/robot|机器人/i, 'robot', '机器人'],
  ];
  for (const [pattern, key, label] of rules) {
    const match = text.match(pattern);
    if (match) {
      const raw = label || match[0].replace(/\s+/g, ' ').trim();
      return { key: key || canonicalizeEventToken(raw), label: raw };
    }
  }
  return null;
};

const getCanonicalEventAction = (text: string, objectLabel = '') => {
  const hasModelObject = /gpt|grok|claude|gemini|llama|deepseek|qwen|minimax|kimi/i.test(objectLabel);
  if (/approved|approve|批准|获批|plans?\s+to\s+let|allow|permit|greenlight|放行|允许|拟允许|计划允许/i.test(text)
    && /buy|purchase|采购|购买|h200|gpu|chip|芯片|算力/i.test(text)) return { key: 'purchase-approval', label: '获准采购' };
  if (/发布|推出|上线|launch|release|announc|unveil|roll out|introduce|open[-\s]?source|开源/i.test(text) && hasModelObject) {
    return { key: 'model-launch', label: '发布' };
  }
  if (/涨价|提价|喊涨|调涨|价格上涨|报价上涨|asp|price\s*(increase|hike)|raise\s+prices?/i.test(text)) return { key: 'price-up', label: '涨价' };
  if (/降价|下跌|跌价|回落|下降|price\s*(drop|decline|cut)|lower\s+prices?/i.test(text)) return { key: 'price-down', label: '降价' };
  if (/供需|短缺|供不应求|供应紧张|产能紧张|tight supply|shortage|constraint|bottleneck/i.test(text)) return { key: 'supply-tight', label: '供给紧张' };
  if (/需求改善|需求回升|需求强劲|订单|采购|客户|出货|销量|交付|demand|orders?|shipments?|deliveries/i.test(text)) return { key: 'demand-improve', label: '需求改善' };
  if (/capex|capital expenditure|资本开支/i.test(text)) return { key: 'capex', label: '资本开支' };
  if (/funding|financing|loan|raise|valuation|融资|贷款|估值/i.test(text)) return { key: 'funding', label: '融资/估值' };
  return null;
};

const getGenericNewsEventKey = (rawText: string) => {
  const text = rawText.replace(/\s+/g, ' ').trim();
  const subject = getCanonicalEventSubject(text);
  const object = getCanonicalEventObject(text);
  if (!object) return '';
  const action = getCanonicalEventAction(text, object.label);
  if (!action) return '';
  if (action.key === 'model-launch' && !subject) return '';
  if (['purchase-approval', 'capex', 'funding'].includes(action.key) && !subject) return '';
  const subjectKey = subject?.key || object.key;
  return `event:${subjectKey}:${action.key}:${object.key}`;
};

const getNewsEventKey = (item: EnrichedNewsItem) => {
  const rawText = `${item.title || ''} ${item.snippet || ''} ${getDisplayTitle(item)} ${getDisplayBody(item)}`;
  const text = normalizeForTopic(rawText);
  if (/china|中国|beijing|北京/.test(text)
    && /approved|approve|批准|获批|plans?\s+to\s+let|allow|permit|greenlight|放行|允许|拟允许|计划允许/.test(text)
    && /deepseek|bytedance|字节|alibaba|阿里|top\s+ai\s+firms?|ai\s+firms?|major\s+ai\s+companies|头部ai|ai公司/.test(text)
    && /h200|nvidia|英伟达/.test(text)) {
    return 'event:china-ai-companies-approved-nvidia-h200-purchases';
  }
  if (/xai|x\.ai|spacexai|space\s*x\s*ai|grok/.test(text)
    && (/grok\s*4\.?5|grok4\.?5|grok-4\.?5/.test(text)
      || /new\s+model.*cursor|cursor.*new\s+model|available.*cursor|try\s+out.*cursor|try\s+out.*vercel/.test(text))) {
    return 'event:xai-grok-4-5-launch';
  }
  return getGenericNewsEventKey(rawText);
};

const mergeDuplicateDisplayItem = (existing: EnrichedNewsItem | undefined, item: EnrichedNewsItem) => {
  if (!existing) return item;
  const existingSources = new Set(existing.digest ? [existing.source] : [existing.source]);
  if (existing.source) existingSources.add(existing.source);
  if (item.source) existingSources.add(item.source);
  const sourceCount = Math.max(existing.sourceCount || 1, item.sourceCount || 1, existingSources.size || 1);
  const sourceBoost = Math.min(24, Math.max(0, sourceCount - 1) * 6);
  const existingBase = existing.score - Math.min(24, Math.max(0, (existing.sourceCount || 1) - 1) * 6);
  const itemBase = item.score - Math.min(24, Math.max(0, (item.sourceCount || 1) - 1) * 6);
  const stronger = itemBase > existingBase || (itemBase === existingBase && item.dateSort > existing.dateSort)
    ? item
    : existing;
  return {
    ...stronger,
    score: Math.round(Math.max(existingBase, itemBase) + sourceBoost),
    sourceCount,
  };
};

const dedupeByTitle = (items: EnrichedNewsItem[]) => {
  const map = new Map<string, EnrichedNewsItem>();
  for (const item of items) {
    const eventKey = getNewsEventKey(item);
    const displayKey = normalizeTitle(getDisplayTitle(item));
    const rawKey = normalizeTitle(item.title);
    const key = eventKey || (displayKey.length >= 6 ? displayKey : rawKey);
    const existing = map.get(key);
    map.set(key, mergeDuplicateDisplayItem(existing, item));
  }
  return Array.from(map.values()).sort((a, b) => b.dateSort - a.dateSort);
};

const stableHash = (input: string) => {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    const char = input.charCodeAt(i);
    hash = (hash * 31 + char) % 100000;
  }
  return hash;
};

const normalizeForTopic = (input: string) =>
  input
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasTopicKeyword = (text: string, keywords: string[]) =>
  keywords.some((keyword) => text.includes(normalizeForTopic(keyword)));

const isNewsTopic = (topic?: string): topic is NewsTopic =>
  Boolean(topic && TOPIC_OPTIONS.includes(topic as NewsTopic) && topic !== '全部');

export const inferSignalBucket = (item: { title?: string; snippet?: string; signalType?: string }): SignalBucket => {
  const text = normalizeForTopic(`${item.title || ''} ${item.snippet || ''} ${item.signalType || ''}`);
  const hasIndustryPriceSubject = /slc|mlc|nand|dram|ddr|hbm|ssd|mlcc|pcb|ccl|wafer|memory|semiconductor|半导体|芯片|晶圆|内存|铜箔|玻纤布|钨精矿|钨粉|废钨|金属/.test(text);
  const hasQuantifiedPriceRise = /(?:rise|rises|rose|rising|increase|increases|increased|increasing|jump|jumps|jumped|surge|surges|surged)(?:\s+up)?(?:\s+by)?\s+\d/.test(text);
  if (/fed|federal reserve|fomc|rate hike|rate cut|interest rate|美联储|联储|加息|降息|利率|cpi|pce|通胀|央行|货币政策/.test(text)) return '宏观政策';
  if (/利空|降价|下跌|回落|需求放缓|砍单|库存/.test(text)) return '利空降价';
  if ((hasIndustryPriceSubject && hasQuantifiedPriceRise) || /利好|涨价|提价|喊涨|调涨|价格上涨|报价上涨|asp|price hike|price increase|asp hike|raise prices|prices?.{0,20}(?:rise|increase)|(?:rise|increase).{0,20}prices?/.test(text)) return '利好涨价';
  if (/china|中国/.test(text)
    && /approved|approve|批准|获批/.test(text)
    && /deepseek|bytedance|字节|alibaba|阿里/.test(text)
    && /h200|nvidia|英伟达/.test(text)) return '需求改善';
  if (/供需|短缺|供不应求|供应紧张|产能紧张|tight supply|shortage/.test(text)) return '供需紧张';
  if (/需求改善|订单|客户|采购|购买|获批|批准|突破|回暖|复苏|上修/.test(text)) return '需求改善';
  return '其他信号';
};

const isInvestableSignalException = (item: { title?: string; snippet?: string; signalType?: string }, signalBucket: SignalBucket) => {
  if (!SIGNAL_VISIBILITY_EXCEPTIONS.has(signalBucket)) return false;
  const rawText = `${item.title || ''} ${item.snippet || ''} ${item.signalType || ''}`;
  if (NON_INVESTABLE_NOISE_PATTERN.test(rawText)) return false;
  if (!INVESTABLE_SIGNAL_CONTEXT_PATTERN.test(rawText)) return false;
  if (signalBucket === '需求改善') return DEMAND_SIGNAL_CONTEXT_PATTERN.test(rawText);
  return true;
};

const inferTopic = (item: NewsItem): NewsTopic => {
  if (isNewsTopic(item.investmentCategory)) return item.investmentCategory;

  const text = normalizeForTopic([
    item.title,
    item.snippet,
    item.source,
    item.category,
  ].filter(Boolean).join(' '));

  if (/fed|federal reserve|fomc|rate hike|rate cut|interest rate|美联储|联储|加息|降息|利率/.test(text)) return '宏观';
  if (hasTopicKeyword(text, INVESTMENT_CATEGORY_KEYWORDS['AI 涨价'])) return 'AI 涨价';
  if (hasTopicKeyword(text, INVESTMENT_CATEGORY_KEYWORDS['宏观'])) return '宏观';
  if (hasTopicKeyword(text, INVESTMENT_CATEGORY_KEYWORDS['硬件'])) return '硬件';
  if (hasTopicKeyword(text, INVESTMENT_CATEGORY_KEYWORDS['软件'])) return '软件';
  if (hasTopicKeyword(text, INVESTMENT_CATEGORY_KEYWORDS['消费'])) return '消费';

  return SOURCE_TYPE_TO_TOPIC[item.sourceCategory || ''] || SOURCE_TYPE_TO_TOPIC[item.category] || '宏观';
};

const parseNewsDate = (time?: string) => {
  if (!time || !time.trim()) return null;
  const parsed = dayjs(new Date(time));
  return parsed.isValid() ? parsed : null;
};

const getTimeZoneParts = (time?: string | number | Date) => {
  const date = time instanceof Date ? time : new Date(time || '');
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone: DISPLAY_TIME_ZONE,
    weekday: 'short',
  }).format(date);
  return {
    year: partMap.year,
    month: partMap.month,
    day: partMap.day,
    hour: partMap.hour,
    minute: partMap.minute,
    second: partMap.second,
    weekday,
    dateKey: `${partMap.year}-${partMap.month}-${partMap.day}`,
  };
};

const getChinaDateKey = (time?: string | number | Date) => getTimeZoneParts(time)?.dateKey || '';

const formatChinaMonthDayTime = (time?: string) => {
  const parts = getTimeZoneParts(time);
  if (!parts) return '';
  return `${Number(parts.month)}月${Number(parts.day)}日 ${parts.hour}:${parts.minute}`;
};

const formatChinaClock = (time?: string) => {
  const parts = getTimeZoneParts(time);
  return parts ? `${parts.hour}:${parts.minute}` : '';
};

const formatChinaDateLabel = (time?: string) => {
  const parts = getTimeZoneParts(time);
  if (!parts) return '';
  const prefix = parts.dateKey === getChinaDateKey(new Date()) ? '今天 ' : '';
  return `${prefix}${Number(parts.month)}月${Number(parts.day)}日 ${parts.weekday}`;
};

const formatChinaFullDateTime = (time?: string | null) => {
  const parts = getTimeZoneParts(time || '');
  if (!parts) return '--';
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} 北京时间`;
};

export const formatNewsTime = (time?: string) => {
  if (!time || !time.trim()) return '刚刚';
  if (time.includes('小时') || time.includes('分钟') || /^\d{1,2}:\d{2}$/.test(time)) return time;
  const parsed = parseNewsDate(time);
  if (parsed) return formatChinaMonthDayTime(time);
  return time;
};

const formatTimelineTime = (time?: string) => {
  const parsed = parseNewsDate(time);
  if (parsed) return formatChinaClock(time);
  return formatNewsTime(time).replace(/^.*? /, '');
};

export const compactSourceName = (source?: string) => {
  const raw = (source || '').trim();
  if (!raw) return '未知';
  return raw
    .replace(/^X\/Twitter\s*@/i, 'X/@')
    .replace(/^X\s*\/\s*@/i, 'X/@')
    .replace(/^Twitter\s*@/i, 'X/@')
    .replace(/^Wall Street CN$/i, '华尔街见闻')
    .replace(/^上海有色网SMM$/i, 'SMM')
    .replace(/^上海有色网\s*/i, 'SMM');
};

const getPriceProductName = (item: EnrichedNewsItem) => {
  if (item.priceProduct) return item.priceProduct;
  const fullText = `${item.title || ''} ${item.snippet || ''}`;
  const priceActionPattern = /涨价|提价|喊涨|调涨|价格上涨|报价上涨|下跌|降价|跌价|回落|price\s*(increase|hike|drop|decline|cut)|raise\s+prices?|lower\s+prices?/i;
  const text = priceActionPattern.test(fullText)
    ? fullText
        .replace(/https?:\/\/\S+/g, '')
        .split(/(?:[。！？!?]|\.\s+)/)
        .map((sentence) => sentence.trim())
        .find((sentence) => priceActionPattern.test(sentence)) || fullText
    : fullText;
  const productRules: Array<[RegExp, string | ((match: RegExpMatchArray) => string)]> = [
    [/钨粉/i, '钨粉'],
    [/黑钨精矿\s*[≥≧]\s*65%|黑钨精矿.*?65%/i, '黑钨精矿≧65%'],
    [/废钨棒材/i, '废钨棒材'],
    [/\bR32\b|制冷剂R32/i, 'R32'],
    [/金属铪|hafnium/i, '金属铪'],
    [/Q5500|动力煤/i, 'Q5500动力煤'],
    [/钨精矿.*?(65%)/i, (match) => `钨精矿（${match[1]}）`],
    [/钨精矿|钨矿|tungsten/i, '钨矿'],
    [/(mlcc)[^\d]*(\d{4}\s*[A-Z]\d[A-Z]?)/i, (match) => `MLCC ${match[2].toUpperCase().replace(/\s+/, ' ')}`],
    [/mlcc|积层陶瓷电容|被动元件|电容器/i, 'MLCC'],
    [/(dram)[^\d]*(ddr\d\s*\d+\s*gb)/i, (match) => `DRAM ${match[2].toUpperCase().replace(/\s+/, ' ')}`],
    [/dram|ddr/i, 'DRAM'],
    [/(nand)[^\d]*(\d+\s*gb\s*tlc)/i, (match) => `NAND ${match[2].toUpperCase().replace(/\s+/, ' ')}`],
    [/nand|flash/i, 'NAND Flash'],
    [/gpu|nvidia|英伟达/i, 'GPU'],
    [/hbm/i, 'HBM'],
    [/ccl|覆铜板/i, 'CCL'],
    [/pcb/i, 'PCB'],
    [/玻纤布/i, '玻纤布'],
    [/铜箔/i, '铜箔'],
    [/cpu|英特尔|intel/i, 'CPU'],
    [/内存|memory/i, '内存'],
    [/robot|机器人|robotics/i, '机器人'],
    [/半导体|semiconductor/i, '半导体'],
  ];
  const matched = productRules.find(([pattern]) => pattern.test(text));
  if (matched) {
    const match = text.match(matched[0]);
    return typeof matched[1] === 'function' && match ? matched[1](match) : matched[1] as string;
  }
  const cleaned = (item.title || '')
    .replace(/^@\w+:\s*/, '')
    .replace(/\s+\d+\s*(分钟前|小时前).*$/, '')
    .split(/[：:，,。|｜\-—]/)[0]
    .trim();
  return cleaned.length > 18 ? `${cleaned.slice(0, 18)}...` : cleaned || item.title;
};

const getPriceDisplayUnit = (item: EnrichedNewsItem) => {
  if (item.priceDisplayUnit) return item.priceDisplayUnit;
  const text = `${item.title || ''} ${item.snippet || ''}`;
  if (/钨粉|废钨棒材/.test(text)) return '元/千克';
  if (/黑钨精矿|钨精矿|钨矿|tungsten/i.test(text)) return '元/吨';
  if (/\bR32\b|制冷剂R32|Q5500|动力煤/i.test(text)) return '元/吨';
  if (/金属铪|hafnium/i.test(text)) return '美元/千克';
  if (/mlcc|电容|被动元件/i.test(text)) return '元/颗';
  if (/dram|ddr|nand|ssd|hbm|memory|flash|gpu|nvidia|英伟达/i.test(text)) return '美元';
  return '';
};

const formatPriceProductLabel = (item: EnrichedNewsItem) => {
  const product = getPriceProductName(item);
  const unit = getPriceDisplayUnit(item);
  return unit ? `${product}（${unit}）` : product;
};

const formatPriceSignalDatePrefix = (item: EnrichedNewsItem) => {
  const sourceTime = item.priceSourceUpdatedAt || item.time;
  const parts = getTimeZoneParts(sourceTime);
  if (!parts) return '';
  return `${parts.month}-${parts.day}`;
};

const formatPriceProductDisplayLabel = (item: EnrichedNewsItem) => {
  const datePrefix = formatPriceSignalDatePrefix(item);
  const label = formatPriceProductLabel(item);
  return datePrefix ? `${datePrefix} ${label}` : label;
};

const isXNewsItem = (item: Pick<NewsDisplayLike, 'title' | 'source'>) =>
  /^X\/|^X\/Twitter|^Twitter/i.test(item.source || '') || /^@\w+:/i.test(item.title || '');

const stripXPrefix = (text: string) =>
  text
    .replace(/^@\w+:\s*/i, '')
    .replace(/^RT\s+@\w+:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

const getXOriginalText = (item: NewsDisplayLike) => {
  const candidate = item.snippet?.trim() || item.title || '';
  return stripXPrefix(candidate);
};

const getXSubject = (text: string) => {
  const productRules: Array<[RegExp, string]> = [
    [/钨粉/i, '钨粉'],
    [/euv|光刻机/i, 'EUV设备'],
    [/cowos|先进封装/i, 'CoWoS先进封装'],
    [/h200|h100|gb200|b200/i, 'NVIDIA H200/AI GPU'],
    [/mlcc|积层陶瓷电容|被动元件|电容器/i, 'MLCC'],
    [/dram|ddr/i, 'DRAM'],
    [/nand|flash/i, 'NAND Flash'],
    [/hbm/i, 'HBM'],
    [/ssd/i, 'SSD'],
    [/gpu|nvidia|英伟达/i, 'GPU'],
    [/黑钨精矿\s*[≥≧]\s*65%|黑钨精矿.*?65%/i, '黑钨精矿≧65%'],
    [/废钨棒材/i, '废钨棒材'],
    [/\bR32\b|制冷剂R32/i, 'R32'],
    [/金属铪|hafnium/i, '金属铪'],
    [/Q5500|动力煤/i, 'Q5500动力煤'],
    [/钨精矿|钨矿|tungsten/i, '钨矿'],
    [/glass substrate|玻璃基板|유리기판/i, '玻璃基板'],
    [/data center|datacenter|数据中心/i, '数据中心'],
    [/robot|机器人/i, '机器人'],
    [/model y/i, 'Tesla Model Y'],
  ];
  const companyRules: Array<[RegExp, string]> = [
    [/cloudflare|\$?net\b/i, 'Cloudflare'],
    [/openai/i, 'OpenAI'],
    [/anthropic|claude/i, 'Anthropic'],
    [/\$?meta\b|zuckerberg/i, 'Meta'],
    [/\$?nvda\b|nvidia|英伟达/i, '英伟达'],
    [/\$?tsm\b|tsmc|台积电/i, '台积电'],
    [/samsung|三星/i, '三星'],
    [/sk hynix|海力士/i, 'SK海力士'],
    [/micron|\$?mu\b|美光/i, '美光'],
    [/y[a]?geo|國巨|国巨/i, '国巨'],
    [/apple|\$?aapl\b|苹果/i, '苹果'],
    [/google|\$?googl\b|gemini/i, 'Google'],
    [/microsoft|\$?msft\b/i, 'Microsoft'],
    [/amazon|\$?amzn\b|aws/i, 'Amazon'],
    [/tesla|\$?tsla\b/i, 'Tesla'],
    [/softbank|软银/i, 'SoftBank'],
    [/minimax/i, 'MiniMax'],
    [/deepseek/i, 'DeepSeek'],
    [/kimi|moonshot/i, 'Kimi'],
    [/xai|grok/i, 'xAI'],
    [/zai|z\.ai/i, 'Z.ai'],
  ];
  const product = productRules.find(([pattern]) => pattern.test(text));
  if (product) return product[1];
  const company = companyRules.find(([pattern]) => pattern.test(text));
  if (company) return company[1];
  const ticker = text.match(/\$([A-Z]{1,6})\b/);
  if (ticker) return ticker[1];
  const cleaned = stripXPrefix(text)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = cleaned.split(/[。！？!?]|\.\s+/)[0]?.trim() || '';
  const chineseSubject = sentence.match(/^([\u4e00-\u9fffA-Za-z0-9.$&\s-]{2,24}?)(?:发布|推出|上线|涨价|降价|提价|供给|供应|需求|融资|贷款|估值|资本开支|订单|客户|出货|产能)/i);
  if (chineseSubject?.[1]) return chineseSubject[1].trim();
  return '产业链';
};

const extractFirstPercent = (text: string) => {
  const match = text.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  if (!match) return '';
  return match[1].startsWith('+') || match[1].startsWith('-') ? `${match[1]}%` : `+${match[1]}%`;
};

const extractMoneyPhrase = (text: string) => {
  const dollar = text.match(/\$?\s*(\d+(?:\.\d+)?)\s*(billion|bn|b|million|mn|m)\b/i);
  if (dollar) {
    const value = Number(dollar[1]);
    if (/^b/i.test(dollar[2])) {
      if (Number.isFinite(value)) {
        const yiUsd = value * 10;
        return `${Number.isInteger(yiUsd) ? yiUsd : yiUsd.toFixed(1)}亿美元`;
      }
      return `${dollar[1]}B美元`;
    }
    return `${dollar[1]}百万美元`;
  }
  const chinese = text.match(/(\d+(?:\.\d+)?)\s*(亿|万亿)\s*美元/);
  return chinese ? `${chinese[1]}${chinese[2]}美元` : '';
};

const USD_AMOUNT_PATTERN = '\\$?\\s*(\\d+(?:\\.\\d+)?)\\s*(billion|bn|b|million|mn|m)\\b';
const FUNDING_VALUATION_PATTERNS = [
  new RegExp(`${USD_AMOUNT_PATTERN}\\s+(?:post[- ]money\\s+)?valuation\\b`, 'i'),
  new RegExp(`(?:valuation(?:\\s+(?:of|at|to))?|valued\\s+at|value(?:s|d)?\\s+(?:the\\s+company\\s+)?at)\\s*(?:around|about|over|more\\s+than|nearly)?\\s*${USD_AMOUNT_PATTERN}`, 'i'),
];
const FUNDING_LOAN_PATTERNS = [
  new RegExp(`${USD_AMOUNT_PATTERN}\\s+(?:[A-Za-z-]+\\s+){0,3}(?:loan|debt|credit\\s+facility)\\b`, 'i'),
  new RegExp(`(?:loan|debt|credit\\s+facility)(?:\\s+(?:of|for|worth))?\\s*${USD_AMOUNT_PATTERN}`, 'i'),
];
const FUNDING_INVESTMENT_PATTERNS = [
  new RegExp(`${USD_AMOUNT_PATTERN}\\s+(?:[A-Za-z-]+\\s+){0,4}(?:investment|funding|financing|round)\\b`, 'i'),
  new RegExp(`(?:rais(?:e|es|ed|ing)|secur(?:e|es|ed|ing)|lands?|closes?)\\s+(?:a\\s+)?(?:new\\s+)?${USD_AMOUNT_PATTERN}`, 'i'),
  new RegExp(`(?:investment|funding|financing|round)(?:\\s+(?:of|for|worth))?\\s*${USD_AMOUNT_PATTERN}`, 'i'),
];

const formatUsdAmount = (valueText: string, unitText: string) => {
  const value = Number(valueText);
  if (!Number.isFinite(value)) return '';
  if (/^(?:billion|bn|b)$/i.test(unitText)) {
    const yiUsd = value * 10;
    return `${Number.isInteger(yiUsd) ? yiUsd : Number(yiUsd.toFixed(1))}亿美元`;
  }
  return `${Number.isInteger(value) ? value : Number(value.toFixed(1))}百万美元`;
};

const extractContextualUsdAmount = (text: string, patterns: RegExp[]) => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && match?.[2]) return formatUsdAmount(match[1], match[2]);
  }
  return '';
};

const getLeadingEventSubject = (text: string) => {
  const firstSentence = normalizeEnglishTitle(text).split(/[。！？!?]|\.\s+/)[0]?.trim() || '';
  const knownSubjects: Array<[RegExp, string]> = [
    [/^Databricks\b/i, 'Databricks'],
    [/^OpenAI\b/i, 'OpenAI'],
    [/^Anthropic\b/i, 'Anthropic'],
    [/^Cloudflare\b/i, 'Cloudflare'],
    [/^Microsoft\b/i, 'Microsoft'],
    [/^Google\b/i, 'Google'],
    [/^Meta\b/i, 'Meta'],
    [/^Nvidia\b/i, '英伟达'],
    [/^Tesla\b/i, 'Tesla'],
    [/^Blue Origin\b/i, 'Blue Origin'],
    [/^Rocket Lab\b/i, 'Rocket Lab'],
  ];
  const known = knownSubjects.find(([pattern]) => pattern.test(firstSentence));
  if (known) return known[1];

  const ticker = firstSentence.match(/^\$([A-Z]{1,6})\b/);
  if (ticker) return ticker[1];
  const leadingEntity = firstSentence.match(/^([A-Z][A-Za-z0-9.&-]*(?:\s+[A-Z][A-Za-z0-9.&-]*){0,2})(?=\s+(?:to\b|is\b|has\b|will\b|plans?\b|seeks?\b|rais(?:e|es|ed|ing)\b|secur(?:e|es|ed|ing)\b|lands?\b|closes?\b|gets?\b|valu(?:e|es|ed|ation)\b))/i)?.[1] || '';
  return /^(?:The|A|An|This|New|According)$/i.test(leadingEntity) ? '' : leadingEntity;
};

const summarizeFundingEventTitle = (text: string) => {
  const cleaned = normalizeEnglishTitle(text);
  if (!/(?:funding|financing|investment|round|rais(?:e|es|ed|ing)|valuation|valued|loan|debt|credit facility)/i.test(cleaned)) return '';

  const firstSentence = cleaned.split(/[。！？!?]|\.\s+/)[0]?.trim() || cleaned;
  const subject = getLeadingEventSubject(firstSentence);
  if (!subject) return '';

  const valuation = extractContextualUsdAmount(firstSentence, FUNDING_VALUATION_PATTERNS);
  const loan = extractContextualUsdAmount(firstSentence, FUNDING_LOAN_PATTERNS);
  const funding = extractContextualUsdAmount(firstSentence, FUNDING_INVESTMENT_PATTERNS);

  if (loan) return `${subject}获得${loan}贷款${valuation ? `，估值${/jump|rise|increase|hit|reach/i.test(firstSentence) ? '升至' : '达到'}${valuation}` : ''}`;
  if (funding && valuation) return `${subject}获${funding}投资，估值${/jump|rise|increase|hit|reach/i.test(firstSentence) ? '升至' : '达到'}${valuation}`;
  if (valuation) return `${subject}估值${/jump|rise|increase|hit|reach/i.test(firstSentence) ? '升至' : '达到'}${valuation}`;
  if (funding) return `${subject}${/investment/i.test(firstSentence) ? `获${funding}投资` : `融资${funding}`}`;
  return '';
};

const extractH200PurchaseQuantity = (text: string) => {
  const match = text.match(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(?:nvidia\s*)?h200/i);
  if (!match) return '';
  const raw = match[1].replace(/,/g, '');
  const value = Number(raw);
  if (!Number.isFinite(value)) return `${match[1]}张`;
  if (value >= 10000) return `${Math.round(value / 10000)}万张`;
  return `${value.toLocaleString('zh-CN')}张`;
};

const getRelevantXSentence = (original: string, pattern: RegExp) => {
  const cleaned = stripXPrefix(original)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = cleaned
    .split(/(?:[。！？!?]|\.\s+)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.find((sentence) => pattern.test(sentence)) || cleaned;
};

const extractModelName = (text: string) => {
  const patterns = [
    /\bMiniMax\s*(M\d+(?:[-\w.]*)?)\b/i,
    /\b(M\d+(?:[-\w.]*)?)\s*(?:model|模型)\b/i,
    /\bClaude\s+[A-Z]?\w+(?:[-\s.]\w+)*/i,
    /\bGPT[-\s]?\d[\w.-]*/i,
    /\bGrok\s*\d[\w.-]*/i,
    /\bGemini\s+[A-Z]?\w+(?:[-\s.]\w+)*/i,
    /\bLlama\s*\d[\w.-]*/i,
    /\bDeepSeek[-\s]?\w+/i,
    /\bQwen\s*\d[\w.-]*/i,
    /\bKimi\s*\w+/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return (match[1] || match[0]).replace(/\s+/g, ' ').trim();
  }
  return '';
};

const getModelLaunchSentence = (original: string, modelName: string) => {
  const cleaned = stripXPrefix(original)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = cleaned
    .split(/(?:[。！？!?]|\.\s+)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const launchPattern = /发布|推出|上线|launch|release|announc|open[-\s]?source|开源/i;
  const lowerModelName = modelName.toLowerCase();
  return sentences.find((sentence) => sentence.toLowerCase().includes(lowerModelName) && launchPattern.test(sentence))
    || sentences.find((sentence) => sentence.toLowerCase().includes(lowerModelName))
    || sentences.find((sentence) => launchPattern.test(sentence))
    || cleaned;
};

const summarizeMultiTopicXPost = (original: string) => {
  const themes: string[] = [];
  if (/hbm/i.test(original) && /self[-\s]?sufficien|自给|自給/i.test(original)) themes.push('中国HBM自给');
  else if (/hbm/i.test(original)) themes.push('HBM供给');
  if (/eda/i.test(original)) themes.push('EDA工具');
  if (/cerebras|gpt[-\s]?5\.6|inference|推理/i.test(original)) themes.push('OpenAI/Cerebras推理需求');
  if (/gpu/i.test(original) && /price|increase|demand|价格|需求/i.test(original)) themes.push('GPU需求与价格');
  if (/broadcom|mediatek|tpu/i.test(original)) themes.push('TPU竞争');
  if (/amd/i.test(original) && /shipment|出货/i.test(original)) themes.push('AMD GPU出货预测');
  if (themes.length === 0) return '';
  return `${themes.slice(0, 4).join('、')}成为产业链讨论重点`;
};

const summarizeSupplySignal = (original: string, subject: string) => {
  if (/euv|光刻机/i.test(original) && /2027|capex|capes|capital expenditure|consensus|supply|capped|供应/i.test(original)) {
    return 'EUV供应约束压低2027资本开支预期';
  }
  if (/dram|nand/i.test(original) && /constraint|bottleneck|shortage|supply|供应|瓶颈|短缺|紧张/i.test(original)) {
    return 'DRAM/NAND供给瓶颈限制AI服务器交付';
  }
  if (/cowos|先进封装/i.test(original) && /capacity|supply|shortage|供应|产能|紧张|短缺/i.test(original)) {
    return 'CoWoS先进封装产能紧张';
  }
  if (/gpu|nvidia|英伟达/i.test(original) && /demand|supply|shortage|供应|需求|紧张|短缺/i.test(original)) {
    return 'GPU供需紧张';
  }
  if (subject && subject !== '产业链') return `${subject}供需紧张`;
  return summarizeOriginalSentence(original, '');
};

const summarizeSpecificEventTitle = (text: string, fallbackSubject = '') => {
  const cleaned = stripXPrefix(text)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const subject = getCanonicalEventSubject(cleaned);
  const object = getCanonicalEventObject(cleaned);
  const action = object ? getCanonicalEventAction(cleaned, object.label) : null;
  if (!object || !action) return '';

  const subjectLabel = subject?.label || fallbackSubject || '';
  const money = extractMoneyPhrase(cleaned);
  const percent = extractFirstPercent(cleaned);

  if (action.key === 'model-launch' && subjectLabel) {
    const launchPattern = /发布|推出|上线|launch|release|announce|unveil|roll out|introduce|open[-\s]?source|开源/i;
    const launchSentence = cleaned
      .split(/(?:[。！？!?]|\.\s+)/)
      .map((sentence) => sentence.trim())
      .find((sentence) => sentence.toLowerCase().includes(object.label.toLowerCase()) && launchPattern.test(sentence));
    if (!launchSentence) return '';
    return `${subjectLabel}发布${object.label}`;
  }
  if (action.key === 'purchase-approval' && subjectLabel) return `${subjectLabel}获准采购${object.label}`;
  if (action.key === 'price-up') return `${object.label}涨价${percent ? ` ${percent}` : ''}`.trim();
  if (action.key === 'price-down') return `${object.label}降价${percent ? ` ${percent}` : ''}`.trim();
  if (action.key === 'supply-tight') return `${object.label}供给紧张`;
  if (action.key === 'demand-improve') return `${subjectLabel || object.label}${object.label && subjectLabel && subjectLabel !== object.label ? `带动${object.label}` : ''}需求改善`;
  if (action.key === 'capex' && subjectLabel) return `${subjectLabel}资本开支${money ? `达${money}` : '更新'}`;
  if (action.key === 'funding' && subjectLabel) return `${subjectLabel}融资/估值更新${money ? `，规模${money}` : ''}`;
  return '';
};

const cleanNewsBoilerplate = (text: string) =>
  text
    .replace(/Article URL:\s*https?:\/\/\S+/gi, '')
    .replace(/Comments URL:\s*https?:\/\/\S+/gi, '')
    .replace(/Points:\s*\d+/gi, '')
    .replace(/#\s*Comments:\s*\d+/gi, '')
    .replace(/Article URL:\s*/gi, '')
    .replace(/Comments URL:\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

const hasChineseText = (text: string) => /[\u4e00-\u9fff]/.test(text);

const normalizeEnglishTitle = (text: string) =>
  cleanNewsBoilerplate(text)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const formatScaleMetricNumber = (raw: string) => {
  const normalized = raw.replace(/,/g, '').trim();
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(billion|million|[bmk]|万|亿)?/i);
  if (!match) return raw.trim();
  const value = Number(match[1]);
  const unit = (match[2] || '').toLowerCase();
  const compact = (number: number) => Number.isInteger(number) ? String(number) : String(Number(number.toFixed(1)));
  if (unit === 'b' || unit === 'billion') return `${compact(value * 10)}亿`;
  if (unit === 'm' || unit === 'million') return `${compact(value * 100)}万`;
  if (unit === 'k') return value >= 10 ? `${compact(value / 10)}万` : `${compact(value * 1000)}`;
  if (unit === '万' || unit === '亿') return `${compact(value)}${unit}`;
  if (value >= 100000000) return `${compact(value / 100000000)}亿`;
  if (value >= 10000) return `${compact(value / 10000)}万`;
  return compact(value);
};

const summarizeAdoptionMetricTitle = (text: string) => {
  const cleaned = normalizeEnglishTitle(text);
  const metricContext = /用户数|活跃用户|付费用户|使用量|调用量|下载量|开发者|MAU|DAU|users?|active users?|paid users?|usage|downloads?|developers?|subscribers?/i;
  if (!metricContext.test(cleaned)) return '';
  const metric = cleaned.match(/(?:\d+(?:\.\d+)?\s*(?:billion|million|[bmk])\b|\d+(?:\.\d+)?\s*(?:万|亿)\b|\d{1,3}(?:,\d{3})+)/i)?.[0];
  if (!metric) return '';

  const subject = /codex/i.test(cleaned)
    ? 'Codex'
    : /chatgpt\s*work/i.test(cleaned)
      ? 'ChatGPT Work'
      : /chatgpt/i.test(cleaned)
        ? 'ChatGPT'
        : /claude/i.test(cleaned)
          ? 'Claude'
          : /gemini/i.test(cleaned)
            ? 'Gemini'
            : /grok/i.test(cleaned)
              ? 'Grok'
              : /deepseek/i.test(cleaned)
                ? 'DeepSeek'
                : getXSubject(cleaned);
  const metricLabel = /MAU|月活/i.test(cleaned)
    ? '月活用户'
    : /DAU|日活/i.test(cleaned)
      ? '日活用户'
      : /paid users?|付费用户|subscribers?/i.test(cleaned)
        ? '付费用户'
        : /downloads?|下载量/i.test(cleaned)
          ? '下载量'
          : /developers?|开发者/i.test(cleaned)
            ? '开发者数量'
            : /usage|使用量|调用量/i.test(cleaned) && !/codex/i.test(cleaned)
              ? '使用量'
              : '用户规模';
  const verb = /might hit|looks? like.{0,20}hit|soon|approach|near|接近|即将|将达/i.test(cleaned)
    ? '接近'
    : /surpass|exceed|break through|突破|超过/i.test(cleaned)
      ? '突破'
      : '达到';
  return `${subject}${metricLabel}${verb}${formatScaleMetricNumber(metric)}`;
};

const summarizeStructuredEnglishFact = (text: string, subject = '') => {
  const cleaned = normalizeEnglishTitle(text);
  const lower = cleaned.toLowerCase();
  const resolvedSubject = subject || getXSubject(cleaned);
  const safeSubject = resolvedSubject === '产业链' ? '' : resolvedSubject;
  const percent = extractFirstPercent(cleaned);
  const percentRange = cleaned.match(/(\d+(?:\.\d+)?)\s*%?\s*(?:to|[-–—~至])\s*(\d+(?:\.\d+)?)\s*%/i);
  const rangeText = percentRange ? `${percentRange[1]}%–${percentRange[2]}%` : percent;
  const fundingTitle = summarizeFundingEventTitle(cleaned);
  if (fundingTitle) return fundingTitle;
  const adoptionTitle = summarizeAdoptionMetricTitle(cleaned);
  if (adoptionTitle) return adoptionTitle;

  const waferCapacity = cleaned.match(/monthly capacity(?: of)?\s*([\d,]+)\s*wafers?/i);
  if (/samsung/i.test(lower) && /new dram fab|build.*dram fab/i.test(lower)) {
    return `三星拟建${waferCapacity ? `月产${formatScaleMetricNumber(waferCapacity[1])}片` : ''}DRAM新厂`;
  }
  if (/slc nand/i.test(lower) && /rise|increase|hike|涨价/i.test(lower) && rangeText) {
    return `TrendForce预计H2 SLC NAND涨价${rangeText}`;
  }
  if (/coreweave/i.test(lower) && /hedg/i.test(lower) && /memory|storage/i.test(lower) && /drop|decline|fall/i.test(lower)) {
    return 'CoreWeave拟对冲DRAM与存储价格下跌风险';
  }
  const revenueGuideRange = cleaned.match(/\$(\d+(?:\.\d+)?)\s*[-–—]\s*\$?(\d+(?:\.\d+)?)\s*m\b/i);
  if (/\$?aehr\b/i.test(cleaned) && /2027 guide|2027 guidance/i.test(lower) && revenueGuideRange) {
    const low = Number(revenueGuideRange[1]) / 100;
    const high = Number(revenueGuideRange[2]) / 100;
    return `Aehr FY2027收入指引${low}亿–${high}亿美元${rangeText ? `，同比增长${rangeText}` : ''}`;
  }
  if (/capacity/i.test(lower) && /increase|expand|ramp/i.test(lower) && rangeText && safeSubject) {
    const product = /low[-\s]?na euv/i.test(lower) ? 'Low-NA EUV' : /euv/i.test(lower) ? 'EUV' : /duv/i.test(lower) ? 'DUV' : /dram/i.test(lower) ? 'DRAM' : '';
    return `${safeSubject}计划将${product ? `${product}` : ''}产能提升${rangeText}`;
  }
  if (/offer|bid/i.test(lower) && /acquir|buy/i.test(lower) && /paypal|\$pypl/i.test(lower)) {
    const money = cleaned.match(/\$\s?\d+(?:\.\d+)?\s*(?:billion|bn|b)\b/i)?.[0] || extractMoneyPhrase(cleaned);
    return `Stripe与Advent拟${money ? `${money}` : ''}收购PayPal`;
  }
  if (/what should we improve|looking for feedback|feedback on/i.test(lower)) {
    const product = /chatgpt work/i.test(lower) ? 'ChatGPT Work' : /codex/i.test(lower) ? 'Codex' : safeSubject;
    return `${product || 'AI产品'}征集产品改进反馈`;
  }
  if (/thank you for creating codex|paid substacks?/i.test(lower) && /codex/i.test(lower)) return '用户用Codex检索付费Substack内容';
  if (/grok\s*4\.?5 is worth trying/i.test(lower)) return '马斯克推荐试用Grok 4.5';
  return '';
};

const summarizeEnglishToChineseTitle = (text: string, subject = '') => {
  const cleaned = normalizeEnglishTitle(text);
  if (!cleaned) return subject || '新闻更新';
  if (hasChineseText(cleaned)) return cleaned;

  const lower = cleaned.toLowerCase();
  const resolvedSubject = subject || getXSubject(cleaned);
  const safeSubject = resolvedSubject === '产业链' ? '' : resolvedSubject;
  const modelName = extractModelName(cleaned);
  const money = extractMoneyPhrase(cleaned);
  const percent = extractFirstPercent(cleaned);
  const structuredFactTitle = summarizeStructuredEnglishFact(cleaned, safeSubject);
  if (structuredFactTitle) return structuredFactTitle;
  const specificEventTitle = summarizeSpecificEventTitle(cleaned, safeSubject);
  if (specificEventTitle) return specificEventTitle;

  if (/show hn/i.test(cleaned) && /agent skills?|llm prompts?/i.test(lower)) return 'Show HN项目推出Agent技能路由工具';
  if (/ai.*interrogates.*startup idea|startup idea.*deadlines/i.test(lower)) return '创业想法AI评估工具Grillr上线';
  if (/former openai exec|kevin weil|stoke space/i.test(lower)) return 'OpenAI前高管Kevin Weil加入Stoke Space董事会';
  if (/outcry|instagram|profile pics?|ai images?/i.test(lower)) return 'Meta允许用Instagram公开头像生成AI图片引发争议';
  if (/control what an ai agent can do|prove what it did|cinchor/i.test(lower)) return 'Cinchor推出AI Agent权限控制与行为证明工具';
  if (/organize and route agent skills?/i.test(lower)) return 'Agent技能组织与路由工具上线';
  if (/retinamind|retina|autism|adhd/i.test(lower)) return 'RetinaMind用视网膜AI模型区分自闭症与多动症';
  if (/ai pc/i.test(lower) && /token bills?|token costs?|runaway token/i.test(lower)) return 'AI PC本地推理可降低Token成本';
  if (/\$?tsm\b|tsmc|台积电/i.test(cleaned) && /one of the cleanest|cleanest.*(ai|semi|semiconductor)|best.*(ai|semi|semiconductor).*play/i.test(lower)) {
    return '台积电被视为AI半导体链条中较清晰的受益标的';
  }
  if (/\$?tsm\b|tsmc|台积电/i.test(cleaned) && /ai.*(beneficiar|winner|play)|semiconductor.*(beneficiar|winner|play)/i.test(lower)) {
    return '台积电受益AI半导体需求';
  }
  if (/google|gemini|deepmind/i.test(cleaned) && /security|vulnerability|patch|safe|safety|risk/i.test(lower)) return 'Google更新AI安全与风险控制相关内容';
  if (/google|gemini|deepmind/i.test(cleaned) && /search|ads|cloud|android|workspace/i.test(lower)) return 'Google更新AI产品与商业化进展';
  if (/xai|x\.ai|spacexai|space\s*x\s*ai|grok/i.test(cleaned)
    && (/grok\s*4\.?5|grok4\.?5|grok-4\.?5/i.test(cleaned)
      || /new\s+model.*cursor|cursor.*new\s+model|available.*cursor|try\s+out.*cursor|try\s+out.*vercel/i.test(cleaned))) return 'xAI发布Grok 4.5';
  if (/openai/i.test(cleaned) && /safety|risk|policy|preparedness/i.test(lower)) return 'OpenAI更新模型安全与风险治理内容';
  if (/meta/i.test(cleaned) && /safety|risk|policy|privacy/i.test(lower)) return 'Meta更新AI安全/隐私相关内容';
  if (/raises?.*price target|pt to|outperform/i.test(lower) && safeSubject) return `${safeSubject}获上调目标价`;
  if (/demand.*ahead of supply|supply.*bottleneck|constraint|shortage/i.test(lower) && safeSubject) return `${safeSubject}需求强于供应并出现供给瓶颈`;
  if (/capex|capital expenditure/i.test(lower) && money && safeSubject) return `${safeSubject}资本开支达${money}`;
  if (/funding|financing|loan|raise|valuation/i.test(lower) && safeSubject) return `${safeSubject}融资/估值更新${money ? `，规模${money}` : ''}`;
  if (/launch|release|announce|unveil|roll out|introduce/i.test(lower) && modelName && safeSubject) return `${safeSubject}发布${modelName}`;
  if (/production|shipment|deliver/i.test(lower) && percent && safeSubject) return `${safeSubject}产量/出货变化${percent}`;
  if (/earnings|revenue|sales|guidance/i.test(lower) && safeSubject) return `${safeSubject}业绩/指引更新${percent ? ` ${percent}` : ''}`;
  if (/data center|datacenter/i.test(lower) && safeSubject) return `${safeSubject}数据中心项目推进${money ? `，规模${money}` : ''}`;
  if (/policy|regulation|tariff|export control/i.test(lower) && safeSubject) return `${safeSubject}政策监管变化`;

  const leadingEntityMatch = cleaned.match(/^\$?([A-Z][A-Za-z0-9.-]+(?:\s+[A-Z][A-Za-z0-9.-]+){0,2})/)?.[1];
  const leadingEntity = /^(?:At|The|We|How|Why|What|From|This|New|An|A|I)$/i.test(leadingEntityMatch || '') ? '' : leadingEntityMatch;
  const entity = safeSubject || leadingEntity || '相关公司';
  if (/funding|financing|loan|raise|valuation/i.test(lower)) return `${entity}${/valuation/i.test(lower) ? '估值' : '融资'}${money ? `达${money}` : '变化'}`;
  if (/contract|order|supply deal|customer/i.test(lower)) return `${entity}披露订单或客户进展${money ? `，规模${money}` : ''}`;
  if (/production|shipment|deliver|capacity/i.test(lower)) return `${entity}${/capacity/i.test(lower) ? '产能' : '产量/出货'}${percent ? `变化${percent}` : '发生变化'}`;
  if (/earnings|revenue|sales|profit|guidance/i.test(lower)) return `${entity}${/guidance/i.test(lower) ? '调整业绩指引' : '披露业绩变化'}${percent ? ` ${percent}` : ''}`;
  if (/policy|regulation|tariff|export control/i.test(lower)) return `${entity}面临政策或监管变化`;
  return safeSubject
    ? `${entity}：${cleaned.length > 42 ? `${cleaned.slice(0, 42)}...` : cleaned}`
    : cleaned.length > 52 ? `${cleaned.slice(0, 52)}...` : cleaned;
};

const summarizeNewsFromText = (text: string) => {
  const cleaned = cleanNewsBoilerplate(stripXPrefix(text)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim());
  if (!cleaned) return '新闻更新';

  if (/cloudflare/i.test(cleaned) && /openai/i.test(cleaned) && /pilot|research|signal|signals/i.test(cleaned)) {
    return 'Cloudflare与OpenAI启动内容信号研究试点';
  }
  if (/meta/i.test(cleaned) && /image|图像|生成/i.test(cleaned)) return 'Meta推出自研图像生成模型';
  if (/alexa/i.test(cleaned) && /agent|智能体/i.test(cleaned)) return '亚马逊推进Alexa智能体计划';
  if (/openai/i.test(cleaned) && /gpt[-\s]?5\.6/i.test(cleaned) && /launch|release|发布|上线/i.test(cleaned)) return 'OpenAI将发布GPT-5.6系列模型';
  if (/blue origin/i.test(cleaned) && /\$?10B|10B|130B|融资|valuation/i.test(cleaned)) return 'Blue Origin寻求外部融资并估值约1300亿美元';
  if (/cloudflare|\$net/i.test(cleaned) && /ai economy|megacap|openai/i.test(cleaned)) return 'Cloudflare受益AI基础设施与OpenAI合作预期';
  if (/rklb|rocket lab/i.test(cleaned) && /loan|financing|funding|融资|贷款|\$?1\s*b|1\s*billion|10亿/i.test(cleaned)) return 'RKLB融资贷款达10亿美元';
  if (/RynnWorld-4D/i.test(cleaned)) return 'RynnWorld-4D发布机器人操作世界模型论文';
  if (/Cinchor/i.test(cleaned) && /AI agent/i.test(cleaned)) return 'Cinchor推出AI Agent权限控制与行为证明工具';

  const firstSentence = cleaned.split(/[。！？\n\r]/)[0]?.trim() || cleaned;
  const firstClause = firstSentence.split(/\s[-–—]\s|；|;| - /)[0]?.trim() || firstSentence;
  if (!hasChineseText(firstClause)) return summarizeEnglishToChineseTitle(firstClause);
  const words = firstClause.split(/\s+/).filter(Boolean);
  if (words.length > 18) return words.slice(0, 18).join(' ');
  if (firstClause.length > 52) return `${firstClause.slice(0, 52)}...`;
  return firstClause || '新闻更新';
};

const summarizeOriginalSentence = (original: string, subject: string) => {
  const cleaned = stripXPrefix(original)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const firstSentence = cleaned.split(/[。！？\n\r]/)[0]?.trim() || cleaned;
  const firstClause = firstSentence.split(/\s[-–—]\s|；|;/)[0]?.trim() || firstSentence;
  if (!firstClause) return `${subject}消息`;
  if (!hasChineseText(firstClause)) return summarizeEnglishToChineseTitle(firstClause, subject);
  const words = firstClause.split(/\s+/).filter(Boolean);
  if (words.length > 18) return words.slice(0, 18).join(' ');
  if (firstClause.length > 46) return `${firstClause.slice(0, 46)}...`;
  return firstClause;
};

const TITLE_COMPANY_ENTITIES: Array<[RegExp, string]> = [
  [/\bxiaomi\b|小米/i, '小米'],
  [/\bredmi\b|红米/i, 'Redmi'],
  [/\boppo\b/i, 'OPPO'],
  [/\bvivo\b/i, 'vivo'],
  [/\bsamsung\b|三星/i, '三星'],
  [/\bapple\b|苹果/i, '苹果'],
  [/\bnvidia\b|英伟达/i, '英伟达'],
  [/\bamd\b/i, 'AMD'],
  [/\btsmc\b|台积电/i, '台积电'],
  [/\bgoogle\b|谷歌/i, '谷歌'],
  [/\bmicrosoft\b|微软/i, '微软'],
  [/\bopenai\b/i, 'OpenAI'],
  [/\banthropic\b/i, 'Anthropic'],
  [/\bxai\b|x\.ai/i, 'xAI'],
  [/\bmeta\b/i, 'Meta'],
  [/\btesla\b|特斯拉/i, '特斯拉'],
  [/\bhuawei\b|华为/i, '华为'],
  [/\bbytedance\b|字节跳动/i, '字节跳动'],
  [/\balibaba\b|阿里巴巴/i, '阿里巴巴'],
];

const getTitleCompany = (text: string) =>
  TITLE_COMPANY_ENTITIES.find(([pattern]) => pattern.test(text))?.[1] || '';

const getTitleProduct = (text: string) => {
  if (/low[\s-]*(?:and|&)[\s-]*mid[\s-]*range smartphones?|中低端手机/i.test(text)) return '中低端手机';
  if (/smartphones?|手机/i.test(text)) return '手机';
  if (/memory chips?|memory market|存储芯片|存储市场/i.test(text)) return '存储芯片';
  if (/\bdram\b/i.test(text)) return 'DRAM';
  if (/\bnand\b/i.test(text)) return 'NAND';
  if (/\bgpu\b/i.test(text)) return 'GPU';
  if (/\bmlcc\b/i.test(text)) return 'MLCC';
  if (/servers?|服务器/i.test(text)) return '服务器';
  return '';
};

const summarizeCompanyActionTitle = (original: string) => {
  const company = getTitleCompany(original);
  if (!company) return '';
  const product = getTitleProduct(original);
  const percent = extractFirstPercent(original);
  const shipmentUp = /(?:increas(?:e|es|ed|ing)|rais(?:e|es|ed|ing)|boost(?:s|ed|ing)?|lift(?:s|ed|ing)?)\b.{0,90}\bshipments?\b|shipment target.{0,40}(?:increase|raise|higher|up)/i;
  const shipmentDown = /(?:decreas(?:e|es|ed|ing)|lower(?:s|ed|ing)?|cut(?:s|ting)?)\b.{0,90}\bshipments?\b|shipment target.{0,40}(?:decrease|lower|cut|down)/i;

  if (shipmentUp.test(original)) {
    const memoryInflection = /memory.{0,120}inflection|inflection.{0,120}memory|存储.{0,40}拐点/i.test(original);
    return `${company}上调${product || '产品'}出货目标${percent ? ` ${percent}` : ''}${memoryInflection ? '，存储涨价动能或临近拐点' : ''}`;
  }
  if (shipmentDown.test(original)) return `${company}下调${product || '产品'}出货目标${percent ? ` ${percent}` : ''}`;
  if (/(?:reject(?:s|ed|ing)?|拒绝).{0,100}(?:pricing|price|报价|提价)/i.test(original)) {
    return `${company}拒绝${product || '供应商'}新报价，涨价阻力上升`;
  }
  if (/(?:rais(?:e|es|ed|ing)|increas(?:e|es|ed|ing)|hike(?:s|d)?|上调|提高).{0,80}(?:price|pricing|价格|报价)/i.test(original)) {
    return `${company}上调${product || '产品'}价格${percent ? ` ${percent}` : ''}`;
  }
  if (/(?:cut(?:s|ting)?|lower(?:s|ed|ing)?|decreas(?:e|es|ed|ing)|下调|降低).{0,80}(?:price|pricing|价格|报价)/i.test(original)) {
    return `${company}下调${product || '产品'}价格${percent ? ` ${percent}` : ''}`;
  }
  return '';
};

const summarizeXTitle = (item: NewsDisplayLike) => {
  const original = getXOriginalText(item);
  const text = normalizeForTopic(original);
  const subject = getXSubject(original);
  const percent = extractFirstPercent(original);
  const money = extractMoneyPhrase(original);
  const modelName = extractModelName(original);
  const isSoftwareSubject = /OpenAI|Anthropic|Google|Microsoft|Amazon|MiniMax|DeepSeek|Kimi|xAI|Z\.ai|Meta/i.test(subject);
  const priceDownPattern = /降价|下跌|跌价|回落|下降|price\s*(drop|decline|cut)|lower\s+prices?/i;
  const priceUpPattern = /涨价|提价|喊涨|调涨|价格上涨|报价上涨|asp|price\s*(increase|hike)|raise\s+prices?/i;
  const modelLaunchPattern = /发布|推出|上线|launch|release|announc|open[-\s]?source|开源/i;
  const multiTopicSummary = summarizeMultiTopicXPost(original);
  const companyActionTitle = summarizeCompanyActionTitle(original);

  if (companyActionTitle) return companyActionTitle;

  const structuredFactTitle = summarizeStructuredEnglishFact(original, subject === '产业链' ? '' : subject);
  if (structuredFactTitle) return structuredFactTitle;
  if (multiTopicSummary && /some thoughts|i.?ve been having|recently|could|also|另外|同时/i.test(original)) return multiTopicSummary;
  if (/china|中国/i.test(original)
    && /approved|approve|批准|获批|plans?\s+to\s+let|allow|permit|greenlight|放行|允许|拟允许|计划允许/i.test(original)
    && /deepseek|bytedance|字节|alibaba|阿里|top\s+ai\s+firms?|ai\s+firms?|major\s+ai\s+companies|头部ai|ai公司/i.test(original)
    && /h200|nvidia|英伟达/i.test(original)) {
    const quantity = extractH200PurchaseQuantity(original);
    return `中国拟允许头部AI公司采购NVIDIA H200${quantity ? ` ${quantity}` : ''}`;
  }
  const specificEventTitle = summarizeSpecificEventTitle(original, subject === '产业链' ? '' : subject);
  if (specificEventTitle) return specificEventTitle;
  if (/cloudflare/i.test(original) && /openai/i.test(original) && /pilot|research|signal|signals/i.test(original)) return 'Cloudflare与OpenAI启动内容信号研究试点';
  if (/cloudflare|\$net/i.test(original) && /openai|chatgpt/i.test(original) && /content|crawl|index|answers?|signals?|web|traffic|内容|索引|答案/i.test(original)) return 'Cloudflare受益OpenAI内容索引与ChatGPT答案入口';
  if (/xai|x\.ai|spacexai|space\s*x\s*ai|grok/i.test(original)
    && (/grok\s*4\.?5|grok4\.?5|grok-4\.?5/i.test(original)
      || /new\s+model.*cursor|cursor.*new\s+model|available.*cursor|try\s+out.*cursor|try\s+out.*vercel/i.test(original))) return 'xAI发布Grok 4.5';
  if (/capex|capital expenditure|资本开支|ai investment|投资/i.test(original) && money && percent) return `${subject}资本开支增至${money}，同比${percent}`;
  if (/capex|capital expenditure|资本开支|ai investment|投资/i.test(original) && money) return `${subject}资本开支/AI投资达${money}`;
  if (/model y/i.test(original) && /production|产量|deliver/i.test(original) && percent) return `Tesla Model Y产量大涨${percent}`;
  if (modelName && modelLaunchPattern.test(original)) {
    const modelSentence = getModelLaunchSentence(original, modelName);
    const modelSubject = getXSubject(modelSentence);
    if (/cerebras/i.test(modelSentence) && /inference|推理/i.test(modelSentence)) return `${modelSubject}将在Cerebras上线${modelName}推理`;
    if (/inference|推理/i.test(modelSentence)) return `${modelSubject}上线${modelName}推理`;
    return `${modelSubject}发布${modelName}模型`;
  }
  if (priceDownPattern.test(original)) {
    const signalSentence = getRelevantXSentence(original, priceDownPattern);
    return `${getXSubject(signalSentence)}价格下跌${extractFirstPercent(signalSentence) || percent || ''}`.trim();
  }
  if (priceUpPattern.test(original)) {
    const signalSentence = getRelevantXSentence(original, priceUpPattern);
    const signalSubject = getXSubject(signalSentence);
    if (signalSubject === '产业链') {
      return summarizeCompanyActionTitle(original) || summarizeOriginalSentence(signalSentence, '');
    }
    return `${signalSubject}涨价${extractFirstPercent(signalSentence) || percent || ''}`.trim();
  }
  if (/供需|短缺|供不应求|供应紧张|产能紧张|tight supply|shortage|supply.*capped|capped.*supply/.test(text)) return summarizeSupplySignal(original, subject);
  if (/订单|客户|供货|合同|agreement|contract|supply deal|customer/i.test(original)) return `${subject}披露订单或供货变化${money ? `，规模${money}` : ''}`;
  if (/blue origin/i.test(original) && /rklb|rocket lab/i.test(original) && /raise|funding|valuation|融资|估值/i.test(original)) return `Blue Origin拟融资${money || '外部资金'}，RKLB受益航天基建估值重估`;
  if (/融资|贷款|估值|raise|funding|valuation|loan/i.test(original)) return `${subject}融资/贷款${money ? `达${money}` : ''}`;
  if (/data center|datacenter|mw|gw|project|数据中心/i.test(original)) return `${subject}披露数据中心项目${money ? `，规模${money}` : ''}`;
  if (/发布|推出|上线|launch|release|model|模型|api|developer/i.test(original) && isSoftwareSubject) return modelName ? `${subject}发布${modelName}` : summarizeOriginalSentence(original, subject);
  if (/出口管制|监管|政策|关税|export control|tariff|policy|regulation/i.test(original)) return `${subject}涉及政策监管变化`;
  if (/业绩|收入|利润|指引|earnings|revenue|sales|guidance/i.test(original)) return `${subject}${/指引|guidance/i.test(original) ? '调整业绩指引' : '披露业绩变化'}${percent ? ` ${percent}` : ''}`;
  return summarizeOriginalSentence(original, subject === '产业链' ? '' : subject);
};

const getOriginalNewsText = (item: NewsDisplayLike) => {
  if (isXNewsItem(item)) return getXOriginalText(item);
  const title = (item.title || '').trim();
  const snippet = (item.snippet || '').trim();
  if (snippet && snippet !== title && !title.includes(snippet)) return cleanNewsBoilerplate(`${title} ${snippet}`.trim());
  return cleanNewsBoilerplate(snippet || title);
};

const GENERIC_DISPLAY_TITLE_PATTERN = /^(?:X平台|X观点|海外消息|行业消息|产业链|市场动态)|(?:最新动态|产品更新|观点讨论|供需紧张信号)$/i;

const ensureSpecificDisplayTitle = (candidate: string, original: string) => {
  if (!GENERIC_DISPLAY_TITLE_PATTERN.test(candidate)) return candidate;
  const companyActionTitle = summarizeCompanyActionTitle(original);
  if (companyActionTitle) return companyActionTitle;
  const originalSummary = summarizeOriginalSentence(original, '');
  return originalSummary && !GENERIC_DISPLAY_TITLE_PATTERN.test(originalSummary)
    ? originalSummary
    : candidate;
};

export const getDisplayTitle = (item: NewsDisplayLike) => {
  const original = getOriginalNewsText(item);
  const candidate = isXNewsItem(item) ? summarizeXTitle(item) : summarizeNewsFromText(original);
  return ensureSpecificDisplayTitle(candidate, original);
};

export const getDisplayBodyLabel = (_item?: NewsDisplayLike) => '原文：';

export const getDisplayBody = (item: NewsDisplayLike) =>
  getOriginalNewsText(item);

const getPriceSignalDirection = (item: EnrichedNewsItem) => {
  const text = `${item.title || ''} ${item.snippet || ''}`;
  if (/持平|无变动|涨跌\s*0|日变动\s*0|—/.test(text)) return '持平';
  return /降价|下跌|跌价|回落|下降|price\s*(drop|decline|cut)/i.test(text)
    ? '下跌'
    : '涨价';
};

const formatPriceSignalTitle = (item: EnrichedNewsItem) => {
  const direction = getPriceSignalDirection(item);
  if (direction === '持平') return `${formatPriceProductLabel(item)}价格持平`;
  return `${formatPriceProductLabel(item)}价格${direction === '涨价' ? '上涨' : '下跌'}`;
};

const formatNumberWithCommas = (value?: string | number | null) => {
  if (value === null || value === undefined || value === '') return '--';
  const raw = String(value).replace(/,/g, '').trim();
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return String(value);
  return numeric.toLocaleString('en-US', {
    maximumFractionDigits: 0,
  });
};

const formatPercentMove = (value?: string | number | null) => {
  if (value === null || value === undefined || value === '') return '--';
  const numeric = Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(numeric)) return String(value);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(2)}%`;
};

const parseNumericValue = (value?: string | number | null) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(numeric) ? numeric : null;
};

const extractPriceLatestNumber = (item: EnrichedNewsItem) => {
  const explicit = parseNumericValue(item.priceLatestValue);
  if (explicit !== null) return explicit;
  const text = `${item.title || ''} ${item.snippet || ''}`;
  const direct = text.match(/(?:最新价|均价|报价|价格|报|至)\s*([0-9,]+(?:\.\d+)?)/i);
  if (direct) return parseNumericValue(direct[1]);
  const unit = text.match(/([0-9,]+(?:\.\d+)?)\s*(元\/标吨|元\/吨|万元\/吨|元\/颗|元\/千克|美元\/颗|美元\/片|美元|美金)/i);
  if (unit) return parseNumericValue(unit[1]);
  return null;
};

const extractPriceLatestValue = (item: EnrichedNewsItem) => {
  if (item.priceLatestValue !== undefined && item.priceLatestValue !== null) {
    return formatNumberWithCommas(item.priceLatestValue);
  }
  const text = `${item.title || ''} ${item.snippet || ''}`;
  const direct = text.match(/(?:最新价|均价|报价|价格|报|至)\s*([0-9,]+(?:\.\d+)?)/i);
  if (direct) return formatNumberWithCommas(direct[1]);
  const unit = text.match(/([0-9,]+(?:\.\d+)?)\s*(元\/标吨|元\/吨|万元\/吨|元\/颗|元\/千克|美元\/颗|美元\/片|美元|美金)/i);
  if (unit) return formatNumberWithCommas(unit[1]);
  return '--';
};

const formatAbsoluteMoveAsPercent = (absoluteMove: string | number | null | undefined, item: EnrichedNewsItem) => {
  const latest = extractPriceLatestNumber(item);
  const move = parseNumericValue(absoluteMove);
  if (latest === null || move === null) return '--';
  const previous = latest - move;
  if (!Number.isFinite(previous) || previous === 0) return '0.00%';
  return formatPercentMove((move / previous) * 100);
};

const extractPriceMoveValue = (item: EnrichedNewsItem) => {
  if (item.priceMoveValue !== undefined && item.priceMoveValue !== null) {
    if (/dram-spot-price-watch|nand-spot-price-watch|r32-price-watch|hafnium-price-watch|q5500-price-watch|price-total-watch/.test(item.sourceId || '')) {
      return formatPercentMove(item.priceMoveValue);
    }
    return formatAbsoluteMoveAsPercent(item.priceMoveValue, item);
  }
  const text = `${item.title || ''} ${item.snippet || ''}`;
  const direction = getPriceSignalDirection(item);
  if (item.collectionChannel === 'price-watch' || item.sourceId === 'tungsten-price-watch') {
    const dailyChange = text.match(/涨跌\s*([+-]?\d+(?:,\d{3})*(?:\.\d+)?)/);
    if (dailyChange) return formatAbsoluteMoveAsPercent(dailyChange[1], item);
    return '0.00%';
  }
  const rangePercent = text.match(/([+-]?\d+(?:\.\d+)?)\s*(?:-|–|~|至|到)\s*([+-]?\d+(?:\.\d+)?)\s*%/);
  if (rangePercent) return `${direction === '涨价' ? '+' : '-'}${rangePercent[1]}-${rangePercent[2]}%`;
  const percent = text.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  if (percent) return formatPercentMove(percent[1]);
  const multiple = text.match(/(\d+(?:\.\d+)?)\s*(?:-|–|~|至|到)\s*(\d+(?:\.\d+)?)\s*x/i);
  if (multiple) return `+${multiple[1]}-${multiple[2]}x`;
  const upToMultiple = text.match(/up to\s*(\d+(?:\.\d+)?)\s*x/i);
  if (upToMultiple) return `最高${upToMultiple[1]}x`;
  const absoluteMove = text.match(/(?:上涨|下跌|上调|下降|涨价|降价|涨跌)\s*([+-]?\d+(?:,\d{3})*(?:\.\d+)?)/);
  if (absoluteMove) {
    const signedMove = `${direction === '涨价' ? '+' : '-'}${absoluteMove[1]}`;
    return formatAbsoluteMoveAsPercent(signedMove, item);
  }
  return '0.00%';
};

const getPriceSourceAuthorityScore = (item: EnrichedNewsItem) => {
  const source = `${item.source || ''} ${item.url || ''}`.toLowerCase();
  const product = getPriceProductName(item).toLowerCase();
  let authority = 0;

  if (/smm|上海有色|hq\.smm/.test(source)) authority += /钨|tungsten|铜|金属/.test(product) ? 80 : 45;
  if (/trendforce|集邦/.test(source)) authority += /dram|nand|hbm|ssd|mlcc|memory|flash/.test(product) ? 75 : 45;
  if (/economics daily|經濟日報|经济日报/.test(source)) authority += /mlcc|被动元件|电容/.test(product) ? 55 : 30;
  if (/reuters|bloomberg|nikkei|digitimes/.test(source)) authority += 45;
  if (/wall street cn|wallstreetcn|华尔街/.test(source)) authority += 28;
  if (/x\/@jukan05|twitter @jukan05|x\.com\/jukan05/.test(source)) authority += 26;
  if (/x\/|twitter|x\.com/.test(source)) authority += 12;

  return authority + (item.score || 0);
};

const isIndustryPriceSignal = (item: EnrichedNewsItem) => {
  const text = `${item.priceProduct || ''} ${item.title || ''} ${item.snippet || ''} ${item.signalType || ''}`;
  const actionPattern = /现货价|合约价|contract price|报价|均价|涨跌|涨价|提价|喊涨|调涨|价格上调|价格上涨|报价上涨|asp|price\s*(increase|hike|cut|decline|drop)|raise\s*prices?|降价|价格下调|跌价|回落|下降/i;
  const specificProductPattern = /dram|ddr[45]?|ssd|nand|mlc|slc|hbm|mlcc|pcb|ccl|铜箔|玻纤布|钨粉|钨精矿|黑钨精矿|废钨|废钨棒材|钨矿|tungsten|内存|memory|晶圆|wafer|被动元件|电容|光模块|server ddr|服务器内存/i;
  const marketNoisePattern = /A股|午评|ETF|基金|指数|成分股|沪指|创业板|恒指|科创|港股|美股|股票|股价|涨停|涨幅|stock price|share price|price target|目标价|评级|买入|增持|估值|valuation|valued at|market cap|CEF|上市|IPO|券商|资金|交易|业绩|净利润|营收|订单大增|设备龙头|非农|PMI|央行|油价|黄金|期权|期货主力/i;
  if (!actionPattern.test(text)) return false;
  if (marketNoisePattern.test(text)) return false;
  if (specificProductPattern.test(text)) return true;
  return false;
};

const buildDateLabel = (time: string, fallback: string) => {
  const parsed = parseNewsDate(time);
  if (parsed) {
    return formatChinaDateLabel(time);
  }

  const relativeHoursMatch = time.match(/(\d+)小时/);
  if (relativeHoursMatch) {
    const hours = parseInt(relativeHoursMatch[1], 10);
    const today = dayjs();
    if (Number.isFinite(hours) && hours >= 18) {
      const yesterday = today.subtract(1, 'day');
      return `6月${yesterday.format('D日')} 周${WEEKDAY_MAP[yesterday.day()]}`;
    }
    return `今天 ${today.format('M月D日')} 周${WEEKDAY_MAP[today.day()]}`;
  }

  if (/^\d{1,2}:\d{2}$/.test(time) || time.includes('分钟')) {
    return `今天 ${dayjs().format('M月D日')} 周${WEEKDAY_MAP[dayjs().day()]}`;
  }

  return fallback;
};

const isTodayNewsItem = (item: EnrichedNewsItem) => {
  const parsedDate = parseNewsDate(item.time || '');
  return parsedDate ? getChinaDateKey(parsedDate.valueOf()) === getChinaDateKey(new Date()) : item.dateLabel.startsWith('今天');
};

const isDisplayPriceSignal = (item: EnrichedNewsItem) => {
  const text = `${item.title || ''} ${item.snippet || ''} ${item.signalType || ''}`;
  const source = `${item.source || ''} ${item.url || ''}`;
  const trustedPriceSource = /smm|上海有色|trendforce|集邦|wall\s*street\s*cn|wallstreetcn|华尔街|工商时报|ctee|digitimes|nikkei|reuters/i.test(source);
  const productPattern = /dram|ddr[45]?|ssd|nand|mlc|slc|hbm|mlcc|pcb|ccl|铜箔|玻纤布|钨粉|钨精矿|黑钨精矿|废钨|废钨棒材|钨矿|tungsten|cpu|gpu|内存|memory|晶圆|wafer|被动元件|电容|光模块|server ddr|服务器内存/i;
  const actionPattern = /现货价|合约价|contract price|报价|均价|涨跌|涨价|提价|喊涨|调涨|价格上调|价格上涨|报价上涨|asp|price\s*(increase|hike|cut|decline|drop)|raise\s*prices?|降价|价格下调|跌价|回落|下降/i;
  const noisePattern = /A股|午评|ETF|基金|指数|成分股|沪指|创业板|恒指|科创|港股|美股|股票|股价|涨停|涨幅|stock price|share price|price target|目标价|评级|买入|增持|估值|valuation|valued at|market cap|CEF|上市|IPO|券商|资金|交易|业绩|净利润|营收|订单大增|设备龙头|非农|PMI|央行|油价|黄金|期权|期货主力/i;

  if (noisePattern.test(text)) return false;
  return isIndustryPriceSignal(item) || (trustedPriceSource && productPattern.test(text) && actionPattern.test(text));
};

const isFixedPriceWatchItem = (item: EnrichedNewsItem) =>
  item.collectionChannel === 'price-watch'
  && /tungsten-price-watch|dram-spot-price-watch|nand-spot-price-watch|r32-price-watch|hafnium-price-watch|q5500-price-watch|price-total-watch/.test(item.sourceId || '');

const shouldShowPriceSignal = (item: EnrichedNewsItem) => {
  const text = `${item.priceProduct || ''} ${item.title || ''} ${item.snippet || ''}`;
  if (/DDR3/i.test(text)) return false;
  if (/DDR5.*eTT|DDR4.*eTT/i.test(text)) return false;
  if (/DDR4\s+8Gb.*3200.*PC/i.test(text)) return false;
  if (/SLC/i.test(text)) return false;
  return true;
};

export const enrichNewsItems = (news: NewsItem[], newNewsIds: Set<string> = new Set()): EnrichedNewsItem[] => {
  const todayLabel = `今天 ${dayjs().format('M月D日')} 周${WEEKDAY_MAP[dayjs().day()]}`;
  return news.map((item) => {
    const topic = inferTopic(item);
    const score = item.score || item.normalizedEngagementScore || 62 + (stableHash(`${item.title}${item.source}`) % 29);
    const sourceCount = 1;
    const digestBody = item.snippet?.trim() || item.title;
    const digest = `${digestBody.replace(/^(.{96}).*$/, '$1')}${digestBody.length > 96 ? '…' : ''}`;
    const dateLabel = buildDateLabel(item.time || '', todayLabel);
    const parsedDate = parseNewsDate(item.time || '');
    return {
      ...item,
      topic,
      score,
      sourceCount,
      digest: `${compactSourceName(item.source)}：${digest}`,
      isNew: newNewsIds.has(item.title),
      dateLabel,
      dateSort: parsedDate ? parsedDate.valueOf() : 0,
    };
  });
};

export const selectTodayHotNewsItems = (enriched: EnrichedNewsItem[]) => {
  const visibleEnriched = enriched.filter((item) => {
    const signalBucket = inferSignalBucket(item);
    return !isPromotionalGiveaway(item) && !isMarketTapeNoise(item) && (
      item.score >= MIN_VISIBLE_SCORE
      || isInvestableSignalException(item, signalBucket)
      || isDisplayPriceSignal(item)
      || isMajorMacroRelease(item)
    );
  });
  const newsTimelineItems = visibleEnriched.filter((item) => !isFixedPriceWatchItem(item));
  const cutoff = Date.now() - HOT_SIGNAL_WINDOW_MS;
  const recentVisibleNewsItems = newsTimelineItems.filter((item) => item.dateSort >= cutoff);
  return dedupeByTitle(recentVisibleNewsItems).sort((a, b) => b.score - a.score).slice(0, 3);
};

const getPriceDisplayOrder = (item: EnrichedNewsItem) => {
  const text = `${item.priceProduct || ''} ${item.title || ''} ${item.snippet || ''}`;
  if (/黑钨精矿|钨精矿/i.test(text)) return 10;
  if (/废钨棒材/i.test(text)) return 11;
  if (/钨粉/i.test(text)) return 12;
  if (/\bR32\b|制冷剂R32/i.test(text)) return 13;
  if (/金属铪|hafnium/i.test(text)) return 14;
  if (/Q5500|动力煤/i.test(text)) return 15;
  if (/LME铜/i.test(text)) return 16;
  if (/LME铝|氧化铝/i.test(text)) return 17;
  if (/钴|碳酸锂|多晶硅|COMEX白银/i.test(text)) return 18;
  if (/DDR5/i.test(text)) return 20;
  if (/DDR4/i.test(text)) return 30;
  if (/NAND|MLC|SLC/i.test(text)) return 40;
  if (/TDI|MDI|氯化钾|尿素|复合肥/i.test(text)) return 50;
  if (/LNG|布伦特|焦煤|焦炭|螺纹钢/i.test(text)) return 60;
  if (/伦敦金|BTC|ETH/i.test(text)) return 80;
  return 90;
};

const getPriceChartUrl = (item: EnrichedNewsItem) => {
  const text = `${item.priceProduct || ''} ${item.title || ''}`;
  const fallbackUrl = /钨粉/i.test(text)
    ? '/api/news/price-chart?kind=tungsten&product=tungsten-powder'
    : /废钨棒材/i.test(text)
      ? '/api/news/price-chart?kind=tungsten&product=waste-tungsten-bar'
      : /\bR32\b|制冷剂R32/i.test(text)
        ? '/api/news/price-chart?kind=tungsten&product=r32'
        : /金属铪|hafnium/i.test(text)
          ? '/api/news/price-chart?kind=tungsten&product=hafnium'
          : /Q5500|动力煤/i.test(text)
            ? '/api/news/price-chart?kind=tungsten&product=q5500'
            : '';
  const url = item.priceChartUrl || fallbackUrl;
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/api')) return `${API_BASE}${url}`;
  return url;
};

export const HotListItem: React.FC<{
  idx: number;
  item: EnrichedNewsItem;
  theme: string;
}> = ({ idx, item, theme }) => {
  const signalBucket = inferSignalBucket(item);
  const tone = SIGNAL_TONE[signalBucket];
  const displayTitle = getDisplayTitle(item);
  const bodyLabel = getDisplayBodyLabel(item);
  const bodyText = getDisplayBody(item);

  return (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (!item.url || item.url.startsWith('local://')) e.preventDefault();
      }}
      style={{ color: 'inherit', textDecoration: 'none' }}
    >
      <div
        style={{
          minHeight: 112,
          padding: '14px 16px',
          borderRadius: 6,
          border: `1px solid ${theme === 'dark' ? '#92400e' : '#e6b06a'}`,
          background: theme === 'dark' ? '#14110d' : '#fffdf8',
        }}
      >
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '32px minmax(0, 1fr)', gap: 10, alignItems: 'center' }}>
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
              }}
            >
              {idx + 1}
            </div>
            <Text
              style={{
                display: 'block',
                color: item.url ? (theme === 'dark' ? '#f5f5f5' : '#111827') : (theme === 'dark' ? '#f5f5f5' : '#1f2937'),
                fontWeight: 800,
                fontSize: 16,
                lineHeight: 1.35,
                minWidth: 0,
              }}
              ellipsis={{ tooltip: displayTitle }}
            >
              {displayTitle}
            </Text>
          </div>
          <div
            style={{
              marginTop: 8,
              paddingLeft: 34,
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto auto auto',
              gap: 8,
              alignItems: 'center',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            <Text type="secondary" style={{ fontSize: 11, minWidth: 0 }} ellipsis={{ tooltip: `来源: ${compactSourceName(item.source)}` }}>
              来源: {compactSourceName(item.source)}
            </Text>
            <Text type="secondary" style={{ fontSize: 11 }}>{formatNewsTime(item.time)}</Text>
            <Tag color={tone.color} style={{ marginRight: 0, background: tone.bg, borderColor: tone.bg, fontSize: 11, lineHeight: '18px', padding: '0 7px' }}>{signalBucket}</Tag>
            <Text type="secondary" style={{ fontSize: 11 }}>热度 {item.score}</Text>
          </div>
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
              marginTop: 12,
              fontSize: 13,
              color: theme === 'dark' ? '#d1d5db' : '#374151',
              lineHeight: 1.5,
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 2,
              overflow: 'hidden',
              maxHeight: 39,
              cursor: 'help',
            }}
          >
            <span style={{ fontWeight: 700, marginRight: 4 }}>{bodyLabel}</span>
            <span>{bodyText}</span>
          </div>
        </Tooltip>
      </div>
    </a>
  );
};

const DailyNewsItem: React.FC<{
  item: EnrichedNewsItem;
  theme: string;
}> = ({ item, theme }) => {
  const signalBucket = inferSignalBucket(item);
  const tone = SIGNAL_TONE[signalBucket];
  const dotColor = tone.color;
  const displayTitle = getDisplayTitle(item);
  const bodyText = getDisplayBody(item);
  const bodyLabel = getDisplayBodyLabel(item);

  return (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (!item.url || item.url.startsWith('local://')) e.preventDefault();
      }}
      style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '58px 18px minmax(0, 1fr) minmax(130px, 180px)',
          gap: 10,
          alignItems: 'start',
          padding: '10px 0',
          borderBottom: `1px solid ${theme === 'dark' ? '#262626' : '#eceff3'}`,
          background: item.isNew ? (theme === 'dark' ? '#171717' : '#fffaf0') : 'transparent',
          transition: 'all .2s',
        }}
      >
        <div style={{ textAlign: 'left', paddingTop: 2 }}>
          <Text strong style={{ display: 'block', fontSize: 13, color: theme === 'dark' ? '#d1d5db' : '#374151', fontVariantNumeric: 'tabular-nums' }}>
            {formatTimelineTime(item.time)}
          </Text>
          {signalBucket !== '其他信号' ? (
            <Tag
              color={tone.color}
              style={{
                marginTop: 6,
                marginRight: 0,
                background: tone.bg,
                borderColor: tone.bg,
                fontSize: 11,
                lineHeight: '18px',
                padding: '0 4px',
              }}
            >
              {signalBucket}
            </Tag>
          ) : null}
        </div>

        <div style={{ position: 'relative', height: '100%', minHeight: 50 }}>
          <span
            style={{
              position: 'absolute',
              top: 7,
              left: 5,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: dotColor,
            }}
          />
          <span
            style={{
              position: 'absolute',
              top: 20,
              bottom: -18,
              left: 8,
              width: 1,
              background: theme === 'dark' ? '#303030' : '#e5e7eb',
            }}
          />
        </div>

        <div style={{ minWidth: 0 }}>
          <Text
            style={{
              color: item.url ? (theme === 'dark' ? '#f3f4f6' : '#111827') : (theme === 'dark' ? '#d9d9d9' : '#262626'),
              fontWeight: item.isNew ? 800 : 650,
              fontSize: 15,
              lineHeight: 1.35,
              display: 'block',
            }}
          >
            {displayTitle}
          </Text>
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
                marginTop: 5,
                color: theme === 'dark' ? '#9ca3af' : '#4b5563',
                fontSize: 13,
                lineHeight: 1.45,
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 2,
                overflow: 'hidden',
                maxHeight: 38,
                cursor: 'help',
              }}
            >
              <span style={{ color: theme === 'dark' ? '#9ca3af' : '#6b7280' }}>{bodyLabel}</span>
              <span>{bodyText}</span>
            </div>
          </Tooltip>
        </div>

        <div style={{ minWidth: 130, textAlign: 'left', paddingTop: 1 }}>
          <Space size={6}>
            <Text type="secondary" style={{ fontSize: 13 }}>热度</Text>
            <Text style={{ color: theme === 'dark' ? '#d1d5db' : '#374151', fontSize: 13, fontWeight: 600 }}>{item.score}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>/ {item.topic}</Text>
          </Space>
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>来源: {compactSourceName(item.source)}</Text>
        </div>
      </div>
    </a>
  );
};

const NewsPanel: React.FC = () => {
  const { theme } = useTheme();
  const { news, lastUpdated, loading, apiStatus, isMockData, refresh } = useNewsFeed();
  const [searchText, setSearchText] = useState('');
  const [topicFilter, setTopicFilter] = useState<NewsTopic>('全部');
  const [signalFilter, setSignalFilter] = useState<SignalBucket | '全部'>('全部');
  const [visibleCount, setVisibleCount] = useState(NEWS_PAGE_SIZE);

  const prevNewsRef = React.useRef<Set<string>>(new Set());
  const [newNewsIds, setNewNewsIds] = useState<Set<string>>(new Set());

  const activeSources = useMemo(() => {
    const sourceSet = new Set<string>();
    news.forEach((item) => {
      if (item.collectionChannel === 'price-watch' || item.sourceId === 'tungsten-price-watch') return;
      if (item.source && item.source.trim()) sourceSet.add(compactSourceName(item.source));
    });
    return Array.from(sourceSet).sort((a, b) => a.localeCompare(b));
  }, [news]);

  React.useEffect(() => {
    const currentIds = new Set(news.map((item) => item.title));
    const incoming = new Set<string>();
    currentIds.forEach((id) => {
      if (!prevNewsRef.current.has(id)) incoming.add(id);
    });
    setNewNewsIds(incoming);
    prevNewsRef.current = currentIds;
  }, [news]);

  React.useEffect(() => {
    setVisibleCount(NEWS_PAGE_SIZE);
  }, [searchText, topicFilter, signalFilter]);

  const enriched = useMemo<EnrichedNewsItem[]>(() => enrichNewsItems(news, newNewsIds), [news, newNewsIds]);

  const visibleEnriched = useMemo(() => enriched.filter((item) => {
    const signalBucket = inferSignalBucket(item);
    return !isPromotionalGiveaway(item) && !isMarketTapeNoise(item) && (
      item.score >= MIN_VISIBLE_SCORE
      || isInvestableSignalException(item, signalBucket)
      || isDisplayPriceSignal(item)
      || isMajorMacroRelease(item)
    );
  }), [enriched]);

  const newsTimelineItems = useMemo(() => visibleEnriched.filter((item) => !isFixedPriceWatchItem(item)), [visibleEnriched]);
  const todayVisibleNewsItems = useMemo(() => newsTimelineItems.filter(isTodayNewsItem), [newsTimelineItems]);

  const topicScopeList = useMemo(() => {
    const scopedByTopic = topicFilter === '全部'
      ? newsTimelineItems
      : newsTimelineItems.filter((item) => item.topic === topicFilter);
    if (signalFilter === '全部') return scopedByTopic;
    return scopedByTopic.filter((item) => inferSignalBucket(item) === signalFilter);
  }, [newsTimelineItems, topicFilter, signalFilter]);

  const pageModeList = useMemo(() => dedupeByTitle(topicScopeList), [topicScopeList]);

  const sortedHot = useMemo(() => selectTodayHotNewsItems(enriched), [enriched]);

  const filtered = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    const currentList = pageModeList.filter((item) => {
      if (!keyword) return true;
      return item.title.toLowerCase().includes(keyword)
        || getDisplayTitle(item).toLowerCase().includes(keyword)
        || getDisplayBody(item).toLowerCase().includes(keyword)
        || item.source.toLowerCase().includes(keyword);
    });
    return dedupeByTitle(currentList);
  }, [pageModeList, searchText]);

  const displayedFiltered = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);

  const hasMoreNews = displayedFiltered.length < filtered.length;

  const groupedByDate = useMemo(() => {
    const groups = new Map<string, EnrichedNewsItem[]>();

    displayedFiltered.forEach((item) => {
      const currentGroup = groups.get(item.dateLabel) || [];
      currentGroup.push(item);
      groups.set(item.dateLabel, currentGroup);
    });

    return Array.from(groups.entries())
      .map(([title, items]) => ({
        title,
        items: [...items].sort((a, b) => b.dateSort - a.dateSort),
        sort: Math.max(...items.map((item) => item.dateSort)),
      }))
      .sort((a, b) => b.sort - a.sort)
      .map(({ title, items }) => ({ title, items }));
  }, [displayedFiltered]);

  const priceSignals = useMemo(() => {
    const latestFixedPriceWatch = new Map<string, EnrichedNewsItem>();
    enriched
      .filter((item) => isFixedPriceWatchItem(item) && shouldShowPriceSignal(item))
      .forEach((item) => {
        const key = `${item.sourceId || item.source}-${formatPriceProductLabel(item)}`;
        const existing = latestFixedPriceWatch.get(key);
        if (!existing || item.dateSort > existing.dateSort) {
          latestFixedPriceWatch.set(key, item);
        }
      });

    const candidates = dedupeByTitle([
      ...todayVisibleNewsItems.filter((item) => isDisplayPriceSignal(item) && shouldShowPriceSignal(item)),
      ...Array.from(latestFixedPriceWatch.values()),
    ]);
    const bySignal = new Map<string, EnrichedNewsItem>();
    candidates.forEach((item) => {
      const signalKey = formatPriceProductLabel(item);
      const existing = bySignal.get(signalKey);
      const itemRank = getPriceSourceAuthorityScore(item);
      const existingRank = existing ? getPriceSourceAuthorityScore(existing) : -Infinity;
      if (!existing || itemRank > existingRank || (itemRank === existingRank && item.dateSort > existing.dateSort)) {
        bySignal.set(signalKey, item);
      }
    });
    return Array.from(bySignal.values())
      .sort((a, b) => getPriceDisplayOrder(a) - getPriceDisplayOrder(b) || b.dateSort - a.dateSort || b.score - a.score);
  }, [todayVisibleNewsItems, enriched]);

  const sourceLeaders = useMemo(() => {
    const sourceMap = new Map<string, { source: string; count: number; maxScore: number; isX: boolean }>();
    todayVisibleNewsItems.forEach((item) => {
      const source = compactSourceName(item.source || '未知来源');
      const current = sourceMap.get(source) || { source, count: 0, maxScore: 0, isX: /^X\//i.test(source) };
      current.count += 1;
      current.maxScore = Math.max(current.maxScore, item.score);
      current.isX = current.isX || /^X\//i.test(source);
      sourceMap.set(source, current);
    });
    const ranked = Array.from(sourceMap.values())
      .sort((a, b) => b.count - a.count || b.maxScore - a.maxScore);
    const mixed = [
      ...ranked.filter((source) => !source.isX).slice(0, 3),
      ...ranked.filter((source) => source.isX).slice(0, 3),
      ...ranked,
    ];
    const seen = new Set<string>();
    return mixed.filter((source) => {
      if (seen.has(source.source)) return false;
      seen.add(source.source);
      return true;
    }).slice(0, 6);
  }, [todayVisibleNewsItems]);

  const todayStats = useMemo(() => {
    const topScore = todayVisibleNewsItems.length > 0 ? Math.max(...todayVisibleNewsItems.map((item) => item.score)) : 0;
    const hotCount = todayVisibleNewsItems.filter((item) => item.score >= 100).length;
    return {
      count: todayVisibleNewsItems.length,
      topScore,
      hotCount,
    };
  }, [todayVisibleNewsItems]);

  return (
    <div style={{ background: theme === 'dark' ? '#050505' : '#faf9f6', padding: 2 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, flexWrap: 'wrap' }}>
          <Text style={{ display: 'block', fontSize: 32, fontWeight: 900, letterSpacing: -0.8, color: theme === 'dark' ? '#f5f5f5' : '#111827' }}>
            新闻资讯
          </Text>
          <Text style={{ color: theme === 'dark' ? '#c4c4c4' : '#4b5563', fontSize: 15 }}>
            买方信息员 · 今日重点 / 历史归档 / 产业价格信号
          </Text>
        </div>
        <Space size={14} wrap>
          <Text style={{ color: theme === 'dark' ? '#c4c4c4' : '#374151', fontSize: 14 }}>
            刷新时间：{formatChinaFullDateTime(lastUpdated)}
          </Text>
          <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>刷新</Button>
        </Space>
      </div>

      <Card
        style={{
          marginBottom: 10,
          borderRadius: 6,
          background: theme === 'dark' ? '#101010' : '#fffdfa',
          border: `1px solid ${theme === 'dark' ? '#3f3f46' : '#ead8bf'}`,
        }}
        bodyStyle={{ padding: '14px 16px' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <Space size={8}>
            <FireOutlined style={{ color: '#b45309' }} />
            <Text strong style={{ fontSize: 17 }}>今日重点信号</Text>
            <Tooltip title="只看过去8小时内的新闻，按当前热度模型取前三。"><Text type="secondary" style={{ cursor: 'help' }}>ⓘ</Text></Tooltip>
          </Space>
          <Space size={8}>
            <Tag color={apiStatus === 'offline' || isMockData ? 'warning' : 'success'}>
              <Tooltip
                title={(
                  <div style={{ maxWidth: 280 }}>
                    {activeSources.length > 0 ? (
                      <div>
                        <div>当前来源：</div>
                        <div style={{ whiteSpace: 'pre-wrap' }}>{activeSources.join('、')}</div>
                      </div>
                    ) : '暂无活跃来源'}
                  </div>
                )}
              >
                {apiStatus === 'offline' || isMockData ? '离线缓存' : '热度源在线'}
              </Tooltip>
            </Tag>
            <Tag color="default">今日池 {todayStats.count}</Tag>
            <Tag color="success">今日</Tag>
          </Space>
        </div>
        <Spin spinning={loading && news.length === 0}>
          {sortedHot.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
              {sortedHot.map((item, idx) => <HotListItem key={`${item.title}-${idx}`} idx={idx} item={item} theme={theme} />)}
            </div>
          ) : <Empty description="暂无热点" />}
        </Spin>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 410px', gap: 12, alignItems: 'start' }}>
        <Card
          style={{
            minWidth: 0,
            background: theme === 'dark' ? '#101010' : '#fff',
            borderRadius: 6,
            border: `1px solid ${theme === 'dark' ? '#2f2f2f' : '#d9dee6'}`,
          }}
          bodyStyle={{ padding: 0 }}
        >
          <div style={{ padding: '0 18px 10px', borderBottom: `1px solid ${theme === 'dark' ? '#262626' : '#e5e7eb'}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Tabs
                activeKey={topicFilter}
                onChange={(value) => setTopicFilter(value as NewsTopic)}
                items={TOPIC_OPTIONS.map((topic) => ({ key: topic, label: topic }))}
                size="small"
                style={{ flex: '1 1 420px' }}
              />
              <Space size={8} wrap>
                <Input
                  allowClear
                  placeholder="搜索标题 / 来源"
                  prefix={<SearchOutlined />}
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  style={{ width: 220, height: 26, padding: '0 9px', fontSize: 13 }}
                />
                <Tooltip
                  overlayStyle={{ maxWidth: 520 }}
                  title={(
                    <div style={{ maxWidth: 500, lineHeight: 1.7 }}>
                      <div><strong>热度算法</strong></div>
                      <div>非 X 新闻：基础 50 + 分类加分 + 信号加分 + 来源质量加分 + 多来源报道加分 + 投资语境加分 + 新鲜度加分。</div>
                      <div>分类加分：AI涨价 +34，硬件 +26，软件 +22，消费 +16，宏观 +12。</div>
                      <div>信号加分：利好涨价 +42，利空降价 +38，供需紧张 +34，需求改善 +22，宏观政策 +20。</div>
                      <div>来源加分：官方 +20，公众号 +18，Newsletter +16，媒体 +15，学术 +11，开发者 +9。</div>
                      <div>多来源报道加分：同一事件被多个来源报道时，每多 1 个来源 +6，最多 +24；合并展示时只保留热度更高的一条。</div>
                      <div>X 新闻：优先使用互动/粉丝归一化热度；不套用普通媒体公式。</div>
                      <div>展示规则：主新闻流默认显示热度 100 以上；明确价格/供需/涨跌信号会保留。</div>
                    </div>
                  )}
                >
                  <Button shape="circle" size="small" icon={<QuestionCircleOutlined />} aria-label="热度算法" />
                </Tooltip>
              </Space>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: -4, paddingBottom: 2 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>信号</Text>
              <button
                type="button"
                onClick={() => setSignalFilter('全部')}
                style={{
                  border: signalFilter === '全部' ? '1px solid #b45309' : `1px solid ${theme === 'dark' ? '#2f2f2f' : '#d9dee6'}`,
                  background: signalFilter === '全部' ? (theme === 'dark' ? '#2a2116' : '#fff7ed') : 'transparent',
                  color: signalFilter === '全部' ? '#b45309' : (theme === 'dark' ? '#d1d5db' : '#4b5563'),
                  borderRadius: 999,
                  padding: '3px 10px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                全部信号
              </button>
              {SIGNAL_BUCKETS.map((signal) => {
                const tone = SIGNAL_TONE[signal];
                const active = signalFilter === signal;
                return (
                  <button
                    key={signal}
                    type="button"
                    onClick={() => setSignalFilter(signal)}
                    style={{
                      border: active ? `1px solid ${tone.color}` : `1px solid ${theme === 'dark' ? '#2f2f2f' : '#d9dee6'}`,
                      background: active ? tone.bg : 'transparent',
                      color: active ? tone.color : (theme === 'dark' ? '#d1d5db' : '#4b5563'),
                      borderRadius: 999,
                      padding: '3px 10px',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    {signal}
                  </button>
                );
              })}
            </div>
          </div>

          <Spin spinning={loading && news.length === 0}>
            {groupedByDate.length > 0 ? (
              <div style={{ padding: '12px 18px 8px' }}>
                {groupedByDate.map((group, groupIndex) => (
                  <div key={group.title} style={{ marginBottom: groupIndex === groupedByDate.length - 1 ? 0 : 12 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '22px minmax(0,1fr) auto', gap: 8, alignItems: 'center', padding: '6px 0 8px' }}>
                      <ClockCircleOutlined style={{ color: theme === 'dark' ? '#a3a3a3' : '#4b5563' }} />
                      <Text strong style={{ fontSize: 15, color: theme === 'dark' ? '#e5e7eb' : '#1f2937' }}>
                        {group.title.replace(/^今天 /, '')}
                        {group.title.startsWith('今天') ? <Text type="secondary" style={{ marginLeft: 8, fontSize: 13 }}>今日</Text> : null}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 13 }}>共 {group.items.length} 条</Text>
                    </div>
                    {group.items.map((item, index) => <DailyNewsItem key={`${group.title}-${item.title}-${index}`} item={item} theme={theme} />)}
                  </div>
                ))}
                <div style={{ textAlign: 'center', padding: '10px 0 4px' }}>
                  {hasMoreNews ? (
                    <Button onClick={() => setVisibleCount((count) => count + NEWS_PAGE_SIZE)}>
                      加载更多（剩余 {filtered.length - displayedFiltered.length} 条）
                    </Button>
                  ) : (
                    <Text type="secondary">已展示当前筛选全部新闻</Text>
                  )}
                </div>
              </div>
            ) : <Empty style={{ padding: '48px 0' }} description={searchText ? '未找到匹配的资讯' : '暂无新闻数据'} />}
          </Spin>
        </Card>

        <div style={{ minWidth: 0 }}>
          <Card
            size="small"
            title={<Text strong>价格异动</Text>}
            extra={<Text type="secondary">共 {priceSignals.length} 条</Text>}
            style={{ marginBottom: 12, borderRadius: 6, background: theme === 'dark' ? '#101010' : '#fff', border: `1px solid ${theme === 'dark' ? '#2f2f2f' : '#d9dee6'}` }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 108px 72px', gap: 8, paddingBottom: 8, borderBottom: `1px solid ${theme === 'dark' ? '#262626' : '#e5e7eb'}` }}>
              <Text type="secondary" style={{ fontSize: 12 }}>品类</Text>
              <Text type="secondary" style={{ fontSize: 12, textAlign: 'right' }}>最新价</Text>
              <Text type="secondary" style={{ fontSize: 12, textAlign: 'right' }}>涨跌幅</Text>
            </div>
            {priceSignals.some((item) => item.priceRefreshPending) && (() => {
              const issue = priceSignals.find((item) => item.priceRefreshPending);
              return (
                <div
                  style={{
                    margin: '8px 0 4px',
                    padding: '8px 10px',
                    borderRadius: 4,
                    border: `1px solid ${issue?.priceLoginRequired ? '#fecaca' : '#fed7aa'}`,
                    background: issue?.priceLoginRequired ? '#fef2f2' : '#fff7ed',
                    color: issue?.priceLoginRequired ? '#b91c1c' : '#9a3412',
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                  title={issue?.priceRefreshMessage}
                >
                  {issue?.priceRefreshMessage}
                </div>
              );
            })()}
            {priceSignals.length > 0 ? priceSignals.map((item) => {
              const direction = getPriceSignalDirection(item);
              const moveValue = extractPriceMoveValue(item);
              const moveColor = direction === '涨价' ? '#dc2626' : direction === '下跌' ? '#16a34a' : '#6b7280';
              const latestValue = extractPriceLatestValue(item);
              const signalLabel = formatPriceProductDisplayLabel(item);
              const chartUrl = getPriceChartUrl(item);
              return (
                <a
                  key={`${formatPriceSignalTitle(item)}-${item.source}`}
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => {
                    if (!item.url || item.url.startsWith('local://')) e.preventDefault();
                  }}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 108px 72px', gap: 8, alignItems: 'center', color: 'inherit', textDecoration: 'none', padding: '10px 0', borderBottom: `1px solid ${theme === 'dark' ? '#202020' : '#f1f2f4'}` }}
                >
                  <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <Tooltip title={`${formatPriceSignalTitle(item)}｜代表来源：${compactSourceName(item.source)}｜${item.title}`}>
                      <Text strong style={{ fontSize: 14, color: item.url ? (theme === 'dark' ? '#93c5fd' : '#0f5fc6') : undefined, minWidth: 0 }} ellipsis>
                        {signalLabel}
                      </Text>
                    </Tooltip>
                    {chartUrl ? (
                      <Tooltip
                        overlayStyle={{ maxWidth: 430 }}
                        title={(
                          <div style={{ maxWidth: 400 }}>
                            <img src={chartUrl} alt={`${signalLabel}历史价格`} style={{ width: 380, maxWidth: '100%', display: 'block', borderRadius: 4 }} />
                            <Text style={{ display: 'block', color: '#fff', fontSize: 12, marginTop: 6 }}>
                              历史价格走势
                            </Text>
                          </div>
                        )}
                      >
                        <QuestionCircleOutlined
                          onClick={(event) => event.preventDefault()}
                          style={{ color: theme === 'dark' ? '#9ca3af' : '#6b7280', fontSize: 13, flex: '0 0 auto' }}
                        />
                      </Tooltip>
                    ) : null}
                  </div>
                  <Tooltip title={latestValue === '--' ? item.title : latestValue}>
                    <Text style={{ fontSize: 13, textAlign: 'right', color: theme === 'dark' ? '#d1d5db' : '#4b5563' }} ellipsis>
                      {latestValue}
                    </Text>
                  </Tooltip>
                  <Tooltip title={item.title}>
                    <Text style={{ fontSize: 13, textAlign: 'right', color: moveColor, fontWeight: 700 }} ellipsis>
                      {moveValue}
                    </Text>
                  </Tooltip>
                </a>
              );
            }) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="今日暂无产业价格异动" />}
          </Card>

          <Card
            size="small"
            title={<Text strong>活跃来源</Text>}
            style={{ borderRadius: 6, background: theme === 'dark' ? '#101010' : '#fff', border: `1px solid ${theme === 'dark' ? '#2f2f2f' : '#d9dee6'}` }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 60px 66px', gap: 8, paddingBottom: 8, borderBottom: `1px solid ${theme === 'dark' ? '#262626' : '#e5e7eb'}` }}>
              <Text type="secondary" style={{ fontSize: 12 }}>来源</Text>
              <Text type="secondary" style={{ fontSize: 12, textAlign: 'right' }}>今日条数</Text>
              <Text type="secondary" style={{ fontSize: 12, textAlign: 'right' }}>最高热度</Text>
            </div>
            {sourceLeaders.map((source) => (
              <div key={source.source} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 60px 66px', gap: 8, alignItems: 'center', padding: '9px 0', borderBottom: `1px solid ${theme === 'dark' ? '#202020' : '#f1f2f4'}` }}>
                <Text style={{ fontSize: 13 }} ellipsis={{ tooltip: source.source }}>{source.source}</Text>
                <Text style={{ fontSize: 13, textAlign: 'right' }}>{source.count}</Text>
                <Text type="secondary" style={{ fontSize: 13, textAlign: 'right' }}>{source.maxScore}</Text>
              </div>
            ))}
            <Divider style={{ margin: '10px 0' }} />
            <Text type="secondary" style={{ display: 'block', fontSize: 12, lineHeight: 1.6 }}>仅统计当前新闻流中的今日资讯，不含价格 tracking。</Text>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default NewsPanel;
