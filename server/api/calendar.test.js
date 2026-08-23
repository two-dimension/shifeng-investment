import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createCalendarRouter } from './calendar.js';
import {
  refreshCalendar,
  refreshEarningsHubCalendar,
  refreshNbsMacroCalendar,
} from '../lib/calendarRefresh.js';
import {
  CalendarDataError,
  buildUsSubsetIndex,
  canonicalizeUsCompanySymbol,
  enrichEventsWithSubsetHits,
  normalizeCalendarEvent,
  normalizeUsSymbol,
  readCalendarStore,
  validateCalendarRange,
} from '../lib/calendarStore.js';

const NOW = '2026-07-13T06:00:00.000Z';
const TEST_FUNDS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'funds.json',
);

function source(name, sourceId) {
  return {
    name,
    sourceId,
    url: name === 'earningshub'
      ? 'https://earningshub.com/earnings-calendar/this-week'
      : 'https://rili.jin10.com/',
    fetchedAt: NOW,
  };
}

function earningsEvent({ id, symbol, date, startAt, importance = 5 }) {
  return {
    id,
    kind: 'us_earnings',
    title: `${symbol} earnings`,
    region: 'US',
    date,
    startAt,
    timezone: 'America/New_York',
    timePrecision: 'exact',
    importance,
    status: 'confirmed',
    earnings: { symbol, period: 'Q2', session: 'before_market' },
    source: source('earningshub', id),
  };
}

async function writeFixtureStore(dir, events) {
  const dataFile = path.join(dir, 'events.json');
  await fs.promises.writeFile(dataFile, JSON.stringify({
    schemaVersion: 1,
    updatedAt: NOW,
    sources: {
      jin10: { status: 'authorization_required', updatedAt: null },
      earningshub: { status: 'authorization_required', updatedAt: null },
      wechat: { status: 'manual_import', updatedAt: null },
    },
    events,
  }), 'utf8');
  return dataFile;
}

async function writeManualCalendarFixture(dir, events) {
  const manualFile = path.join(dir, 'manual-events.json');
  await fs.promises.writeFile(manualFile, JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-08-23T11:00:00.000Z',
    sources: {
      jin10: {
        status: 'manual_import',
        updatedAt: '2026-08-23T11:00:00.000Z',
        message: '通过已登录金十网页人工核验并导入快照',
      },
      wechat: {
        status: 'manual_import',
        updatedAt: '2026-08-22T12:28:00.000Z',
        message: '根据 A 股投资日历 PDF 人工导入题材快照',
      },
    },
    events,
  }), 'utf8');
  return manualFile;
}

async function writeFixtureFunds(dir, symbols) {
  const fundsFile = path.join(dir, 'funds.json');
  await fs.promises.writeFile(fundsFile, JSON.stringify({
    funds: [{
      id: 'us-watchlist',
      name: '美股关注',
      market: 'us',
      positions: symbols.map((symbol) => ({ code: symbol, name: symbol })),
    }],
    lastUpdated: new Date().toISOString(),
  }), 'utf8');
  return fundsFile;
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('validateCalendarRange rejects invalid and excessive ranges', () => {
  assert.deepEqual(validateCalendarRange('2026-07-13', '2026-07-19'), {
    start: '2026-07-13',
    end: '2026-07-19',
    days: 7,
  });
  assert.throws(() => validateCalendarRange('2026-02-30', '2026-03-01'), CalendarDataError);
  assert.throws(() => validateCalendarRange('2026-07-20', '2026-07-19'), CalendarDataError);
  assert.throws(() => validateCalendarRange('2026-01-01', '2027-01-02'), CalendarDataError);
});

test('calendar source status identifies company IR as manual verification', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'calendar-source-status-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = await writeFixtureStore(dir, []);
  const raw = JSON.parse(await fs.promises.readFile(dataFile, 'utf8'));
  raw.sources.company_ir = {
    status: 'ready',
    updatedAt: null,
    message: '公司投资者关系或公告页面直接核验',
  };
  await fs.promises.writeFile(dataFile, JSON.stringify(raw), 'utf8');

  const store = await readCalendarStore({ dataFile, fundsFile: TEST_FUNDS_FILE });

  assert.equal(store.sources.company_ir.status, 'manual_import');
  assert.match(store.sources.company_ir.message, /人工核验/);
});

test('tracked manual snapshot merges with runtime data and runtime wins duplicate ids', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'calendar-manual-merge-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = await writeFixtureStore(dir, [{
    id: 'macro-shared',
    kind: 'macro',
    title: '官方已发布数据',
    country: '中国',
    region: 'CN',
    date: '2026-08-24',
    timezone: 'Asia/Shanghai',
    timePrecision: 'date',
    importance: 5,
    status: 'released',
    metrics: { actual: '1.0%' },
    source: {
      name: 'official',
      sourceId: 'macro-shared',
      url: 'https://www.stats.gov.cn/',
      fetchedAt: NOW,
    },
  }]);
  const manualFile = await writeManualCalendarFixture(dir, [
    {
      id: 'macro-shared',
      kind: 'macro',
      title: '人工快照旧值',
      country: '中国',
      region: 'CN',
      date: '2026-08-24',
      timezone: 'Asia/Shanghai',
      timePrecision: 'date',
      importance: 4,
      status: 'confirmed',
      source: source('jin10', 'macro-shared'),
    },
    {
      id: 'jin10-us-consumer-confidence-2026-08-25',
      kind: 'macro',
      title: '美国8月谘商会消费者信心指数',
      country: '美国',
      region: 'US',
      date: '2026-08-25',
      startAt: '2026-08-25T22:00:00+08:00',
      timezone: 'Asia/Shanghai',
      timePrecision: 'exact',
      importance: 3,
      status: 'confirmed',
      metrics: { previous: '90.8', forecast: '90.1' },
      source: {
        name: 'jin10',
        sourceId: '2026-08-25-us-consumer-confidence',
        url: 'https://rili.jin10.com/day/2026-08-25',
        fetchedAt: '2026-08-23T11:00:00.000Z',
      },
    },
    {
      id: 'wechat-hot-chips-2026',
      kind: 'a_share',
      title: 'Hot Chips 2026',
      country: '中国',
      region: 'CN',
      date: '2026-08-23',
      endDate: '2026-08-25',
      timezone: 'Asia/Shanghai',
      timePrecision: 'date',
      importance: 4,
      status: 'confirmed',
      tags: ['AI芯片'],
      source: {
        name: 'wechat',
        sourceId: 'wechat-hot-chips-2026',
        url: 'https://mp.weixin.qq.com/s/EfWIB03udmx42X4UxRhx2g',
        fetchedAt: '2026-08-22T12:28:00.000Z',
      },
    },
  ]);

  const store = await readCalendarStore({
    dataFile,
    manualFile,
    fundsFile: TEST_FUNDS_FILE,
  });
  const byId = new Map(store.events.map((event) => [event.id, event]));

  assert.equal(store.events.length, 3);
  assert.equal(byId.get('macro-shared').title, '官方已发布数据');
  assert.equal(byId.get('macro-shared').source.name, 'official');
  assert.equal(byId.get('jin10-us-consumer-confidence-2026-08-25').country, '美国');
  assert.equal(byId.get('wechat-hot-chips-2026').endDate, '2026-08-25');
  assert.equal(store.sources.jin10.status, 'manual_import');
  assert.equal(store.sources.wechat.status, 'manual_import');
  assert.equal(store.updatedAt, '2026-08-23T11:00:00.000Z');
});

test('manual refresh reports and preserves Jin10 and A-share snapshot coverage', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'calendar-manual-refresh-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = await writeFixtureStore(dir, []);
  const manualFile = await writeManualCalendarFixture(dir, [
    {
      id: 'jin10-us-confidence',
      kind: 'macro',
      title: '美国8月谘商会消费者信心指数',
      country: '美国',
      region: 'US',
      date: '2026-08-25',
      startAt: '2026-08-25T22:00:00+08:00',
      timezone: 'Asia/Shanghai',
      timePrecision: 'exact',
      importance: 3,
      status: 'confirmed',
      source: {
        name: 'jin10',
        sourceId: 'jin10-us-confidence',
        url: 'https://rili.jin10.com/day/2026-08-25',
        fetchedAt: '2026-08-23T11:00:00.000Z',
      },
    },
    {
      id: 'wechat-hot-chips-2026',
      kind: 'a_share',
      title: 'Hot Chips 2026',
      country: '中国',
      region: 'CN',
      date: '2026-08-23',
      endDate: '2026-08-25',
      timezone: 'Asia/Shanghai',
      timePrecision: 'date',
      importance: 4,
      status: 'confirmed',
      source: {
        name: 'wechat',
        sourceId: 'wechat-hot-chips-2026',
        url: 'https://mp.weixin.qq.com/s/EfWIB03udmx42X4UxRhx2g',
        fetchedAt: '2026-08-22T12:28:00.000Z',
      },
    },
  ]);
  const fetchImpl = async (url) => {
    if (String(url).includes('savvytrader.com')) {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('stats.gov.cn')) {
      return new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    return new Response(JSON.stringify({ data: { rows: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await refreshCalendar({
    dataFile,
    manualFile,
    start: '2026-08-24',
    end: '2026-08-30',
    fetchImpl,
    now: () => new Date('2026-08-23T11:30:00.000Z'),
  });
  const store = await readCalendarStore({ dataFile, manualFile, fundsFile: TEST_FUNDS_FILE });

  assert.equal(result.results.macro.sources.schedule.status, 'manual');
  assert.equal(result.results.macro.sources.schedule.checked, 1);
  assert.match(result.results.macro.sources.schedule.message, /已登录金十网页/);
  assert.equal(result.results.aShare.checked, 1);
  assert.equal(store.events.some((event) => event.id === 'jin10-us-confidence'), true);
  assert.equal(store.events.some((event) => event.id === 'wechat-hot-chips-2026'), true);
});

test('GET returns an empty calendar before the local snapshot has been created', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'calendar-missing-store-'));
  const dataFile = path.join(dir, 'calendar', 'events.json');

  const app = express();
  app.use('/api/calendar', createCalendarRouter({
    dataFile,
    fundsFile: TEST_FUNDS_FILE,
    now: () => new Date(NOW),
  }));
  const server = await listen(app);
  t.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/calendar?start=2026-07-13&end=2026-07-19`,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.count, 0);
  assert.deepEqual(body.events, []);
  assert.equal(body.updatedAt, null);
});

test('manual refresh creates the local snapshot when it does not exist yet', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'calendar-first-refresh-'));
  const dataFile = path.join(dir, 'calendar', 'events.json');
  const fetchImpl = async (url) => {
    if (String(url).includes('savvytrader.com')) {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('stats.gov.cn')) {
      return new Response('', { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    return new Response(JSON.stringify({ data: { rows: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const app = express();
  app.use('/api/calendar', createCalendarRouter({
    dataFile,
    fundsFile: TEST_FUNDS_FILE,
    fetchImpl,
    now: () => new Date(NOW),
  }));
  const server = await listen(app);
  t.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/calendar/refresh?start=2026-07-13&end=2026-07-19`,
    { method: 'POST' },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.count, 0);
  assert.deepEqual(body.events, []);
  assert.equal(body.updatedAt, NOW);
  assert.equal(JSON.parse(await fs.promises.readFile(dataFile, 'utf8')).updatedAt, NOW);
});

test('US symbol aliases normalize to the same subset key', () => {
  assert.equal(normalizeUsSymbol('brk-b'), 'BRK.B');
  assert.equal(normalizeUsSymbol('$brk.b'), 'BRK.B');
  assert.equal(canonicalizeUsCompanySymbol('GOOG'), 'GOOGL');
  assert.equal(canonicalizeUsCompanySymbol('GOOGL'), 'GOOGL');
});

test('funds fixture dynamically drives sector and North America 7 subset hits', async () => {
  const fundsData = JSON.parse(await fs.promises.readFile(TEST_FUNDS_FILE, 'utf8'));
  const subsetIndex = buildUsSubsetIndex(fundsData);
  const magnificentSeven = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'];
  const northAmericaSeven = fundsData.funds.find((fund) => fund.name === '北美7大');
  assert.ok(northAmericaSeven);
  assert.deepEqual(northAmericaSeven.positions.map((position) => position.code), magnificentSeven);
  for (const position of northAmericaSeven.positions) {
    assert.ok(Number.isFinite(position.shares) && position.shares > 0);
    assert.ok(Number.isFinite(position.currentPrice) && position.currentPrice > 0);
  }
  const events = ['ASML', 'TSM', 'NFLX', 'GOOG', ...magnificentSeven].map((symbol, index) => normalizeCalendarEvent(
    earningsEvent({
      id: `real-${symbol}`,
      symbol,
      date: `2026-07-${15 + index}`,
      startAt: `2026-07-${15 + index}T10:00:00.000Z`,
    }),
    index,
  ));
  const enriched = enrichEventsWithSubsetHits(events, subsetIndex);
  const hits = Object.fromEntries(enriched.map((event) => [event.earnings.symbol, event.subsetHits]));

  assert.deepEqual(hits.ASML.map((hit) => hit.fundName), ['美股半导体', '美股半导体设备']);
  assert.deepEqual(hits.TSM.map((hit) => hit.fundName), ['美股半导体']);
  // NFLX is important in the external calendar, but is not currently in a real US subset.
  assert.deepEqual(hits.NFLX, []);
  for (const symbol of magnificentSeven) {
    assert.ok(
      hits[symbol].some((hit) => hit.fundName === '北美7大'),
      `${symbol} should match the 北美7大 subset`,
    );
  }
  assert.ok(hits.GOOG.some((hit) => hit.fundName === '北美7大'));
});

test('Alphabet share classes match North America 7 but return one earnings row', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'calendar-alphabet-alias-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = await writeFixtureStore(dir, [
    earningsEvent({ id: 'goog', symbol: 'GOOG', date: '2026-07-22', startAt: '2026-07-22T20:03:00.000Z' }),
    earningsEvent({ id: 'googl', symbol: 'GOOGL', date: '2026-07-22', startAt: '2026-07-22T20:03:00.000Z' }),
  ]);

  const app = express();
  app.use('/api/calendar', createCalendarRouter({ dataFile, fundsFile: TEST_FUNDS_FILE }));
  const server = await listen(app);
  t.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/calendar?start=2026-07-22&end=2026-07-22`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.events[0].earnings.symbol, 'GOOGL');
  assert.deepEqual(body.events[0].symbols.sort(), ['GOOG', 'GOOGL']);
  assert.ok(body.events[0].subsetHits.some((hit) => hit.fundName === '北美7大'));
});

test('GET keeps only subset-hit US earnings and returns source status', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'calendar-api-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = await writeFixtureStore(dir, [
    earningsEvent({ id: 'late', symbol: 'NFLX', date: '2026-07-16', startAt: '2026-07-16T20:00:00.000Z' }),
    earningsEvent({ id: 'early', symbol: 'TSM', date: '2026-07-16', startAt: '2026-07-16T10:00:00.000Z' }),
    earningsEvent({ id: 'outside', symbol: 'ASML', date: '2026-07-20', startAt: '2026-07-20T10:00:00.000Z' }),
  ]);

  const app = express();
  app.use('/api/calendar', createCalendarRouter({
    dataFile,
    fundsFile: TEST_FUNDS_FILE,
    now: () => new Date(NOW),
  }));
  const server = await listen(app);
  t.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/calendar?start=2026-07-16&end=2026-07-16`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.count, 1);
  assert.deepEqual(body.events.map((event) => event.id), ['early']);
  assert.deepEqual(body.events[0].subsetHits.map((hit) => hit.fundName), ['美股半导体']);
  assert.equal(body.sources.wechat.status, 'manual_import');
  assert.equal(body.updatedAt, NOW);
});

test('GET re-matches stored earnings after a new US symbol is added to a subset', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'calendar-dynamic-subset-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = await writeFixtureStore(dir, [
    earningsEvent({ id: 'tsm', symbol: 'TSM', date: '2026-07-16', startAt: '2026-07-16T10:00:00.000Z' }),
    earningsEvent({ id: 'nflx', symbol: 'NFLX', date: '2026-07-16', startAt: '2026-07-16T12:00:00.000Z' }),
  ]);
  const fundsFile = await writeFixtureFunds(dir, ['TSM']);

  const app = express();
  app.use('/api/calendar', createCalendarRouter({ dataFile, fundsFile }));
  const server = await listen(app);
  t.after(server.close);

  const before = await fetch(`${server.baseUrl}/api/calendar?start=2026-07-16&end=2026-07-16`);
  assert.deepEqual((await before.json()).events.map((event) => event.earnings.symbol), ['TSM']);

  await writeFixtureFunds(dir, ['TSM', 'NFLX']);
  const after = await fetch(`${server.baseUrl}/api/calendar?start=2026-07-16&end=2026-07-16`);
  const afterBody = await after.json();
  assert.deepEqual(afterBody.events.map((event) => event.earnings.symbol), ['TSM', 'NFLX']);
  assert.deepEqual(afterBody.events[1].subsetHits.map((hit) => hit.fundName), ['美股关注']);
});

test('multi-day events overlap the queried day and retain endDate', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'calendar-api-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = await writeFixtureStore(dir, [{
    id: 'waic-2026',
    kind: 'a_share',
    title: '2026 世界人工智能大会（WAIC）',
    region: 'CN',
    date: '2026-07-17',
    endDate: '2026-07-20',
    timezone: 'Asia/Shanghai',
    timePrecision: 'date',
    importance: 5,
    status: 'confirmed',
    tags: ['AI'],
    source: source('wechat', 'waic-2026'),
  }]);

  const app = express();
  app.use('/api/calendar', createCalendarRouter({ dataFile, fundsFile: TEST_FUNDS_FILE }));
  const server = await listen(app);
  t.after(server.close);

  const coveredDay = await fetch(`${server.baseUrl}/api/calendar?start=2026-07-18&end=2026-07-18`);
  assert.equal(coveredDay.status, 200);
  const coveredBody = await coveredDay.json();
  assert.equal(coveredBody.count, 1);
  assert.equal(coveredBody.events[0].id, 'waic-2026');
  assert.equal(coveredBody.events[0].endDate, '2026-07-20');

  const beforeEvent = await fetch(`${server.baseUrl}/api/calendar?start=2026-07-16&end=2026-07-16`);
  assert.equal(beforeEvent.status, 200);
  assert.equal((await beforeEvent.json()).count, 0);

  assert.throws(() => normalizeCalendarEvent({
    ...coveredBody.events[0],
    endDate: '2026-07-16',
  }), /endDate must be on or after date/);
});

test('GET validates query dates and manual refresh replaces EarningsHub events', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'calendar-api-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = await writeFixtureStore(dir, [
    earningsEvent({
      id: 'stale-tsm',
      symbol: 'TSM',
      date: '2026-07-16',
      startAt: '2026-07-16T10:00:00.000Z',
    }),
  ]);

  let hubAttempts = 0;
  let nasdaqRequests = 0;
  const hubRecord = {
    symbol: 'TSM',
    sk: 'earnings#2026#q2',
    earningsDate: '2026-07-16',
    earningsDateTime: '2026-07-16T05:00:00.000Z',
    earningsTime: '01:00:00',
    externalId: 'tsm-q2-2026',
    period: 'Q2',
    periodYear: 2026,
    isDateConfirmed: true,
    importance: 5,
    epsEstimate: 3.12,
    revenueEstimate: 40100000000,
    assetName: 'Taiwan Semiconductor Manufacturing',
  };
  const fetchImpl = async (url) => {
    if (url.includes('stats.gov.cn')) {
      return new Response('<html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (url.includes('savvytrader.com')) {
      hubAttempts += 1;
      if (hubAttempts === 1) throw new Error('temporary connection failure');
      return new Response(JSON.stringify([hubRecord]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    nasdaqRequests += 1;
    const isTsmDay = url.includes('date=2026-07-16');
    return new Response(JSON.stringify({ data: { rows: isTsmDay ? [{
      symbol: 'TSM',
      name: 'Taiwan Semiconductor Manufacturing',
      time: 'time-pre-market',
      fiscalQuarterEnding: 'Jun/2026',
      epsForecast: '$3.12',
      noOfEsts: '8',
    }] : [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const app = express();
  app.use('/api/calendar', createCalendarRouter({
    dataFile,
    fundsFile: TEST_FUNDS_FILE,
    fetchImpl,
    now: () => new Date(NOW),
  }));
  const server = await listen(app);
  t.after(server.close);

  const invalid = await fetch(`${server.baseUrl}/api/calendar?start=2026-07-20&end=2026-07-19`);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'CALENDAR_RANGE_REVERSED');

  const refresh = await fetch(
    `${server.baseUrl}/api/calendar/refresh?start=2026-07-13&end=2026-07-19`,
    { method: 'POST' },
  );
  assert.equal(refresh.status, 200);
  const refreshBody = await refresh.json();
  assert.equal(refreshBody.success, true);
  assert.equal(refreshBody.refreshMode, 'manual');
  assert.equal(refreshBody.refreshed.allSucceeded, true);
  assert.equal(refreshBody.refreshed.coverageComplete, false);
  assert.equal(refreshBody.refreshed.results.earnings.count, 1);
  assert.equal(refreshBody.refreshed.results.macro.updated, 0);
  assert.equal(refreshBody.refreshed.results.aShare.status, 'manual');
  assert.deepEqual(refreshBody.events.map((event) => event.earnings.symbol), ['TSM']);
  assert.equal(refreshBody.sources.earningshub.status, 'ready');
  assert.equal(refreshBody.sources.nasdaq.status, 'ready');
  assert.equal(hubAttempts, 2);
  assert.equal(nasdaqRequests, 5);

  const refreshed = await fetch(
    `${server.baseUrl}/api/calendar?start=2026-07-16&end=2026-07-16`,
  );
  const refreshedBody = await refreshed.json();
  assert.equal(refreshedBody.count, 1);
  assert.equal(refreshedBody.events[0].id, 'nasdaq-tsm-2026-07-16');
  assert.equal(refreshedBody.events[0].earnings.currency, 'USD');
  assert.equal(refreshedBody.events[0].earnings.revenueEstimate, 40100000000);
});

test('manual refresh updates a released US CPI event from official BLS data', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'calendar-cpi-refresh-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = await writeFixtureStore(dir, [{
    id: 'us-cpi-june-2026',
    kind: 'macro',
    title: '美国6月CPI',
    region: 'US',
    date: '2026-07-14',
    startAt: '2026-07-14T08:30:00-04:00',
    timezone: 'America/New_York',
    timePrecision: 'exact',
    importance: 5,
    status: 'confirmed',
    tags: ['CPI'],
    source: source('jin10', 'us-cpi-june-2026'),
  }]);
  const blsSeries = [
    ['CUSR0000SA0', [['2026', 'M06', '99.6'], ['2026', 'M05', '100.0']]],
    ['CUUR0000SA0', [['2026', 'M06', '103.5'], ['2025', 'M06', '100.0']]],
    ['CUSR0000SA0L1E', [['2026', 'M06', '100.0'], ['2026', 'M05', '100.0']]],
    ['CUUR0000SA0L1E', [['2026', 'M06', '102.6'], ['2025', 'M06', '100.0']]],
  ].map(([seriesID, rows]) => ({
    seriesID,
    data: rows.map(([year, period, value]) => ({ year, period, value })),
  }));
  const fetchImpl = async (url) => {
    if (url.includes('api.bls.gov')) {
      return new Response(JSON.stringify({
        status: 'REQUEST_SUCCEEDED',
        Results: { series: blsSeries },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('savvytrader.com')) {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: { rows: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const app = express();
  app.use('/api/calendar', createCalendarRouter({
    dataFile,
    fundsFile: TEST_FUNDS_FILE,
    fetchImpl,
    now: () => new Date(NOW),
  }));
  const server = await listen(app);
  t.after(server.close);

  const refresh = await fetch(
    `${server.baseUrl}/api/calendar/refresh?start=2026-07-14&end=2026-07-14`,
    { method: 'POST' },
  );
  assert.equal(refresh.status, 200);
  const refreshBody = await refresh.json();
  assert.equal(refreshBody.refreshed.allSucceeded, true);
  assert.equal(refreshBody.refreshed.results.macro.updated, 1);

  const calendar = await fetch(
    `${server.baseUrl}/api/calendar?start=2026-07-14&end=2026-07-14`,
  );
  const body = await calendar.json();
  assert.equal(body.events[0].status, 'released');
  assert.equal(body.events[0].source.name, 'official');
  assert.equal(
    body.events[0].metrics.actual,
    '同比+3.5% · 环比-0.4% · 核心同比+2.6% · 核心环比0.0%',
  );
});

test('manual refresh imports released China GDP, industrial, retail, investment, and jobs data from NBS', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'calendar-nbs-refresh-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = await writeFixtureStore(dir, [
    {
      id: 'macro-cn-q2-gdp-activity-2026',
      kind: 'macro',
      title: '中国二季度国民经济运行情况发布会',
      region: 'CN',
      date: '2026-07-15',
      startAt: '2026-07-15T10:00:00+08:00',
      timezone: 'Asia/Shanghai',
      timePrecision: 'exact',
      importance: 5,
      status: 'confirmed',
      tags: ['GDP', '工业增加值', '固定资产投资', '社会消费品零售'],
      metrics: { actual: '不应保留的汇总数据' },
      source: source('jin10', 'macro-cn-q2-gdp-activity-2026'),
    },
    {
      id: 'macro-cn-home-prices-70-cities-2026-06',
      kind: 'macro',
      title: '中国6月70个大中城市商品住宅销售价格',
      region: 'CN',
      date: '2026-07-15',
      startAt: '2026-07-15T09:30:00+08:00',
      timezone: 'Asia/Shanghai',
      timePrecision: 'exact',
      importance: 4,
      status: 'confirmed',
      tags: ['房地产'],
      source: source('jin10', 'macro-cn-home-prices-70-cities-2026-06'),
    },
  ]);
  const indexHtml = `
    <a href="./202607/t20260715_1964121.html"
       title="上半年经济运行在合理区间 新动能快速成长">最新发布</a>
  `;
  const articleHtml = `
    <p>初步核算，上半年国内生产总值 <span>695704</span> 亿元，按不变价格计算，同比增长 <span>4.7%</span>。</p>
    <p>分季度看，一季度国内生产总值同比增长5.0%，二季度增长 <span>4.3%</span>。从环比看，二季度国内生产总值增长 <span>0.9%</span>。</p>
    <p>6 月份，规模以上工业增加值同比增长 <span>5.3%</span>。</p>
    <p>6 月份，社会消费品零售总额 <span>42691</span> 亿元，同比增长 <span>1.0%</span>。</p>
    <p>上半年，全国固定资产投资（不含农户） <span>226370</span> 亿元，同比下降 <span>5.7%</span>。</p>
    <p>6 月份，全国城镇调查失业率为 <span>5.0%</span>。</p>
  `;
  const aggregateHtml = `
    <a href="./202607/t20260715_1964115.html"
       title="2026年6月份70个大中城市商品住宅销售价格变动情况">数据发布</a>
  `;
  const fetchImpl = async (url) => {
    if (url === 'https://www.stats.gov.cn/sj/zxfb/') {
      return new Response(indexHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (url === 'https://www.stats.gov.cn/sj/zxfbhjd/') {
      return new Response(aggregateHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (url.includes('t20260715_1964121.html')) {
      return new Response(articleHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (url.includes('savvytrader.com')) {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: { rows: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const app = express();
  app.use('/api/calendar', createCalendarRouter({
    dataFile,
    fundsFile: TEST_FUNDS_FILE,
    fetchImpl,
    now: () => new Date('2026-07-15T02:05:00.000Z'),
  }));
  const server = await listen(app);
  t.after(server.close);

  const refresh = await fetch(
    `${server.baseUrl}/api/calendar/refresh?start=2026-07-15&end=2026-07-15`,
    { method: 'POST' },
  );
  assert.equal(refresh.status, 200);
  const refreshBody = await refresh.json();
  assert.equal(refreshBody.refreshed.allSucceeded, true);
  assert.equal(refreshBody.refreshed.coverageComplete, false);
  assert.equal(refreshBody.refreshed.results.macro.updated, 8);
  assert.equal(refreshBody.refreshed.results.macro.sources.nbs.updated, 8);

  const calendar = await fetch(
    `${server.baseUrl}/api/calendar?start=2026-07-15&end=2026-07-15`,
  );
  const body = await calendar.json();
  const byId = new Map(body.events.map((event) => [event.id, event]));
  assert.equal(byId.get('macro-cn-q2-gdp-2026').metrics.actual, '同比+4.3% · 环比+0.9%');
  assert.equal(byId.get('macro-cn-h1-gdp-2026').metrics.actual, '+4.7% · 695704亿元');
  assert.equal(byId.get('macro-cn-industrial-production-2026-06').metrics.actual, '+5.3%');
  assert.equal(byId.get('macro-cn-retail-sales-2026-06').metrics.actual, '+1.0% · 42691亿元');
  assert.equal(byId.get('macro-cn-fixed-investment-2026-h1').metrics.actual, '-5.7% · 226370亿元');
  assert.equal(byId.get('macro-cn-surveyed-unemployment-2026-06').metrics.actual, '5.0%');
  assert.equal(byId.get('macro-cn-q2-gdp-2026').source.name, 'official');
  assert.equal(byId.get('macro-cn-q2-gdp-activity-2026').metrics.actual, undefined);
  assert.match(byId.get('macro-cn-q2-gdp-activity-2026').summary, /拆分为独立条目/);
  assert.equal(byId.get('macro-cn-home-prices-70-cities-2026-06').status, 'released');
  assert.equal(byId.get('macro-cn-home-prices-70-cities-2026-06').source.name, 'official');
});

test('full-month earnings refresh keeps EarningsHub enrichment by loading bounded date windows', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'calendar-earnings-month-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = await writeFixtureStore(dir, []);
  const hubRecords = [
    {
      symbol: 'AMD',
      assetName: 'Advanced Micro Devices',
      sk: 'earnings#2026#q2',
      earningsDate: '2026-08-04',
      earningsDateTime: '2026-08-04T20:05:00.000Z',
      earningsTime: '16:05:00',
      period: 'Q2',
      periodYear: 2026,
      isDateConfirmed: true,
      epsEstimate: 1.2,
    },
    {
      symbol: 'NVDA',
      assetName: 'NVIDIA',
      sk: 'earnings#2026#q2',
      earningsDate: '2026-08-26',
      earningsDateTime: '2026-08-26T20:05:00.000Z',
      earningsTime: '16:05:00',
      period: 'Q2',
      periodYear: 2026,
      isDateConfirmed: true,
      epsEstimate: 1.4,
    },
  ];
  const fetchImpl = async (url) => {
    const requestUrl = new URL(String(url));
    if (requestUrl.hostname === 'api.savvytrader.com') {
      const start = requestUrl.searchParams.get('start');
      const end = requestUrl.searchParams.get('end');
      const spanDays = Math.round(
        (Date.parse(`${end}T12:00:00.000Z`) - Date.parse(`${start}T12:00:00.000Z`)) / 86_400_000,
      ) + 1;
      const payload = spanDays > 7
        ? Array.from({ length: 2_001 }, () => hubRecords[0])
        : hubRecords.filter((record) => record.earningsDate >= start && record.earningsDate <= end);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ data: { rows: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await refreshEarningsHubCalendar({
    dataFile,
    start: '2026-08-01',
    end: '2026-08-31',
    fetchImpl,
    now: () => new Date(NOW),
  });
  const store = JSON.parse(await fs.promises.readFile(dataFile, 'utf8'));

  assert.equal(store.sources.earningshub.status, 'ready');
  assert.equal(result.sourceCounts.earningshub, 2);
  assert.deepEqual(
    store.events.map((event) => event.earnings.symbol),
    ['AMD', 'NVDA'],
  );
});

test('NBS refresh inserts a released 70-city housing event when the schedule snapshot has no match', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'calendar-nbs-housing-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataFile = await writeFixtureStore(dir, []);
  const aggregateHtml = `
    <a href="./202608/t20260815_1965001.html"
       title="2026年7月份70个大中城市商品住宅销售价格变动情况">数据发布</a>
  `;
  const fetchImpl = async (url) => new Response(
    url === 'https://www.stats.gov.cn/sj/zxfbhjd/' ? aggregateHtml : '<html></html>',
    { status: 200, headers: { 'Content-Type': 'text/html' } },
  );

  const result = await refreshNbsMacroCalendar({
    dataFile,
    start: '2026-08-01',
    end: '2026-08-31',
    fetchImpl,
    now: () => new Date(NOW),
  });
  const store = JSON.parse(await fs.promises.readFile(dataFile, 'utf8'));

  assert.equal(result.updated, 1);
  assert.equal(result.inserted, 1);
  assert.match(result.message, /已同步70城房价发布/);
  assert.equal(store.events[0].id, 'macro-cn-home-prices-70-cities-2026-07');
  assert.equal(store.events[0].status, 'released');
  assert.equal(store.events[0].source.name, 'official');
});
