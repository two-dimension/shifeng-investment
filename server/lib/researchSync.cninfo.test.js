import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'research-cninfo-direct-'));
const dataRoot = path.join(tempRoot, 'data');
const reportsRoot = path.join(tempRoot, 'reports');
const cninfoRoot = path.join(tempRoot, 'cninfo-import');
const earningsRoot = path.join(tempRoot, 'earnings-import');
const earningsReportRoot = path.join(tempRoot, 'earnings-report-import');
const riskRoot = path.join(tempRoot, 'risk-import');
const fundsFile = path.join(tempRoot, 'funds.json');

process.env.RESEARCH_DATA_DIR = dataRoot;
process.env.RESEARCH_REPORTS_DIR = reportsRoot;
process.env.CNINFO_OUTPUT_DIR = cninfoRoot;
process.env.EARNINGS_OUTPUT_DIR = earningsRoot;
process.env.EARNINGS_REPORT_OUTPUT_DIR = earningsReportRoot;
process.env.RISK_OUTPUT_DIR = riskRoot;

const { getResearchSourceStatus, syncResearch } = await import('./researchSync.js');

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.RESEARCH_DATA_DIR;
  delete process.env.RESEARCH_REPORTS_DIR;
  delete process.env.CNINFO_OUTPUT_DIR;
  delete process.env.EARNINGS_OUTPUT_DIR;
  delete process.env.EARNINGS_REPORT_OUTPUT_DIR;
  delete process.env.RISK_OUTPUT_DIR;
});

beforeEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });
});

function writeFunds() {
  fs.writeFileSync(fundsFile, JSON.stringify({ funds: [{
    name: '小金属',
    positions: [{ code: '600497', name: '驰宏锌锗', shares: 100 }],
  }] }));
}

function announcement(secCode, announcementTitle) {
  return {
    announcementId: `${secCode}-fixture`,
    secCode,
    secName: '驰宏锌锗',
    announcementTitle,
    announcementTime: Date.parse('2026-08-20T09:30:00.000Z'),
    adjunctUrl: 'https://static.cninfo.com.cn/fixture.pdf',
    adjunctType: 'PDF',
  };
}

function marketDay(date, announcements = []) {
  return { date, totalCount: announcements.length ? 2492 : 0, columns: [], announcements };
}

test('cninfo sync uses the official source when legacy artifacts are absent', async () => {
  writeFunds();

  const result = await syncResearch({ kind: 'cninfo', date: '2026-08-20' }, {
    fundsFile,
    fetchCninfoMarketDayImpl: async () => marketDay('2026-08-20', [
      announcement('600497', '关于股东增持股份的公告'),
    ]),
  });

  assert.equal(result.success, true);
  assert.equal(result.totals.attempted, 1);
  assert.equal(result.results[0].source, 'cninfo-direct');
  assert.equal(result.results[0].fetched, 1);
  assert.equal(result.results[0].matched, 1);
  assert.equal(result.results[0].totalCount, 2492);
  const cached = JSON.parse(fs.readFileSync(path.join(dataRoot, 'cninfo', '2026-08-20.json')));
  assert.equal(cached.topGood[0].code, '600497');
  assert.deepEqual(cached.files, []);
});

test('failed official refresh leaves the previous cached summary unchanged', async () => {
  const target = path.join(dataRoot, 'cninfo', '2026-08-20.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ kind: 'cninfo', date: '2026-08-20', totalCount: 7 }));

  const result = await syncResearch({ kind: 'cninfo', date: '2026-08-20' }, {
    fundsFile,
    fetchCninfoMarketDayImpl: async () => { throw new Error('CNINFO upstream unavailable'); },
  });

  assert.equal(result.success, false);
  assert.match(result.results[0].error, /upstream unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(target)).totalCount, 7);
});

test('cninfo automatic sync tries Shanghai weekdays newest-first and skips empty days', async () => {
  writeFunds();
  const requestedDates = [];

  const result = await syncResearch({ kind: 'cninfo' }, {
    fundsFile,
    now: new Date('2026-08-23T04:00:00.000Z'),
    fetchCninfoMarketDayImpl: async ({ date }) => {
      requestedDates.push(date);
      if (date === '2026-08-21') return marketDay(date);
      return marketDay(date, [announcement('600497', '关于股东增持股份的公告')]);
    },
  });

  assert.deepEqual(requestedDates, ['2026-08-21', '2026-08-20']);
  assert.equal(result.success, true);
  assert.equal(result.totals.attempted, 1);
  assert.equal(result.results[0].date, '2026-08-20');
  assert.equal(result.results[0].source, 'cninfo-direct');
});

test('a requested import-only kind without available source dates reports zero attempts', async () => {
  const result = await syncResearch({ kind: 'earnings' });

  assert.deepEqual(result, {
    success: false,
    error: '未找到可同步的 earnings 数据源',
    totals: {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      changedDates: 0,
      filesCopied: 0,
      filesSkipped: 0,
    },
    results: [],
  });
});

test('all sync remains successful when direct cninfo succeeds without imported sources', async () => {
  writeFunds();

  const result = await syncResearch({ kind: 'all' }, {
    fundsFile,
    now: new Date('2026-08-23T04:00:00.000Z'),
    fetchCninfoMarketDayImpl: async ({ date }) => marketDay(date, [
      announcement('600497', '关于股东增持股份的公告'),
    ]),
  });

  assert.equal(result.success, true);
  assert.equal(result.totals.attempted, 1);
  assert.equal(result.results[0].source, 'cninfo-direct');
});

test('cninfo source status exposes the direct official endpoint', () => {
  assert.deepEqual(getResearchSourceStatus().cninfo.direct, {
    enabled: true,
    endpoint: 'https://www.cninfo.com.cn/new/hisAnnouncement/query',
    markets: ['sse', 'szse'],
  });
});
