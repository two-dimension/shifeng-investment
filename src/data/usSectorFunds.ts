import type { Fund, Position } from '../types/fund';

export interface USSectorFundSymbol {
  code: string;
  name: string;
  weight?: number;
}

export interface USSectorFundPreset {
  name: string;
  group: '主要指数' | '股指期货' | '板块数据' | '其他指标';
  positions: USSectorFundSymbol[];
}

const single = (name: string, code: string, symbolName = name): USSectorFundPreset => ({
  name,
  group: name.includes('期货') ? '股指期货' : '其他指标',
  positions: [{ code, name: symbolName }],
});

export const US_SECTOR_INITIAL_CAPITAL = 100000;
export const DEFAULT_PORTFOLIO_MARKET = 'us' as const;

const SMH_CONSTITUENTS: USSectorFundSymbol[] = [
  { code: 'NVDA', name: '美股英伟达', weight: 18.16 },
  { code: 'TSM', name: '美股台积电ADR', weight: 9.04 },
  { code: 'MU', name: '美股美光科技', weight: 5.98 },
  { code: 'AVGO', name: '美股博通', weight: 5.49 },
  { code: 'AMD', name: '美股AMD', weight: 5.43 },
  { code: 'AMAT', name: '美股应用材料', weight: 5.35 },
  { code: 'INTC', name: '美股英特尔', weight: 5.09 },
  { code: 'LRCX', name: '美股Lam Research', weight: 5.00 },
  { code: 'KLAC', name: '美股KLA', weight: 4.94 },
  { code: 'ASML', name: '美股ASML Holding', weight: 4.89 },
  { code: 'MRVL', name: '美股Marvell', weight: 4.49 },
  { code: 'TXN', name: '美股德州仪器', weight: 4.29 },
  { code: 'ADI', name: '美股Analog Devices', weight: 4.19 },
  { code: 'QCOM', name: '美股高通', weight: 4.12 },
  { code: 'CDNS', name: '美股Cadence Design Systems', weight: 2.32 },
  { code: 'SNPS', name: '美股Synopsys', weight: 1.96 },
  { code: 'TER', name: '美股Teradyne', weight: 1.45 },
  { code: 'STM', name: '美股STMicroelectronics', weight: 1.29 },
  { code: 'MPWR', name: '美股Monolithic Power Systems', weight: 1.25 },
  { code: 'NXPI', name: '美股NXP Semiconductors', weight: 1.22 },
  { code: 'ARM', name: '美股Arm Holdings', weight: 1.18 },
  { code: 'ALAB', name: '美股Astera Labs', weight: 1.11 },
  { code: 'MCHP', name: '美股Microchip Technology', weight: 0.93 },
  { code: 'ON', name: '美股ON Semiconductor', weight: 0.60 },
  { code: 'SWKS', name: '美股Skyworks Solutions', weight: 0.17 },
];

export const US_SECTOR_FUND_PRESETS: USSectorFundPreset[] = [
  { ...single('纳斯达克100', '^NDX', 'Nasdaq 100'), group: '主要指数' },
  { ...single('标普500', '^GSPC', 'S&P 500'), group: '主要指数' },
  { ...single('道琼斯', '^DJI', 'Dow Jones'), group: '主要指数' },
  { ...single('纳指期货', 'NQ=F', 'Nasdaq 100 Futures'), group: '股指期货' },
  { ...single('标普期货', 'ES=F', 'S&P 500 Futures'), group: '股指期货' },
  { ...single('道指期货', 'YM=F', 'Dow Futures'), group: '股指期货' },
  {
    name: '北美7大',
    group: '板块数据',
    positions: [
      { code: 'AAPL', name: '美股苹果' },
      { code: 'MSFT', name: '美股微软' },
      { code: 'GOOGL', name: '美股Alphabet' },
      { code: 'AMZN', name: '美股亚马逊' },
      { code: 'NVDA', name: '美股英伟达' },
      { code: 'META', name: '美股Meta' },
      { code: 'TSLA', name: '美股特斯拉' },
    ],
  },
  {
    name: '美股AI算力',
    group: '板块数据',
    positions: [
      { code: 'NVDA', name: '美股英伟达' },
      { code: 'AMD', name: '美股AMD' },
      { code: 'AVGO', name: '美股博通' },
      { code: 'MRVL', name: '美股Marvell' },
      { code: 'ANET', name: '美股Arista Networks' },
      { code: 'SMCI', name: '美股Super Micro Computer' },
      { code: 'DELL', name: '美股戴尔科技' },
      { code: 'VRT', name: '美股Vertiv' },
    ],
  },
  {
    name: '美股CPO',
    group: '板块数据',
    positions: [
      { code: 'COHR', name: '美股Coherent' },
      { code: 'LITE', name: '美股Lumentum' },
      { code: 'CIEN', name: '美股Ciena' },
      { code: 'AAOI', name: '美股Applied Optoelectronics' },
      { code: 'CRDO', name: '美股Credo Technology' },
      { code: 'ANET', name: '美股Arista Networks' },
      { code: 'AVGO', name: '美股博通' },
    ],
  },
  { name: '美股半导体', group: '板块数据', positions: SMH_CONSTITUENTS },
  {
    name: '美股半导体设备',
    group: '板块数据',
    positions: [
      { code: 'ASML', name: '美股ASML Holding' },
      { code: 'AMAT', name: '美股应用材料' },
      { code: 'LRCX', name: '美股Lam Research' },
      { code: 'KLAC', name: '美股KLA' },
      { code: 'TER', name: '美股Teradyne' },
      { code: 'ACMR', name: '美股ACM Research' },
      { code: 'CAMT', name: '美股Camtek' },
      { code: 'AEHR', name: '美股Aehr Test Systems' },
    ],
  },
  {
    name: '美股半导体材料',
    group: '板块数据',
    positions: [
      { code: 'ENTG', name: '美股Entegris' },
      { code: 'WOLF', name: '美股Wolfspeed' },
      { code: 'COHR', name: '美股Coherent' },
      { code: 'MKSI', name: '美股MKS Instruments' },
      { code: 'DD', name: '美股DuPont' },
      { code: 'GLW', name: '美股Corning' },
    ],
  },
  {
    name: '美股半导体零部件',
    group: '板块数据',
    positions: [
      { code: 'MKSI', name: '美股MKS Instruments' },
      { code: 'UCTT', name: '美股Ultra Clean Holdings' },
      { code: 'ICHR', name: '美股Ichor Holdings' },
      { code: 'AEIS', name: '美股Advanced Energy Industries' },
      { code: 'FORM', name: '美股FormFactor' },
      { code: 'COHU', name: '美股Cohu' },
      { code: 'VECO', name: '美股Veeco Instruments' },
    ],
  },
  {
    name: '美股功率半导体',
    group: '板块数据',
    positions: [
      { code: 'ON', name: '美股ON Semiconductor' },
      { code: 'WOLF', name: '美股Wolfspeed' },
      { code: 'STM', name: '美股STMicroelectronics' },
      { code: 'NXPI', name: '美股NXP Semiconductors' },
      { code: 'MCHP', name: '美股Microchip Technology' },
      { code: 'DIOD', name: '美股Diodes' },
      { code: 'POWI', name: '美股Power Integrations' },
      { code: 'VSH', name: '美股Vishay Intertechnology' },
    ],
  },
  {
    name: '美股存储',
    group: '板块数据',
    positions: [
      { code: 'MU', name: '美股美光科技' },
      { code: 'WDC', name: '美股西部数据' },
      { code: 'STX', name: '美股希捷科技' },
      { code: 'NTAP', name: '美股NetApp' },
      { code: 'PSTG', name: '美股Pure Storage' },
    ],
  },
  {
    name: '美股数据中心',
    group: '板块数据',
    positions: [
      { code: 'DLR', name: '美股Digital Realty' },
      { code: 'EQIX', name: '美股Equinix' },
      { code: 'VRT', name: '美股Vertiv' },
      { code: 'ETN', name: '美股Eaton' },
      { code: 'CEG', name: '美股Constellation Energy' },
      { code: 'PWR', name: '美股Quanta Services' },
    ],
  },
  { name: '美股云计算', group: '板块数据', positions: [{ code: 'SKYY', name: '美股First Trust Cloud Computing ETF' }] },
  { name: '美股商业航天', group: '板块数据', positions: [{ code: 'ARKX', name: '美股ARK Space Exploration ETF' }] },
  {
    name: '美股卫星',
    group: '板块数据',
    positions: [
      { code: 'IRDM', name: '美股Iridium' },
      { code: 'GSAT', name: '美股Globalstar' },
      { code: 'ECHO', name: '美股EchoStar' },
      { code: 'VSAT', name: '美股Viasat' },
      { code: 'RKLB', name: '美股Rocket Lab' },
    ],
  },
  { name: '美股机器人', group: '板块数据', positions: [{ code: 'BOTZ', name: '美股Global X Robotics ETF' }] },
  {
    name: '美股自动驾驶',
    group: '板块数据',
    positions: [
      { code: 'TSLA', name: '美股特斯拉' },
      { code: 'MBLY', name: '美股Mobileye' },
      { code: 'AUR', name: '美股Aurora Innovation' },
      { code: 'LAZR', name: '美股Luminar' },
      { code: 'INVZ', name: '美股Innoviz' },
    ],
  },
  { name: '美股核电', group: '板块数据', positions: [{ code: 'URA', name: '美股Global X Uranium ETF' }] },
  { name: '美股电网', group: '板块数据', positions: [{ code: 'GRID', name: '美股First Trust NASDAQ Clean Edge Smart Grid ETF' }] },
  { name: '美股新能源', group: '板块数据', positions: [{ code: 'ICLN', name: '美股iShares Global Clean Energy ETF' }] },
  { name: '美股光伏', group: '板块数据', positions: [{ code: 'TAN', name: '美股Invesco Solar ETF' }] },
  { name: '美股锂电池', group: '板块数据', positions: [{ code: 'LIT', name: '美股Global X Lithium & Battery Tech ETF' }] },
  { name: '美股石油', group: '板块数据', positions: [{ code: 'XLE', name: '美股Energy Select Sector SPDR' }] },
  { name: '美股天然气', group: '板块数据', positions: [{ code: 'UNG', name: '美股United States Natural Gas Fund' }] },
  { name: '美股铜/有色', group: '板块数据', positions: [{ code: 'COPX', name: '美股Global X Copper Miners ETF' }] },
  { name: '美股黄金', group: '板块数据', positions: [{ code: 'GLD', name: '美股SPDR Gold Shares' }] },
  { name: '美股银行金融', group: '板块数据', positions: [{ code: 'XLF', name: '美股Financial Select Sector SPDR' }] },
  { name: '美股生物医药', group: '板块数据', positions: [{ code: 'XBI', name: '美股SPDR S&P Biotech ETF' }] },
  { name: '美股消费', group: '板块数据', positions: [{ code: 'XLY', name: '美股Consumer Discretionary Select Sector SPDR' }] },
  single('布伦特原油', 'BZ=F', 'Brent Crude Oil Futures'),
  single('恐慌指数', '^VIX', 'CBOE Volatility Index'),
  single('美元强弱', 'DX-Y.NYB', 'US Dollar Index'),
  single('美债长债', 'TLT', 'iShares 20+ Year Treasury Bond ETF'),
  single('白银', 'SLV', 'iShares Silver Trust'),
  single('铜', 'CPER', 'United States Copper Index Fund'),
];

export const US_SECTOR_SYMBOLS = Array.from(
  new Map(
    US_SECTOR_FUND_PRESETS.flatMap((preset) => preset.positions).map((position) => [position.code, position])
  ).values()
);

const LEGACY_DEFAULT_POSITIONS = new Map([
  ['600519', { name: '贵州茅台', shares: 100, avgCost: 1680 }],
  ['000858', { name: '五粮液', shares: 2000, avgCost: 145 }],
  ['600036', { name: '招商银行', shares: 5000, avgCost: 35.8 }],
  ['000001', { name: '平安银行', shares: 5000, avgCost: 12.5 }],
]);

function stablePresetId(name: string): string {
  const encodedName = Array.from(name, (character) => character.codePointAt(0)!.toString(36)).join('_');
  return `us_sector_${encodedName}`;
}

function stripUSSubsetPrefix(name: string): string {
  return name.replace(/^美股(?=.)/, '');
}

export function createUSSectorPresetFunds(createdAt = new Date().toISOString()): Fund[] {
  return US_SECTOR_FUND_PRESETS.map((preset) => {
    const rawWeights = preset.positions.map((position) => {
      const explicitWeight = Number(position.weight);
      return Number.isFinite(explicitWeight) && explicitWeight > 0 ? explicitWeight : 1;
    });
    const totalWeight = rawWeights.reduce((total, weight) => total + weight, 0);

    return {
      id: stablePresetId(preset.name),
      name: stripUSSubsetPrefix(preset.name),
      market: DEFAULT_PORTFOLIO_MARKET,
      initialCapital: US_SECTOR_INITIAL_CAPITAL,
      positions: preset.positions.map((position, index) => {
        const targetWeight = (rawWeights[index] / totalWeight) * 100;
        const allocatedCapital = US_SECTOR_INITIAL_CAPITAL * targetWeight / 100;
        return {
          code: position.code,
          name: position.name,
          shares: allocatedCapital,
          avgCost: 1,
          currentPrice: 1,
          prevClose: 1,
          targetWeight,
        };
      }),
      navHistory: [],
      createdAt,
    };
  });
}

function isLegacyDefaultFundSet(funds: Fund[]): boolean {
  if (funds.length !== 1) return false;
  const [fund] = funds;
  if (
    fund.id !== 'fund_1'
    || fund.name !== '锋行成长1号'
    || fund.market !== 'a'
    || fund.initialCapital !== 1_000_000
    || fund.positions.length !== LEGACY_DEFAULT_POSITIONS.size
    || fund.navHistory.length !== 0
    || fund.lastSyncDate !== undefined
    || fund.shareToken !== undefined
  ) return false;

  const positionsByCode = new Map(fund.positions.map((position) => [position.code, position]));
  return positionsByCode.size === LEGACY_DEFAULT_POSITIONS.size
    && [...LEGACY_DEFAULT_POSITIONS].every(([code, expected]) => {
      const actual = positionsByCode.get(code);
      return actual?.name === expected.name
        && actual.shares === expected.shares
        && actual.avgCost === expected.avgCost
        && actual.currentPrice === expected.avgCost
        && actual.prevClose === undefined
        && actual.targetWeight === undefined;
    });
}

export type FundSetSource = 'missing' | 'legacy' | 'preset' | 'custom';

const PRESET_IDENTITIES = new Set(
  US_SECTOR_FUND_PRESETS.flatMap((preset) => [
    `${stablePresetId(preset.name)}\0${preset.name}`,
    `${stablePresetId(preset.name)}\0${stripUSSubsetPrefix(preset.name)}`,
  ]),
);

export function migrateUSSubsetNames(funds: Fund[]): Fund[] {
  const hasPrefixedUSSubset = funds.some(
    (fund) => fund.market === 'us' && stripUSSubsetPrefix(fund.name) !== fund.name,
  );
  if (!hasPrefixedUSSubset) return funds;

  return funds.map((fund) => {
    if (fund.market !== 'us') return fund;
    const name = stripUSSubsetPrefix(fund.name);
    return name === fund.name ? fund : { ...fund, name };
  });
}

export function classifyFundSet(funds: Fund[]): FundSetSource {
  if (funds.length === 0) return 'missing';
  if (isLegacyDefaultFundSet(funds)) return 'legacy';
  if (
    funds.length === US_SECTOR_FUND_PRESETS.length
    && funds.every((fund) =>
      fund.market === DEFAULT_PORTFOLIO_MARKET
      && PRESET_IDENTITIES.has(`${fund.id}\0${fund.name}`)
    )
  ) return 'preset';
  return 'custom';
}

export function shouldPreferLocalFundSource(options: {
  localSource: FundSetSource;
  localTime: number;
  backendSource: FundSetSource;
  backendTime: number;
}): boolean {
  if (options.localSource === 'missing') return false;
  if (options.backendSource === 'legacy' && options.localSource !== 'legacy') return true;
  if (options.backendSource === 'custom' && options.localSource !== 'custom') return false;
  if (
    options.localSource === 'legacy'
    && options.backendSource !== 'legacy'
    && options.backendSource !== 'missing'
  ) return false;
  return options.localTime > options.backendTime;
}

export function migrateLegacyDefaultFunds(
  funds: Fund[],
  createdAt?: string,
): Fund[] {
  if (!isLegacyDefaultFundSet(funds)) return funds;
  return createUSSectorPresetFunds(createdAt ?? funds[0].createdAt ?? new Date().toISOString());
}

export function applyTargetWeightQuote(
  position: Position,
  quote: { currentPrice: number; prevClose: number },
  initialCapital: number,
): Position {
  const currentPrice = Number(quote.currentPrice);
  const prevClose = Number(quote.prevClose);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return position;

  const targetWeight = Number(position.targetWeight);
  const hasTargetWeight = Number.isFinite(targetWeight) && targetWeight > 0;
  const shouldRebalance = hasTargetWeight
    && Number.isFinite(initialCapital)
    && initialCapital > 0;
  const usesPlaceholderPrice = position.avgCost === 1
    && position.currentPrice === 1
    && position.prevClose === 1;
  if (hasTargetWeight && usesPlaceholderPrice && !shouldRebalance) return position;

  return {
    ...position,
    shares: shouldRebalance
      ? (initialCapital * targetWeight / 100) / currentPrice
      : position.shares,
    avgCost: usesPlaceholderPrice ? currentPrice : position.avgCost,
    currentPrice,
    prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : position.prevClose,
  };
}

export function calculatePortfolioMarketValue(positions: Position[]): number {
  return positions.reduce(
    (total, position) => total + position.shares * (position.currentPrice ?? position.avgCost),
    0,
  );
}

export function hasUninitializedTargetWeightPositions(positions: Position[]): boolean {
  return positions.some((position) => {
    const targetWeight = Number(position.targetWeight);
    return Number.isFinite(targetWeight)
      && targetWeight > 0
      && position.avgCost === 1
      && position.currentPrice === 1
      && position.prevClose === 1;
  });
}

export function getTargetWeightRebalanceCapital(
  positions: Position[],
  prices: Record<string, { currentPrice: number; prevClose: number }>,
  initialCapital: number,
): number | null {
  if (positions.length === 0) return null;
  const allPositionsHaveTargets = positions.every((position) => {
    const targetWeight = Number(position.targetWeight);
    return Number.isFinite(targetWeight) && targetWeight > 0;
  });
  if (!allPositionsHaveTargets) return null;

  const allQuotesAreFresh = positions.every((position) => {
    const currentPrice = Number(prices[position.code]?.currentPrice);
    return Number.isFinite(currentPrice) && currentPrice > 0;
  });
  if (!allQuotesAreFresh) return null;

  const allPositionsUsePlaceholders = positions.every((position) =>
    position.avgCost === 1 && position.currentPrice === 1 && position.prevClose === 1
  );
  if (allPositionsUsePlaceholders) {
    return Number.isFinite(initialCapital) && initialCapital > 0 ? initialCapital : null;
  }

  const currentEquity = positions.reduce(
    (total, position) => total + position.shares * Number(prices[position.code].currentPrice),
    0,
  );
  return Number.isFinite(currentEquity) && currentEquity > 0 ? currentEquity : null;
}
