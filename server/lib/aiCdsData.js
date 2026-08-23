function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeChange(value) {
  const number = finiteNumber(value);
  return number === null ? null : number;
}

export function normalizeCdsDataset(dataset) {
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) {
    throw new Error('CDS dataset must be an object');
  }
  if (!validDate(dataset.asOf)) throw new Error('CDS dataset asOf must be YYYY-MM-DD');

  const companies = (Array.isArray(dataset.companies) ? dataset.companies : []).flatMap((row) => {
    const company = String(row?.company || '').trim();
    const latestBp = finiteNumber(row?.latestBp);
    if (!company || latestBp === null || latestBp < 0) return [];

    const historyByDate = new Map();
    for (const point of Array.isArray(row?.history) ? row.history : []) {
      const valueBp = finiteNumber(point?.valueBp);
      if (!validDate(point?.date) || valueBp === null || valueBp < 0) continue;
      historyByDate.set(point.date, { date: point.date, valueBp });
    }

    return [{
      company,
      latestBp,
      changes: {
        oneDayBp: normalizeChange(row?.changes?.oneDayBp),
        sevenDayBp: normalizeChange(row?.changes?.sevenDayBp),
        oneMonthBp: normalizeChange(row?.changes?.oneMonthBp),
      },
      history: [...historyByDate.values()].sort((left, right) => left.date.localeCompare(right.date)),
    }];
  });

  return {
    asOf: dataset.asOf,
    sourceLabel: String(dataset.sourceLabel || '平台数据').trim() || '平台数据',
    sourceUrl: typeof dataset.sourceUrl === 'string' && dataset.sourceUrl.trim() ? dataset.sourceUrl.trim() : null,
    historyEstimated: dataset.historyEstimated === true,
    note: typeof dataset.note === 'string' ? dataset.note.trim() : '',
    companies,
  };
}
