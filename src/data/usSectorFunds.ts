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
