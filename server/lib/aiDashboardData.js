import { validateCacheHitRange } from './aiDashboardMetrics.js';

const FEISHU_API_ROOT = 'https://open.feishu.cn/open-apis';
const EMPTY_CELL = new Set([undefined, null, '']);

function clean(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function text(value) {
  return String(clean(value) ?? '');
}

function headerText(value) {
  return text(value).toLowerCase().replace(/\s+/g, '');
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = text(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function numberRange(value) {
  if (typeof value === 'number') return { low: value, high: value };
  const matches = text(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [];
  if (matches.length === 0) return { low: null, high: null };
  const low = Number(matches[0]);
  const high = Number(matches[1] ?? matches[0]);
  return { low: Math.min(low, high), high: Math.max(low, high) };
}

function parseDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    return new Date(excelEpoch + Math.round(value) * 86_400_000).toISOString().slice(0, 10);
  }
  const raw = text(value);
  const chineseDate = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (chineseDate) {
    return `${chineseDate[1]}-${String(chineseDate[2]).padStart(2, '0')}-${String(chineseDate[3]).padStart(2, '0')}`;
  }
  const chineseMonth = raw.match(/(\d{4})年(\d{1,2})月/);
  if (chineseMonth) return `${chineseMonth[1]}-${String(chineseMonth[2]).padStart(2, '0')}-01`;
  const match = raw.match(/(\d{4})[\/-](\d{1,2})(?:[\/-](\d{1,2}))?/);
  if (!match) return null;
  return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3] || 1).padStart(2, '0')}`;
}

function endOfMonth(date) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

function parseWideValuationMatrix(values) {
  const titleRowIndex = values.findIndex((row) => row.some((value) => headerText(value) === '估值'));
  if (titleRowIndex < 0) return [];
  const dateIndex = values[titleRowIndex].findIndex((value) => headerText(value) === '估值');
  const headers = values[titleRowIndex + 1] || [];
  const companyColumns = headers
    .map((header, index) => ({ company: text(header), index }))
    .filter(({ company, index }) => index > dateIndex && company && !/p\/?arr|倍数/i.test(company));
  const valuationRecords = [];
  for (const row of values.slice(titleRowIndex + 2)) {
    const asOf = parseDate(cell(row, dateIndex));
    if (!asOf) continue;
    for (const { company, index } of companyColumns) {
      const raw = cell(row, index);
      const range = numberRange(raw);
      if (range.low === null) continue;
      valuationRecords.push({
        company,
        asOf,
        valuationLow: range.low,
        valuationHigh: range.high,
        sourceLabel: '飞书估值表',
        note: typeof raw === 'string' ? raw : '',
      });
    }
  }
  return valuationRecords;
}

function parseYipitArrBlock(values) {
  const markerIndex = values.findIndex((row) => row.some((value) => /^yipit$/i.test(text(value))));
  if (markerIndex < 0) return [];
  const headerIndex = values.slice(markerIndex + 1)
    .findIndex((row) => row.some((value) => /anthropic|openai/i.test(text(value))));
  if (headerIndex < 0) return [];
  const absoluteHeaderIndex = markerIndex + 1 + headerIndex;
  const headers = values[absoluteHeaderIndex] || [];
  const companies = headers
    .map((header, index) => ({ company: text(header), index }))
    .filter(({ company, index }) => index > 0 && company);
  const records = [];
  let latestObservedAt = null;
  let forecastCaptured = false;
  for (const row of values.slice(absoluteHeaderIndex + 1)) {
    const observedAt = parseDate(cell(row, 0));
    const hasValues = companies.some(({ index }) => finiteNumber(cell(row, index)) !== null);
    if (observedAt) latestObservedAt = observedAt;
    if (!observedAt && (!latestObservedAt || !hasValues || forecastCaptured)) {
      if (latestObservedAt && !hasValues) break;
      continue;
    }
    const kind = observedAt ? 'actual' : 'forecast';
    const pointDate = observedAt || endOfMonth(latestObservedAt);
    for (const { company, index } of companies) {
      const rawValue = finiteNumber(cell(row, index));
      if (rawValue === null) continue;
      records.push({
        company,
        observedAt: pointDate,
        value: rawValue * 10,
        kind,
        sourceLabel: 'Yipit',
        note: kind === 'forecast'
          ? '源表月底预测；已从十亿美元换算为亿美元'
          : 'Yipit 实测；已从十亿美元换算为亿美元',
      });
    }
    if (kind === 'forecast') forecastCaptured = true;
  }
  return records;
}

function findHeaderRow(values, required) {
  return (values || []).findIndex((row) => required.every((needle) => row.some((cell) => headerText(cell).includes(needle))));
}

function findColumn(headers, ...needles) {
  return headers.findIndex((header) => needles.every((needle) => headerText(header).includes(needle)));
}

function cell(row, index) {
  return index >= 0 ? clean(row[index]) : undefined;
}

function inferVendor(model) {
  const name = text(model);
  if (/gpt|openai/i.test(name)) return 'OpenAI';
  if (/claude|opus|sonnet/i.test(name)) return 'Anthropic';
  if (/gemini/i.test(name)) return 'Google';
  if (/qwen/i.test(name)) return 'Alibaba';
  if (/deepseek/i.test(name)) return 'DeepSeek';
  if (/mythos|fable/i.test(name)) return 'Fable';
  if (/grok/i.test(name)) return 'xAI';
  if (/glm|智谱/i.test(name)) return 'Zhipu';
  if (/kimi/i.test(name)) return 'Moonshot';
  if (/minimax/i.test(name)) return 'MiniMax';
  return 'Other';
}

function normalizeModelName(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

function parseArrSheet(values) {
  const yipitRecords = parseYipitArrBlock(values);
  if (yipitRecords.length > 0) {
    return { arrRecords: yipitRecords, valuationRecords: parseWideValuationMatrix(values) };
  }
  const headerIndex = findHeaderRow(values, ['月份']);
  if (headerIndex < 0) return { arrRecords: [], valuationRecords: [] };
  const headers = values[headerIndex] || [];
  const dateIndex = findColumn(headers, '月份');
  const valuationDateIndex = headers.findIndex((header, index) => index > dateIndex && /估值日期/.test(text(header)));
  const arrEnd = valuationDateIndex >= 0 ? valuationDateIndex : headers.length;
  const arrCompanyColumns = headers
    .map((header, index) => ({ company: text(header), index }))
    .filter(({ company, index }) => index > dateIndex
      && index < arrEnd
      && company
      && !/环比|同比|绝对值|p\/?arr/i.test(company));
  const valuationCompanyColumns = headers
    .map((header, index) => ({ company: text(header), index }))
    .filter(({ company, index }) => valuationDateIndex >= 0
      && index > valuationDateIndex
      && company
      && !/p\/?arr|倍数/i.test(company));
  const arrRecords = [];
  const valuationRecords = [];

  for (const row of values.slice(headerIndex + 1)) {
    const observedAt = parseDate(cell(row, dateIndex));
    if (observedAt) {
      for (const { company, index } of arrCompanyColumns) {
        const raw = cell(row, index);
        if (EMPTY_CELL.has(raw)) continue;
        const note = typeof raw === 'string' ? raw : '';
        const forecastMatch = note.match(/(?:月底|月末)?预测\s*[:：]?\s*([0-9,.]+)/i);
        const actualMatch = note.match(/(?:实测|实际|硅谷|估计|估值)\s*[:：]?\s*([0-9,.]+)/i);
        const sourceLabel = /yipit/i.test(note) ? 'Yipit' : '飞书历史';
        const range = numberRange(raw);
        const actualValue = actualMatch ? finiteNumber(actualMatch[1]) : forecastMatch ? null : range.low;
        if (actualValue !== null) {
          arrRecords.push({ company, observedAt, value: actualValue, kind: 'actual', sourceLabel, note });
        }
        const forecastValue = forecastMatch ? finiteNumber(forecastMatch[1]) : null;
        if (forecastValue !== null) {
          arrRecords.push({ company, observedAt, value: forecastValue, kind: 'forecast', sourceLabel, note });
        }
      }
    }

    const valuationAsOf = valuationDateIndex >= 0 ? parseDate(cell(row, valuationDateIndex)) : null;
    if (valuationAsOf) {
      for (const { company, index } of valuationCompanyColumns) {
        const raw = cell(row, index);
        const range = numberRange(raw);
        if (range.low === null) continue;
        valuationRecords.push({
          company,
          asOf: valuationAsOf,
          valuationLow: range.low,
          valuationHigh: range.high,
          sourceLabel: '飞书估值表',
          note: typeof raw === 'string' ? raw : '',
        });
      }
    }
  }
  return { arrRecords, valuationRecords };
}

function parseModelPrices(values) {
  const headerIndex = findHeaderRow(values, ['模型', '输入']);
  if (headerIndex < 0) return [];
  const headers = values[headerIndex];
  const indexes = {
    region: findColumn(headers, '地区'),
    vendor: findColumn(headers, '厂商'),
    releasedAt: headers.findIndex((header) => /发布.*时间|发布时间/.test(text(header))),
    model: findColumn(headers, '模型'),
    category: findColumn(headers, '分类'),
    input: headers.findIndex((header) => /输入/.test(text(header)) && !/缓存/.test(text(header))),
    cache: headers.findIndex((header) => /缓存命中/.test(text(header)) && !/率.*(?:下限|上限)/.test(text(header))),
    output: findColumn(headers, '输出'),
    cacheLow: headers.findIndex((header) => /缓存命中率.*下限/.test(text(header))),
    cacheHigh: headers.findIndex((header) => /缓存命中率.*上限/.test(text(header))),
    source: findColumn(headers, '来源'),
    updatedAt: findColumn(headers, '更新时间'),
    note: headers.findIndex((header) => /优化方向|点评|备注/.test(text(header))),
  };
  let lastRegion = '';
  let lastVendor = '';
  const rows = [];
  for (const row of values.slice(headerIndex + 1)) {
    lastRegion = text(cell(row, indexes.region)) || lastRegion;
    lastVendor = text(cell(row, indexes.vendor)) || lastVendor;
    const model = text(cell(row, indexes.model));
    if (!model) continue;
    const cacheHitLow = finiteNumber(cell(row, indexes.cacheLow));
    const cacheHitHigh = finiteNumber(cell(row, indexes.cacheHigh));
    rows.push({
      region: lastRegion,
      vendor: lastVendor || inferVendor(model),
      model,
      releasedAt: parseDate(cell(row, indexes.releasedAt)),
      category: text(cell(row, indexes.category)),
      inputPrice: finiteNumber(cell(row, indexes.input)),
      cacheReadPrice: finiteNumber(cell(row, indexes.cache)),
      outputPrice: finiteNumber(cell(row, indexes.output)),
      cacheHitLow,
      cacheHitHigh,
      cacheRangeValid: validateCacheHitRange(cacheHitLow, cacheHitHigh),
      sourceLabel: text(cell(row, indexes.source)) || lastVendor || '飞书',
      asOf: parseDate(cell(row, indexes.updatedAt)) || parseDate(cell(row, indexes.releasedAt)),
      note: text(cell(row, indexes.note)),
    });
  }
  return rows;
}

function parseBenchmarks(values, modelPrices) {
  const headerIndex = findHeaderRow(values, ['测试分类', '评测维度']);
  if (headerIndex < 0) return [];
  const headers = values[headerIndex];
  const dimensionIndex = findColumn(headers, '评测维度');
  const metricIndex = findColumn(headers, '核心指标');
  const firstModelIndex = Math.max(dimensionIndex, metricIndex) + 1;
  const releaseEntries = modelPrices
    .filter((price) => price.releasedAt)
    .map((price) => ({ name: normalizeModelName(price.model), releasedAt: price.releasedAt }));
  const releaseByModel = new Map(releaseEntries.map((entry) => [entry.name, entry.releasedAt]));
  const releaseDateForModel = (model) => {
    const normalized = normalizeModelName(model);
    const exact = releaseByModel.get(normalized);
    if (exact) return exact;
    return releaseEntries
      .filter((entry) => entry.name.includes(normalized) || normalized.includes(entry.name))
      .map((entry) => entry.releasedAt)
      .toSorted((left, right) => right.localeCompare(left))[0] || '1970-01-01';
  };
  const byModel = new Map();
  headers.slice(firstModelIndex).forEach((header, offset) => {
    const model = text(header);
    if (!model) return;
    byModel.set(firstModelIndex + offset, {
      vendor: inferVendor(model),
      model,
      releasedAt: releaseDateForModel(model),
      scores: {},
      sourceLabel: '飞书模型基准测试',
    });
  });
  let parsedScoreRow = false;
  for (const row of values.slice(headerIndex + 1)) {
    const dimension = text(cell(row, dimensionIndex));
    const metric = text(cell(row, metricIndex));
    if (parsedScoreRow && !dimension && !metric) break;
    if (/^(?:评测|测评)维度$/.test(dimension)) break;
    if (!dimension) continue;
    parsedScoreRow = true;
    const direction = /成本|价格|延迟|耗时|cost|latency/i.test(`${dimension} ${metric}`) ? 'lower' : 'higher';
    for (const [index, model] of byModel.entries()) {
      const value = finiteNumber(cell(row, index));
      if (value !== null) model.scores[dimension] = { value, direction, metric };
    }
  }
  return [...byModel.values()];
}

function parseComputeRental(values) {
  const headerIndex = findHeaderRow(values, ['平台', 'gpu', '日期']);
  if (headerIndex < 0) return [];
  const headers = values[headerIndex];
  const indexes = {
    platform: findColumn(headers, '平台'),
    gpu: findColumn(headers, 'gpu'),
    date: findColumn(headers, '日期'),
    onDemand: headers.findIndex((header) => /on-demand/i.test(text(header)) && !/preemptible/i.test(text(header))),
    preemptible: headers.findIndex((header) => /^preemptible/i.test(text(header))),
    source: findColumn(headers, '来源'),
  };
  let platform = '';
  let gpu = '';
  const rows = [];
  for (const row of values.slice(headerIndex + 1)) {
    platform = text(cell(row, indexes.platform)) || platform;
    gpu = text(cell(row, indexes.gpu)) || gpu;
    const asOf = parseDate(cell(row, indexes.date));
    if (!platform || !gpu || !asOf) continue;
    const onDemand = finiteNumber(cell(row, indexes.onDemand));
    const preemptible = finiteNumber(cell(row, indexes.preemptible));
    if (onDemand === null && preemptible === null) continue;
    rows.push({
      platform,
      gpu,
      asOf,
      onDemand,
      preemptible,
      preemptibleRatio: onDemand && preemptible !== null ? preemptible / onDemand : null,
      sourceLabel: text(cell(row, indexes.source)) || '飞书算力租赁表',
    });
  }
  return rows;
}

function parseDebt(values) {
  const headerIndex = findHeaderRow(values, ['公司', '手段', '规模']);
  if (headerIndex < 0) return [];
  const headers = values[headerIndex];
  const indexes = {
    company: findColumn(headers, '公司'), date: findColumn(headers, '日期'), method: findColumn(headers, '手段'),
    amount: findColumn(headers, '规模'), currency: findColumn(headers, '币种'), note: headers.findIndex((h) => /点评|备注/.test(text(h))),
    source: findColumn(headers, '来源'), updatedAt: findColumn(headers, '更新时间'),
  };
  return values.slice(headerIndex + 1).flatMap((row) => {
    const company = text(cell(row, indexes.company));
    const method = text(cell(row, indexes.method));
    const amount = finiteNumber(cell(row, indexes.amount));
    if (!company || !method || amount === null) return [];
    return [{ company, asOf: parseDate(cell(row, indexes.date)), method, amount, currency: text(cell(row, indexes.currency)), note: text(cell(row, indexes.note)), sourceLabel: text(cell(row, indexes.source)) || '飞书', updatedAt: parseDate(cell(row, indexes.updatedAt)) }];
  });
}

function parseVideoPrices(values) {
  const headerIndex = findHeaderRow(values, ['厂商', '模型', 'usd/秒']);
  if (headerIndex < 0) return [];
  const headers = values[headerIndex];
  const indexes = {
    vendor: findColumn(headers, '厂商'), model: findColumn(headers, '模型'), mode: findColumn(headers, '生成模式'),
    resolution: findColumn(headers, '分辨率'), duration: findColumn(headers, '时长档'), price: findColumn(headers, 'usd/秒'),
    source: findColumn(headers, '来源'), updatedAt: findColumn(headers, '更新时间'),
  };
  return values.slice(headerIndex + 1).flatMap((row) => {
    const vendor = text(cell(row, indexes.vendor));
    const model = text(cell(row, indexes.model));
    const pricePerSecond = finiteNumber(cell(row, indexes.price));
    if (!vendor || !model || pricePerSecond === null) return [];
    return [{ vendor, model, mode: text(cell(row, indexes.mode)), resolution: text(cell(row, indexes.resolution)), durationTier: text(cell(row, indexes.duration)), pricePerSecond, sourceLabel: text(cell(row, indexes.source)) || vendor, asOf: parseDate(cell(row, indexes.updatedAt)) }];
  });
}

function parseCodingPlans(values) {
  const headerIndex = findHeaderRow(values, ['厂商', '套餐', '月付usd']);
  if (headerIndex < 0) return [];
  const headers = values[headerIndex];
  const indexes = {
    vendor: findColumn(headers, '厂商'), plan: findColumn(headers, '套餐'), monthly: findColumn(headers, '月付usd'), annualMonthly: findColumn(headers, '年付折算/月usd'),
    limits: findColumn(headers, '额度限制'), overage: findColumn(headers, '超量计费'), source: findColumn(headers, '来源'), updatedAt: findColumn(headers, '更新时间'),
  };
  return values.slice(headerIndex + 1).flatMap((row) => {
    const vendor = text(cell(row, indexes.vendor));
    const plan = text(cell(row, indexes.plan));
    const monthlyPrice = finiteNumber(cell(row, indexes.monthly));
    if (!vendor || !plan || monthlyPrice === null) return [];
    return [{ vendor, plan, monthlyPrice, annualMonthlyPrice: finiteNumber(cell(row, indexes.annualMonthly)), limits: text(cell(row, indexes.limits)), overage: text(cell(row, indexes.overage)), sourceLabel: text(cell(row, indexes.source)) || vendor, asOf: parseDate(cell(row, indexes.updatedAt)) }];
  });
}

export function normalizeFeishuWorkbook(workbook, { asOf = new Date().toISOString() } = {}) {
  const modelPrices = parseModelPrices(workbook['API模型token价格&发布日期&优化方向'] || []);
  const arr = parseArrSheet(workbook['ARR&估值'] || []);
  const headerRequirements = {
    'ARR&估值': ['月份'],
    'API模型token价格&发布日期&优化方向': ['模型', '输入'],
    '模型基准测试': ['测试分类', '评测维度'],
    '海外算力租赁价格追踪': ['平台', 'gpu', '日期'],
    '债务融资': ['公司', '手段', '规模'],
    '视频模型价格': ['厂商', '模型', 'usd/秒'],
    'Coding Plan价格': ['厂商', '套餐', '月付usd'],
  };
  return {
    availableSheets: Object.keys(workbook),
    validSheets: Object.entries(headerRequirements)
      .filter(([title, required]) => title === 'ARR&估值'
        ? arr.arrRecords.length > 0 || arr.valuationRecords.length > 0
        : findHeaderRow(workbook[title] || [], required) >= 0)
      .map(([title]) => title),
    ...arr,
    modelPrices,
    benchmarkModels: parseBenchmarks(workbook['模型基准测试'] || [], modelPrices),
    computeRental: parseComputeRental(workbook['海外算力租赁价格追踪'] || []),
    debtFinancing: parseDebt(workbook['债务融资'] || []),
    videoPrices: parseVideoPrices(workbook['视频模型价格'] || []),
    codingPlans: parseCodingPlans(workbook['Coding Plan价格'] || []),
    asOf,
  };
}

async function readJson(response, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  const body = await response.json();
  if (body.code !== 0) throw new Error(`${label} failed: ${body.msg || body.code}`);
  return body;
}

export function createFeishuClient({ appId, appSecret, spreadsheetToken, fetchImpl = fetch }) {
  if (!appId || !appSecret || !spreadsheetToken) throw new Error('Feishu credentials are incomplete');
  let cachedToken = null;
  let tokenExpiresAt = 0;

  const getToken = async () => {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
    const response = await fetchImpl(`${FEISHU_API_ROOT}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const body = await readJson(response, 'Feishu token');
    cachedToken = body.tenant_access_token;
    tokenExpiresAt = Date.now() + Math.max(60, Number(body.expire || 7200) - 600) * 1000;
    return cachedToken;
  };

  const authorizedGet = async (url) => {
    const token = await getToken();
    return readJson(await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } }), 'Feishu Sheets API');
  };

  return {
    async readWorkbook(sheetTitles) {
      const metadata = await authorizedGet(`${FEISHU_API_ROOT}/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`);
      const titleById = new Map((metadata.data?.sheets || []).map((sheet) => [sheet.sheet_id, sheet.title]));
      const idByTitle = new Map([...titleById.entries()].map(([id, title]) => [title, id]));
      const selected = sheetTitles.flatMap((title) => idByTitle.has(title) ? [{ title, id: idByTitle.get(title) }] : []);
      if (selected.length === 0) throw new Error('None of the requested Feishu sheets were found');
      const ranges = selected.map(({ id }) => `${id}!A1:ZZ1000`);
      const params = new URLSearchParams({
        ranges: ranges.join(','),
        valueRenderOption: 'FormattedValue',
        dateTimeRenderOption: 'FormattedString',
      });
      const payload = await authorizedGet(`${FEISHU_API_ROOT}/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values_batch_get?${params}`);
      const workbook = {};
      for (const valueRange of payload.data?.valueRanges || []) {
        const id = text(valueRange.range).split('!')[0];
        const title = titleById.get(id);
        if (title) workbook[title] = valueRange.values || [];
      }
      return workbook;
    },
  };
}
