import assert from 'node:assert/strict';
import test from 'node:test';

import type { Fund, Position } from '../src/types/fund.ts';
import * as presetModule from '../src/data/usSectorFunds.ts';

type PresetModule = typeof presetModule & {
  DEFAULT_PORTFOLIO_MARKET?: string;
  createUSSectorPresetFunds?: (createdAt?: string) => Fund[];
  migrateLegacyDefaultFunds?: (funds: Fund[], createdAt?: string) => Fund[];
  migrateUSSubsetNames?: (funds: Fund[]) => Fund[];
  classifyFundSet?: (funds: Fund[]) => 'missing' | 'legacy' | 'preset' | 'custom';
  shouldPreferLocalFundSource?: (options: {
    localSource: 'missing' | 'legacy' | 'preset' | 'custom';
    localTime: number;
    backendSource: 'missing' | 'legacy' | 'preset' | 'custom';
    backendTime: number;
  }) => boolean;
  applyTargetWeightQuote?: (
    position: Position,
    quote: { currentPrice: number; prevClose: number },
    initialCapital: number,
  ) => Position;
  getTargetWeightRebalanceCapital?: (
    positions: Position[],
    prices: Record<string, { currentPrice: number; prevClose: number }>,
    initialCapital: number,
  ) => number | null;
  calculatePortfolioMarketValue?: (positions: Position[]) => number;
  hasUninitializedTargetWeightPositions?: (positions: Position[]) => boolean;
};

const restoration = presetModule as PresetModule;
const FIXED_TIME = '2026-08-20T00:00:00.000Z';

const legacyDefault: Fund = {
  id: 'fund_1',
  name: '锋行成长1号',
  market: 'a',
  initialCapital: 1_000_000,
  positions: [
    { code: '600519', name: '贵州茅台', shares: 100, avgCost: 1680, currentPrice: 1680 },
    { code: '000858', name: '五粮液', shares: 2000, avgCost: 145, currentPrice: 145 },
    { code: '600036', name: '招商银行', shares: 5000, avgCost: 35.8, currentPrice: 35.8 },
    { code: '000001', name: '平安银行', shares: 5000, avgCost: 12.5, currentPrice: 12.5 },
  ],
  navHistory: [],
  createdAt: FIXED_TIME,
};

test('creates exactly the 39 archived US-sector subsets with stable identities', () => {
  assert.equal(typeof restoration.createUSSectorPresetFunds, 'function');
  const createFunds = restoration.createUSSectorPresetFunds!;
  const funds = createFunds(FIXED_TIME);
  const repeated = createFunds('2026-08-21T00:00:00.000Z');

  assert.equal(funds.length, 39);
  assert.equal(new Set(funds.map((fund) => fund.id)).size, 39);
  assert.equal(new Set(funds.map((fund) => fund.name)).size, 39);
  assert.deepEqual(repeated.map((fund) => fund.id), funds.map((fund) => fund.id));
  assert.ok(funds.every((fund) => fund.market === 'us'));
  assert.ok(funds.every((fund) => fund.initialCapital === 100_000));
  assert.ok(!funds.some((fund) => fund.name === '锋行成长1号'));
  assert.ok(!funds.some((fund) => fund.name.startsWith('美股')));
  assert.ok(funds.some((fund) => fund.name === 'AI算力'));
  assert.equal(restoration.DEFAULT_PORTFOLIO_MARKET, 'us');
});

test('removes the US-market prefix from subset names without changing holdings or other markets', () => {
  assert.equal(typeof restoration.migrateUSSubsetNames, 'function');
  const migrate = restoration.migrateUSSubsetNames!;
  const usFund: Fund = {
    id: 'us-custom',
    name: '美股半导体',
    market: 'us',
    initialCapital: 100_000,
    positions: [{ code: 'NVDA', name: '美股英伟达', shares: 1, avgCost: 100 }],
    navHistory: [],
    createdAt: FIXED_TIME,
  };
  const aShareFund: Fund = { ...usFund, id: 'a-custom', name: '美股概念', market: 'a' };
  const alreadyClean: Fund = { ...usFund, id: 'us-clean', name: 'AI算力' };

  const migrated = migrate([usFund, aShareFund, alreadyClean]);

  assert.equal(migrated[0].name, '半导体');
  assert.equal(migrated[0].positions[0].name, '美股英伟达');
  assert.strictEqual(migrated[1], aShareFund);
  assert.strictEqual(migrated[2], alreadyClean);
  assert.strictEqual(migrate(migrated), migrated);
});

test('uses equal weights unless the preset contains explicit weights', () => {
  assert.equal(typeof restoration.createUSSectorPresetFunds, 'function');
  const funds = restoration.createUSSectorPresetFunds!(FIXED_TIME);

  const magnificentSeven = funds.find((fund) => fund.name === '北美7大');
  assert.ok(magnificentSeven);
  assert.ok(magnificentSeven.positions.every((position) =>
    Math.abs((position.targetWeight ?? 0) - (100 / 7)) < 1e-10
  ));

  const semiconductors = funds.find((fund) => fund.name === '半导体');
  assert.ok(semiconductors);
  const totalWeight = semiconductors.positions.reduce(
    (total, position) => total + (position.targetWeight ?? 0),
    0,
  );
  const nvda = semiconductors.positions.find((position) => position.code === 'NVDA');
  const tsm = semiconductors.positions.find((position) => position.code === 'TSM');
  assert.ok(nvda?.targetWeight && tsm?.targetWeight);
  assert.ok(Math.abs(totalWeight - 100) < 1e-10);
  assert.ok(Math.abs((nvda.targetWeight / tsm.targetWeight) - (18.16 / 9.04)) < 1e-10);
});

test('replaces only the exact legacy default set and stays idempotent', () => {
  assert.equal(typeof restoration.migrateLegacyDefaultFunds, 'function');
  const migrate = restoration.migrateLegacyDefaultFunds!;
  const restored = migrate([legacyDefault], FIXED_TIME);
  const repeated = migrate(restored, FIXED_TIME);

  assert.equal(restored.length, 39);
  assert.ok(!restored.some((fund) => fund.name === '锋行成长1号'));
  assert.deepEqual(repeated, restored);

  const custom = { ...legacyDefault, id: 'custom', name: '我自己的组合' };
  assert.strictEqual(migrate([custom], FIXED_TIME)[0], custom);

  const changedCapital = { ...legacyDefault, initialCapital: 2_000_000 };
  assert.strictEqual(migrate([changedCapital], FIXED_TIME)[0], changedCapital);

  const changedShares = {
    ...legacyDefault,
    positions: legacyDefault.positions.map((position, index) =>
      index === 0 ? { ...position, shares: position.shares + 1 } : position
    ),
  };
  assert.strictEqual(migrate([changedShares], FIXED_TIME)[0], changedShares);

  const withHistory = {
    ...legacyDefault,
    navHistory: [{ date: '2026-08-19', nav: 1.01, cumulativeNav: 1.01, marketValue: 1_010_000 }],
    lastSyncDate: '2026-08-19',
  };
  assert.strictEqual(migrate([withHistory], FIXED_TIME)[0], withHistory);

  const withUpdatedPrice = {
    ...legacyDefault,
    positions: legacyDefault.positions.map((position, index) =>
      index === 0 ? { ...position, currentPrice: position.currentPrice! + 1 } : position
    ),
  };
  assert.strictEqual(migrate([withUpdatedPrice], FIXED_TIME)[0], withUpdatedPrice);
});

test('never lets a legacy backend replace current custom local funds', () => {
  assert.equal(typeof restoration.classifyFundSet, 'function');
  assert.equal(typeof restoration.shouldPreferLocalFundSource, 'function');
  const custom = [{ ...legacyDefault, id: 'custom', name: '我自己的组合' }];

  assert.equal(restoration.classifyFundSet!(custom), 'custom');
  assert.equal(restoration.shouldPreferLocalFundSource!({
    localSource: 'custom',
    localTime: 1,
    backendSource: 'legacy',
    backendTime: 2,
  }), true);
  assert.equal(restoration.shouldPreferLocalFundSource!({
    localSource: 'preset',
    localTime: 1,
    backendSource: 'legacy',
    backendTime: 2,
  }), true);
  assert.equal(restoration.shouldPreferLocalFundSource!({
    localSource: 'legacy',
    localTime: 3,
    backendSource: 'custom',
    backendTime: 2,
  }), false);
  assert.equal(restoration.shouldPreferLocalFundSource!({
    localSource: 'preset',
    localTime: 3,
    backendSource: 'custom',
    backendTime: 2,
  }), false);
  assert.equal(restoration.shouldPreferLocalFundSource!({
    localSource: 'preset',
    localTime: 1,
    backendSource: 'preset',
    backendTime: 2,
  }), false);
});

test('rebalances restored positions to their target weights when a quote arrives', () => {
  assert.equal(typeof restoration.applyTargetWeightQuote, 'function');
  const position: Position = {
    code: 'AAPL',
    name: '美股苹果',
    shares: 100_000 / 7,
    avgCost: 1,
    currentPrice: 1,
    prevClose: 1,
    targetWeight: 100 / 7,
  };

  const updated = restoration.applyTargetWeightQuote!(
    position,
    { currentPrice: 200, prevClose: 198 },
    100_000,
  );

  assert.ok(Math.abs(updated.shares - (100_000 / 7 / 200)) < 1e-10);
  assert.equal(updated.currentPrice, 200);
  assert.equal(updated.prevClose, 198);
  assert.equal(updated.avgCost, 200);
});

test('rebalances first quotes from initial capital and later quotes from current equity', () => {
  assert.equal(typeof restoration.getTargetWeightRebalanceCapital, 'function');
  const getCapital = restoration.getTargetWeightRebalanceCapital!;
  const placeholders: Position[] = [
    { code: 'AAA', name: 'AAA', shares: 50_000, avgCost: 1, currentPrice: 1, prevClose: 1, targetWeight: 50 },
    { code: 'BBB', name: 'BBB', shares: 50_000, avgCost: 1, currentPrice: 1, prevClose: 1, targetWeight: 50 },
  ];
  const firstQuotes = {
    AAA: { currentPrice: 100, prevClose: 99 },
    BBB: { currentPrice: 50, prevClose: 49 },
  };
  assert.equal(getCapital(placeholders, firstQuotes, 100_000), 100_000);

  const partialQuotes = { AAA: firstQuotes.AAA };
  assert.equal(getCapital(placeholders, partialQuotes, 100_000), null);
  const afterPartial = placeholders.map((position) => {
    const quote = partialQuotes[position.code];
    return quote
      ? restoration.applyTargetWeightQuote!(position, quote, Number.NaN)
      : position;
  });
  assert.deepEqual(afterPartial, placeholders);
  assert.equal(getCapital(afterPartial, firstQuotes, 100_000), 100_000);

  const invested: Position[] = [
    { code: 'AAA', name: 'AAA', shares: 500, avgCost: 100, currentPrice: 100, prevClose: 99, targetWeight: 50 },
    { code: 'BBB', name: 'BBB', shares: 1000, avgCost: 50, currentPrice: 50, prevClose: 49, targetWeight: 50 },
  ];
  const laterQuotes = {
    AAA: { currentPrice: 120, prevClose: 118 },
    BBB: { currentPrice: 50, prevClose: 49 },
  };
  const equity = getCapital(invested, laterQuotes, 100_000);
  assert.equal(equity, 110_000);

  const rebalanced = invested.map((position) => restoration.applyTargetWeightQuote!(
    position,
    laterQuotes[position.code],
    equity!,
  ));
  const postRebalanceValue = rebalanced.reduce(
    (total, position) => total + position.shares * position.currentPrice!,
    0,
  );
  assert.ok(Math.abs(postRebalanceValue - 110_000) < 1e-10);
  assert.equal(getCapital(invested, { AAA: laterQuotes.AAA }, 100_000), null);
});

test('does not record NAV from a reliable-looking partial first quote set', () => {
  assert.equal(typeof restoration.calculatePortfolioMarketValue, 'function');
  assert.equal(typeof restoration.hasUninitializedTargetWeightPositions, 'function');
  const calculateMarketValue = restoration.calculatePortfolioMarketValue!;
  const hasUninitializedPositions = restoration.hasUninitializedTargetWeightPositions!;
  const initialCapital = 100_000;
  const placeholders: Position[] = Array.from({ length: 7 }, (_, index) => ({
    code: `P${index + 1}`,
    name: `Position ${index + 1}`,
    shares: initialCapital / 7,
    avgCost: 1,
    currentPrice: 1,
    prevClose: 1,
    targetWeight: 100 / 7,
  }));
  const completeQuotes = Object.fromEntries(placeholders.map((position, index) => [
    position.code,
    { currentPrice: 50 + index * 10, prevClose: 49 + index * 10 },
  ]));
  const partialQuotes = Object.fromEntries(Object.entries(completeQuotes).slice(0, 6));

  const partialCapital = restoration.getTargetWeightRebalanceCapital!(
    placeholders,
    partialQuotes,
    initialCapital,
  );
  const afterPartial = placeholders.map((position) => {
    const quote = partialQuotes[position.code];
    return quote
      ? restoration.applyTargetWeightQuote!(position, quote, partialCapital ?? Number.NaN)
      : position;
  });

  assert.equal(partialCapital, null);
  assert.ok(Math.abs(calculateMarketValue(afterPartial) - initialCapital) < 1e-10);
  assert.equal(hasUninitializedPositions(afterPartial), true);

  const completeCapital = restoration.getTargetWeightRebalanceCapital!(
    afterPartial,
    completeQuotes,
    initialCapital,
  );
  const afterComplete = afterPartial.map((position) => restoration.applyTargetWeightQuote!(
    position,
    completeQuotes[position.code],
    completeCapital!,
  ));

  assert.equal(completeCapital, initialCapital);
  assert.ok(Math.abs(calculateMarketValue(afterComplete) - initialCapital) < 1e-10);
  assert.equal(hasUninitializedPositions(afterComplete), false);
});
