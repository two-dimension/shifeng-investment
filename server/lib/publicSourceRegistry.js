export const DASHBOARD_SOURCE_KEYS = Object.freeze([
  'growth',
  'openRouter',
  'pricing',
  'capital',
  'benchmarks',
  'artificialAnalysis',
  'compute',
  'creditRisk',
]);

const SOURCE_KEY_SET = new Set(DASHBOARD_SOURCE_KEYS);
const SOURCE_KINDS = new Set(['official', 'filing', 'estimate', 'named-third-party']);
const SOURCE_FORMATS = new Set(['html', 'json', 'markdown', 'pdf']);

function requiredText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizeDefinition(definition) {
  const id = requiredText(definition?.id, 'source id');
  const slice = requiredText(definition?.slice, `source ${id} slice`);
  if (!SOURCE_KEY_SET.has(slice)) throw new Error(`unsupported source slice: ${slice}`);
  const entity = requiredText(definition?.entity, `source ${id} entity`);
  const entryUrl = requiredText(definition?.entryUrl, `source ${id} entryUrl`);
  let parsedUrl;
  try {
    parsedUrl = new URL(entryUrl);
  } catch {
    throw new Error(`source ${id} entryUrl is invalid`);
  }
  if (parsedUrl.protocol !== 'https:') throw new Error(`source ${id} entryUrl must use HTTPS`);
  const allowedHosts = [...new Set((definition?.allowedHosts || [])
    .map((host) => String(host || '').trim().toLowerCase())
    .filter(Boolean))];
  if (allowedHosts.length === 0) throw new Error(`source ${id} allowedHosts is required`);
  if (!allowedHosts.includes(parsedUrl.hostname.toLowerCase())) {
    throw new Error(`source ${id} entry host is not allowlisted`);
  }
  const format = requiredText(definition?.format, `source ${id} format`);
  if (!SOURCE_FORMATS.has(format)) throw new Error(`source ${id} format is unsupported: ${format}`);
  const sourceKind = requiredText(definition?.sourceKind, `source ${id} sourceKind`);
  if (!SOURCE_KINDS.has(sourceKind)) throw new Error(`source ${id} sourceKind is unsupported: ${sourceKind}`);
  const freshMs = Number(definition?.freshMs);
  if (!Number.isFinite(freshMs) || freshMs <= 0) {
    throw new Error(`source ${id} freshMs must be a positive number`);
  }
  return Object.freeze({
    id,
    slice,
    entity,
    entryUrl: parsedUrl.toString(),
    allowedHosts: Object.freeze(allowedHosts),
    format,
    freshMs,
    sourceKind,
  });
}

export function validatePublicSourceRegistry(definitions) {
  if (!Array.isArray(definitions)) throw new Error('source registry must be an array');
  const seen = new Set();
  const normalized = definitions.map((definition) => {
    const item = normalizeDefinition(definition);
    if (seen.has(item.id)) throw new Error(`duplicate source id: ${item.id}`);
    seen.add(item.id);
    return item;
  });
  return Object.freeze(normalized);
}

const DAY_MS = 86_400_000;

export const PUBLIC_SOURCE_REGISTRY = validatePublicSourceRegistry([
  {
    id: 'anthropic-series-g', slice: 'growth', entity: 'Anthropic',
    entryUrl: 'https://www.anthropic.com/news/anthropic-raises-30-billion-series-g-funding-380-billion-post-money-valuation', allowedHosts: ['www.anthropic.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'anthropic-run-rate', slice: 'growth', entity: 'Anthropic',
    entryUrl: 'https://www.anthropic.com/news/series-h', allowedHosts: ['www.anthropic.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'openai-arr-history', slice: 'growth', entity: 'OpenAI',
    entryUrl: 'https://openai.com/index/a-business-that-scales-with-the-value-of-intelligence/', allowedHosts: ['openai.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'openai-valuation', slice: 'growth', entity: 'OpenAI',
    entryUrl: 'https://openai.com/index/accelerating-the-next-phase-ai/', allowedHosts: ['openai.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'yipit-ai-revenue', slice: 'growth', entity: 'AI company ARR estimates',
    entryUrl: 'https://www.yipitdata.com/', allowedHosts: ['www.yipitdata.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'estimate',
  },
  {
    id: 'openai-pricing', slice: 'pricing', entity: 'OpenAI',
    entryUrl: 'https://platform.openai.com/pricing', allowedHosts: ['platform.openai.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'anthropic-pricing', slice: 'pricing', entity: 'Anthropic',
    entryUrl: 'https://platform.claude.com/docs/en/about-claude/pricing', allowedHosts: ['platform.claude.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'gemini-pricing', slice: 'pricing', entity: 'Gemini',
    entryUrl: 'https://ai.google.dev/gemini-api/docs/pricing', allowedHosts: ['ai.google.dev'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'zhipu-models', slice: 'pricing', entity: '智谱',
    entryUrl: 'https://docs.bigmodel.cn/cn/guide/start/model-overview', allowedHosts: ['docs.bigmodel.cn'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'minimax-pricing', slice: 'pricing', entity: 'MiniMax',
    entryUrl: 'https://platform.minimaxi.com/docs/guides/pricing-paygo', allowedHosts: ['platform.minimaxi.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'minimax-coding-plan', slice: 'pricing', entity: 'MiniMax Coding Plan',
    entryUrl: 'https://platform.minimaxi.com/docs/guides/pricing-token-plan', allowedHosts: ['platform.minimaxi.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'kimi-pricing', slice: 'pricing', entity: 'Kimi',
    entryUrl: 'https://platform.kimi.ai/docs/pricing/chat-k3.md', allowedHosts: ['platform.kimi.ai'],
    format: 'markdown', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'deepseek-pricing', slice: 'pricing', entity: 'DeepSeek',
    entryUrl: 'https://api-docs.deepseek.com/quick_start/pricing', allowedHosts: ['api-docs.deepseek.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'mimo-pricing', slice: 'pricing', entity: 'Mimo',
    entryUrl: 'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go', allowedHosts: ['mimo.mi.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'qwen-pricing', slice: 'pricing', entity: 'Qwen',
    entryUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', allowedHosts: ['help.aliyun.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'seedance-pricing', slice: 'pricing', entity: 'Seedance',
    entryUrl: 'https://www.volcengine.com/docs/84458/1585097', allowedHosts: ['www.volcengine.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'kling-pricing', slice: 'pricing', entity: 'Kling',
    entryUrl: 'https://kling.ai/document-api/pricing/base/video', allowedHosts: ['kling.ai'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'openai-codex-plan', slice: 'pricing', entity: 'OpenAI Codex',
    entryUrl: 'https://openai.com/chatgpt/pricing', allowedHosts: ['openai.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'anthropic-claude-code-plan', slice: 'pricing', entity: 'Claude Code',
    entryUrl: 'https://claude.com/product/claude-code', allowedHosts: ['claude.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'gemini-code-assist-plan', slice: 'pricing', entity: 'Gemini Code Assist',
    entryUrl: 'https://cloud.google.com/products/gemini/pricing', allowedHosts: ['cloud.google.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'zhipu-coding-plan', slice: 'pricing', entity: 'GLM Coding Plan',
    entryUrl: 'https://open.bigmodel.cn/glm-coding', allowedHosts: ['open.bigmodel.cn'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'mimo-token-plan', slice: 'pricing', entity: 'MiMo Token Plan',
    entryUrl: 'https://mimo.mi.com/docs/en-US/price/token-plan', allowedHosts: ['mimo.mi.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'qwen-code-plan', slice: 'pricing', entity: 'Qwen Code',
    entryUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/', allowedHosts: ['qwenlm.github.io'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'kimi-coding-plan', slice: 'pricing', entity: 'Kimi Code',
    entryUrl: 'https://platform.kimi.ai/docs/pricing/chat-k27-code', allowedHosts: ['platform.kimi.ai'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'deepseek-coding-plan', slice: 'pricing', entity: 'DeepSeek Coding',
    entryUrl: 'https://api-docs.deepseek.com/quick_start/pricing/', allowedHosts: ['api-docs.deepseek.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'artificial-analysis-index', slice: 'artificialAnalysis', entity: 'Artificial Analysis',
    entryUrl: 'https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index', allowedHosts: ['artificialanalysis.ai'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'named-third-party',
  },
  {
    id: 'aws-ec2-pricing', slice: 'compute', entity: 'AWS',
    entryUrl: 'https://aws.amazon.com/ec2/pricing/on-demand/', allowedHosts: ['aws.amazon.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'azure-vm-pricing', slice: 'compute', entity: 'Azure',
    entryUrl: 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/', allowedHosts: ['azure.microsoft.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'gcp-gpu-pricing', slice: 'compute', entity: 'Google Cloud',
    entryUrl: 'https://cloud.google.com/compute/gpus-pricing', allowedHosts: ['cloud.google.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'coreweave-pricing', slice: 'compute', entity: 'CoreWeave',
    entryUrl: 'https://coreweave.com/pricing', allowedHosts: ['coreweave.com', 'www.coreweave.com'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
  {
    id: 'lambda-cloud-pricing', slice: 'compute', entity: 'Lambda',
    entryUrl: 'https://lambda.ai/instances', allowedHosts: ['lambda.ai'],
    format: 'html', freshMs: DAY_MS, sourceKind: 'official',
  },
]);
