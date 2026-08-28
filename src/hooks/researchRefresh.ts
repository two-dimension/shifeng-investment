import type {
  ResearchRefreshRequestResult,
  ResearchRefreshState,
  ResearchRefreshStatus,
} from '../types/research.ts';

export type ResearchRefreshFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface PollOptions {
  signal?: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const REFRESH_STATUSES = new Set<ResearchRefreshStatus>([
  'idle',
  'queued',
  'running',
  'success',
  'failed',
]);

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isRefreshState(value: unknown): value is ResearchRefreshState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.scope === 'all'
    && isNullableString(record.jobId)
    && typeof record.status === 'string'
    && REFRESH_STATUSES.has(record.status as ResearchRefreshStatus)
    && isNullableString(record.requestedAt)
    && isNullableString(record.startedAt)
    && isNullableString(record.finishedAt)
    && isNullableString(record.lastSuccessAt)
    && isNullableString(record.lastError);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error('云端更新返回格式不正确');
  }
}

async function requireOkJson(response: Response): Promise<unknown> {
  const payload = await readJson(response);
  if (!response.ok) {
    const message = payload && typeof payload === 'object'
      ? Reflect.get(payload, 'error')
      : null;
    throw new Error(typeof message === 'string' && message ? message : `云端更新失败: HTTP ${response.status}`);
  }
  return payload;
}

function defaultWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const handleAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export async function requestResearchRefresh(
  fetcher: ResearchRefreshFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResearchRefreshRequestResult> {
  throwIfAborted(signal);
  const payload = await requireOkJson(await fetcher('/api/research/refresh', {
    method: 'POST',
    signal,
  }));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('云端更新返回格式不正确');
  }
  const dispatched = Reflect.get(payload, 'dispatched');
  const state = Reflect.get(payload, 'state');
  if (typeof dispatched !== 'boolean' || !isRefreshState(state)) {
    throw new Error('云端更新返回格式不正确');
  }
  return { dispatched, state };
}

export async function pollResearchRefresh(
  fetcher: ResearchRefreshFetcher = fetch,
  {
    signal,
    intervalMs = 4_000,
    timeoutMs = 50 * 60 * 1_000,
    now = Date.now,
    wait = defaultWait,
  }: PollOptions = {},
): Promise<ResearchRefreshState> {
  const startedAt = now();
  while (true) {
    throwIfAborted(signal);
    if (now() - startedAt >= timeoutMs) throw new Error('等待云端更新超时，请稍后再试');

    const payload = await requireOkJson(await fetcher('/api/research/refresh/status', {
      method: 'GET',
      signal,
    }));
    if (!isRefreshState(payload)) throw new Error('云端更新返回格式不正确');
    if (payload.status !== 'queued' && payload.status !== 'running') return payload;
    await wait(intervalMs, signal);
  }
}

export function keepCachedResearchData<T>(data: T | null, error: unknown): {
  data: T | null;
  loading: false;
  error: string;
} {
  return {
    data,
    loading: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
