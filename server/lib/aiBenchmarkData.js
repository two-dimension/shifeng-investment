const OPENROUTER_BENCHMARKS_DOCS_URL = 'https://openrouter.ai/docs/api/api-reference/benchmarks/list-benchmarks';
const ARTIFICIAL_ANALYSIS_URL = 'https://artificialanalysis.ai/';
const DESIGN_ARENA_URL = 'https://www.designarena.ai/';
const FEISHU_SOURCE_URL = 'https://xcn0zaydz11m.feishu.cn/sheets/F9W3s5BBEhRRV8tdZvCchEAfnCf?sheet=0rbUAO&table=tblzvLEtWP2TaYtF&view=vew0i9u3MV';
const EXCLUDED_WINNER_RE = /fable|mythos/i;

const VENDOR_LABELS = new Map([
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
  ['google', 'Google'],
  ['deepseek', 'DeepSeek'],
  ['qwen', 'Alibaba'],
  ['alibaba', 'Alibaba'],
  ['z-ai', 'Zhipu'],
  ['zhipu', 'Zhipu'],
  ['moonshotai', 'Moonshot'],
  ['moonshot', 'Moonshot'],
  ['minimax', 'MiniMax'],
  ['fable', 'Fable'],
  ['meta-llama', 'Meta'],
  ['x-ai', 'xAI'],
  ['mistralai', 'Mistral'],
  ['cohere', 'Cohere'],
  ['nvidia', 'NVIDIA'],
  ['microsoft', 'Microsoft'],
  ['amazon', 'Amazon'],
  ['perplexity', 'Perplexity'],
  ['baidu', 'Baidu'],
  ['tencent', 'Tencent'],
  ['xiaomi', 'Xiaomi'],
  ['stepfun', 'StepFun'],
]);

const ATTRIBUTIONS = Object.freeze({
  'artificial-analysis': { source: 'artificial-analysis', label: 'Artificial Analysis', url: ARTIFICIAL_ANALYSIS_URL },
  'design-arena': { source: 'design-arena', label: 'Design Arena', url: DESIGN_ARENA_URL },
  openrouter: { source: 'openrouter', label: 'OpenRouter Evals', url: OPENROUTER_BENCHMARKS_DOCS_URL },
  feishu: { source: 'feishu', label: '飞书模型基准测试', url: FEISHU_SOURCE_URL },
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function titleCase(value) {
  return String(value || '')
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.length <= 4 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'model';
}

function scoreRecord({ value, asOf, sampleSize, standardDeviation, source, sourceUrl }) {
  const score = { value, asOf, source, sourceUrl };
  if (sampleSize !== undefined && sampleSize !== null) score.sampleSize = sampleSize;
  if (standardDeviation !== undefined && standardDeviation !== null) score.standardDeviation = standardDeviation;
  return score;
}

function addMetric(metrics, definition) {
  if (!metrics.has(definition.key)) metrics.set(definition.key, definition);
}

export function canonicalModelSlug(slug) {
  let canonical = String(slug || '').trim();
  let previous;
  do {
    previous = canonical;
    canonical = canonical.replace(/:(?:free|extended|thinking|nitro|floor|exacto)$/i, '');
  } while (canonical !== previous);
  return canonical;
}

export function vendorLabel(slug) {
  const namespace = canonicalModelSlug(slug).split('/')[0].toLowerCase();
  return VENDOR_LABELS.get(namespace) || namespace;
}

export function selectLatestCatalogModels(catalog, benchmarkRows, feishuModels = []) {
  const tracked = new Set([
    ...(benchmarkRows || []).map((row) => vendorLabel(row?.model_permaslug)).filter(Boolean),
    ...(feishuModels || []).map((row) => String(row?.vendor || '').trim()).filter(Boolean),
  ]);
  const latest = new Map();

  for (const row of catalog || []) {
    const rawSlug = String(row?.id || '').trim();
    const modelSlug = canonicalModelSlug(rawSlug);
    if (!modelSlug || rawSlug !== modelSlug) continue;
    const vendor = vendorLabel(modelSlug);
    const modalities = row?.architecture?.output_modalities || row?.output_modalities || [];
    if (!tracked.has(vendor) || (modalities.length > 0 && !modalities.includes('text'))) continue;
    const created = finiteNumber(row?.created) ?? 0;
    const candidate = {
      vendor,
      model: String(row?.name || modelSlug.split('/').at(-1)),
      modelSlug,
      created,
      releasedAt: created > 0 ? new Date(created * 1000).toISOString().slice(0, 10) : null,
      sourceMode: 'openrouter',
      scores: {},
    };
    const current = latest.get(vendor);
    if (!current || candidate.created > current.created
      || (candidate.created === current.created && candidate.modelSlug < current.modelSlug)) {
      latest.set(vendor, candidate);
    }
  }

  for (const row of feishuModels || []) {
    const vendor = String(row?.vendor || '').trim();
    if (!vendor || latest.has(vendor)) continue;
    latest.set(vendor, {
      ...row,
      vendor,
      model: String(row?.model || '').trim(),
      modelSlug: `feishu/${slugify(row?.model)}`,
      sourceMode: 'feishu',
      scores: { ...(row?.scores || {}) },
    });
  }

  return [...latest.values()].sort((left, right) => left.vendor.localeCompare(right.vendor));
}

function addArtificialAnalysisRow({ row, model, metrics, asOf }) {
  const fields = [
    ['intelligence_index', 'Intelligence Index'],
    ['coding_index', 'Coding Index'],
    ['agentic_index', 'Agentic Index'],
  ];
  for (const [field, label] of fields) {
    const value = finiteNumber(row[field]);
    if (value === null) continue;
    const key = `artificial-analysis:${field}`;
    addMetric(metrics, {
      key,
      label,
      group: 'Artificial Analysis',
      unit: 'index',
      direction: 'higher',
      source: 'artificial-analysis',
      sourceUrl: ARTIFICIAL_ANALYSIS_URL,
    });
    model.scores[key] = scoreRecord({ value, asOf, source: 'artificial-analysis', sourceUrl: ARTIFICIAL_ANALYSIS_URL });
  }
}

function addDesignArenaRow({ row, model, metrics, asOf }) {
  const arena = String(row?.arena || 'models').trim().toLowerCase();
  const category = String(row?.category || 'overall').trim().toLowerCase();
  const fields = [
    ['elo', 'Elo', 'elo', 'higher'],
    ['win_rate', 'Win Rate', 'percent-point', 'higher'],
    ['rank', 'Rank', 'rank', 'lower'],
  ];
  for (const [field, fieldLabel, unit, direction] of fields) {
    const value = finiteNumber(row[field]);
    if (value === null) continue;
    const key = `design-arena:${arena}:${category}:${field}`;
    addMetric(metrics, {
      key,
      label: `${titleCase(category)} ${fieldLabel}`,
      group: `Design Arena · ${titleCase(arena)}`,
      unit,
      direction,
      source: 'design-arena',
      sourceUrl: DESIGN_ARENA_URL,
    });
    model.scores[key] = scoreRecord({ value, asOf, source: 'design-arena', sourceUrl: DESIGN_ARENA_URL });
  }
}

function addOpenRouterRow({ row, model, metrics, asOf }) {
  const benchmarkType = String(row?.benchmark_type || 'benchmark').trim().toLowerCase();
  const fields = [
    ['accuracy', 'Accuracy', 'percent', 'higher'],
    ['avg_cost_per_task', 'Avg Cost / Task', 'usd', 'lower'],
  ];
  for (const [field, fieldLabel, unit, direction] of fields) {
    const value = finiteNumber(row[field]);
    if (value === null) continue;
    const key = `openrouter:${benchmarkType}:${field}`;
    addMetric(metrics, {
      key,
      label: `${titleCase(benchmarkType)} ${fieldLabel}`,
      group: 'OpenRouter Evals',
      unit,
      direction,
      source: 'openrouter',
      sourceUrl: OPENROUTER_BENCHMARKS_DOCS_URL,
    });
    model.scores[key] = scoreRecord({
      value,
      asOf: row?.last_run_timestamp || asOf,
      sampleSize: finiteNumber(row?.total_tasks),
      standardDeviation: finiteNumber(row?.accuracy_stddev),
      source: 'openrouter',
      sourceUrl: OPENROUTER_BENCHMARKS_DOCS_URL,
    });
  }
}

function addFeishuScores({ model, metrics, asOf }) {
  const originalScores = { ...(model.scores || {}) };
  model.scores = {};
  for (const [name, original] of Object.entries(originalScores)) {
    const value = finiteNumber(original?.value);
    if (value === null) continue;
    const key = `feishu:${name}`;
    const direction = original?.direction === 'lower' ? 'lower' : 'higher';
    addMetric(metrics, {
      key,
      label: name,
      group: '飞书历史口径',
      unit: original?.metric || 'number',
      direction,
      source: 'feishu',
      sourceUrl: FEISHU_SOURCE_URL,
    });
    model.scores[key] = scoreRecord({
      value,
      asOf: model.releasedAt || asOf,
      source: 'feishu',
      sourceUrl: FEISHU_SOURCE_URL,
    });
  }
}

function generateWinners(models, metrics) {
  const winners = {};
  for (const metric of metrics.values()) {
    const scored = models
      .filter((model) => !EXCLUDED_WINNER_RE.test(`${model.vendor} ${model.model}`))
      .map((model) => ({ model: model.model, value: finiteNumber(model.scores?.[metric.key]?.value) }))
      .filter((row) => row.value !== null);
    if (scored.length === 0) continue;
    const values = scored.map((row) => row.value);
    const best = metric.direction === 'lower' ? Math.min(...values) : Math.max(...values);
    winners[metric.key] = scored
      .filter((row) => row.value === best)
      .map((row) => row.model)
      .sort((left, right) => left.localeCompare(right));
  }
  return winners;
}

export function normalizeOnlineBenchmarks({ catalog = [], benchmarkPayload = {}, feishuModels = [] } = {}) {
  const benchmarkRows = Array.isArray(benchmarkPayload?.data) ? benchmarkPayload.data : [];
  const asOf = benchmarkPayload?.meta?.as_of || null;
  const models = selectLatestCatalogModels(catalog, benchmarkRows, feishuModels)
    .map((model) => ({ ...model, scores: { ...(model.scores || {}) } }));
  const modelsBySlug = new Map(models.map((model) => [canonicalModelSlug(model.modelSlug), model]));
  const metrics = new Map();

  for (const model of models.filter((candidate) => candidate.sourceMode === 'feishu')) {
    addFeishuScores({ model, metrics, asOf });
  }

  for (const row of benchmarkRows) {
    const model = modelsBySlug.get(canonicalModelSlug(row?.model_permaslug));
    if (!model || model.sourceMode !== 'openrouter') continue;
    if (row?.source === 'artificial-analysis') addArtificialAnalysisRow({ row, model, metrics, asOf });
    if (row?.source === 'design-arena') addDesignArenaRow({ row, model, metrics, asOf });
    if (row?.source === 'openrouter') addOpenRouterRow({ row, model, metrics, asOf });
  }

  const metricList = [...metrics.values()];
  const usedSources = new Set(metricList.map((metric) => metric.source));
  return {
    models,
    metrics: metricList,
    winners: generateWinners(models, metrics),
    asOf,
    sourceMode: 'openrouter',
    coverage: {
      vendors: models.length,
      evaluatedVendors: models.filter((model) => Object.keys(model.scores).length > 0).length,
      metrics: metricList.length,
    },
    attributions: ['artificial-analysis', 'design-arena', 'openrouter', 'feishu']
      .filter((source) => usedSources.has(source))
      .map((source) => ATTRIBUTIONS[source]),
  };
}
