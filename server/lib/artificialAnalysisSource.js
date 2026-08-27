import { load } from 'cheerio';
import { normalizeArtificialAnalysisSnapshot } from './artificialAnalysisData.js';
import { PUBLIC_SOURCE_REGISTRY } from './publicSourceRegistry.js';

const DEFINITION = PUBLIC_SOURCE_REGISTRY.find((source) => source.id === 'artificial-analysis-index');

function parseDatasets(html) {
  const $ = load(String(html || ''));
  const datasets = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const value = JSON.parse($(element).text());
      const values = Array.isArray(value) ? value : [value];
      datasets.push(...values.filter((row) => row?.['@type'] === 'Dataset'));
    } catch {
      // Ignore unrelated malformed JSON-LD blocks; required dataset validation happens below.
    }
  });
  return datasets;
}

export function parseArtificialAnalysisDocument(document) {
  const sourceUrl = document?.finalUrl || DEFINITION.entryUrl;
  const parsed = new URL(sourceUrl);
  if (!DEFINITION.allowedHosts.includes(parsed.hostname.toLowerCase())) throw new Error('AA final host is not allowlisted');
  const retrievedAt = document?.retrievedAt;
  if (!retrievedAt || !Number.isFinite(Date.parse(retrievedAt))) throw new Error('AA retrievedAt is invalid');
  const html = String(document?.text || '');
  const indexVersion = html.match(/Intelligence Index\s+v(?:ersion\s*)?([\d.]+)/i)?.[1] || null;
  return normalizeArtificialAnalysisSnapshot({
    datasets: parseDatasets(html),
    indexVersion,
    asOf: retrievedAt.slice(0, 10),
    retrievedAt,
    sourceUrl,
  });
}

export function createArtificialAnalysisCollector({ documentClient } = {}) {
  if (!documentClient || typeof documentClient.fetchDocument !== 'function') throw new Error('AA documentClient is required');
  return async ({ generatedAt }) => {
    const document = await documentClient.fetchDocument(DEFINITION);
    const artificialAnalysis = parseArtificialAnalysisDocument(document);
    return {
      payload: { artificialAnalysis },
      source: {
        status: 'ready',
        stale: false,
        asOf: generatedAt.slice(0, 10),
        url: document.finalUrl || DEFINITION.entryUrl,
        message: `Artificial Analysis 独立参考：${artificialAnalysis.intelligenceIndex.length} 个模型 · ${artificialAnalysis.taskCosts.length} 条单任务成本`,
      },
    };
  };
}
