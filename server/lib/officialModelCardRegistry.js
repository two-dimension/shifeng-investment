import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { decodeOfficialDocument } from './officialDocumentClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_FILE = path.join(__dirname, '../data/ai-dashboard/official-model-card-registry.json');

export const TRACKED_OFFICIAL_VENDORS = Object.freeze([
  'Anthropic', 'OpenAI', 'Gemini', '智谱', 'MiniMax', 'Qwen',
  'Mimo', 'DeepSeek', 'Kimi', 'Meta', 'Tencent', 'xAI',
]);

const BANNED_SCORE_PATTERN = /Artificial Analysis|AA Intelligence Index|^AA[- ]|Design Arena|OpenRouter|Arena Elo|(?:input|output) price|pricing|价格|上下文|最大输出|^特点$|^date$|release(?:d)? date|system card|context length|parameters?|architecture|training stage|vocabulary|number of|hidden size/i;

const TEXT_SCORE_PATTERNS = Object.freeze({
  MiniMax: Object.freeze([
    ['MLE Bench Lite', null, 'Medal rate', /MLE Bench Lite[^.\n]*?([\d.]+)%[*_\s]+medal rate/i, 'percent-point'],
    ['SWE-Pro', null, 'Accuracy', /SWE-Pro[^.\n]*?([\d.]+)%/i, 'percent-point'],
    ['SWE Multilingual', null, 'Accuracy', /SWE Multilingual\s*\(([\d.]+)\)/i, 'percent-point'],
    ['Multi SWE Bench', null, 'Accuracy', /Multi SWE Bench\s*\(([\d.]+)\)/i, 'percent-point'],
    ['VIBE-Pro', null, 'Accuracy', /VIBE-Pro\s*\(([\d.]+)%\)/i, 'percent-point'],
    ['Terminal-Bench', '2.0', 'Accuracy', /Terminal Bench\s*2\s*\(([\d.]+)%\)/i, 'percent-point'],
    ['NL2Repo', null, 'Accuracy', /NL2Repo\s*\(([\d.]+)%\)/i, 'percent-point'],
    ['Toolathon', null, 'Accuracy', /Toolathon[^.\n]*?([\d.]+)%/i, 'percent-point'],
    ['MM Claw', null, 'Accuracy', /MM Claw[^.\n]*?([\d.]+)%/i, 'percent-point'],
  ]),
  Tencent: Object.freeze([
    ['Expert blind evaluation', '2026-07', 'Mean score', /blind evaluation[^.\n]*?scored\s*([\d.]+)\s*\/\s*4/i, 'number'],
  ]),
  xAI: Object.freeze([
    ['CursorBench', '3.2', 'Accuracy', /CursorBench\s+v?3\.2\s+([\d.]+)%/i, 'percent-point'],
    ['DeepSWE', '1.1', 'Accuracy', /DeepSWE\s+v?1\.1\s+([\d.]+)%/i, 'percent-point'],
    ['FrontierCode', '1.1 Extended', 'Accuracy', /FrontierCode\s+v?1\.1\s*\(Extended\)\s+([\d.]+)%/i, 'percent-point'],
    ['APEX-Agents', null, 'Accuracy', /APEX-Agents\s+([\d.]+)%/i, 'percent-point'],
    ['Terminal-Bench', '3.0', 'Accuracy', /Terminal-Bench\s+v?3\.0\s+([\d.]+)%/i, 'percent-point'],
    ['APEX-SWE', null, 'Accuracy', /APEX-SWE\s+([\d.]+)%/i, 'percent-point'],
    ['Harvey LAB', 'Vals', 'Accuracy', /Harvey LAB\s*\(Vals\)\s+([\d.]+)%/i, 'percent-point'],
  ]),
});

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim() || null;
}

function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff.]+/g, '');
}

function normalizedHeader(value) {
  return compact(value).replace(/percentagepoints?|percentpoint/g, 'unit');
}

function parseUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  return url;
}

function assertOfficialOwner(definition, url, label) {
  const host = url.hostname.toLowerCase();
  const firstPathPart = decodeURIComponent(url.pathname.split('/').filter(Boolean)[0] || '');
  if ((host === 'github.com' || host === 'raw.githubusercontent.com' || host === 'api.github.com')
    && definition.officialOwner && firstPathPart.toLowerCase() !== definition.officialOwner.toLowerCase()) {
    throw new Error(`${definition.vendor} ${label} is outside the registered official owner`);
  }
  if (host === 'huggingface.co' && definition.officialHuggingFaceOwner
    && firstPathPart.toLowerCase() !== definition.officialHuggingFaceOwner.toLowerCase()) {
    throw new Error(`${definition.vendor} ${label} is outside the registered official owner`);
  }
}

function validateDefinition(definition) {
  if (!TRACKED_OFFICIAL_VENDORS.includes(definition?.vendor)) throw new Error(`unsupported official Benchmark vendor: ${definition?.vendor}`);
  const allowedHosts = [...new Set((definition.allowedHosts || []).map((host) => String(host).toLowerCase()))];
  if (allowedHosts.length === 0) throw new Error(`${definition.vendor} allowedHosts is required`);
  const indexUrl = parseUrl(definition.indexUrl, `${definition.vendor} indexUrl`);
  if (!allowedHosts.includes(indexUrl.hostname.toLowerCase())) throw new Error(`${definition.vendor} index host is not allowlisted`);
  assertOfficialOwner(definition, indexUrl, 'index URL');
  let cardUrl = null;
  if (definition.cardUrl) {
    cardUrl = parseUrl(definition.cardUrl, `${definition.vendor} cardUrl`);
    if (!allowedHosts.includes(cardUrl.hostname.toLowerCase())) throw new Error(`${definition.vendor} card host is not allowlisted`);
    assertOfficialOwner(definition, cardUrl, 'card URL');
  }
  let fetchUrl = null;
  if (definition.fetchUrl) {
    fetchUrl = parseUrl(definition.fetchUrl, `${definition.vendor} fetchUrl`);
    if (!allowedHosts.includes(fetchUrl.hostname.toLowerCase())) throw new Error(`${definition.vendor} fetch host is not allowlisted`);
    assertOfficialOwner(definition, fetchUrl, 'fetch URL');
  }
  return Object.freeze({
    ...definition,
    indexUrl: indexUrl.toString(),
    cardUrl: cardUrl?.toString() || null,
    fetchUrl: fetchUrl?.toString() || null,
    allowedHosts: Object.freeze(allowedHosts),
    modelAliases: Object.freeze([definition.model, ...(definition.modelAliases || [])].filter(Boolean)),
  });
}

function loadRegistry() {
  const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('official model-card registry must be an array');
  const normalized = parsed.map(validateDefinition);
  if (normalized.length !== TRACKED_OFFICIAL_VENDORS.length
    || normalized.some((row, index) => row.vendor !== TRACKED_OFFICIAL_VENDORS[index])) {
    throw new Error('official model-card registry must contain the 12 tracked vendors in stable order');
  }
  return Object.freeze(normalized);
}

export const OFFICIAL_MODEL_CARD_SOURCES = loadRegistry();

function formatFromDocument(document, fallback) {
  const contentType = String(document.contentType || '').toLowerCase();
  if (contentType.includes('pdf')) return 'pdf';
  if (contentType.includes('json')) return 'json';
  if (contentType.includes('markdown') || contentType.includes('text/plain')) return 'markdown';
  if (contentType.includes('html') || contentType.includes('xhtml')) return 'html';
  return fallback;
}

function tableMatrixFromHtml(html) {
  const $ = load(String(html || ''));
  const matrices = [];
  $('table').each((_, table) => {
    const rows = [];
    $(table).find('tr').each((__, row) => {
      const cells = $(row).find('th,td').map((___, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
      if (cells.length > 0) rows.push(cells);
    });
    if (rows.length >= 2) matrices.push(rows);
  });
  return matrices;
}

function markdownCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.replace(/<br\s*\/?\s*>/gi, ' ').trim());
}

function tableMatrixFromMarkdown(markdown) {
  const matrices = [];
  let current = [];
  const flush = () => {
    if (current.length >= 2) matrices.push(current);
    current = [];
  };
  for (const line of String(markdown || '').split(/\r?\n/)) {
    if (!/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      continue;
    }
    const cells = markdownCells(line);
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    current.push(cells);
  }
  flush();
  return matrices;
}

function cellNumber(value) {
  const normalized = String(value || '').replaceAll(',', '').replace(/[％%*†‡]+/g, '').trim();
  if (!normalized || /^(?:-|—|--|n\/a|na)$/i.test(normalized) || normalized.includes('/')) return null;
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function nullableNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolean(value) {
  return /^(?:true|yes|1|完整)$/i.test(String(value || '').trim());
}

function inferBenchmarkName(rawName) {
  const label = text(rawName) || 'Unnamed official evaluation';
  if (/terminal[- ]bench/i.test(label)) {
    const version = label.match(/(?:terminal[- ]bench)\s*(?:v(?:ersion)?\s*)?(\d+(?:\.\d+)?)/i)?.[1] || null;
    return { testName: 'Terminal-Bench', testVersion: version, scoreName: 'Accuracy' };
  }
  if (/swe[- ]bench/i.test(label)) {
    const suffix = label.replace(/^.*?swe[- ]bench\s*/i, '').trim() || null;
    return { testName: 'SWE-bench', testVersion: suffix, scoreName: /pass@/i.test(label) ? text(label.match(/pass@\d+/i)?.[0]) : 'Pass@1' };
  }
  if (/gpqa/i.test(label)) return { testName: 'GPQA', testVersion: /diamond/i.test(label) ? 'Diamond' : null, scoreName: 'Accuracy' };
  if (/mmmu[- ]?pro/i.test(label)) return { testName: 'MMMU-Pro', testVersion: null, scoreName: 'Accuracy' };
  const versionMatch = label.match(/\b(?:v(?:ersion)?\s*)?(\d+(?:\.\d+)+)\b/i);
  return {
    testName: versionMatch ? text(label.replace(versionMatch[0], '')) : label,
    testVersion: versionMatch?.[1] || null,
    scoreName: /elo|rating/i.test(label) ? 'Elo' : 'Accuracy',
  };
}

function scoreRecord(fields, context) {
  const testName = text(fields.testName);
  const value = cellNumber(fields.value);
  if (!testName || value === null || BANNED_SCORE_PATTERN.test(testName)) return null;
  const inferred = inferBenchmarkName(testName);
  const unit = text(fields.unit) || (String(fields.value || '').includes('%') || Math.abs(value) <= 100 ? 'percent-point' : 'number');
  const configurationComplete = boolean(fields.configurationComplete);
  return {
    testName: inferred.testName,
    testVersion: text(fields.testVersion) || inferred.testVersion,
    split: text(fields.split),
    scoreName: text(fields.scoreName) || inferred.scoreName,
    value,
    unit,
    direction: /lower/i.test(String(fields.direction || '')) ? 'lower' : 'higher',
    agent: text(fields.agent),
    harness: text(fields.harness),
    effort: text(fields.effort),
    shots: nullableNumber(fields.shots),
    passK: nullableNumber(fields.passK),
    tools: text(fields.tools),
    configurationComplete,
    comparisonNote: configurationComplete ? null : '官网未完整披露可比运行配置',
    sourceUrl: context.sourceUrl,
    publishedAt: context.releasedAt,
    retrievedAt: context.retrievedAt,
    sourceOrder: context.sourceOrder,
  };
}

function columnIndex(headers, names) {
  const normalized = headers.map(normalizedHeader);
  return normalized.findIndex((header) => names.some((name) => header === compact(name)));
}

function standardizedTableScores(matrix, context) {
  const headers = matrix[0];
  const indexes = {
    testName: columnIndex(headers, ['benchmark', 'test', 'evaluation', '评测', '基准']),
    testVersion: columnIndex(headers, ['version', 'test version', '版本']),
    split: columnIndex(headers, ['split', '数据集']),
    scoreName: columnIndex(headers, ['score name', 'metric', '指标']),
    value: columnIndex(headers, ['value', 'score', '得分', '分数']),
    unit: columnIndex(headers, ['unit', '单位']),
    direction: columnIndex(headers, ['direction', '方向']),
    agent: columnIndex(headers, ['agent', '智能体']),
    harness: columnIndex(headers, ['harness', '脚手架']),
    effort: columnIndex(headers, ['effort', 'reasoning effort', '推理强度']),
    shots: columnIndex(headers, ['shots', 'shot']),
    passK: columnIndex(headers, ['pass@k', 'pass k']),
    tools: columnIndex(headers, ['tools', 'tool policy', '工具']),
    configurationComplete: columnIndex(headers, ['configuration complete', 'comparable', '配置完整']),
  };
  if (indexes.testName < 0 || indexes.value < 0) return null;
  return matrix.slice(1).flatMap((row, rowIndex) => {
    const fields = Object.fromEntries(Object.entries(indexes).map(([key, index]) => [key, index >= 0 ? row[index] : null]));
    const score = scoreRecord(fields, { ...context, sourceOrder: context.sourceOrder + rowIndex });
    return score ? [score] : [];
  });
}

function modelColumnScores(matrix, definition, context) {
  const headers = matrix[0];
  const aliases = definition.modelAliases.map(compact);
  const modelColumn = headers.findIndex((header) => {
    const candidate = compact(header);
    return candidate && aliases.some((alias) => candidate.includes(alias) || alias.includes(candidate));
  });
  if (modelColumn <= 0) return null;
  return matrix.slice(1).flatMap((row, rowIndex) => {
    const score = scoreRecord({ testName: row[0], value: row[modelColumn] }, { ...context, sourceOrder: context.sourceOrder + rowIndex });
    return score ? [score] : [];
  });
}

function modelRowScores(matrix, definition, context) {
  const aliases = definition.modelAliases.map(compact);
  const modelRow = matrix.slice(1).find((row) => {
    const candidate = compact(row[0]);
    return candidate && aliases.some((alias) => candidate.includes(alias) || alias.includes(candidate));
  });
  if (!modelRow) return null;
  return matrix[0].slice(1).flatMap((header, columnOffset) => {
    const score = scoreRecord({ testName: header, value: modelRow[columnOffset + 1] }, { ...context, sourceOrder: context.sourceOrder + columnOffset });
    return score ? [score] : [];
  });
}

function parseScores(matrices, definition, context) {
  const scores = [];
  for (const matrix of matrices) {
    const parsed = standardizedTableScores(matrix, { ...context, sourceOrder: scores.length })
      || modelColumnScores(matrix, definition, { ...context, sourceOrder: scores.length })
      || modelRowScores(matrix, definition, { ...context, sourceOrder: scores.length })
      || [];
    scores.push(...parsed);
  }
  return scores.filter((score, index, rows) => rows.findIndex((candidate) => (
    candidate.testName === score.testName && candidate.testVersion === score.testVersion
      && candidate.scoreName === score.scoreName && candidate.value === score.value
  )) === index);
}

function parseTextScores(rawText, definition, context) {
  return (TEXT_SCORE_PATTERNS[definition.vendor] || []).flatMap(([
    testName, testVersion, scoreName, pattern, unit,
  ], sourceOrder) => {
    const value = String(rawText || '').replace(/\s+/g, ' ').match(pattern)?.[1];
    const score = scoreRecord({
      testName, testVersion, scoreName, value, unit, direction: 'higher', configurationComplete: false,
    }, { ...context, sourceOrder });
    return score ? [score] : [];
  });
}

function documentMetadata(document, format, definition) {
  if (format === 'html') {
    const $ = load(String(document.text || ''));
    return {
      model: text($('[data-model]').first().attr('data-model')) || definition.model,
      releasedAt: text($('[data-released-at]').first().attr('data-released-at')) || definition.releasedAt,
      matrices: tableMatrixFromHtml(document.text),
    };
  }
  if (format === 'markdown') {
    const markdown = String(document.text || '');
    return {
      model: text(markdown.match(/^Model:\s*(.+)$/mi)?.[1]) || definition.model,
      releasedAt: text(markdown.match(/^Released:\s*(.+)$/mi)?.[1]) || definition.releasedAt,
      matrices: [...tableMatrixFromMarkdown(markdown), ...tableMatrixFromHtml(markdown)],
    };
  }
  return { model: definition.model, releasedAt: definition.releasedAt, matrices: [] };
}

function validateFinalDocumentUrl(definition, finalUrl) {
  const parsed = parseUrl(finalUrl, `${definition.vendor} final URL`);
  if (!definition.allowedHosts.includes(parsed.hostname.toLowerCase())) throw new Error(`${definition.vendor} final host is not allowlisted`);
  assertOfficialOwner(definition, parsed, 'final URL');
}

export function createOfficialModelCardRegistry({
  documentClient,
  now = () => new Date(),
  registry = OFFICIAL_MODEL_CARD_SOURCES,
} = {}) {
  if (!documentClient || typeof documentClient.fetchDocument !== 'function') throw new Error('official model-card documentClient is required');
  const definitions = registry.map(validateDefinition);
  const seen = new Set();
  for (const definition of definitions) {
    if (seen.has(definition.vendor)) throw new Error(`duplicate official Benchmark vendor: ${definition.vendor}`);
    seen.add(definition.vendor);
  }

  async function readOne(definition) {
    const sourceUrl = definition.cardUrl || definition.indexUrl;
    const entryUrl = definition.fetchUrl || sourceUrl;
    try {
      const document = await documentClient.fetchDocument({
        vendor: definition.vendor,
        entryUrl,
        allowedHosts: definition.allowedHosts,
        format: definition.format,
      });
      validateFinalDocumentUrl(definition, document.finalUrl || entryUrl);
      const format = formatFromDocument(document, definition.format);
      if (format === 'pdf') await decodeOfficialDocument(document, 'pdf');
      const metadata = documentMetadata(document, format, definition);
      const retrievedAt = document.retrievedAt || now().toISOString();
      if (!definition.cardUrl) {
        return {
          vendor: definition.vendor, status: 'unavailable', stale: true,
          model: metadata.model, releasedAt: metadata.releasedAt || null, sourceUrl,
          sourceLabel: `${definition.vendor} 官方发现入口`, discoveryMode: definition.discoveryMode,
          retrievedAt, scores: [], error: '官网发现入口尚未提供稳定的当前旗舰模型卡链接',
        };
      }
      const scoreContext = {
        sourceUrl, releasedAt: metadata.releasedAt || null, retrievedAt, sourceOrder: 0,
      };
      const scores = parseScores(metadata.matrices, definition, scoreContext);
      const rawText = format === 'html'
        ? await decodeOfficialDocument(document, 'html')
        : String(document.text || '');
      const narrativeScores = parseTextScores(rawText, definition, { ...scoreContext, sourceOrder: scores.length });
      scores.push(...narrativeScores.filter((score) => !scores.some((existing) => (
        existing.testName === score.testName && existing.testVersion === score.testVersion
      ))));
      return {
        vendor: definition.vendor, status: 'ready', stale: definition.discoveryMode === 'manual-registry',
        model: metadata.model, releasedAt: metadata.releasedAt || null, sourceUrl,
        sourceLabel: `${definition.vendor} 官网模型卡`, discoveryMode: definition.discoveryMode,
        retrievedAt, scores,
      };
    } catch (error) {
      return {
        vendor: definition.vendor, status: 'error', stale: true,
        model: definition.model || null, releasedAt: definition.releasedAt || null,
        sourceUrl, sourceLabel: `${definition.vendor} 官网模型卡`, discoveryMode: definition.discoveryMode,
        retrievedAt: now().toISOString(), scores: [], error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    readAll() {
      return Promise.all(definitions.map(readOne));
    },
  };
}
