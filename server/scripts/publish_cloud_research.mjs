import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const MAX_ATTEMPTS = 3;
const FILE_CONCURRENCY = 3;

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CLOUD_RESEARCH_BASE_URL must be a valid URL');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('CLOUD_RESEARCH_BASE_URL must be an HTTP(S) origin without credentials');
  }
  return url.origin;
}

function endpoint(baseUrl, pathname) {
  return new URL(pathname, `${validateBaseUrl(baseUrl)}/`).href;
}

function authHeaders(token, extra = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('RESEARCH_PUBLISH_TOKEN is required');
  }
  return { Authorization: `Bearer ${token}`, ...extra };
}

function retryableStatus(status) {
  return status === 429 || status >= 500;
}

async function requestWithRetry({
  url,
  makeInit,
  fetchImpl,
  retryDelay,
  maxAttempts = MAX_ATTEMPTS,
}) {
  let response;
  let method = 'REQUEST';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const init = makeInit();
    method = init.method || method;
    response = await fetchImpl(url, init);
    if (response.ok) return response;
    if (!retryableStatus(response.status) || attempt === maxAttempts) break;
    await retryDelay(250 * (2 ** (attempt - 1)));
  }
  const requestPath = new URL(url).pathname;
  throw new Error(`HTTP ${response?.status ?? 'network-error'} for ${method} ${requestPath}`);
}

function defaultRetryDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function updateRefreshState({
  baseUrl,
  token,
  jobId,
  status,
  error,
  fetchImpl,
  retryDelay,
}) {
  const body = { jobId, status };
  if (status === 'failed') body.error = String(error || 'Research refresh failed').slice(0, 1000);
  return requestWithRetry({
    url: endpoint(baseUrl, '/api/research/internal/refresh-state'),
    makeInit: () => ({
      method: 'POST',
      headers: authHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }),
    fetchImpl,
    retryDelay,
  });
}

async function uploadFile({ baseUrl, token, file, fetchImpl, retryDelay }) {
  const stat = await fs.promises.stat(file.path);
  if (!stat.isFile()) throw new Error(`report is not a file: ${file.filename}`);
  const pathname = [
    '/api/research/internal/files',
    encodeURIComponent(file.kind),
    encodeURIComponent(file.date),
    encodeURIComponent(file.filename),
  ].join('/');
  return requestWithRetry({
    url: endpoint(baseUrl, pathname),
    makeInit: () => ({
      method: 'PUT',
      headers: authHeaders(token, {
        'Content-Type': file.type === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/pdf',
        'Content-Length': String(stat.size),
      }),
      body: fs.createReadStream(file.path),
      duplex: 'half',
    }),
    fetchImpl,
    retryDelay,
  });
}

async function uploadSummary({ baseUrl, token, summary, fetchImpl, retryDelay }) {
  const pathname = [
    '/api/research/internal/summaries',
    encodeURIComponent(summary.kind),
    encodeURIComponent(summary.date),
  ].join('/');
  return requestWithRetry({
    url: endpoint(baseUrl, pathname),
    makeInit: () => ({
      method: 'PUT',
      headers: authHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(summary),
    }),
    fetchImpl,
    retryDelay,
  });
}

async function mapWithConcurrency(items, limit, mapper) {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('cloud research manifest must be an object');
  }
  if (typeof manifest.jobId !== 'string' || manifest.jobId.length === 0 || manifest.jobId.length > 128) {
    throw new Error('cloud research manifest has an invalid jobId');
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.summaries)) {
    throw new Error('cloud research manifest must contain files and summaries arrays');
  }
}

export async function markResearchFailed({
  jobId,
  error,
  baseUrl,
  token,
  fetchImpl = fetch,
  retryDelay = defaultRetryDelay,
}) {
  return updateRefreshState({
    baseUrl,
    token,
    jobId,
    status: 'failed',
    error,
    fetchImpl,
    retryDelay,
  });
}

export async function publishResearchManifest({
  manifest,
  baseUrl,
  token,
  fetchImpl = fetch,
  retryDelay = defaultRetryDelay,
}) {
  validateManifest(manifest);
  const shared = { baseUrl, token, fetchImpl, retryDelay };
  try {
    await updateRefreshState({ ...shared, jobId: manifest.jobId, status: 'running' });
    await mapWithConcurrency(
      manifest.files,
      FILE_CONCURRENCY,
      (file) => uploadFile({ ...shared, file }),
    );
    for (const summary of manifest.summaries) {
      await uploadSummary({ ...shared, summary });
    }
    await updateRefreshState({ ...shared, jobId: manifest.jobId, status: 'success' });
  } catch (error) {
    try {
      await markResearchFailed({
        ...shared,
        jobId: manifest.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (stateError) {
      process.stderr.write(
        `[cloud-research] unable to record failed state: ${stateError instanceof Error ? stateError.message : String(stateError)}\n`,
      );
    }
    throw error;
  }
}

async function main() {
  const baseUrl = process.env.CLOUD_RESEARCH_BASE_URL;
  const token = process.env.RESEARCH_PUBLISH_TOKEN;
  if (process.argv.includes('--mark-failed')) {
    const jobId = process.env.RESEARCH_JOB_ID || process.env.GITHUB_RUN_ID;
    if (!jobId) throw new Error('RESEARCH_JOB_ID is required to mark a failed job');
    await markResearchFailed({
      jobId,
      error: process.env.RESEARCH_FAILURE_MESSAGE || 'GitHub Actions research task failed',
      baseUrl,
      token,
    });
    process.stdout.write(`[cloud-research] marked failed job=${jobId}\n`);
    return;
  }

  const manifestPath = process.env.CLOUD_RESEARCH_MANIFEST_PATH
    || path.join(REPO_ROOT, 'cloud-research-manifest.json');
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  await publishResearchManifest({ manifest, baseUrl, token });
  process.stdout.write(
    `[cloud-research] published job=${manifest.jobId} summaries=${manifest.summaries.length} files=${manifest.files.length}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[cloud-research] publish failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
