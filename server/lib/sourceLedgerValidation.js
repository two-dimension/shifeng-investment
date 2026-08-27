import { AI_CAPITAL_SOURCE_REGISTRY } from './aiCapitalSources.js';
import { OFFICIAL_MODEL_CARD_SOURCES } from './officialModelCardRegistry.js';
import { PUBLIC_SOURCE_REGISTRY } from './publicSourceRegistry.js';

const SOURCE_KINDS = new Set(['official', 'filing', 'estimate', 'named-third-party']);
const SOURCE_STATUSES = new Set(['active', 'discovery']);
const VERIFICATION_STATUSES = new Set(['verified', 'user-confirmed-estimate', 'unavailable']);
const MEDIA_HOSTS = new Set([
  'reuters.com', 'www.reuters.com', 'bloomberg.com', 'www.bloomberg.com',
  'techcrunch.com', 'www.techcrunch.com', 'theinformation.com', 'www.theinformation.com',
  '36kr.com', 'www.36kr.com', 'caixin.com', 'www.caixin.com',
]);

function asIso(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function validDate(value) {
  const raw = String(value || '').slice(0, 10);
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw ? raw : null;
}

function shanghaiDate(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function normalizedHosts(hosts, entryUrl) {
  const result = new Set((hosts || []).map((host) => String(host || '').trim().toLowerCase()).filter(Boolean));
  if (entryUrl) result.add(new URL(entryUrl).hostname.toLowerCase());
  return [...result];
}

function normalizedSource(source) {
  return {
    id: String(source.id),
    slice: String(source.slice),
    entity: String(source.entity),
    sourceKind: String(source.sourceKind),
    entryUrl: new URL(source.entryUrl).toString(),
    allowedHosts: normalizedHosts(source.allowedHosts, source.entryUrl),
    status: source.status === 'discovery' ? 'discovery' : 'active',
  };
}

export function buildAiDashboardSourceManifest({ generatedAt = new Date().toISOString() } = {}) {
  const sources = [
    ...PUBLIC_SOURCE_REGISTRY.map((source) => normalizedSource({ ...source, status: 'active' })),
    ...AI_CAPITAL_SOURCE_REGISTRY.map((source) => normalizedSource({
      ...source,
      slice: 'capital',
      status: source.status === 'discovery-maintained' ? 'discovery' : 'active',
    })),
    ...OFFICIAL_MODEL_CARD_SOURCES.map((source) => normalizedSource({
      id: `benchmark:${source.vendor}`,
      slice: 'benchmarks',
      entity: source.vendor,
      sourceKind: 'official',
      entryUrl: source.cardUrl || source.indexUrl,
      allowedHosts: source.allowedHosts,
      status: source.cardUrl ? 'active' : 'discovery',
    })),
    normalizedSource({
      id: 'openrouter-rankings',
      slice: 'openRouter',
      entity: 'OpenRouter',
      sourceKind: 'named-third-party',
      entryUrl: 'https://openrouter.ai/rankings',
      allowedHosts: ['openrouter.ai'],
      status: 'active',
    }),
  ];
  const unique = new Map();
  for (const source of sources) {
    if (unique.has(source.id)) throw new Error(`duplicate generated source id: ${source.id}`);
    unique.set(source.id, source);
  }
  return {
    schemaVersion: 1,
    generatedAt: asIso(generatedAt) || String(generatedAt),
    sources: [...unique.values()].sort((left, right) => left.slice.localeCompare(right.slice) || left.id.localeCompare(right.id)),
  };
}

function issue(errors, code, path, message) {
  errors.push({ code, path, message });
}

function validateCommonDocument(document, errors, prefix, now) {
  if (document?.schemaVersion !== 1) issue(errors, 'SCHEMA_VERSION', 'schemaVersion', 'schemaVersion must equal 1');
  const generatedAt = asIso(document?.generatedAt);
  if (!generatedAt) issue(errors, 'GENERATED_AT_INVALID', 'generatedAt', 'generatedAt must be a valid ISO timestamp');
  else if (Date.parse(generatedAt) > now.getTime()) issue(errors, 'GENERATED_AT_FUTURE', 'generatedAt', `${prefix} generatedAt is in the future`);
}

export function validateSourceManifest(manifest, { now = new Date() } = {}) {
  const errors = [];
  validateCommonDocument(manifest, errors, 'manifest', now);
  if (!Array.isArray(manifest?.sources)) {
    issue(errors, 'MANIFEST_SOURCES_INVALID', 'sources', 'sources must be an array');
    return { errors, counts: { sources: 0, active: 0, discovery: 0 } };
  }
  const ids = new Set();
  manifest.sources.forEach((source, index) => {
    const path = `sources[${index}]`;
    const id = String(source?.id || '').trim();
    if (!id) issue(errors, 'MANIFEST_ID_MISSING', `${path}.id`, 'source id is required');
    else if (ids.has(id)) issue(errors, 'MANIFEST_ID_DUPLICATE', `${path}.id`, `duplicate source id: ${id}`);
    ids.add(id);
    if (!String(source?.slice || '').trim()) issue(errors, 'MANIFEST_SLICE_MISSING', `${path}.slice`, 'slice is required');
    if (!String(source?.entity || '').trim()) issue(errors, 'MANIFEST_ENTITY_MISSING', `${path}.entity`, 'entity is required');
    if (!SOURCE_KINDS.has(source?.sourceKind)) issue(errors, 'MANIFEST_SOURCE_KIND_INVALID', `${path}.sourceKind`, 'sourceKind is unsupported');
    if (!SOURCE_STATUSES.has(source?.status)) issue(errors, 'MANIFEST_STATUS_INVALID', `${path}.status`, 'status is unsupported');
    let url;
    try {
      url = new URL(source?.entryUrl);
      if (url.protocol !== 'https:') throw new Error('not HTTPS');
    } catch {
      issue(errors, 'MANIFEST_URL_INVALID', `${path}.entryUrl`, 'entryUrl must be a valid HTTPS URL');
    }
    const allowedHosts = new Set((source?.allowedHosts || []).map((host) => String(host).toLowerCase()));
    if (allowedHosts.size === 0) issue(errors, 'MANIFEST_HOSTS_MISSING', `${path}.allowedHosts`, 'allowedHosts is required');
    else if (url && !allowedHosts.has(url.hostname.toLowerCase())) {
      issue(errors, 'MANIFEST_HOST_NOT_ALLOWLISTED', `${path}.entryUrl`, 'entry URL host is not allowlisted');
    }
  });
  return {
    errors,
    counts: {
      sources: manifest.sources.length,
      active: manifest.sources.filter((source) => source.status === 'active').length,
      discovery: manifest.sources.filter((source) => source.status === 'discovery').length,
    },
  };
}

function valuePresent(value) {
  return (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim().length > 0);
}

export function validateResearchLedger(ledger, manifest, { now = new Date() } = {}) {
  const errors = [];
  validateCommonDocument(ledger, errors, 'ledger', now);
  const manifestResult = validateSourceManifest(manifest, { now });
  errors.push(...manifestResult.errors.map((error) => ({ ...error, path: `manifest.${error.path}` })));
  const sources = new Map((manifest?.sources || []).map((source) => [source.id, source]));
  if (!Array.isArray(ledger?.records)) {
    issue(errors, 'LEDGER_RECORDS_INVALID', 'records', 'records must be an array');
    return { errors, counts: { records: 0, verified: 0, estimates: 0, unavailable: 0 } };
  }
  const ids = new Set();
  ledger.records.forEach((record, index) => {
    const path = `records[${index}]`;
    const id = String(record?.id || '').trim();
    if (!id) issue(errors, 'LEDGER_ID_MISSING', `${path}.id`, 'record id is required');
    else if (ids.has(id)) issue(errors, 'LEDGER_ID_DUPLICATE', `${path}.id`, `duplicate record id: ${id}`);
    ids.add(id);
    for (const field of ['entity', 'metric', 'unit', 'methodology']) {
      if (!String(record?.[field] || '').trim()) issue(errors, `LEDGER_${field.toUpperCase()}_MISSING`, `${path}.${field}`, `${field} is required`);
    }
    const source = sources.get(record?.sourceId);
    if (!source) issue(errors, 'LEDGER_SOURCE_UNREGISTERED', `${path}.sourceId`, 'sourceId is not registered');
    else if (record.sourceKind !== source.sourceKind) {
      issue(errors, 'LEDGER_SOURCE_KIND_MISMATCH', `${path}.sourceKind`, 'record sourceKind does not match the source manifest');
    }
    const asOf = validDate(record?.asOf);
    if (!asOf) issue(errors, 'LEDGER_DATE_INVALID', `${path}.asOf`, 'asOf must be YYYY-MM-DD');
    else if (asOf > shanghaiDate(now)) issue(errors, 'LEDGER_DATE_FUTURE', `${path}.asOf`, 'asOf is in the future');
    const retrievedAt = asIso(record?.retrievedAt);
    if (!retrievedAt) issue(errors, 'LEDGER_RETRIEVED_AT_INVALID', `${path}.retrievedAt`, 'retrievedAt must be a valid ISO timestamp');
    else if (Date.parse(retrievedAt) > now.getTime()) issue(errors, 'LEDGER_DATE_FUTURE', `${path}.retrievedAt`, 'retrievedAt is in the future');
    const verification = record?.verification;
    if (!VERIFICATION_STATUSES.has(verification?.status)) {
      issue(errors, 'LEDGER_VERIFICATION_INVALID', `${path}.verification.status`, 'verification status is unsupported');
    }
    if (!asIso(verification?.checkedAt)) {
      issue(errors, 'LEDGER_CHECKED_AT_INVALID', `${path}.verification.checkedAt`, 'checkedAt must be a valid ISO timestamp');
    }
    if (!valuePresent(record?.value) && verification?.status !== 'unavailable') {
      issue(errors, 'LEDGER_VALUE_MISSING', `${path}.value`, 'value is required unless the record documents unavailable coverage');
    }
    if (verification?.status === 'unavailable' && !String(verification?.note || '').trim()) {
      issue(errors, 'LEDGER_UNAVAILABLE_NOTE_MISSING', `${path}.verification.note`, 'unavailable coverage requires an explanatory note');
    }
    let url;
    try {
      url = new URL(record?.sourceUrl);
      if (url.protocol !== 'https:') throw new Error('not HTTPS');
    } catch {
      issue(errors, 'LEDGER_URL_INVALID', `${path}.sourceUrl`, 'sourceUrl must be a valid HTTPS URL');
    }
    if (url) {
      const host = url.hostname.toLowerCase();
      if (MEDIA_HOSTS.has(host)) issue(errors, 'LEDGER_MEDIA_SOURCE', `${path}.sourceUrl`, 'media reports cannot be used as metric evidence');
      if (source && !(source.allowedHosts || []).map((item) => item.toLowerCase()).includes(host)) {
        issue(errors, 'LEDGER_HOST_NOT_ALLOWLISTED', `${path}.sourceUrl`, 'sourceUrl host is outside the registered allowlist');
      }
    }
    if (record?.sourceId === 'yipit-ai-revenue'
      && (record?.sourceKind !== 'estimate' || verification?.status !== 'user-confirmed-estimate')) {
      issue(errors, 'LEDGER_YIPIT_KIND', path, 'Yipit values must remain user-confirmed estimates');
    }
  });
  return {
    errors,
    counts: {
      records: ledger.records.length,
      verified: ledger.records.filter((record) => record.verification?.status === 'verified').length,
      estimates: ledger.records.filter((record) => record.verification?.status === 'user-confirmed-estimate').length,
      unavailable: ledger.records.filter((record) => record.verification?.status === 'unavailable').length,
    },
  };
}
