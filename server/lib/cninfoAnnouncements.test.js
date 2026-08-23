import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchCninfoMarketDay } from './cninfoAnnouncements.js';

function announcement(id, secCode) {
  return {
    secCode: `${secCode},${secCode}`,
    secName: '<b>测试公司</b>',
    announcementId: id,
    announcementTitle: '<span>公告标题</span>',
    announcementTime: 1_755_648_000_000,
    adjunctUrl: `/finalpage/2026-08-20/${id}.PDF`,
    adjunctType: 'PDF',
    pageColumn: 'szse',
    announcementType: 'A',
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function createPagedFetch(pages) {
  return async (_url, options) => {
    const pageNum = Number(options.body.get('pageNum'));
    const column = options.body.get('column');
    const rows = pages[column][pageNum - 1] ?? [];
    const totalRecordNum = pages[column].flat().length;
    return response({ totalRecordNum, totalAnnouncement: totalRecordNum, announcements: rows });
  };
}

test('fetchCninfoMarketDay reads every Shanghai and Shenzhen page and removes duplicate ids', async () => {
  const result = await fetchCninfoMarketDay({
    date: '2026-08-20',
    pageSize: 2,
    attempts: 1,
    fetchImpl: createPagedFetch({
      szse: [
        [announcement('sz-1', '000001'), announcement('shared', '000002')],
        [announcement('shared', '000002')],
      ],
      sse: [[announcement('sh-1', '600000')]],
    }),
  });

  assert.equal(result.totalCount, 4);
  assert.deepEqual(result.announcements.map((item) => item.announcementId), [
    'sh-1', 'sz-1', 'shared',
  ]);
  assert.deepEqual(result.columns, [
    { column: 'sse', totalCount: 1, pages: 1 },
    { column: 'szse', totalCount: 3, pages: 2 },
  ]);
});

test('fetchCninfoMarketDay retries 503 and returns the later valid response', async () => {
  let calls = 0;
  const result = await fetchCninfoMarketDay({
    date: '2026-08-20',
    columns: ['szse'],
    attempts: 2,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return response({}, 503);
      return response({ totalRecordNum: 1, totalAnnouncement: 1, announcements: [announcement('a-1', '000001')] });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.announcements.length, 1);
});

test('fetchCninfoMarketDay rejects an incomplete final page', async () => {
  await assert.rejects(
    fetchCninfoMarketDay({
      date: '2026-08-20',
      columns: ['szse'],
      pageSize: 2,
      attempts: 1,
      fetchImpl: async () => response({ totalRecordNum: 2, totalAnnouncement: 2, announcements: [] }),
    }),
    /incomplete CNINFO response/,
  );
});
