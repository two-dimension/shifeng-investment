export const BENCHMARK_CATEGORY_ORDER = Object.freeze([
  'Agent',
  'Coding',
  'Search & Tool Use',
  'Reasoning & Knowledge',
  'Multimodal',
  '其他',
]);

const CATEGORY_RULES = Object.freeze([
  ['Agent', /terminal[- ]bench|tau.?bench|τ.?bench|gaia|osworld|mcp|toolbench|apex-agents|toolathlon|coworkbench|workspacebench|jobbench|skillsbench|automation-bench/i],
  ['Coding', /swe[- ]bench|swe-pro|deepswe|frontiercode|cursorbench|programbench|scicode|nl2repo|paperbench|androidbench|vibe-pro|livecodebench|aider.*polyglot|humaneval|mbpp/i],
  ['Search & Tool Use', /browsecomp|webarena|wide.?search|search/i],
  ['Reasoning & Knowledge', /gpqa|mmlu|aime|hle|arc[- ]/i],
  ['Multimodal', /mmmu|mathvista|chartqa|videomme/i],
]);

function cleanText(value) {
  return String(value ?? '').trim() || null;
}

function slug(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/τ²/g, 'tau2')
    .replace(/τ/g, 'tau')
    .replace(/@/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fff.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function classifyOfficialBenchmark(testName) {
  const name = String(testName || '');
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(name))?.[0] || '其他';
}

function testFamily(testName) {
  const name = String(testName || '').trim();
  if (/terminal[- ]bench/i.test(name)) return 'Terminal-Bench';
  if (/swe[- ]bench/i.test(name)) return 'SWE-bench';
  if (/browsecomp/i.test(name)) return 'BrowseComp';
  if (/gpqa/i.test(name)) return 'GPQA';
  if (/mmlu/i.test(name)) return /pro/i.test(name) ? 'MMLU-Pro' : 'MMLU';
  if (/mmmu/i.test(name)) return /pro/i.test(name) ? 'MMMU-Pro' : 'MMMU';
  return name;
}

function comparisonParts(score) {
  const category = classifyOfficialBenchmark(score.testName);
  const family = testFamily(score.testName);
  const version = cleanText(score.testVersion);
  const split = cleanText(score.split);
  const scoreName = cleanText(score.scoreName);
  const agent = cleanText(score.agent);
  const harness = cleanText(score.harness);
  const effort = cleanText(score.effort);
  const shots = score.shots === 0 || score.shots ? String(score.shots) : null;
  const passK = score.passK === 0 || score.passK ? String(score.passK) : null;
  const tools = cleanText(score.tools);
  return { category, family, version, split, scoreName, agent, harness, effort, shots, passK, tools };
}

export function officialComparisonKey(score) {
  if (!score || score.configurationComplete !== true || !cleanText(score.testName)
    || !cleanText(score.scoreName) || !cleanText(score.unit) || !['higher', 'lower'].includes(score.direction)) return null;
  const parts = comparisonParts(score);
  const runParts = [parts.agent, parts.harness]
    .filter(Boolean)
    .filter((value, index, values) => values.findIndex((candidate) => slug(candidate) === slug(value)) === index);
  return [
    parts.category,
    parts.family,
    parts.version,
    parts.split,
    parts.scoreName,
    ...runParts,
    parts.effort,
    parts.shots,
    parts.passK,
    parts.tools,
  ].filter((value) => value !== null && value !== undefined && value !== '').map(slug).join(':');
}

function metricLabel(score, family) {
  const exact = [family, cleanText(score.testVersion), cleanText(score.split)].filter(Boolean).join(' ');
  return `${exact} · ${cleanText(score.scoreName)}`;
}

function normalizeMetric(score, key, sourceOrder, comparable) {
  const parts = comparisonParts(score);
  return {
    key,
    category: parts.category,
    testName: cleanText(score.testName),
    testFamily: parts.family,
    testVersion: parts.version,
    split: parts.split,
    scoreName: parts.scoreName,
    label: metricLabel(score, parts.family),
    group: parts.category,
    unit: cleanText(score.unit),
    direction: score.direction,
    agent: parts.agent,
    harness: parts.harness,
    effort: parts.effort,
    shots: score.shots ?? null,
    passK: score.passK ?? null,
    tools: parts.tools,
    comparable,
    comparisonNote: comparable ? null : (cleanText(score.comparisonNote) || '运行配置不完整，不参与冠军计算'),
    sourceOrder,
    priority: parts.family === 'Terminal-Bench' ? 0 : 1,
    source: 'official-model-card',
    sourceUrl: cleanText(score.sourceUrl),
    winnerKey: comparable ? key : null,
  };
}

function metricSort(left, right) {
  return BENCHMARK_CATEGORY_ORDER.indexOf(left.category) - BENCHMARK_CATEGORY_ORDER.indexOf(right.category)
    || left.priority - right.priority
    || left.sourceOrder - right.sourceOrder
    || left.label.localeCompare(right.label, 'en');
}

function normalizeScore(score, card, metric) {
  const value = Number(score.value);
  if (!Number.isFinite(value)) return null;
  return {
    value,
    direction: metric.direction,
    metric: metric.scoreName,
    unit: metric.unit,
    asOf: cleanText(score.publishedAt || card.releasedAt),
    source: 'official-model-card',
    sourceUrl: cleanText(score.sourceUrl || card.sourceUrl),
    publishedAt: cleanText(score.publishedAt || card.releasedAt),
    retrievedAt: cleanText(score.retrievedAt || card.retrievedAt),
    configurationComplete: metric.comparable,
    comparisonNote: metric.comparisonNote,
  };
}

function generateWinners(models, metrics) {
  const winners = {};
  for (const metric of metrics) {
    if (!metric.comparable) continue;
    const scored = models.flatMap((model) => {
      const score = model.scores[metric.key];
      return score && Number.isFinite(score.value) ? [{ model: model.model, value: score.value }] : [];
    });
    if (scored.length === 0) continue;
    const best = metric.direction === 'lower'
      ? Math.min(...scored.map((row) => row.value))
      : Math.max(...scored.map((row) => row.value));
    winners[metric.key] = {
      models: scored.filter((row) => row.value === best).map((row) => row.model).sort((left, right) => left.localeCompare(right, 'en')),
      value: best,
    };
  }
  return winners;
}

export function normalizeOfficialBenchmarks({ vendorCards = [], asOf = new Date().toISOString() } = {}) {
  const metricsByKey = new Map();
  const models = vendorCards.map((card) => {
    const model = {
      vendor: cleanText(card.vendor),
      model: cleanText(card.model) || '官网模型卡暂不可读',
      releasedAt: cleanText(card.releasedAt),
      sourceMode: 'official-model-card',
      status: card.status || 'error',
      stale: Boolean(card.stale),
      sourceLabel: cleanText(card.sourceLabel) || `${card.vendor} 官网模型卡`,
      sourceUrl: cleanText(card.sourceUrl),
      discoveryMode: cleanText(card.discoveryMode),
      error: cleanText(card.error),
      scores: {},
    };
    (card.scores || []).forEach((rawScore, sourceOrder) => {
      const comparisonKey = officialComparisonKey(rawScore);
      const key = comparisonKey || `incomplete:${slug(card.vendor)}:${slug(card.model)}:${sourceOrder}`;
      let metric = metricsByKey.get(key);
      if (!metric) {
        metric = normalizeMetric({ ...rawScore, sourceUrl: rawScore.sourceUrl || card.sourceUrl }, key, rawScore.sourceOrder ?? sourceOrder, Boolean(comparisonKey));
        metricsByKey.set(key, metric);
      }
      const score = normalizeScore(rawScore, card, metric);
      if (score) model.scores[key] = score;
    });
    return model;
  });
  const metrics = [...metricsByKey.values()].sort(metricSort);
  const winners = generateWinners(models, metrics);
  const vendorSources = vendorCards.map((card) => ({
    vendor: card.vendor,
    model: card.model || null,
    status: card.status || 'error',
    stale: Boolean(card.stale),
    sourceUrl: card.sourceUrl || null,
    discoveryMode: card.discoveryMode || null,
    releasedAt: card.releasedAt || null,
    retrievedAt: card.retrievedAt || null,
    error: card.error || null,
    disclosedScores: card.scores?.length || 0,
  }));
  const attributions = [...new Map(vendorCards.filter((card) => card.sourceUrl).map((card) => [card.sourceUrl, {
    source: 'official-model-card',
    label: `${card.vendor} · ${card.model || '模型卡'}`,
    url: card.sourceUrl,
  }])).values()];
  return {
    models,
    metrics,
    winners,
    vendorSources,
    coverage: {
      vendors: models.length,
      disclosedVendors: models.filter((model) => Object.keys(model.scores).length > 0).length,
      metrics: metrics.length,
      comparableMetrics: metrics.filter((metric) => metric.comparable).length,
    },
    asOf,
    sourceMode: 'official-model-cards',
    attributions,
  };
}
