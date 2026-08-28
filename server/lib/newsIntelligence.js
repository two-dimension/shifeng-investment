import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const NEWS_INTELLIGENCE_ROOT = process.env.NEWS_INTELLIGENCE_ROOT || path.join(os.homedir(), 'Documents', '新闻资讯');
const NEWS_INTELLIGENCE_SCRIPT = process.env.NEWS_INTELLIGENCE_SCRIPT || path.join(NEWS_INTELLIGENCE_ROOT, 'scripts', 'fetch_ai_news.py');
const NEWS_INTELLIGENCE_PYTHON = process.env.NEWS_INTELLIGENCE_PYTHON || 'python3';
const OPENCLI_COMMAND = process.env.OPENCLI_COMMAND
  || (fs.existsSync(path.join(os.homedir(), '.npm-global', 'bin', 'opencli')) ? path.join(os.homedir(), '.npm-global', 'bin', 'opencli') : 'opencli');
const EXTRA_BIN_PATHS = [
  path.join(os.homedir(), '.npm-global', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
].filter((candidate) => fs.existsSync(candidate));
const WX_MP_RSS_CORE_CANDIDATES = [
  process.env.WX_MP_RSS_CORE_PATH,
  path.join(os.homedir(), 'Documents', 'wx-mp-rss-core', 'wx-mp-rss-core'),
  path.join(os.homedir(), 'Documents', 'wx-mp-rss-core'),
  path.join(os.homedir(), 'Documents', '新闻资讯', 'wx-mp-rss-core'),
].filter(Boolean);
const RESOLVED_WX_MP_RSS_CORE_PATH = WX_MP_RSS_CORE_CANDIDATES.find((candidate) => fs.existsSync(candidate));
const NEWS_CHILD_ENV = {
  ...process.env,
  PATH: [...EXTRA_BIN_PATHS, process.env.PATH || ''].join(':'),
  OPENCLI_COMMAND,
  PYTHONIOENCODING: 'utf-8',
  ...(RESOLVED_WX_MP_RSS_CORE_PATH ? { WX_MP_RSS_CORE_PATH: RESOLVED_WX_MP_RSS_CORE_PATH } : {}),
};
const X_WATCH_ACCOUNT_FILE_CANDIDATES = [
  process.env.X_WATCH_ACCOUNTS_FILE,
  path.join(os.homedir(), 'Documents', 'x_opencli', 'accounts.txt'),
  path.join(os.homedir(), 'Documents', 'x_opencli', 'skill', 'accounts.txt'),
  path.join(os.homedir(), 'Documents', 'x_opencli', 'work', 'accounts.txt'),
  path.join(os.homedir(), '.codex', 'skills', 'x-watch', 'accounts.txt'),
  path.join(os.homedir(), 'Library', 'Application Support', 'x-watch', 'accounts.txt'),
  path.join(NEWS_INTELLIGENCE_ROOT, 'references', 'x_accounts.txt'),
].filter(Boolean);
const X_WATCH_DIGEST_CANDIDATES = [
  process.env.X_WATCH_DIGEST_FILE,
  path.join(os.homedir(), 'Documents', 'x_opencli', 'work', 'digest.md'),
  path.join(os.homedir(), 'Library', 'Application Support', 'x-watch', 'digest.md'),
].filter(Boolean);
const DEFAULT_X_PER_ACCOUNT_LIMIT = Math.max(1, Number(process.env.NEWS_X_PER_ACCOUNT_LIMIT || 1));
const DEFAULT_X_CONCURRENCY = Math.max(1, Number(process.env.NEWS_X_CONCURRENCY || 8));
const ENABLE_LIVE_X_FETCH = process.env.NEWS_X_LIVE_FETCH === '1';
const X_FOLLOWER_CACHE_FILE = process.env.X_FOLLOWER_CACHE_FILE || path.join(process.cwd(), 'server', 'data', 'x-followers.json');
const X_FOLLOWER_CACHE_LOCK_FILE = `${X_FOLLOWER_CACHE_FILE}.lock`;
const X_FOLLOWER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const X_FOLLOWER_UPDATE_SCRIPT = path.join(process.cwd(), 'scripts', 'update-x-followers.mjs');
const BLS_API_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const BLS_CPI_SERIES = ['CUSR0000SA0', 'CUUR0000SA0', 'CUSR0000SA0L1E', 'CUUR0000SA0L1E'];

const RSS_SOURCES = {
  'openai-blog': { name: 'OpenAI Blog', url: 'https://openai.com/blog/rss.xml', type: 'official', lang: 'en' },
  'anthropic-news': { name: 'Anthropic News', url: 'https://www.anthropic.com/rss.xml', type: 'official', lang: 'en' },
  'deepmind-blog': { name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', type: 'official', lang: 'en' },
  'google-ai': { name: 'Google AI Blog', url: 'https://blog.google/technology/ai/rss/', type: 'official', lang: 'en' },
  'meta-ai': { name: 'Meta AI', url: 'https://ai.meta.com/blog/rss/', type: 'official', lang: 'en' },
  'microsoft-ai': { name: 'Microsoft AI', url: 'https://blogs.microsoft.com/ai/feed/', type: 'official', lang: 'en' },
  'nvidia-ai': { name: 'NVIDIA AI', url: 'https://blogs.nvidia.com/blog/category/deep-learning/feed/', type: 'official', lang: 'en' },
  'huggingface-blog': { name: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml', type: 'official', lang: 'en' },
  'mistral-news': { name: 'Mistral AI', url: 'https://mistral.ai/news/feed.xml', type: 'official', lang: 'en' },
  'cohere-blog': { name: 'Cohere Blog', url: 'https://cohere.com/blog/rss.xml', type: 'official', lang: 'en' },
  'apple-ml': { name: 'Apple ML Research', url: 'https://machinelearning.apple.com/blog/feed.xml', type: 'official', lang: 'en' },
  'theverge-ai': { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', type: 'media', lang: 'en' },
  'techcrunch-ai': { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', type: 'media', lang: 'en' },
  'arstechnica-ai': { name: 'Ars Technica AI', url: 'https://arstechnica.com/ai/feed/', type: 'media', lang: 'en' },
  'mit-tech-review': { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', type: 'media', lang: 'en' },
  'venturebeat-ai': { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/', type: 'media', lang: 'en' },
  'wired-ai': { name: 'Wired AI', url: 'https://www.wired.com/feed/tag/artificial-intelligence', type: 'media', lang: 'en' },
  'reuters-tech': { name: 'Reuters Technology', url: 'https://feeds.reuters.com/reuters/technologyNews', type: 'media', lang: 'en' },
  jiqizhixin: { name: '机器之心', url: 'https://www.jiqizhixin.com/rss', type: 'media', lang: 'zh' },
  qbitai: { name: '量子位', url: 'https://www.qbitai.com/feed', type: 'media', lang: 'zh' },
  '36kr-ai': { name: '36氪 AI', url: 'https://36kr.com/feed', type: 'media', lang: 'zh' },
  xinzhiyuan: { name: '新智元', url: 'https://www.ai-era.com/feed', type: 'media', lang: 'zh' },
  geekpark: { name: '极客公园', url: 'https://www.geekpark.net/rss', type: 'media', lang: 'zh' },
  'huxiu-ai': { name: '虎嗅', url: 'https://www.huxiu.com/rss/', type: 'media', lang: 'zh' },
  'arxiv-cs-ai': { name: 'arXiv cs.AI', url: 'https://rss.arxiv.org/rss/cs.AI', type: 'academic', lang: 'en' },
  'arxiv-cs-cl': { name: 'arXiv cs.CL', url: 'https://rss.arxiv.org/rss/cs.CL', type: 'academic', lang: 'en' },
  'hf-papers': { name: 'HF Daily Papers', url: 'https://huggingface.co/papers/rss', type: 'academic', lang: 'en' },
  'papers-with-code': { name: 'Papers With Code', url: 'https://paperswithcode.com/feed', type: 'academic', lang: 'en' },
  'hn-ai-rss': { name: 'Hacker News AI', url: 'https://hnrss.org/newest?q=AI+OR+LLM+OR+GPT&count=20', type: 'developer', lang: 'en' },
  coindesk: { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', type: 'media', lang: 'en' },
  coinmarketcap: { name: 'CoinMarketCap News', url: 'https://coinmarketcap.com/headlines/news/feed', type: 'media', lang: 'en' },
  'bloomberg-crypto': { name: 'Bloomberg Crypto', url: 'https://feeds.bloomberg.com/markets/news.rss', type: 'media', lang: 'en' },
  'reuters-crypto': { name: 'Reuters Cryptocurrency', url: 'https://feeds.reuters.com/reuters/cryptoNews', type: 'media', lang: 'en' },
  'binance-square': { name: 'Binance Square News', url: 'https://www.binance.com/en/square/rss', type: 'official', lang: 'en' },
  'binance-announce': { name: 'Binance Announcement', url: 'https://www.binance.com/en/support/announcement/rss', type: 'official', lang: 'en' },
};

const percentChange = (current, previous) => ((current / previous) - 1) * 100;

const formatMacroPercent = (value) => {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`;
};

export async function fetchBlsCpiNews() {
  const currentYear = new Date().getUTCFullYear();
  const response = await fetch(BLS_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      seriesid: BLS_CPI_SERIES,
      startyear: String(currentYear - 1),
      endyear: String(currentYear),
      annualaverage: false,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`BLS CPI API ${response.status}`);
  const payload = await response.json();
  const series = new Map((payload?.Results?.series || []).map((item) => [item.seriesID, item.data || []]));
  const latestSeries = series.get('CUUR0000SA0') || [];
  const latest = latestSeries.find((item) => item.latest === 'true');
  if (!latest) return [];

  const observationKey = `${latest.year}-${latest.period}`;
  const findValue = (seriesId, year, period) => {
    const row = (series.get(seriesId) || []).find((item) => item.year === year && item.period === period);
    const value = Number(row?.value);
    return Number.isFinite(value) ? value : null;
  };
  const currentPeriodIndex = Number(latest.period.slice(1));
  const previousYear = currentPeriodIndex === 1 ? String(Number(latest.year) - 1) : latest.year;
  const previousPeriod = `M${String(currentPeriodIndex === 1 ? 12 : currentPeriodIndex - 1).padStart(2, '0')}`;
  const priorYear = String(Number(latest.year) - 1);
  const headlineSa = findValue('CUSR0000SA0', latest.year, latest.period);
  const headlineSaPrior = findValue('CUSR0000SA0', previousYear, previousPeriod);
  const headlineNsa = findValue('CUUR0000SA0', latest.year, latest.period);
  const headlineNsaYearAgo = findValue('CUUR0000SA0', priorYear, latest.period);
  const coreSa = findValue('CUSR0000SA0L1E', latest.year, latest.period);
  const coreSaPrior = findValue('CUSR0000SA0L1E', previousYear, previousPeriod);
  const coreNsa = findValue('CUUR0000SA0L1E', latest.year, latest.period);
  const coreNsaYearAgo = findValue('CUUR0000SA0L1E', priorYear, latest.period);
  if ([headlineSa, headlineSaPrior, headlineNsa, headlineNsaYearAgo, coreSa, coreSaPrior, coreNsa, coreNsaYearAgo].some((value) => value === null)) return [];

  const headlineMom = percentChange(headlineSa, headlineSaPrior);
  const headlineYoy = percentChange(headlineNsa, headlineNsaYearAgo);
  const coreMom = percentChange(coreSa, coreSaPrior);
  const coreYoy = percentChange(coreNsa, coreNsaYearAgo);
  const monthLabel = `${Number(latest.period.slice(1))}月`;
  return [{
    title: `美国${monthLabel}CPI同比${formatMacroPercent(headlineYoy)}、环比${formatMacroPercent(headlineMom)}，核心CPI同比${formatMacroPercent(coreYoy)}`,
    source_name: '美国劳工统计局 BLS',
    source_id: 'bls-cpi',
    source_type: 'official',
    collection_channel: 'macro-official',
    published_at: new Date().toISOString(),
    url: `https://www.bls.gov/news.release/cpi.nr0.htm?period=${observationKey}`,
    content_snippet: `美国${latest.year}年${monthLabel}CPI：总体环比${formatMacroPercent(headlineMom)}、同比${formatMacroPercent(headlineYoy)}；核心环比${formatMacroPercent(coreMom)}、同比${formatMacroPercent(coreYoy)}。`,
    language: 'zh',
    investment_category: '宏观',
    signal_type: '重大宏观数据',
    hotness_score: 130,
    macro_release: true,
  }];
}

const SOURCE_PRIORITY_WEIGHTS = {
  official: 1000,
  academic: 800,
  media: 600,
  developer: 400,
};

const SOURCE_TYPE_LABELS = {
  official: '公司官方',
  media: '行业媒体',
  academic: '学术平台',
  wechat: '微信公众号',
  developer: '开发者社区',
  newsletter: 'Newsletter',
  social: '社交媒体',
  policy: '政策法规',
};

const COLLECTION_CHANNEL_LABELS = {
  rss: 'RSS',
  wechat: '微信公众号',
  x: '社交媒体',
  newsletter: 'Newsletter',
};

const HOT_KEYWORDS = [
  'announce',
  'launch',
  'release',
  'new',
  'latest',
  'breaking',
  'exclusive',
  'reveal',
  'unveil',
  'update',
  'hot',
  'trending',
  'viral',
  'popular',
  'listing',
  'delisting',
  'surge',
  'crash',
  '突破',
  '发布',
  '最新',
  '重磅',
  '震撼',
  '首发',
  '上市',
  '下架',
  '监管',
  '政策',
];

const INVESTMENT_CATEGORY_KEYWORDS = {
  'AI 涨价': [
    '涨价',
    '提价',
    '喊涨',
    '调涨',
    '涨价在即',
    '价格上调',
    '价格上涨',
    '报价上涨',
    '价格调涨',
    'price increase',
    'price hike',
    'asp hike',
    'raise prices',
    'raising prices',
    'contract price',
    'asp',
    'shortage',
    'tight supply',
    'supply shortage',
    'supply shortages',
    '供不应求',
    '供给紧张',
    '供应紧张',
    '产能紧张',
    '稼动率',
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
    '台积电涨价',
    'tsmc price',
  ],
  宏观: [
    '非农',
    'cpi',
    'ppi',
    'pce',
    '通胀',
    '降息',
    '加息',
    '利率',
    '美联储',
    'fed',
    'fomc',
    'gdp',
    'pmi',
    '就业',
    '失业率',
    '汇率',
    '美元',
    '人民币',
    '财政',
    '关税',
    'tariff',
    '地缘',
    '原油',
    'oil price',
    '债券',
    '国债',
    'yield',
    'treasury',
    '监管',
    '政策',
  ],
  硬件: [
    'gpu',
    'nvidia',
    '英伟达',
    '芯片',
    '半导体',
    'semiconductor',
    'tsmc',
    '台积电',
    'broadcom',
    'avgo',
    'asic',
    'hbm',
    'dram',
    'nand',
    'memory',
    '存储',
    '服务器',
    'server',
    'datacenter',
    'data center',
    '数据中心',
    'cowos',
    '先进封装',
    '封装',
    '光模块',
    'optical',
    'photonics',
    '光通信',
    'pcb',
    'ccl',
    'mlcc',
    '铜箔',
    '玻纤布',
    '晶圆',
    'foundry',
    '机器人',
    'robotics',
  ],
  软件: [
    'openai',
    'anthropic',
    'claude',
    'chatgpt',
    'gpt',
    'gemini',
    'deepmind',
    'llm',
    'large language model',
    '大模型',
    '模型',
    'agent',
    '智能体',
    'ai agent',
    'api',
    'saas',
    'software',
    '软件',
    'cloud',
    '云',
    '开发者',
    'developer',
    'github',
    'hugging face',
    'mcp',
    '应用',
    'app',
  ],
  消费: [
    '消费',
    'retail',
    '零售',
    '电商',
    'ecommerce',
    '品牌',
    '食品',
    '饮料',
    '餐饮',
    'coffee',
    '咖啡',
    '美妆',
    '化妆品',
    '服装',
    'apparel',
    '旅游',
    'travel',
    '酒店',
    '家电',
    '汽车',
    'auto',
    'ev',
    'tesla',
    'model y',
    '白酒',
    '啤酒',
    '快消',
  ],
};

const INVESTMENT_SIGNAL_KEYWORDS = {
  利好涨价: [
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
    'raising prices',
    'contract price',
    'price floor',
  ],
  利空降价: [
    '降价',
    '价格下调',
    '价格下降',
    '跌价',
    '砍价',
    'price cut',
    'price decline',
    'price drop',
    'lower prices',
    'margin pressure',
  ],
  供需紧张: [
    '供不应求',
    '供给紧张',
    '供应紧张',
    '产能紧张',
    '缺货',
    'shortage',
    'tight supply',
    'supply shortage',
    'supply constrained',
    'capacity constrained',
    'bottleneck',
    '瓶颈',
    '满产',
    '产能满载',
  ],
  需求放缓: [
    '需求放缓',
    '需求疲软',
    '库存上升',
    '库存压力',
    '去库存',
    '砍单',
    '订单下修',
    'slowdown',
    'weak demand',
    'inventory build',
    'inventory pressure',
    'order cut',
    'cuts orders',
  ],
  订单客户突破: [
    '订单超预期',
    '新订单',
    '大单',
    '客户导入',
    '进入供应链',
    'supply chain',
    'design win',
    'customer win',
    'new customer',
    'awarded',
    'contract win',
    'win order',
  ],
  capex上修: [
    'capex 上修',
    'capex上修',
    '资本开支上修',
    '提高资本开支',
    'raise capex',
    'raises capex',
    'capex increase',
    'higher capex',
    'investment plan raised',
    'accelerate investment',
  ],
  capex下修: [
    'capex 下修',
    'capex下修',
    '资本开支下修',
    '削减资本开支',
    'cut capex',
    'cuts capex',
    'lower capex',
    'capex reduction',
    'delay datacenter',
    'delay data center',
  ],
};

function normalizeText(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasKeyword(text, keywords) {
  return keywords.some((keyword) => text.includes(normalizeText(keyword)));
}

function classifyInvestmentCategory(item = {}) {
  const text = normalizeText([
    item.title,
    item.content_snippet,
    item.snippet,
    item.source_name,
    item.source,
    item.author,
  ].filter(Boolean).join(' '));

  if (/fed|federal reserve|fomc|rate hike|rate cut|interest rate|美联储|联储|加息|降息|利率/.test(text)) return '宏观';
  if (hasKeyword(text, INVESTMENT_CATEGORY_KEYWORDS['AI 涨价'])) return 'AI 涨价';
  if (hasKeyword(text, INVESTMENT_CATEGORY_KEYWORDS['宏观'])) return '宏观';
  if (hasKeyword(text, INVESTMENT_CATEGORY_KEYWORDS['硬件'])) return '硬件';
  if (hasKeyword(text, INVESTMENT_CATEGORY_KEYWORDS['软件'])) return '软件';
  if (hasKeyword(text, INVESTMENT_CATEGORY_KEYWORDS['消费'])) return '消费';

  const sourceType = String(item.source_type || item.sourceCategory || '').trim();
  if (['official', 'academic', 'developer'].includes(sourceType)) return '软件';
  return '宏观';
}

function classifyInvestmentSignal(item = {}) {
  const text = normalizeText([
    item.title,
    item.content_snippet,
    item.snippet,
    item.source_name,
    item.source,
    item.author,
  ].filter(Boolean).join(' '));

  if (/fed|federal reserve|fomc|rate hike|rate cut|interest rate|美联储|联储|加息|降息|利率|cpi|pce|通胀|央行|货币政策/.test(text)) return '宏观政策';
  if (hasKeyword(text, INVESTMENT_SIGNAL_KEYWORDS['利好涨价'])) return '利好涨价';
  if (hasKeyword(text, INVESTMENT_SIGNAL_KEYWORDS['利空降价'])) return '利空降价';
  if (/china|中国|beijing|北京/.test(text)
    && /approved|approve|批准|获批|plans?\s+to\s+let|allow|permit|greenlight|放行|允许|拟允许|计划允许/.test(text)
    && /deepseek|bytedance|字节|alibaba|阿里|top\s+ai\s+firms?|ai\s+firms?|major\s+ai\s+companies|头部ai|ai公司/.test(text)
    && /h200|nvidia|英伟达/.test(text)) return '需求改善';
  if (hasKeyword(text, INVESTMENT_SIGNAL_KEYWORDS['供需紧张'])) return '供需紧张';
  if (hasKeyword(text, INVESTMENT_SIGNAL_KEYWORDS['需求放缓'])) return '需求放缓';
  if (hasKeyword(text, INVESTMENT_SIGNAL_KEYWORDS['订单客户突破'])) return '订单客户突破';
  if (hasKeyword(text, INVESTMENT_SIGNAL_KEYWORDS['capex上修'])) return 'capex上修';
  if (hasKeyword(text, INVESTMENT_SIGNAL_KEYWORDS['capex下修'])) return 'capex下修';
  return '普通新闻';
}

function investmentSignalBoost(signalType) {
  return {
    利好涨价: 42,
    利空降价: 38,
    供需紧张: 34,
    需求放缓: 32,
    需求改善: 22,
    宏观政策: 20,
    订单客户突破: 28,
    capex上修: 28,
    capex下修: 28,
    普通新闻: 0,
  }[signalType] || 0;
}

function investmentCategoryBoost(investmentCategory) {
  return {
    'AI 涨价': 34,
    硬件: 26,
    软件: 22,
    宏观: 12,
    消费: 16,
  }[investmentCategory] || 0;
}

function recencyBoostFromTime(value) {
  const publishedDate = parseDate(value);
  if (!publishedDate) return 0;
  const hoursOld = (Date.now() - publishedDate.getTime()) / 3600000;
  if (hoursOld <= 2) return 10;
  if (hoursOld <= 6) return 8;
  if (hoursOld <= 12) return 5;
  if (hoursOld <= 24) return 3;
  return 0;
}

function calculateNonXSignalScore(item, investmentCategory, signalType, baseScore) {
  const sourceType = String(item.source_type || item.sourceCategory || '').trim();
  const channel = String(item.collection_channel || item.collectionChannel || '').trim();
  const text = normalizeText([
    item.title,
    item.content_snippet,
    item.snippet,
    item.source_name,
    item.source,
    investmentCategory,
    signalType,
  ].filter(Boolean).join(' '));
  const noisePattern = /村民|棍棒|赶蛇|蛇毒|血清|救治需求|空调|省电|天气|民生|高铁|站房|绿道|景区|婚恋|宠物|养生|病例|医院/i;
  const hardInvestmentPattern = /ai|算力|gpu|hbm|dram|nand|ssd|mlcc|pcb|ccl|cowos|芯片|半导体|服务器|数据中心|光模块|铜箔|玻纤布|钨|钨矿|金属|涨价|提价|降价|报价|均价|asp|price|shortage|tight supply|订单|客户|出货|产能|库存|供给|供应|需求|景气|capex|资本开支|收入|利润|销量|交付|零售|电商|汽车|家电|白酒|餐饮|旅游|美妆|openai|anthropic|claude|gpt|gemini|deepseek|qwen|llm|agent/i;
  const demandContextPattern = /订单|客户|出货|销量|交付|下游|景气|复苏|回暖|需求改善|需求回升|需求强劲|需求增长|库存去化|供需|产能|收入|利润|业绩/i;

  if (noisePattern.test(text) && !hardInvestmentPattern.test(text)) {
    return Math.min(Number.isFinite(baseScore) ? baseScore : 60, 72);
  }

  const sourceBoost = {
    official: 20,
    media: 15,
    wechat: 18,
    newsletter: 16,
    academic: 11,
    developer: 9,
    policy: 12,
  }[sourceType] || (channel === 'wechat' ? 18 : channel === 'newsletter' ? 16 : 9);
  const textLengthBoost = Math.min(8, Math.floor(String(item.content_snippet || item.snippet || item.title || '').length / 90));
  const contextBoost = hardInvestmentPattern.test(text) ? 12 : 0;
  const demandQualityBoost = signalType === '需求改善' && demandContextPattern.test(text) ? 10 : 0;
  const weakDemandPenalty = signalType === '需求改善' && !demandContextPattern.test(text) ? 18 : 0;
  const signalScore = 50
    + investmentSignalBoost(signalType)
    + investmentCategoryBoost(investmentCategory)
    + recencyBoostFromTime(item.published_at || item.published_dt || item.time)
    + sourceBoost
    + textLengthBoost
    + contextBoost
    + demandQualityBoost
    - weakDemandPenalty;
  return Math.max(Number.isFinite(baseScore) ? baseScore : 0, signalScore);
}

function fingerprint(value = '') {
  const text = normalizeText(value);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

function canonicalUrl(url = '') {
  return String(url)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '');
}

function parseSince(since = '48h') {
  const match = String(since).match(/^(\d+)([hd])$/);
  const amount = match ? Number(match[1]) : 48;
  const unit = match ? match[2] : 'h';
  const ms = unit === 'd' ? amount * 24 * 60 * 60 * 1000 : amount * 60 * 60 * 1000;
  return new Date(Date.now() - ms);
}

function parseDate(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function decodeXml(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

function stripHtml(value = '') {
  return decodeXml(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getTag(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function getEntryLink(block) {
  const directLink = getTag(block, 'link');
  if (directLink && !directLink.includes('<')) return directLink;
  const atomLink = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  return atomLink ? decodeXml(atomLink[1]) : directLink;
}

function parseFeedEntries(xml) {
  const itemMatches = Array.from(String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi), (match) => match[0]);
  const entryMatches = Array.from(String(xml).matchAll(/<entry\b[\s\S]*?<\/entry>/gi), (match) => match[0]);
  return itemMatches.length > 0 ? itemMatches : entryMatches;
}

function calculateHotness(article, sourcePriority) {
  let score = sourcePriority * 0.4;
  const text = normalizeText(`${article.title} ${article.content_snippet || ''}`);

  HOT_KEYWORDS.forEach((keyword) => {
    if (text.includes(normalizeText(keyword))) {
      score += keyword.length > 5 ? 5.5 : 3.5;
    }
  });

  const titleLength = String(article.title || '').length;
  if (titleLength >= 40) score += 15;
  else if (titleLength >= 25) score += 10;
  else if (titleLength >= 15) score += 5;

  const publishedDate = parseDate(article.published_at);
  if (publishedDate) {
    const hoursOld = (Date.now() - publishedDate.getTime()) / 3600000;
    if (hoursOld < 1) score += 10;
    else if (hoursOld < 6) score += 8;
    else if (hoursOld < 12) score += 6;
    else if (hoursOld < 24) score += 4;
    else if (hoursOld < 48) score += 2;
  }

  return Math.round(score * 100) / 100;
}

async function fetchText(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Shifeng-News-Intelligence/1.0',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOneSource(sourceId, source, limit, sinceDate) {
  const xml = await fetchText(source.url);
  const blocks = parseFeedEntries(xml);
  const sourcePriority = SOURCE_PRIORITY_WEIGHTS[source.type] || 500;
  const timeFiltered = [];

  for (const block of blocks) {
    const rawDate = getTag(block, 'pubDate') || getTag(block, 'published') || getTag(block, 'updated') || getTag(block, 'dc:date');
    const parsedDate = parseDate(rawDate);
    if (parsedDate && parsedDate < sinceDate) continue;

    const title = stripHtml(getTag(block, 'title')) || 'Untitled';
    const url = getEntryLink(block) || getTag(block, 'id') || source.url;
    const snippet = stripHtml(getTag(block, 'summary') || getTag(block, 'description') || getTag(block, 'content:encoded')).slice(0, 500);

    timeFiltered.push({
      title,
      url: String(url).trim(),
      source_id: sourceId,
      source_name: source.name,
      source_type: source.type,
      language: source.lang,
      published_at: rawDate || '',
      content_snippet: snippet,
      source_priority_weight: sourcePriority,
    });
  }

  return timeFiltered.slice(0, limit * 2).map((article) => ({
    ...article,
    hotness_score: calculateHotness(article, sourcePriority),
  }));
}

async function fetchHackerNews(limit = 15) {
  const query = 'AI OR LLM OR GPT OR "large language model"';
  const params = new URLSearchParams({
    query,
    tags: 'story',
    hitsPerPage: String(Math.min(limit, 50)),
  });
  const text = await fetchText(`https://hn.algolia.com/api/v1/search_by_date?${params.toString()}`, 12000);
  const data = JSON.parse(text);
  const sourcePriority = SOURCE_PRIORITY_WEIGHTS.developer;

  return (data.hits || []).slice(0, limit).map((hit) => {
    const article = {
      title: hit.title || 'Untitled',
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID || ''}`,
      source_id: 'hn-algolia',
      source_name: 'Hacker News',
      source_type: 'developer',
      language: 'en',
      published_at: hit.created_at || '',
      content_snippet: `score ${hit.points || 0}, comments ${hit.num_comments || 0}`,
      score: hit.points || 0,
      comments_count: hit.num_comments || 0,
      source_priority_weight: sourcePriority,
    };
    return {
      ...article,
      hotness_score: calculateHotness(article, sourcePriority) + (hit.points || 0) / 20 + (hit.num_comments || 0) / 30,
    };
  });
}

function priorityFairDeduplicate(articlesBySource, outputPerSource = 1) {
  const finalResults = [];
  const seenUrls = new Set();
  const seenTitles = new Set();
  const queues = {};

  Object.entries(articlesBySource).forEach(([sourceId, articles]) => {
    if (!articles.length) return;
    const sortedArticles = [...articles].sort((a, b) => (b.hotness_score || 0) - (a.hotness_score || 0));
    queues[sourceId] = {
      sourceType: sortedArticles[0].source_type,
      sourceWeight: SOURCE_PRIORITY_WEIGHTS[sortedArticles[0].source_type] || 500,
      articles: sortedArticles,
      taken: 0,
    };
  });

  while (true) {
    const available = Object.entries(queues).filter(([, queue]) => queue.taken < outputPerSource && queue.articles.length > 0);
    if (!available.length) break;

    const [bestSourceId, bestQueue] = available.reduce((best, current) => {
      const bestScore = best[1].articles[0].hotness_score || 0;
      const currentScore = current[1].articles[0].hotness_score || 0;
      return currentScore > bestScore ? current : best;
    });

    const candidate = bestQueue.articles.shift();
    const urlKey = canonicalUrl(candidate.url);
    const titleKey = fingerprint(candidate.title);
    const duplicateIndex = finalResults.findIndex((item) => canonicalUrl(item.url) === urlKey || fingerprint(item.title) === titleKey);

    if (duplicateIndex >= 0) {
      const existing = finalResults[duplicateIndex];
      const existingWeight = SOURCE_PRIORITY_WEIGHTS[existing.source_type] || 500;
      if (bestQueue.sourceWeight > existingWeight) {
        finalResults.splice(duplicateIndex, 1, candidate);
        bestQueue.taken += 1;
        queues[bestSourceId] = bestQueue;
      }
      continue;
    }

    finalResults.push(candidate);
    if (urlKey) seenUrls.add(urlKey);
    if (titleKey) seenTitles.add(titleKey);
    bestQueue.taken += 1;
    queues[bestSourceId] = bestQueue;
  }

  return finalResults.sort((a, b) => (b.hotness_score || 0) - (a.hotness_score || 0));
}

function toNewsItem(article) {
  const sourceTypeLabel = SOURCE_TYPE_LABELS[article.source_type] || '行业媒体';
  return {
    category: sourceTypeLabel,
    sourceCategory: article.source_type,
    sourceId: article.source_id,
    title: article.title,
    source: article.source_name,
    time: article.published_at || '',
    url: article.url,
    snippet: article.content_snippet || '',
    language: article.language || '',
    score: Math.round(article.hotness_score || 0),
  };
}

async function fetchOnce({ since, limit, outputPerSource }) {
  const sinceDate = parseSince(since);
  const articlesBySource = {};

  const rssResults = await Promise.allSettled(
    Object.entries(RSS_SOURCES).map(async ([sourceId, source]) => {
      const articles = await fetchOneSource(sourceId, source, limit, sinceDate);
      return [sourceId, articles];
    }),
  );

  rssResults.forEach((result) => {
    if (result.status !== 'fulfilled') return;
    const [sourceId, articles] = result.value;
    if (articles.length > 0) articlesBySource[sourceId] = articles;
  });

  const hnResult = await Promise.allSettled([fetchHackerNews(15)]);
  if (hnResult[0].status === 'fulfilled' && hnResult[0].value.length > 0) {
    articlesBySource['hn-algolia'] = hnResult[0].value;
  }

  const deduped = priorityFairDeduplicate(articlesBySource, outputPerSource);
  return {
    news: deduped.map(toNewsItem),
    meta: {
      since,
      generatedAt: new Date().toISOString(),
      sourceCount: Object.keys(articlesBySource).length,
      articleCount: deduped.length,
      sourceTypes: Array.from(new Set(deduped.map((item) => item.source_type))).sort(),
    },
  };
}

function extractJsonArray(text) {
  const raw = String(text || '');
  let start = raw.indexOf('[');
  while (start !== -1) {
    let end = raw.lastIndexOf(']');
    while (end > start) {
      const candidate = raw.slice(start, end + 1);
      try {
        const payload = JSON.parse(candidate);
        if (Array.isArray(payload)) return payload;
      } catch {
        end = raw.lastIndexOf(']', end - 1);
        continue;
      }
      end = raw.lastIndexOf(']', end - 1);
    }
    start = raw.indexOf('[', start + 1);
  }
  return [];
}

function runAiNewsSkill({ since = '24h', rssLimit, wechatLimit, xLimit, newsletterLimit }) {
  const args = [NEWS_INTELLIGENCE_SCRIPT, '--since', since];
  if (Number.isFinite(rssLimit)) args.push('--rss-limit', String(rssLimit));
  if (Number.isFinite(wechatLimit)) args.push('--wechat-limit', String(wechatLimit));
  if (Number.isFinite(xLimit)) args.push('--x-limit', String(xLimit));
  if (Number.isFinite(newsletterLimit)) args.push('--newsletter-limit', String(newsletterLimit));

  return new Promise((resolve, reject) => {
    const proc = spawn(NEWS_INTELLIGENCE_PYTHON, args, {
      cwd: NEWS_INTELLIGENCE_ROOT,
      env: NEWS_CHILD_ENV,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('news-intelligence 聚合超时'));
    }, 240000);

    proc.stdout.on('data', (data) => { stdout += data.toString('utf8'); });
    proc.stderr.on('data', (data) => { stderr += data.toString('utf8'); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `news-intelligence exited with code ${code}`));
      }
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function runSkillChannel({ channel, script, args, timeoutMs }) {
  return new Promise((resolve) => {
    const proc = spawn(NEWS_INTELLIGENCE_PYTHON, [path.join(NEWS_INTELLIGENCE_ROOT, 'scripts', script), ...args], {
      cwd: NEWS_INTELLIGENCE_ROOT,
      detached: true,
      env: NEWS_CHILD_ENV,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const killGroup = () => {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        try {
          proc.kill('SIGTERM');
        } catch {
          // best effort
        }
      }
    };
    const timer = setTimeout(() => {
      killGroup();
      finish({ channel, ok: false, stdout, stderr: `${channel} timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    proc.stdout.on('data', (data) => { stdout += data.toString('utf8'); });
    proc.stderr.on('data', (data) => { stderr += data.toString('utf8'); });
    proc.on('close', (code) => {
      finish({ channel, ok: code === 0, stdout, stderr: code === 0 ? stderr : stderr || `${channel} exited with code ${code}` });
    });
    proc.on('error', (error) => {
      finish({ channel, ok: false, stdout, stderr: error.message });
    });
  });
}

function parseOpenCliWeixinDate(value) {
  if (!value) return '';
  const text = String(value).trim();
  const relativeMatch = text.match(/^(\d+)\s*(分钟|小时|天)前$/);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2];
    const deltaMs = unit === '分钟'
      ? amount * 60 * 1000
      : unit === '小时'
        ? amount * 60 * 60 * 1000
        : amount * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - deltaMs).toISOString();
  }
  const normalized = text.replace(/年|\/|\./g, '-').replace(/月/g, '-').replace(/日/g, '');
  const parts = normalized.split('-').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const [year, month, day] = parts;
    return new Date(Number(year), Number(month) - 1, Number(day), 9, 0, 0).toISOString();
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function isAfterSince(value, since) {
  const date = Date.parse(value || '');
  if (!Number.isFinite(date)) return true;
  return date >= parseSince(since).getTime();
}

function cleanXHandle(handle = '') {
  return String(handle).trim().replace(/^@/, '');
}

function loadXTargetAccounts() {
  const foundPath = X_WATCH_ACCOUNT_FILE_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!foundPath) {
    return {
      accounts: ['OpenAI'],
      path: null,
      warning: 'x-watch accounts.txt not found; fallback to OpenAI only',
    };
  }

  const accounts = fs.readFileSync(foundPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => cleanXHandle(line))
    .filter((line) => line && !line.startsWith('#'));

  return {
    accounts: Array.from(new Set(accounts)),
    path: foundPath,
    warning: accounts.length ? '' : `${foundPath} is empty; fallback to OpenAI only`,
  };
}

function loadXFollowerCache() {
  try {
    const payload = JSON.parse(fs.readFileSync(X_FOLLOWER_CACHE_FILE, 'utf8'));
    return {
      updatedAt: payload.updatedAt || '',
      accounts: payload.accounts && typeof payload.accounts === 'object' ? payload.accounts : {},
    };
  } catch {
    return { updatedAt: '', accounts: {} };
  }
}

function getXFollowerProfile(cache, handle) {
  const normalized = cleanXHandle(handle).toLowerCase();
  return cache.accounts?.[normalized] || null;
}

function shouldRefreshXFollowerCache(cache, accounts) {
  const updatedAtMs = Date.parse(cache.updatedAt || '');
  if (!Number.isFinite(updatedAtMs)) return true;
  if (Date.now() - updatedAtMs > X_FOLLOWER_CACHE_TTL_MS) return true;
  return accounts.some((account) => !getXFollowerProfile(cache, account)?.followers);
}

function maybeRefreshXFollowerCache(accounts, accountsFile, cache) {
  if (!accounts.length || !fs.existsSync(X_FOLLOWER_UPDATE_SCRIPT)) return;
  if (!shouldRefreshXFollowerCache(cache, accounts)) return;

  try {
    const lockStat = fs.existsSync(X_FOLLOWER_CACHE_LOCK_FILE) ? fs.statSync(X_FOLLOWER_CACHE_LOCK_FILE) : null;
    if (lockStat && Date.now() - lockStat.mtimeMs < 30 * 60 * 1000) return;
    fs.mkdirSync(path.dirname(X_FOLLOWER_CACHE_FILE), { recursive: true });
    fs.writeFileSync(X_FOLLOWER_CACHE_LOCK_FILE, new Date().toISOString());

    const args = [
      X_FOLLOWER_UPDATE_SCRIPT,
      '--output',
      X_FOLLOWER_CACHE_FILE,
    ];
    if (accountsFile) args.push('--accounts-file', accountsFile);
    else args.push('--accounts', accounts.join(','));

    const proc = spawn(process.execPath, args, {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      env: NEWS_CHILD_ENV,
    });
    proc.unref();
  } catch {
    // Follower counts are a scoring enhancement; never block news refresh.
  }
}

function calculateXSignalScore({ likes, retweets, replies, followers, investmentCategory, signalType, publishedAt, text }) {
  const weightedEngagement = Math.max(0, likes) + Math.max(0, retweets) * 2 + Math.max(0, replies) * 1.5;
  const followerBase = Math.max(Number(followers) || 0, 1000);
  const normalizedEngagement = (Math.log1p(weightedEngagement) / Math.log1p(followerBase)) * 100;
  const absoluteEngagementFloor = Math.min(10, Math.log1p(weightedEngagement) * 1.2);
  const normalizedContent = normalizeText(text || '');
  const hasInvestmentKeyword = Object.values(INVESTMENT_CATEGORY_KEYWORDS).some((keywords) => hasKeyword(normalizedContent, keywords))
    || Object.values(INVESTMENT_SIGNAL_KEYWORDS).some((keywords) => hasKeyword(normalizedContent, keywords));
  const lowInformationPenalty = !hasInvestmentKeyword && normalizedContent.length < 45 ? 35 : 0;
  const retweetPenalty = !hasInvestmentKeyword && /^rt\s+@/i.test(String(text || '').trim()) ? 12 : 0;
  const effectiveCategoryBoost = hasInvestmentKeyword ? investmentCategoryBoost(investmentCategory) : 0;
  const signalBoost = investmentSignalBoost(signalType);
  const recencyBoost = recencyBoostFromTime(publishedAt);
  const chinaGpuApprovalBoost = /china|中国|beijing|北京/.test(normalizedContent)
    && /approved|approve|批准|获批|plans?\s+to\s+let|allow|permit|greenlight|放行|允许|拟允许|计划允许/.test(normalizedContent)
    && /deepseek|bytedance|字节|alibaba|阿里|top\s+ai\s+firms?|ai\s+firms?|major\s+ai\s+companies|头部ai|ai公司/.test(normalizedContent)
    && /h200|nvidia|英伟达/.test(normalizedContent)
    ? 24
    : 0;

  return Math.max(20, Math.round(
    45
    + normalizedEngagement * 0.9
    + absoluteEngagementFloor
    + effectiveCategoryBoost
    + signalBoost
    + chinaGpuApprovalBoost
    + recencyBoost
    - lowInformationPenalty
    - retweetPenalty,
  ));
}

function loadXWatchDigestItems({ since, accounts, followerCache, limit = 40 }) {
  const digestPath = X_WATCH_DIGEST_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!digestPath) return { items: [], path: null };

  const accountSet = new Set(accounts.map((account) => account.toLowerCase()));
  const raw = fs.readFileSync(digestPath, 'utf8');
  const blocks = raw.split(/\n---+\n/g);
  const seen = new Set();
  const items = [];

  blocks.forEach((block) => {
    const header = block.match(/##\s+@([A-Za-z0-9_]+)\s+-\s+(.+)/);
    if (!header) return;

    const handle = cleanXHandle(header[1]);
    if (accountSet.size && !accountSet.has(handle.toLowerCase())) return;

    const publishedDate = parseDate(header[2].trim());
    const publishedAt = publishedDate ? publishedDate.toISOString() : header[2].trim();
    if (!isAfterSince(publishedAt, since)) return;

    const urlMatch = block.match(/^URL\s+(https?:\/\/\S+)(?:\s+heart\s+(\d+))?(?:\s+retweet\s+(\d+))?(?:\s+reply\s+(\d+))?/m);
    const url = urlMatch ? urlMatch[1] : `https://x.com/${handle}`;
    if (seen.has(url)) return;
    seen.add(url);

    const lines = block.split(/\r?\n/);
    const bodyLines = [];
    let collecting = false;
    lines.forEach((line) => {
      if (line.startsWith('## ')) {
        collecting = true;
        return;
      }
      if (!collecting) return;
      if (line.startsWith('URL ')) {
        collecting = false;
        return;
      }
      if (line.startsWith('media:') || line.startsWith('optional media:')) return;
      bodyLines.push(line);
    });

    const text = bodyLines.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return;

    const likes = Number(urlMatch?.[2] || 0);
    const retweets = Number(urlMatch?.[3] || 0);
    const replies = Number(urlMatch?.[4] || 0);
    const followerProfile = getXFollowerProfile(followerCache, handle);
    const followers = Number(followerProfile?.followers || 0);
    const investmentCategory = classifyInvestmentCategory({
      title: text,
      content_snippet: text,
      source_name: `X/Twitter @${handle}`,
      source_type: 'social',
      author: handle,
    });
    const signalType = classifyInvestmentSignal({
      title: text,
      content_snippet: text,
      source_name: `X/Twitter @${handle}`,
      source_type: 'social',
      author: handle,
    });
    const weightedEngagement = likes + retweets * 2 + replies * 1.5;
    const hotnessScore = calculateXSignalScore({
      likes,
      retweets,
      replies,
      followers,
      investmentCategory,
      signalType,
      publishedAt,
      text,
    });

    items.push({
      title: `@${handle}: ${text.slice(0, 140)}`,
      url,
      source_id: `x-${handle.toLowerCase()}`,
      source_name: `X/Twitter @${handle}`,
      source_type: 'social',
      collection_channel: 'x',
      author: handle,
      published_at: publishedAt,
      content_snippet: text,
      language: /[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en',
      hotness_score: Math.round(hotnessScore * 100) / 100,
      investment_category: investmentCategory,
      signal_type: signalType,
      followers,
      engagement: weightedEngagement,
      engagement_rate: followers > 0 ? weightedEngagement / followers : null,
      normalized_engagement_score: hotnessScore,
      metrics: { likes, retweets, replies },
    });
  });

  items.sort((a, b) => (Date.parse(b.published_at || '') || 0) - (Date.parse(a.published_at || '') || 0));
  return { items: items.slice(0, limit), path: digestPath };
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = [];
  let index = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length || 1);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }));

  return results.filter(Boolean);
}

function runOpenCliWeixinSearch({ query, sourceName, sourceId, since, limit }) {
  return new Promise((resolve) => {
    const proc = spawn(OPENCLI_COMMAND, ['weixin', 'search', query, '--limit', String(Math.min(limit || 5, 10)), '-f', 'json'], {
      cwd: NEWS_INTELLIGENCE_ROOT,
      env: NEWS_CHILD_ENV,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (items, warning = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ items, warning });
    };
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // best effort
      }
      finish([], `opencli weixin search timeout: ${query}`);
    }, 25000);

    proc.stdout.on('data', (data) => { stdout += data.toString('utf8'); });
    proc.stderr.on('data', (data) => { stderr += data.toString('utf8'); });
    proc.on('close', (code) => {
      if (code !== 0) {
        finish([], stderr || `opencli weixin search exited with code ${code}: ${query}`);
        return;
      }
      const payload = extractJsonArray(stdout);
      const items = payload
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const publishedAt = parseOpenCliWeixinDate(item.publish_time);
          return {
            title: item.title || '',
            url: item.url || '',
            source_id: `wechat-opencli-${sourceId}`,
            source_name: `微信公众号 ${sourceName}`,
            source_type: 'wechat',
            collection_channel: 'wechat',
            language: 'zh',
            published_at: publishedAt,
            content_snippet: item.summary || '',
          };
        })
        .filter((item) => item.title && isAfterSince(item.published_at, since));
      finish(items, stderr);
    });
    proc.on('error', (error) => {
      finish([], error.message);
    });
  });
}

async function fetchWeixinOpenCliFallback({ since, limit }) {
  const sources = [
    { sourceId: 'jiqizhixin', sourceName: '机器之心', query: '机器之心 2026 7月 AI Agent' },
    { sourceId: 'xinzhiyuan', sourceName: '新智元', query: '新智元 2026 7月 AI' },
  ];
  const results = await Promise.all(sources.map((source) => runOpenCliWeixinSearch({ ...source, since, limit })));
  return {
    items: results.flatMap((result) => result.items),
    warnings: results
      .map((result) => result.warning)
      .filter(Boolean)
      .map((warning) => `[WARN] wechat-opencli: ${warning}`),
  };
}

async function runAiNewsChannels({ since = '24h', rssLimit, wechatLimit, xLimit, newsletterLimit, mode = 'full' }) {
  const quickMode = mode === 'quick';
  const xTargets = loadXTargetAccounts();
  const xAccounts = xTargets.accounts.length ? xTargets.accounts : ['OpenAI'];
  const xPerAccountLimit = Math.max(1, Math.min(Number(xLimit) || DEFAULT_X_PER_ACCOUNT_LIMIT, DEFAULT_X_PER_ACCOUNT_LIMIT));
  const xFollowerCache = loadXFollowerCache();
  maybeRefreshXFollowerCache(xAccounts, xTargets.path, xFollowerCache);
  const xDigest = loadXWatchDigestItems({
    since,
    accounts: xAccounts,
    followerCache: xFollowerCache,
    limit: Math.max(40, xAccounts.length * xPerAccountLimit),
  });
  const fullRssSourceIds = [
    'openai-blog',
    'anthropic-news',
    'deepmind-blog',
    'google-ai',
    'meta-ai',
    'microsoft-ai',
    'nvidia-ai',
    'huggingface-blog',
    'mistral-news',
    'cohere-blog',
    'apple-ml',
    'theverge-ai',
    'techcrunch-ai',
    'arstechnica-ai',
    'mit-tech-review',
    'venturebeat-ai',
    'wired-ai',
    'reuters-tech',
    'qbitai',
    '36kr-ai',
    'geekpark',
    'huxiu-ai',
    'arxiv-cs-ai',
    'arxiv-cs-cl',
    'hf-papers',
    'papers-with-code',
    'hn-ai',
    'stats-latest-releases',
    'chinanews-finance',
    'chinanews-life',
    'yicai-news',
  ];
  const quickRssSourceIds = [
    'yicai-news',
    '36kr-ai',
    'qbitai',
    'huxiu-ai',
    'hn-ai',
    'techcrunch-ai',
    'theverge-ai',
    'openai-blog',
    'anthropic-news',
    'nvidia-ai',
    'hf-papers',
    'chinanews-finance',
  ];
  const rssSourceIds = quickMode ? quickRssSourceIds : fullRssSourceIds;
  const rssSourceArgs = (sourceId) => [
    '--source',
    sourceId,
    '--since',
    since,
    '--limit',
    String(rssLimit || (quickMode ? 2 : 5)),
    '--dedup',
    '--output-per-source',
    '1',
  ];
  const rssSpecs = rssSourceIds.map((sourceId) => ({
      channel: `rss-${sourceId}`,
      collectionChannel: 'rss',
      script: 'fetch_rss.py',
      args: rssSourceArgs(sourceId),
      timeoutMs: quickMode ? 8000 : 18000,
  }));
  const xSpecs = !quickMode && ENABLE_LIVE_X_FETCH ? xAccounts.map((account) => ({
    channel: `x-${account}`,
    collectionChannel: 'x',
    script: 'fetch_x_twitter.py',
    args: ['--accounts', account, '--since', since, '--limit', String(xPerAccountLimit)],
    timeoutMs: 35000,
  })) : [];
  const nonXChannelSpecs = quickMode
    ? [...rssSpecs]
    : [
        ...rssSpecs,
        {
          channel: 'wechat',
          script: 'fetch_wechat_mp.py',
          args: ['--source', 'jiqizhixin,xinzhiyuan', '--since', since, '--limit', String(wechatLimit || 5)],
          timeoutMs: 25000,
        },
        {
          channel: 'newsletter',
          script: 'fetch_newsletter.py',
          args: ['--all', '--since', since, '--limit', String(newsletterLimit || 3)],
          timeoutMs: 45000,
        },
      ];
  const channelSpecs = [...nonXChannelSpecs, ...xSpecs];

  const [nonXResults, xResults, blsCpiItems] = await Promise.all([
    Promise.all(nonXChannelSpecs.map(runSkillChannel)),
    runWithConcurrency(xSpecs, DEFAULT_X_CONCURRENCY, runSkillChannel),
    fetchBlsCpiNews().catch((error) => {
      warnings.push(`[WARN] bls-cpi: ${error.message}`);
      return [];
    }),
  ]);
  const results = [...nonXResults, ...xResults];
  const items = [];
  const warnings = [];
  if (xTargets.warning) warnings.push(`[WARN] x-watch: ${xTargets.warning}`);
  if (!ENABLE_LIVE_X_FETCH && !xDigest.items.length) {
    warnings.push('[WARN] x-watch: digest snapshot has no X posts in the selected time range');
  }
  let wechatItems = 0;

  for (const result of results) {
    if (!result.ok) {
      warnings.push(`[WARN] ${result.channel}: ${result.stderr}`);
      continue;
    }
    const payload = extractJsonArray(result.stdout);
    payload.forEach((item) => {
      if (item && typeof item === 'object') {
        const collectionChannel = item.collection_channel || channelSpecs.find((spec) => spec.channel === result.channel)?.collectionChannel || result.channel;
        if (collectionChannel === 'x' && !isAfterSince(item.published_at || item.published_dt || item.time, since)) return;
        items.push({
          ...item,
          collection_channel: collectionChannel,
        });
        if ((item.collection_channel || result.channel) === 'wechat') {
          wechatItems += 1;
        }
      }
    });
    result.stderr
      .split('\n')
      .filter((line) => line.includes('[WARN]'))
      .forEach((line) => warnings.push(line));
  }

  if (!quickMode && wechatItems === 0) {
    const fallback = await fetchWeixinOpenCliFallback({ since, limit: wechatLimit || 5 });
    fallback.items.forEach((item) => items.push(item));
    fallback.warnings.forEach((warning) => warnings.push(warning));
  }
  xDigest.items.forEach((item) => items.push(item));
  blsCpiItems.forEach((item) => items.push(item));

  items.sort((a, b) => {
    const left = Date.parse(a.published_at || a.published_dt || a.time || '') || 0;
    const right = Date.parse(b.published_at || b.published_dt || b.time || '') || 0;
    return right - left;
  });

  return {
    items,
    warnings,
    xAccounts,
    xAccountsFile: xTargets.path,
    xDigestFile: xDigest.path,
    xDigestCount: xDigest.items.length,
    xFollowerCacheFile: X_FOLLOWER_CACHE_FILE,
    xFollowerCacheUpdatedAt: xFollowerCache.updatedAt || null,
    xFollowerCacheAccountCount: Object.keys(xFollowerCache.accounts || {}).length,
    xPerAccountLimit,
    xConcurrency: DEFAULT_X_CONCURRENCY,
    xLiveFetch: ENABLE_LIVE_X_FETCH,
    mode,
  };
}

function normalizeSourceType(item) {
  const sourceType = String(item.source_type || '').trim();
  const channel = String(item.collection_channel || '').trim();
  if (sourceType) return sourceType;
  if (channel === 'x') return 'social';
  if (channel) return channel;
  return 'media';
}

function normalizeSkillArticle(item) {
  const sourceType = normalizeSourceType(item);
  const channel = String(item.collection_channel || sourceType || '').trim();
  const category = SOURCE_TYPE_LABELS[sourceType] || COLLECTION_CHANNEL_LABELS[channel] || '行业媒体';
  const title = String(item.title || '').trim();
  const sourceName = String(item.source_name || item.source || item.author || category).trim();
  const investmentCategory = item.investment_category || classifyInvestmentCategory(item);
  const signalType = item.signal_type || classifyInvestmentSignal(item);
  const rawScore = Number(item.hotness_score || item.score);
  const baseScore = Number.isFinite(rawScore) ? Math.round(rawScore) : undefined;
  const finalScore = channel === 'x' || sourceType === 'social'
    ? baseScore
    : Math.round(calculateNonXSignalScore(item, investmentCategory, signalType, baseScore));

  return {
    category,
    sourceCategory: sourceType,
    collectionChannel: channel,
    sourceId: item.source_id || '',
    title,
    source: sourceName,
    time: item.published_at || item.published_dt || item.time || '',
    url: item.url || '',
    snippet: item.content_snippet || item.snippet || '',
    language: item.language || item.lang || '',
    investmentCategory,
    signalType,
    followers: item.followers,
    engagement: item.engagement,
    engagementRate: item.engagement_rate,
    normalizedEngagementScore: item.normalized_engagement_score,
    metrics: item.metrics,
    score: finalScore,
  };
}

function isBlockedSkillArticle(item) {
  const source = String(item?.source || item?.source_name || '').trim();
  const title = String(item?.title || '').trim();
  if (/Last Week in AI/i.test(source)) return true;
  if (/^(Last Week in AI|Editorials)$/i.test(title)) return true;
  return false;
}

function dedupeSkillNews(news) {
  const seen = new Set();
  const result = [];

  for (const item of news) {
    if (!item.title) continue;
    const urlKey = item.url ? canonicalUrl(item.url) : '';
    const titleKey = fingerprint(item.title);
    const key = urlKey || titleKey;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    result.push(item);
  }

  return result;
}

export async function fetchNewsIntelligence(options = {}) {
  const since = options.since || '24h';
  const mode = options.mode === 'quick' ? 'quick' : 'full';
  const channelLimit = Number(options.limit);
  const {
    items: rawItems,
    warnings,
    xAccounts,
    xAccountsFile,
    xDigestFile,
    xDigestCount,
    xFollowerCacheFile,
    xFollowerCacheUpdatedAt,
    xFollowerCacheAccountCount,
    xPerAccountLimit,
    xConcurrency,
    xLiveFetch,
  } = await runAiNewsChannels({
    since,
    mode,
    rssLimit: Number.isFinite(channelLimit) ? channelLimit : undefined,
    wechatLimit: Number.isFinite(channelLimit) ? channelLimit : undefined,
    xLimit: Number.isFinite(channelLimit) ? channelLimit : undefined,
    newsletterLimit: Number.isFinite(channelLimit) ? channelLimit : undefined,
  });

  const news = dedupeSkillNews(rawItems.filter((item) => !isBlockedSkillArticle(item)).map(normalizeSkillArticle));
  const channelCounts = news.reduce((acc, item) => {
    const key = item.collectionChannel || item.sourceCategory || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const investmentCategoryCounts = news.reduce((acc, item) => {
    const key = item.investmentCategory || '宏观';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const signalTypeCounts = news.reduce((acc, item) => {
    const key = item.signalType || '普通新闻';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const sourceTypes = Array.from(new Set(news.map((item) => item.sourceCategory))).sort();

  return {
    news,
    meta: {
      since,
      generatedAt: new Date().toISOString(),
      sourceCount: new Set(news.map((item) => item.source)).size,
      articleCount: news.length,
      sourceTypes,
      channelCounts,
      investmentCategoryCounts,
      signalTypeCounts,
      mode,
      skillRoot: NEWS_INTELLIGENCE_ROOT,
      skillScript: NEWS_INTELLIGENCE_SCRIPT,
      wxMpRssCorePath: RESOLVED_WX_MP_RSS_CORE_PATH || null,
      xAccountsFile,
      xDigestFile,
      xAccountCount: xAccounts.length,
      xAccounts,
      xDigestCount,
      xFollowerCacheFile,
      xFollowerCacheUpdatedAt,
      xFollowerCacheAccountCount,
      xPerAccountLimit,
      xConcurrency,
      xLiveFetch,
      warnings: warnings.slice(0, 20),
    },
  };
}
