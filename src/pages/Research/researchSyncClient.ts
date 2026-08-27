import type { ResearchKind } from '../../types/research';

export interface ResearchSyncResult {
  kind: ResearchKind;
  date: string;
  success: boolean;
  error?: string;
  source?: string;
  fetched?: number;
  matched?: number;
}

export interface ResearchSyncResponse {
  success: boolean;
  error?: string;
  totals?: {
    attempted: number;
    succeeded: number;
    failed: number;
    changedDates: number;
    filesCopied: number;
    filesSkipped: number;
  };
  results?: ResearchSyncResult[];
}

export async function postResearchSync(
  kind: ResearchKind,
  date: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ResearchSyncResponse> {
  const res = await fetchImpl('/api/research/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind,
      date: date || undefined,
      days: date ? undefined : 14,
      force: false,
    }),
  });
  const payload = await res.json().catch(() => ({})) as ResearchSyncResponse;
  if (!res.ok) {
    throw new Error(payload.error || `同步失败: HTTP ${res.status}`);
  }
  return payload;
}

export function describeResearchSyncResult(
  result: ResearchSyncResponse,
): { level: 'success' | 'warning' | 'error'; text: string } {
  if (result.error) {
    return { level: 'error', text: result.error };
  }

  const failedResult = result.results?.find((item) => !item.success && item.error);
  if (failedResult?.error) {
    return { level: 'error', text: failedResult.error };
  }

  const totals = result.totals;
  if (totals?.attempted === 0) {
    return { level: 'error', text: '未找到可同步来源' };
  }

  const directAnnouncement = result.results?.find(
    (item) => item.kind === 'cninfo' && item.success && item.source === 'cninfo-direct',
  );
  if (directAnnouncement) {
    return {
      level: 'success',
      text: `公告已更新：抓取 ${(directAnnouncement.fetched ?? 0).toLocaleString('zh-CN')} 条，持仓命中 ${(directAnnouncement.matched ?? 0).toLocaleString('zh-CN')} 条`,
    };
  }

  if (totals?.failed) {
    return { level: 'warning', text: `同步完成，但有 ${totals.failed} 个日期失败` };
  }

  return {
    level: 'success',
    text: totals
      ? `同步完成：更新 ${totals.changedDates} 天，复制 ${totals.filesCopied} 个文件`
      : '同步完成',
  };
}
