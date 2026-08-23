import assert from 'node:assert/strict';
import test from 'node:test';
import { describeResearchSyncResult } from '../src/pages/Research/researchSyncClient.ts';

test('describeResearchSyncResult does not call zero attempts a success', () => {
  assert.deepEqual(describeResearchSyncResult({
    success: false,
    error: '未找到可同步的 earnings 数据源',
    totals: { attempted: 0, succeeded: 0, failed: 0, changedDates: 0, filesCopied: 0, filesSkipped: 0 },
    results: [],
  }), {
    level: 'error',
    text: '未找到可同步的 earnings 数据源',
  });
});

test('describeResearchSyncResult surfaces the first failed date reason', () => {
  assert.deepEqual(describeResearchSyncResult({
    success: false,
    totals: { attempted: 1, succeeded: 0, failed: 1, changedDates: 0, filesCopied: 0, filesSkipped: 0 },
    results: [{ kind: 'cninfo', date: '2026-08-20', success: false, error: '巨潮资讯暂时不可用' }],
  }), {
    level: 'error',
    text: '巨潮资讯暂时不可用',
  });
});

test('describeResearchSyncResult reports fetched and matched direct announcements', () => {
  assert.deepEqual(describeResearchSyncResult({
    success: true,
    totals: { attempted: 1, succeeded: 1, failed: 0, changedDates: 1, filesCopied: 0, filesSkipped: 0 },
    results: [{ kind: 'cninfo', date: '2026-08-20', success: true, source: 'cninfo-direct', fetched: 4021, matched: 18 }],
  }), {
    level: 'success',
    text: '公告已更新：抓取 4,021 条，持仓命中 18 条',
  });
});
