const TITLE_RULES = [
  { label: '退市风险', score: -9, pattern: /退市风险|终止上市/ },
  { label: '立案调查', score: -8, pattern: /立案|调查通知书/ },
  { label: '行政处罚', score: -6, pattern: /行政处罚|监管措施|警示函/ },
  { label: '重大亏损', score: -6, pattern: /重大亏损|首亏|续亏/ },
  { label: '业绩预减', score: -5, pattern: /业绩预减|预亏/ },
  { label: '冻结诉讼', score: -5, pattern: /冻结|诉讼|仲裁/ },
  { label: '质押风险', score: -4, pattern: /质押.*风险|风险.*质押/ },
  { label: '股东减持', score: -4, pattern: /减持/, exclude: /不减持/ },
  { label: '股份回购', score: 6, pattern: /股份回购|回购.*股份/ },
  { label: '业绩改善', score: 6, pattern: /业绩预增|扭亏为盈|扭亏/ },
  { label: '重大合同', score: 5, pattern: /中标|重大合同|签订.*合同/ },
  { label: '股东增持', score: 4, pattern: /增持/ },
  { label: '分红方案', score: 3, pattern: /现金分红|利润分配/ },
  { label: '获得批复', score: 3, pattern: /获得.*批复|收到.*批复|获批/ },
];

const A_SHARE_CODE = /^[036]\d{5}$/;

export function buildPortfolioUniverse(fundsData = {}) {
  const universe = new Map();

  for (const fund of Array.isArray(fundsData.funds) ? fundsData.funds : []) {
    const subset = String(fund?.name || '').trim();
    for (const position of Array.isArray(fund?.positions) ? fund.positions : []) {
      const code = String(position?.code || '').trim();
      if (!A_SHARE_CODE.test(code) || Number(position?.shares) <= 0) continue;

      const name = String(position?.name || '').trim();
      const existing = universe.get(code);
      if (existing) {
        if (!existing.name && name) existing.name = name;
        if (subset && !existing.subsets.includes(subset)) existing.subsets.push(subset);
      } else {
        universe.set(code, { code, name, subsets: subset ? [subset] : [] });
      }
    }
  }

  return universe;
}

export function classifyAnnouncementTitle(title) {
  const normalizedTitle = String(title || '');
  const matchedRules = TITLE_RULES.filter((rule) => (
    rule.pattern.test(normalizedTitle) && !(rule.exclude?.test(normalizedTitle))
  ));
  const score = clamp(matchedRules.reduce((sum, rule) => sum + rule.score, 0));

  return {
    score,
    direction: score > 0 ? 'good' : score < 0 ? 'bad' : 'neutral',
    matchedRules: matchedRules.map((rule) => rule.label),
  };
}

export function buildDirectCninfoSummary({
  date,
  totalCount,
  announcements = [],
  universe = new Map(),
  generatedAt,
} = {}) {
  const matchedAnnouncements = (Array.isArray(announcements) ? announcements : [])
    .filter((item) => universe instanceof Map && universe.has(String(item?.secCode || '').trim()));
  const grouped = new Map();

  for (const item of matchedAnnouncements) {
    const code = String(item.secCode || '').trim();
    const classified = classifyAnnouncementTitle(item.announcementTitle);
    const current = grouped.get(code) || [];
    current.push({ ...item, classified });
    grouped.set(code, current);
  }

  let neutralFiltered = 0;
  const allGood = [];
  const allBad = [];
  for (const [code, companyAnnouncements] of grouped) {
    neutralFiltered += companyAnnouncements.filter((item) => item.classified.direction === 'neutral').length;
    const score = clamp(companyAnnouncements.reduce((sum, item) => sum + item.classified.score, 0));
    if (score === 0) continue;

    const company = universe.get(code);
    const main = chooseMainAnnouncement(companyAnnouncements);
    const entry = {
      code,
      name: company.name || String(main.secName || '').trim(),
      subset: company.subsets.join('；'),
      score,
      title: String(main.announcementTitle || ''),
      summary: `标题规则：${main.classified.matchedRules.join('、') || '未命中'}；仅基于公告标题判断。`,
      url: String(main.adjunctUrl || ''),
      annCount: companyAnnouncements.length,
      time: Number.isFinite(Number(main.announcementTime)) && Number(main.announcementTime) > 0
        ? new Date(Number(main.announcementTime)).toISOString()
        : '',
    };
    (score > 0 ? allGood : allBad).push(entry);
  }

  allGood.sort(compareGood);
  allBad.sort(compareBad);
  addRanks(allGood);
  addRanks(allBad);

  return {
    kind: 'cninfo',
    date,
    reportDate: String(date || '').slice(2).replaceAll('-', ''),
    generatedAt,
    coverage: `${date} 沪深市场`,
    totalCount,
    watchlistHits: matchedAnnouncements.length,
    topGood: allGood.slice(0, 5),
    topBad: allBad.slice(0, 5),
    allGood,
    allBad,
    files: [],
    stats: { goodCount: allGood.length, badCount: allBad.length, neutralFiltered },
    sentiment: {
      summary: `持仓命中 ${matchedAnnouncements.length} 条，利好 ${allGood.length} 家，利空 ${allBad.length} 家`,
      goodSectors: [],
      badSectors: [],
      netScore: allGood.reduce((sum, item) => sum + item.score, 0)
        + allBad.reduce((sum, item) => sum + item.score, 0),
    },
  };
}

function clamp(score) {
  return Math.max(-10, Math.min(10, score));
}

function chooseMainAnnouncement(announcements) {
  return [...announcements].sort((left, right) => (
    Math.abs(right.classified.score) - Math.abs(left.classified.score)
    || Number(right.announcementTime || 0) - Number(left.announcementTime || 0)
  ))[0];
}

function compareGood(left, right) {
  return right.score - left.score || left.code.localeCompare(right.code);
}

function compareBad(left, right) {
  return left.score - right.score || left.code.localeCompare(right.code);
}

function addRanks(items) {
  items.forEach((item, index) => {
    item.rank = index + 1;
  });
}
