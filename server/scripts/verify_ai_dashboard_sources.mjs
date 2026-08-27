import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildAiDashboardSourceManifest,
  validateResearchLedger,
  validateSourceManifest,
} from '../lib/sourceLedgerValidation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../data/ai-dashboard');
const MANIFEST_FILE = path.join(DATA_DIR, 'source-manifest.json');
const LEDGER_FILE = path.join(DATA_DIR, 'research-ledger.json');

function jsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function manifestDrift(manifest, expected) {
  const current = new Map((manifest?.sources || []).map((source) => [source.id, source]));
  const desired = new Map((expected?.sources || []).map((source) => [source.id, source]));
  const errors = [];
  for (const [id, source] of desired) {
    if (!current.has(id)) errors.push({ code: 'MANIFEST_REGISTERED_SOURCE_MISSING', path: `sources.${id}`, message: 'registered source is missing' });
    else if (JSON.stringify(current.get(id)) !== JSON.stringify(source)) {
      errors.push({ code: 'MANIFEST_REGISTERED_SOURCE_DRIFT', path: `sources.${id}`, message: 'registered source metadata has drifted' });
    }
  }
  for (const id of current.keys()) {
    if (!desired.has(id)) errors.push({ code: 'MANIFEST_UNKNOWN_SOURCE', path: `sources.${id}`, message: 'manifest source is no longer registered' });
  }
  return errors;
}

export async function verifyLiveSource(source, { fetchImpl = fetch, timeoutMs = 12_000, maxRedirects = 3 } = {}) {
  const allowedHosts = new Set(source.allowedHosts.map((host) => String(host).toLowerCase()));
  let url = new URL(source.entryUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    for (let redirect = 0; ; redirect += 1) {
      if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase())) {
        throw new Error('live URL is outside the registered HTTPS allowlist');
      }
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'Shifeng-AI-Dashboard-Source-Verification/2.0 contact=dashboard-owner' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect >= maxRedirects) throw new Error(`too many redirects (max ${maxRedirects})`);
        const location = response.headers.get('location');
        if (!location) throw new Error('redirect is missing location');
        url = new URL(location, url);
        continue;
      }
      await response.body?.cancel();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { id: source.id, status: 'ready', finalUrl: url.toString() };
    }
  } catch (error) {
    return { id: source.id, status: 'error', finalUrl: url.toString(), message: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function printErrors(errors) {
  for (const error of errors) process.stderr.write(`${error.code} ${error.path}: ${error.message}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const generatedAt = new Date().toISOString();
  const expected = buildAiDashboardSourceManifest({ generatedAt });
  if (argv.includes('--write-manifest')) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(expected, null, 2)}\n`);
  }
  const manifest = jsonFile(MANIFEST_FILE);
  const ledger = jsonFile(LEDGER_FILE);
  const now = new Date();
  const manifestResult = validateSourceManifest(manifest, { now });
  const ledgerResult = validateResearchLedger(ledger, manifest, { now });
  const drift = manifestDrift(manifest, { ...expected, generatedAt: manifest.generatedAt });
  const errors = [...manifestResult.errors, ...ledgerResult.errors, ...drift];
  if (errors.length > 0) {
    printErrors(errors);
    process.exitCode = 1;
    return { errors, live: [] };
  }

  let live = [];
  if (argv.includes('--live')) {
    const requestedIds = argv.filter((arg) => arg.startsWith('--source=')).map((arg) => arg.slice('--source='.length));
    const sources = manifest.sources.filter((source) => source.status === 'active'
      && (requestedIds.length === 0 || requestedIds.includes(source.id)));
    live = await mapLimit(sources, 4, (source) => verifyLiveSource(source));
    for (const result of live) {
      const stream = result.status === 'ready' ? process.stdout : process.stderr;
      stream.write(`${result.status === 'ready' ? 'OK' : 'FAIL'} ${result.id}${result.message ? `: ${result.message}` : ''}\n`);
    }
    if (live.some((result) => result.status === 'error')) process.exitCode = 1;
  }
  process.stdout.write(`AI source verification passed: ${manifestResult.counts.sources} sources, ${ledgerResult.counts.records} ledger records.\n`);
  return { errors: [], live };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
