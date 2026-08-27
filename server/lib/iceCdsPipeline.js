import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCdsDataset } from './aiCdsData.js';
import { parseIceSettlementText, selectTrackedFiveYearContracts } from './iceCdsImport.js';
import { ICE_CDS_CONTRACT_REGISTRY } from './iceCdsRegistry.js';
import { buildIceCdsWorkbook, readIceCdsWorkbook } from './iceCdsWorkbook.js';
import { enqueueIceCdsSnapshotWrite } from './iceCdsSnapshotWriteQueue.js';
import { cleanPriceToParSpread, validateDiscountCurve } from './isdaCdsSpread.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICE_CDS_EOD_URL = 'https://www.ice.com/cds-settlement-prices/icc/single-name-instruments';
const DEFAULT_DATA_DIR = path.join(__dirname, '../data/ai-dashboard/ice-cds');
const DEFAULT_SNAPSHOT_FILE = path.join(__dirname, '../data/ai-dashboard/snapshot.json');
const WORKBOOK_NAME = 'ice-cds-history.xlsx';
const MODEL_VERSION = 'ice-isda-compatible-v1';
const PRICE_TOLERANCE = 0.005;
const RELATIVE_BENCHMARK_TOLERANCE = 0.01;
const MAX_CURRENT_BACKUPS = 30;

export class IceCdsPipelineError extends Error {
  constructor(message, code = 'ice-cds-pipeline-error') {
    super(message);
    this.name = 'IceCdsPipelineError';
    this.code = code;
  }
}

function isoNow(now) {
  return now().toISOString();
}

function canonicalRegistry() {
  return ICE_CDS_CONTRACT_REGISTRY.map((row) => ({
    ...row,
    aliases: [...row.aliases],
    symbols: [...row.symbols],
  }));
}

function normalizeOfficialSpreads(value) {
  if (value === undefined || value === null) return new Map();
  const entries = Array.isArray(value)
    ? value.map((row) => [row?.company, row?.spreadBp])
    : typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).map(([company, spread]) => [company, typeof spread === 'object' ? spread?.spreadBp : spread])
      : null;
  if (!entries) throw new IceCdsPipelineError('officialSpreads must be an object or array', 'invalid-official-spreads');
  const normalized = new Map();
  for (const [companyValue, spreadValue] of entries) {
    const company = String(companyValue || '').trim();
    const spreadBp = Number(spreadValue);
    if (!company || !Number.isFinite(spreadBp) || spreadBp <= 0) {
      throw new IceCdsPipelineError(`Invalid official spread benchmark for ${company || '(missing company)'}`, 'invalid-official-spreads');
    }
    normalized.set(company, spreadBp);
  }
  return normalized;
}

function priorMonth(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  const targetMonth = date.getUTCMonth() - 1;
  const year = date.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay))).toISOString().slice(0, 10);
}

function offsetDate(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Computes signed differences in bp; it never returns percentages. */
export function calculateCdsChanges(history, currentDate) {
  const byDate = new Map();
  for (const point of Array.isArray(history) ? history : []) {
    if (typeof point?.date !== 'string' || !Number.isFinite(point?.valueBp) || point.date > currentDate) continue;
    byDate.set(point.date, { date: point.date, valueBp: point.valueBp });
  }
  const points = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  const currentIndex = points.findIndex((point) => point.date === currentDate);
  if (currentIndex < 0) return { oneDayBp: null, sevenDayBp: null, oneMonthBp: null };
  const current = points[currentIndex];
  const latestAtOrBefore = (target) => {
    for (let index = points.length - 1; index >= 0; index -= 1) {
      if (points[index].date <= target) return points[index];
    }
    return null;
  };
  const previous = currentIndex > 0 ? points[currentIndex - 1] : null;
  const sevenDay = latestAtOrBefore(offsetDate(currentDate, -7));
  const oneMonth = latestAtOrBefore(priorMonth(currentDate));
  return {
    oneDayBp: previous ? current.valueBp - previous.valueBp : null,
    sevenDayBp: sevenDay ? current.valueBp - sevenDay.valueBp : null,
    oneMonthBp: oneMonth ? current.valueBp - oneMonth.valueBp : null,
  };
}

function evaluateQuality(result, officialSpreadBp) {
  if (result.priceResidual > PRICE_TOLERANCE) {
    return {
      qualityStatus: 'needs-review',
      publishable: false,
      officialSpreadBp: officialSpreadBp ?? null,
      relativeError: officialSpreadBp ? Math.abs(result.spreadBp - officialSpreadBp) / officialSpreadBp : null,
      validationMessage: `Price residual ${result.priceResidual.toFixed(6)} exceeds ${PRICE_TOLERANCE}`,
    };
  }
  if (officialSpreadBp === undefined) {
    return {
      qualityStatus: 'model-derived',
      publishable: true,
      officialSpreadBp: null,
      relativeError: null,
      validationMessage: 'No official spread benchmark supplied; model-derived only',
    };
  }
  const absoluteError = Math.abs(result.spreadBp - officialSpreadBp);
  const relativeError = absoluteError / officialSpreadBp;
  const absoluteTolerance = Math.min(2, officialSpreadBp * RELATIVE_BENCHMARK_TOLERANCE);
  const validated = relativeError <= RELATIVE_BENCHMARK_TOLERANCE
    && absoluteError <= absoluteTolerance
    && result.priceResidual <= PRICE_TOLERANCE;
  return {
    qualityStatus: validated ? 'validated' : 'needs-review',
    publishable: validated,
    officialSpreadBp,
    relativeError,
    validationMessage: validated
      ? 'Official benchmark and price residual are within tolerance'
      : `Official benchmark mismatch: ${absoluteError.toFixed(2)} bp / ${(relativeError * 100).toFixed(2)}%`,
  };
}

function batchIdFor(clearingDate, rows, discountCurve) {
  const canonical = JSON.stringify({
    clearingDate,
    curve: discountCurve,
    rows: rows.map((row) => ({
      company: row.company,
      instrumentName: row.instrumentName,
      eodPrice: row.eodPrice,
      spreadBp: row.spreadBp,
      officialSpreadBp: row.officialSpreadBp,
      qualityStatus: row.qualityStatus,
    })),
  });
  return `ice-${clearingDate.replaceAll('-', '')}-${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
}

function previewInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new IceCdsPipelineError('ICE import input is required');
  const rows = parseIceSettlementText(input.iceText);
  const clearingDates = [...new Set(rows.map((row) => row.clearingDate))];
  if (clearingDates.length !== 1) {
    throw new IceCdsPipelineError('Each ICE import batch must contain exactly one clearing date', 'multiple-clearing-dates');
  }
  const clearingDate = clearingDates[0];
  const discountCurve = validateDiscountCurve(input.discountCurve);
  if (discountCurve.asOf > clearingDate) {
    throw new IceCdsPipelineError('Discount curve asOf cannot be after the ICE clearing date', 'future-discount-curve');
  }
  const officialSpreads = normalizeOfficialSpreads(input.officialSpreads);
  const selection = selectTrackedFiveYearContracts(rows, clearingDate);
  const derivedRows = selection.selected.map((selected) => {
    const pricing = cleanPriceToParSpread({
      cleanPrice: selected.eodPrice,
      couponBp: selected.contract.couponBp,
      clearingDate,
      maturityDate: selected.contract.maturityDate,
      recoveryRate: 0.4,
      discountCurve,
    });
    const quality = evaluateQuality(pricing, officialSpreads.get(selected.company));
    return {
      clearingDate,
      company: selected.company,
      name: selected.name,
      instrumentName: selected.instrumentName,
      eodPrice: selected.eodPrice,
      couponBp: selected.contract.couponBp,
      maturityDate: selected.contract.maturityDate,
      spreadBp: pricing.spreadBp,
      roundTripPrice: pricing.roundTripPrice,
      priceResidual: pricing.priceResidual,
      hazardRate: pricing.hazardRate,
      curveId: pricing.curveId,
      recoveryRate: pricing.recoveryRate,
      modelVersion: pricing.modelVersion,
      sourceUrl: ICE_CDS_EOD_URL,
      ...quality,
    };
  });
  const batchId = batchIdFor(clearingDate, derivedRows, discountCurve);
  const rowsWithBatch = derivedRows.map((row) => ({ ...row, batchId }));
  const qualityErrors = rowsWithBatch
    .filter((row) => !row.publishable)
    .map((row) => ({ company: row.company, code: 'needs-review', message: row.validationMessage }));
  const errors = [...selection.errors, ...qualityErrors];
  const warnings = [];
  if (rowsWithBatch.some((row) => row.qualityStatus === 'model-derived')) {
    warnings.push('Rows without an official benchmark are model-derived and are not official ICE spread quotations.');
  }
  return {
    batchId,
    clearingDate,
    rows: rowsWithBatch,
    publishedRows: rowsWithBatch.filter((row) => row.publishable),
    errors,
    warnings,
    blocking: errors.length > 0 || rowsWithBatch.length !== ICE_CDS_CONTRACT_REGISTRY.length,
    discountCurve,
  };
}

async function exists(fsImpl, file) {
  try {
    await fsImpl.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function rowKey(row) {
  return `${row.clearingDate}|${row.company}|${row.instrumentName}`;
}

function sameDerivedRow(left, right) {
  return ['eodPrice', 'couponBp', 'spreadBp', 'roundTripPrice', 'priceResidual', 'hazardRate', 'curveId',
    'recoveryRate', 'modelVersion', 'qualityStatus', 'officialSpreadBp', 'relativeError']
    .every((field) => Object.is(left?.[field] ?? null, right?.[field] ?? null));
}

function createArchiveState(previous, preview, generatedAt) {
  const rawMap = new Map((previous.rawRows || []).map((row) => [rowKey(row), row]));
  const derivedMap = new Map((previous.derivedRows || []).map((row) => [rowKey(row), row]));
  const validationLog = [...(previous.validationLog || [])];
  const logKeys = new Set(validationLog.map((row) => `${row.batchId}|${row.code}|${row.company || ''}`));
  const addLog = (row) => {
    const key = `${row.batchId}|${row.code}|${row.company || ''}`;
    if (!logKeys.has(key)) {
      logKeys.add(key);
      validationLog.push(row);
    }
  };

  for (const row of preview.publishedRows) {
    const key = rowKey(row);
    const prior = derivedMap.get(key);
    if (prior && !sameDerivedRow(prior, row)) {
      addLog({
        batchId: preview.batchId,
        createdAt: generatedAt,
        level: 'warning',
        code: 'corrected-row',
        company: row.company,
        message: `Replaced prior ${row.clearingDate} value: EOD ${prior.eodPrice} → ${row.eodPrice}; spread ${prior.spreadBp} → ${row.spreadBp}`,
      });
    }
    rawMap.set(key, {
      batchId: preview.batchId,
      clearingDate: row.clearingDate,
      company: row.company,
      name: row.name,
      instrumentName: row.instrumentName,
      eodPrice: row.eodPrice,
      sourceUrl: row.sourceUrl,
      importedAt: generatedAt,
    });
    const { name, publishable, validationMessage, ...derived } = row;
    derivedMap.set(key, derived);
    addLog({
      batchId: preview.batchId,
      createdAt: generatedAt,
      level: row.qualityStatus === 'validated' ? 'info' : 'warning',
      code: row.qualityStatus === 'validated' ? 'official-benchmark-ok' : 'model-derived',
      company: row.company,
      message: validationMessage,
    });
  }

  const curveMap = new Map((previous.curves || []).map((curve) => [curve.curveId, curve]));
  curveMap.set(preview.discountCurve.curveId, preview.discountCurve);
  return {
    schemaVersion: 1,
    batchId: preview.batchId,
    generatedAt,
    rawRows: [...rawMap.values()].sort((left, right) => left.clearingDate.localeCompare(right.clearingDate)),
    derivedRows: [...derivedMap.values()].sort((left, right) => left.clearingDate.localeCompare(right.clearingDate)),
    curves: [...curveMap.values()],
    registry: canonicalRegistry(),
    validationLog,
    methodology: {
      modelVersion: MODEL_VERSION,
      priceTolerance: PRICE_TOLERANCE,
      relativeBenchmarkTolerance: RELATIVE_BENCHMARK_TOLERANCE,
      note: 'Model-derived unless an official spread benchmark passes validation.',
    },
  };
}

function createCdsSnapshot(state, preview, generatedAt) {
  const grouped = new Map();
  for (const row of state.derivedRows) {
    if (!grouped.has(row.company)) grouped.set(row.company, []);
    grouped.get(row.company).push(row);
  }
  const companies = ICE_CDS_CONTRACT_REGISTRY.flatMap((definition) => {
    const rows = (grouped.get(definition.company) || []).sort((left, right) => left.clearingDate.localeCompare(right.clearingDate));
    if (rows.length === 0) return [];
    const latest = rows[rows.length - 1];
    const history = rows.map((row) => {
      const isScreenshotBackfill = row.modelVersion === 'screenshot-backfill-v1';
      return {
        date: row.clearingDate,
        valueBp: row.spreadBp,
        ...(!isScreenshotBackfill && Number.isFinite(row.eodPrice) ? { eodPrice: row.eodPrice } : {}),
        ...(!isScreenshotBackfill && row.instrumentName ? { instrumentName: row.instrumentName } : {}),
        qualityStatus: row.qualityStatus,
        ...(isScreenshotBackfill ? { sourceKind: 'screenshot_backfill' } : {}),
      };
    });
    return [{
      company: definition.company,
      latestBp: latest.spreadBp,
      latestEodPrice: latest.eodPrice,
      latestInstrumentName: latest.instrumentName,
      qualityStatus: latest.qualityStatus,
      changes: calculateCdsChanges(history, latest.clearingDate),
      history,
    }];
  });
  const asOf = companies.length > 0
    ? companies.flatMap((company) => company.history.map((point) => point.date)).sort().at(-1)
    : preview.clearingDate;
  const qualityStatus = companies.every((company) => company.qualityStatus === 'validated') ? 'validated' : 'model-derived';
  return normalizeCdsDataset({
    asOf,
    sourceKind: 'ice_eod_isda',
    sourceLabel: 'ICE EOD Price · ISDA 换算值',
    sourceUrl: ICE_CDS_EOD_URL,
    batchId: state.batchId,
    qualityStatus,
    workbookAvailable: true,
    historyEstimated: true,
    note: '2026-06-10 至 2026-08-21 为用户截图曲线回填估算；最新点由 ICE EOD Price 经 ISDA-compatible 模型换算。未经官方基准验证时不代表 ICE 官方 spread。',
    lastCheckedAt: generatedAt,
    companies,
  });
}
async function readSnapshot(fsImpl, snapshotFile, generatedAt) {
  try {
    return JSON.parse(await fsImpl.readFile(snapshotFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { schemaVersion: 2, generatedAt, sources: {}, creditRisk: {} };
  }
}

async function rotateBackups(fsImpl, dataDir, workbookFile, snapshotFile, batchId) {
  const backupsDir = path.join(dataDir, 'backups');
  const archiveDir = path.join(dataDir, 'archive');
  await fsImpl.mkdir(backupsDir, { recursive: true });
  await fsImpl.mkdir(archiveDir, { recursive: true });
  await fsImpl.copyFile(workbookFile, path.join(backupsDir, `${batchId}.xlsx`));
  await fsImpl.copyFile(snapshotFile, path.join(backupsDir, `${batchId}.json`));
  const names = await fsImpl.readdir(backupsDir);
  const xlsxIds = new Set(names.filter((name) => name.endsWith('.xlsx')).map((name) => name.slice(0, -5)));
  const jsonIds = new Set(names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)));
  const pairs = [];
  for (const id of xlsxIds) {
    if (!jsonIds.has(id)) continue;
    const stat = await fsImpl.stat(path.join(backupsDir, `${id}.xlsx`));
    pairs.push({ id, mtimeMs: stat.mtimeMs });
  }
  pairs.sort((left, right) => right.mtimeMs - left.mtimeMs || right.id.localeCompare(left.id));
  for (const { id } of pairs.slice(MAX_CURRENT_BACKUPS)) {
    for (const extension of ['xlsx', 'json']) {
      const from = path.join(backupsDir, `${id}.${extension}`);
      const to = path.join(archiveDir, `${id}.${extension}`);
      await fsImpl.rm(to, { force: true });
      await fsImpl.rename(from, to);
    }
  }
}

async function commitAtomically({ fsImpl, dataDir, snapshotFile, workbookFile, state, snapshot }) {
  await fsImpl.mkdir(dataDir, { recursive: true });
  const stagedWorkbook = path.join(dataDir, `ice-cds-history.${state.batchId}.tmp.xlsx`);
  const stagedSnapshot = path.join(dataDir, `snapshot.${state.batchId}.tmp.json`);
  const lastGoodWorkbook = path.join(dataDir, 'ice-cds-history.last-good.xlsx');
  const lastGoodSnapshot = path.join(dataDir, 'snapshot.last-good.json');
  const workbookBuffer = await buildIceCdsWorkbook(state);
  await fsImpl.writeFile(stagedWorkbook, workbookBuffer);
  await fsImpl.writeFile(stagedSnapshot, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  const stagedState = await readIceCdsWorkbook(await fsImpl.readFile(stagedWorkbook));
  const stagedSnapshotValue = JSON.parse(await fsImpl.readFile(stagedSnapshot, 'utf8'));
  if (stagedState.batchId !== state.batchId || stagedSnapshotValue.creditRisk?.cds5y?.batchId !== state.batchId) {
    throw new IceCdsPipelineError('Staged Excel and JSON batch IDs do not match', 'batch-mismatch');
  }

  const hadWorkbook = await exists(fsImpl, workbookFile);
  const hadSnapshot = await exists(fsImpl, snapshotFile);
  let oldWorkbookMoved = false;
  let oldSnapshotMoved = false;
  let newWorkbookInstalled = false;
  let newSnapshotInstalled = false;
  try {
    await fsImpl.rm(lastGoodWorkbook, { force: true });
    await fsImpl.rm(lastGoodSnapshot, { force: true });
    if (hadWorkbook) {
      await fsImpl.rename(workbookFile, lastGoodWorkbook);
      oldWorkbookMoved = true;
    }
    if (hadSnapshot) {
      await fsImpl.rename(snapshotFile, lastGoodSnapshot);
      oldSnapshotMoved = true;
    }
    await fsImpl.rename(stagedWorkbook, workbookFile);
    newWorkbookInstalled = true;
    await fsImpl.rename(stagedSnapshot, snapshotFile);
    newSnapshotInstalled = true;
  } catch (error) {
    if (newSnapshotInstalled) await fsImpl.rm(snapshotFile, { force: true });
    if (oldSnapshotMoved) await fsImpl.rename(lastGoodSnapshot, snapshotFile);
    if (newWorkbookInstalled) await fsImpl.rm(workbookFile, { force: true });
    if (oldWorkbookMoved) await fsImpl.rename(lastGoodWorkbook, workbookFile);
    throw error;
  } finally {
    await fsImpl.rm(stagedWorkbook, { force: true });
    await fsImpl.rm(stagedSnapshot, { force: true });
  }
  await rotateBackups(fsImpl, dataDir, workbookFile, snapshotFile, state.batchId);
}

export function createIceCdsPipeline({
  dataDir = DEFAULT_DATA_DIR,
  snapshotFile = DEFAULT_SNAPSHOT_FILE,
  fsImpl = fs.promises,
  now = () => new Date(),
  localWriteAllowed = true,
} = {}) {
  const workbookFile = path.join(dataDir, WORKBOOK_NAME);
  let importQueue = Promise.resolve();

  const preview = async (input) => previewInput(input);
  const performImportUnlocked = async (input) => {
    if (!localWriteAllowed) throw new IceCdsPipelineError('Local ICE CDS writes are disabled', 'write-disabled');
    const importPreview = previewInput(input);
    if (importPreview.blocking) {
      throw new IceCdsPipelineError(`ICE CDS import blocked: ${importPreview.errors.map((error) => error.message).join('; ')}`, 'preview-blocked');
    }
    const generatedAt = isoNow(now);
    let previousState;
    try {
      previousState = await readIceCdsWorkbook(await fsImpl.readFile(workbookFile));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      previousState = { rawRows: [], derivedRows: [], curves: [], registry: [], validationLog: [] };
    }
    const state = createArchiveState(previousState, importPreview, generatedAt);
    const previousSnapshot = await readSnapshot(fsImpl, snapshotFile, generatedAt);
    const cds5y = createCdsSnapshot(state, importPreview, generatedAt);
    const snapshot = {
      ...previousSnapshot,
      sources: {
        ...(previousSnapshot.sources || {}),
        creditRisk: {
          status: 'ready',
          stale: false,
          asOf: cds5y.asOf,
          syncedAt: generatedAt,
          url: ICE_CDS_EOD_URL,
          message: `ICE EOD Price 导入成功；${state.batchId}`,
        },
      },
      creditRisk: {
        ...(previousSnapshot.creditRisk || {}),
        cds5y,
      },
    };
    await commitAtomically({ fsImpl, dataDir, snapshotFile, workbookFile, state, snapshot });
    return { snapshot, batchId: state.batchId, workbookPath: workbookFile };
  };
  const performImport = (input) => enqueueIceCdsSnapshotWrite(
    () => performImportUnlocked(input),
    { lockFile: `${snapshotFile}.lock` },
  );

  return {
    preview,
    import(input) {
      const queued = importQueue.then(() => performImport(input));
      importQueue = queued.catch(() => undefined);
      return queued;
    },
    async status() {
      try {
        const state = await readIceCdsWorkbook(await fsImpl.readFile(workbookFile));
        const latestDate = state.derivedRows.map((row) => row.clearingDate).sort().at(-1) || null;
        return {
          available: true,
          localWriteAllowed,
          batchId: state.batchId,
          asOf: latestDate,
          generatedAt: state.generatedAt,
          workbookAvailable: true,
        };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return {
          available: false,
          localWriteAllowed,
          batchId: null,
          asOf: null,
          generatedAt: null,
          workbookAvailable: false,
        };
      }
    },
    async exportWorkbook() {
      try {
        return await fsImpl.readFile(workbookFile);
      } catch (error) {
        if (error.code === 'ENOENT') throw new IceCdsPipelineError('ICE CDS workbook is not available', 'workbook-unavailable');
        throw error;
      }
    },
  };
}

export function createIceCdsPipelineFromEnv(options = {}) {
  return createIceCdsPipeline({
    dataDir: options.dataDir || process.env.ICE_CDS_DATA_DIR || DEFAULT_DATA_DIR,
    snapshotFile: options.snapshotFile || DEFAULT_SNAPSHOT_FILE,
    fsImpl: options.fsImpl,
    now: options.now,
    localWriteAllowed: options.localWriteAllowed ?? process.env.ICE_CDS_LOCAL_WRITES_DISABLED !== '1',
  });
}
