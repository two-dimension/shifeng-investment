const SCORE_DATASET = 'Artificial Analysis Intelligence Index: Score';
const TOKEN_DATASET = 'Artificial Analysis Intelligence Index: Output Tokens per Task';
const COST_DATASET = 'Cost per Intelligence Index Task';

function cleanText(value) {
  return String(value ?? '').trim() || null;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 12) {
  return Number(value.toFixed(digits));
}

function absoluteUrl(value, sourceUrl) {
  if (!value) return null;
  try {
    return new URL(value, sourceUrl).toString();
  } catch {
    return null;
  }
}

function provenance({ asOf, retrievedAt, sourceUrl, methodology }) {
  return {
    sourceLabel: 'Artificial Analysis',
    sourceUrl,
    sourceKind: 'named-third-party',
    asOf,
    retrievedAt,
    methodology,
    stale: false,
  };
}

function datasetByName(datasets, name) {
  return datasets.find((dataset) => dataset?.['@type'] === 'Dataset' && dataset?.name === name);
}

function tokenKey(row) {
  return cleanText(row?.detailsUrl) || cleanText(row?.label);
}

export function normalizeArtificialAnalysisSnapshot({
  datasets = [],
  indexVersion = null,
  asOf,
  retrievedAt,
  sourceUrl,
} = {}) {
  if (!cleanText(sourceUrl) || !cleanText(asOf) || !cleanText(retrievedAt)) throw new Error('AA provenance is incomplete');
  const scoreDataset = datasetByName(datasets, SCORE_DATASET);
  const tokenDataset = datasetByName(datasets, TOKEN_DATASET);
  const costDataset = datasetByName(datasets, COST_DATASET);
  if (!scoreDataset || !tokenDataset || !costDataset) throw new Error('AA required public datasets are unavailable');
  const version = cleanText(indexVersion) || '未披露版本';
  const indexMethod = `Artificial Analysis Intelligence Index v${version}；独立第三方综合评测，不参与官网模型卡冠军`;
  const intelligenceIndex = (scoreDataset.data || []).flatMap((row) => {
    const model = cleanText(row?.label);
    const score = finite(row?.['Artificial Analysis Intelligence Index']);
    if (!model || score === null) return [];
    return [{
      model,
      modelUrl: absoluteUrl(row.detailsUrl, sourceUrl),
      score: round(score),
      rank: 0,
      indexVersion: version,
      ...provenance({ asOf, retrievedAt, sourceUrl, methodology: indexMethod }),
    }];
  }).sort((left, right) => right.score - left.score || left.model.localeCompare(right.model, 'en'))
    .map((row, index) => ({ ...row, rank: index + 1 }));

  const tokens = new Map((tokenDataset.data || []).map((row) => [tokenKey(row), row]));
  const costMethod = 'AA 公共 JSON-LD：每项评测按任务数与 Intelligence Index 权重计算；组件成本求和';
  const taskCosts = (costDataset.data || []).flatMap((row) => {
    const key = tokenKey(row);
    const model = cleanText(row?.label);
    if (!key || !model) return [];
    const token = tokens.get(key);
    const answerTokens = finite(token?.answer);
    const reasoningTokens = finite(token?.reasoning);
    const components = {
      inputCost: finite(row.input),
      cacheHitCost: finite(row.cacheHit),
      cacheWriteCost: finite(row.cacheWrite),
      reasoningCost: finite(row.reasoning),
      answerCost: finite(row.answer),
    };
    const disclosedCosts = Object.values(components).filter((value) => value !== null);
    const totalCost = disclosedCosts.length > 0 ? round(disclosedCosts.reduce((sum, value) => sum + value, 0)) : null;
    return [{
      model,
      modelUrl: absoluteUrl(row.detailsUrl, sourceUrl),
      taskName: 'Artificial Analysis Intelligence Index',
      taskVersion: version,
      harness: 'Artificial Analysis independent evaluation',
      answerTokens,
      reasoningTokens,
      outputTokens: answerTokens !== null && reasoningTokens !== null ? round(answerTokens + reasoningTokens) : null,
      ...components,
      totalCost,
      currency: 'USD',
      ...provenance({ asOf, retrievedAt, sourceUrl, methodology: costMethod }),
    }];
  }).sort((left, right) => (left.totalCost ?? Number.POSITIVE_INFINITY) - (right.totalCost ?? Number.POSITIVE_INFINITY)
    || left.model.localeCompare(right.model, 'en'));

  return { intelligenceIndex, taskCosts, indexVersion: version };
}

export const ARTIFICIAL_ANALYSIS_DATASET_NAMES = Object.freeze({
  score: SCORE_DATASET,
  tokens: TOKEN_DATASET,
  cost: COST_DATASET,
});
