import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPortfolioUniverse,
  buildDirectCninfoSummary,
  classifyAnnouncementTitle,
} from './announcementJudgement.js';

function announcement({ id, code, title, time }) {
  return {
    announcementId: id,
    secCode: code,
    secName: '驰宏锌锗',
    announcementTitle: title,
    announcementTime: time,
    adjunctUrl: `https://static.cninfo.com.cn/finalpage/${id}.PDF`,
    adjunctType: 'PDF',
  };
}

test('buildPortfolioUniverse keeps positive A-share positions and combines fund labels', () => {
  const universe = buildPortfolioUniverse({ funds: [
    { name: '小金属', positions: [
      { code: '600497', name: '驰宏锌锗', shares: 100 },
      { code: 'AAPL', name: 'Apple', shares: 10 },
    ] },
    { name: '资源股', positions: [
      { code: '600497', name: '驰宏锌锗', shares: 20 },
      { code: '000001', name: '平安银行', shares: 0 },
    ] },
  ] });

  assert.deepEqual(universe.get('600497'), {
    code: '600497', name: '驰宏锌锗', subsets: ['小金属', '资源股'],
  });
  assert.equal(universe.has('AAPL'), false);
  assert.equal(universe.has('000001'), false);
});

test('classifyAnnouncementTitle reports matched rules without pretending to read the body', () => {
  assert.deepEqual(classifyAnnouncementTitle('关于收到行政处罚决定书的公告'), {
    score: -6,
    direction: 'bad',
    matchedRules: ['行政处罚'],
  });
  assert.deepEqual(classifyAnnouncementTitle('关于签订重大合同的公告'), {
    score: 5,
    direction: 'good',
    matchedRules: ['重大合同'],
  });
  assert.deepEqual(classifyAnnouncementTitle('2026年第一次临时股东大会决议公告'), {
    score: 0,
    direction: 'neutral',
    matchedRules: [],
  });
});

test('buildDirectCninfoSummary aggregates portfolio companies and keeps market totals', () => {
  const universe = new Map([['600497', {
    code: '600497', name: '驰宏锌锗', subsets: ['小金属', '资源股'],
  }]]);
  const summary = buildDirectCninfoSummary({
    date: '2026-08-20',
    totalCount: 2492,
    generatedAt: '2026-08-20T15:00:00.000Z',
    universe,
    announcements: [
      announcement({ id: 'a1', code: '600497', title: '关于股东增持股份的公告', time: 1787220000000 }),
      announcement({ id: 'a2', code: '600497', title: '2026年第一次临时股东大会决议公告', time: 1787221000000 }),
      announcement({ id: 'a3', code: '000001', title: '关于股份回购的公告', time: 1787222000000 }),
    ],
  });

  assert.equal(summary.totalCount, 2492);
  assert.equal(summary.watchlistHits, 2);
  assert.equal(summary.topGood.length, 1);
  assert.equal(summary.topGood[0].annCount, 2);
  assert.equal(summary.topGood[0].subset, '小金属；资源股');
  assert.match(summary.topGood[0].summary, /标题规则：股东增持/);
  assert.doesNotMatch(summary.topGood[0].summary, /正文/);
  assert.equal(summary.topGood[0].url, 'https://static.cninfo.com.cn/finalpage/a1.PDF');
  assert.equal(summary.stats.neutralFiltered, 1);
});

test('buildDirectCninfoSummary preserves the main announcement time on the research entry', () => {
  const universe = new Map([['600497', {
    code: '600497', name: '驰宏锌锗', subsets: ['小金属'],
  }]]);
  const summary = buildDirectCninfoSummary({
    date: '2026-08-20',
    totalCount: 1,
    generatedAt: '2026-08-20T15:00:00.000Z',
    universe,
    announcements: [
      announcement({ id: 'timed', code: '600497', title: '关于股东增持股份的公告', time: 1787220000000 }),
    ],
  });

  assert.equal(summary.topGood[0].time, '2026-08-20T10:00:00.000Z');
});
