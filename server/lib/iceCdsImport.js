import { ICE_CDS_CONTRACT_REGISTRY } from './iceCdsRegistry.js';

const REQUIRED_HEADERS = ['Clearing Date', 'Name', 'Instrument Name', 'EOD Price'];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class IceCdsImportError extends Error {
  constructor(message, { code = 'invalid-input', rowNumber = null } = {}) {
    super(message);
    this.name = 'IceCdsImportError';
    this.code = code;
    this.rowNumber = rowNumber;
  }
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (quoted) throw new IceCdsImportError('ICE table contains an unterminated quoted field');
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ''));
}

function assertHeaders(headers) {
  const normalized = headers.map((value) => value.replace(/^\uFEFF/, '').trim());
  if (normalized.length !== REQUIRED_HEADERS.length
    || REQUIRED_HEADERS.some((header, index) => normalized[index] !== header)) {
    throw new IceCdsImportError(`ICE table headers must be: ${REQUIRED_HEADERS.join(', ')}`, { code: 'invalid-headers' });
  }
}

export function parseIceInstrumentName(value) {
  const instrumentName = String(value || '').trim().toUpperCase();
  const match = instrumentName.match(/^([^.]+)\.([^.]+)\.([A-Z]{3})\.([^.]+)\.(\d+(?:\.\d+)?)\.(\d{4}-\d{2}-\d{2})$/);
  if (!match || !validDate(match[6])) {
    throw new IceCdsImportError(`Invalid ICE instrument name: ${value || '(empty)'}`, { code: 'invalid-instrument' });
  }
  const couponBp = Number(match[5]);
  if (!Number.isFinite(couponBp) || couponBp <= 0) {
    throw new IceCdsImportError(`Invalid ICE instrument coupon: ${match[5]}`, { code: 'invalid-instrument' });
  }
  return {
    symbol: match[1],
    tier: match[2],
    currency: match[3],
    restructuring: match[4],
    couponBp,
    maturityDate: match[6],
  };
}

export function parseIceSettlementText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new IceCdsImportError('ICE table text is empty', { code: 'empty-input' });
  }
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  const records = parseDelimited(text, delimiter);
  if (records.length === 0) throw new IceCdsImportError('ICE table text is empty', { code: 'empty-input' });
  assertHeaders(records[0]);

  return records.slice(1).map((cells, index) => {
    const rowNumber = index + 2;
    if (cells.length !== REQUIRED_HEADERS.length) {
      throw new IceCdsImportError(`ICE row ${rowNumber} has ${cells.length} fields; expected 4`, {
        code: 'invalid-row', rowNumber,
      });
    }
    const clearingDate = cells[0].trim();
    const name = cells[1].trim();
    const instrumentName = cells[2].trim();
    const eodPriceText = cells[3].trim();
    if (!validDate(clearingDate)) {
      throw new IceCdsImportError(`ICE row ${rowNumber} has an invalid clearing date`, {
        code: 'invalid-date', rowNumber,
      });
    }
    const eodPrice = Number(eodPriceText);
    if (eodPriceText === '' || !Number.isFinite(eodPrice) || eodPrice < 0) {
      throw new IceCdsImportError(`ICE row ${rowNumber} has an invalid EOD Price`, {
        code: 'invalid-price', rowNumber,
      });
    }
    if (!name || !instrumentName) {
      throw new IceCdsImportError(`ICE row ${rowNumber} is missing issuer or instrument`, {
        code: 'invalid-row', rowNumber,
      });
    }
    parseIceInstrumentName(instrumentName);
    return { clearingDate, name, instrumentName, eodPrice, rowNumber };
  });
}

function yearsBetween(startDate, endDate) {
  return (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / MS_PER_DAY / 365.25;
}

function selectionError(company, code, message, candidates = []) {
  return {
    company,
    code,
    message,
    candidateRows: candidates.map((candidate) => candidate.rowNumber),
  };
}

export function selectTrackedFiveYearContracts(rows, clearingDate, {
  registry = ICE_CDS_CONTRACT_REGISTRY,
} = {}) {
  if (!Array.isArray(rows)) throw new IceCdsImportError('ICE rows must be an array');
  if (!validDate(clearingDate)) throw new IceCdsImportError('Selection clearing date must be YYYY-MM-DD', { code: 'invalid-date' });

  const selected = [];
  const errors = [];
  const datedRows = rows.filter((row) => row?.clearingDate === clearingDate);
  for (const definition of registry) {
    const acceptedNames = new Set([definition.company, ...definition.aliases].map(normalizeName));
    const issuerRows = datedRows.filter((row) => acceptedNames.has(normalizeName(row.name)));
    if (issuerRows.length === 0) {
      errors.push(selectionError(definition.company, 'missing-issuer', `No ${definition.company} rows for ${clearingDate}`));
      continue;
    }

    const candidates = issuerRows.flatMap((row) => {
      let contract;
      try {
        contract = parseIceInstrumentName(row.instrumentName);
      } catch {
        return [];
      }
      const tenorYears = yearsBetween(clearingDate, contract.maturityDate);
      const matches = definition.symbols.includes(contract.symbol)
        && contract.currency === definition.currency
        && contract.tier === definition.tier
        && contract.restructuring === definition.restructuring
        && contract.couponBp === definition.couponBp
        && tenorYears >= 4.5
        && tenorYears <= 5.5;
      return matches ? [{ ...row, contract, tenorYears }] : [];
    }).sort((left, right) => (
      Math.abs(left.tenorYears - 5) - Math.abs(right.tenorYears - 5)
      || left.instrumentName.localeCompare(right.instrumentName)
      || left.rowNumber - right.rowNumber
    ));

    if (candidates.length === 0) {
      errors.push(selectionError(
        definition.company,
        'no-canonical-contract',
        `No ${definition.company} row matches the registered 5Y contract`,
        issuerRows,
      ));
    } else if (candidates.length > 1) {
      errors.push(selectionError(
        definition.company,
        'ambiguous-contract',
        `Multiple ${definition.company} rows match the registered 5Y contract`,
        candidates,
      ));
    } else {
      selected.push({ company: definition.company, ...candidates[0] });
    }
  }

  return { selected, errors };
}

