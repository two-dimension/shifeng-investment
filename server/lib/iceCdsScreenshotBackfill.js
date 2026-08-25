import { ICE_CDS_CONTRACT_REGISTRY } from './iceCdsRegistry.js';

const MODEL_VERSION = 'screenshot-backfill-v1';
const BATCH_ID = 'screenshot-reference-20260824-v1';
const END_DATE = '2026-08-21';

const SERIES = Object.freeze({
  Oracle: [
    ['2026-06-10', 160], ['2026-06-15', 154], ['2026-06-22', 160], ['2026-06-29', 171],
    ['2026-07-06', 169], ['2026-07-13', 187], ['2026-07-20', 188], ['2026-07-24', 205],
    ['2026-07-29', 217], ['2026-08-03', 201], ['2026-08-06', 189], ['2026-08-10', 195],
    ['2026-08-13', 199], ['2026-08-17', 192], ['2026-08-21', 214],
  ],
  CoreWeave: [
    ['2026-06-10', 510], ['2026-06-17', 480], ['2026-06-24', 555], ['2026-06-29', 550],
    ['2026-07-02', 585], ['2026-07-08', 600], ['2026-07-10', 575], ['2026-07-17', 680],
    ['2026-07-21', 690], ['2026-07-27', 750], ['2026-07-30', 950], ['2026-08-03', 820],
    ['2026-08-06', 710], ['2026-08-10', 760], ['2026-08-14', 740], ['2026-08-17', 670],
    ['2026-08-21', 790],
  ],
  NVIDIA: [
    ['2026-06-22', 40], ['2026-06-29', 46], ['2026-07-08', 45], ['2026-07-14', 57],
    ['2026-07-20', 59], ['2026-07-24', 70], ['2026-07-27', 80], ['2026-07-30', 82],
    ['2026-08-06', 68], ['2026-08-10', 76], ['2026-08-13', 72], ['2026-08-17', 82],
    ['2026-08-21', 87],
  ],
  Amazon: [
    ['2026-06-10', 51], ['2026-06-17', 50], ['2026-06-24', 54], ['2026-07-02', 55],
    ['2026-07-06', 53], ['2026-07-13', 60], ['2026-07-17', 57], ['2026-07-22', 59],
    ['2026-07-27', 67], ['2026-07-30', 69], ['2026-08-03', 57], ['2026-08-07', 55],
    ['2026-08-10', 57], ['2026-08-14', 53], ['2026-08-21', 65],
  ],
  Google: [
    ['2026-06-10', 50], ['2026-06-17', 49], ['2026-06-24', 52], ['2026-07-01', 54],
    ['2026-07-06', 53], ['2026-07-13', 60], ['2026-07-17', 57], ['2026-07-21', 59],
    ['2026-07-24', 64], ['2026-07-29', 67], ['2026-08-03', 56], ['2026-08-07', 55],
    ['2026-08-13', 51], ['2026-08-17', 56], ['2026-08-21', 59],
  ],
  Microsoft: [
    ['2026-06-10', 39], ['2026-06-17', 38], ['2026-06-24', 40], ['2026-06-29', 42],
    ['2026-07-06', 41], ['2026-07-13', 48], ['2026-07-17', 47], ['2026-07-22', 48],
    ['2026-07-27', 52], ['2026-07-30', 55], ['2026-08-03', 47], ['2026-08-07', 46],
    ['2026-08-13', 41], ['2026-08-17', 45], ['2026-08-21', 48],
  ],
  Meta: [
    ['2026-06-10', 71], ['2026-06-17', 69], ['2026-06-24', 71], ['2026-07-02', 68],
    ['2026-07-06', 69], ['2026-07-13', 79], ['2026-07-17', 76], ['2026-07-22', 79],
    ['2026-07-27', 93], ['2026-07-30', 98], ['2026-08-03', 83], ['2026-08-10', 86],
    ['2026-08-14', 80], ['2026-08-18', 91], ['2026-08-21', 96],
  ],
});

function dateMs(value) {
  return new Date(`${value}T00:00:00.000Z`).getTime();
}

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function interpolateSeries(anchors) {
  const points = [];
  const start = dateMs(anchors[0][0]);
  const end = dateMs(END_DATE);
  let anchorIndex = 0;
  for (let cursor = start; cursor <= end; cursor += 24 * 60 * 60 * 1000) {
    const day = new Date(cursor).getUTCDay();
    if (day === 0 || day === 6) continue;
    while (anchorIndex < anchors.length - 2 && cursor > dateMs(anchors[anchorIndex + 1][0])) anchorIndex += 1;
    const [leftDate, leftValue] = anchors[anchorIndex];
    const [rightDate, rightValue] = anchors[Math.min(anchorIndex + 1, anchors.length - 1)];
    const left = dateMs(leftDate);
    const right = dateMs(rightDate);
    const ratio = right === left ? 0 : Math.max(0, Math.min(1, (cursor - left) / (right - left)));
    points.push({
      date: isoDate(cursor),
      valueBp: Math.round((leftValue + ((rightValue - leftValue) * ratio)) * 100) / 100,
    });
  }
  return points;
}

export function generateScreenshotBackfillRows() {
  return ICE_CDS_CONTRACT_REGISTRY.flatMap((definition) => {
    const anchors = SERIES[definition.company];
    if (!anchors) return [];
    return interpolateSeries(anchors).map((point) => ({
      batchId: BATCH_ID,
      clearingDate: point.date,
      company: definition.company,
      instrumentName: `SCREENSHOT.${definition.symbols[0]}.5Y`,
      eodPrice: null,
      couponBp: definition.couponBp,
      spreadBp: point.valueBp,
      maturityDate: '2031-06-20',
      roundTripPrice: null,
      priceResidual: null,
      hazardRate: null,
      curveId: 'screenshot-reference-not-applicable',
      recoveryRate: 0.4,
      modelVersion: MODEL_VERSION,
      qualityStatus: 'stale',
      officialSpreadBp: null,
      relativeError: null,
      sourceUrl: null,
    }));
  });
}

export function applyScreenshotBackfill(state, { generatedAt = new Date().toISOString() } = {}) {
  const liveRows = (state.derivedRows || []).filter((row) => row.modelVersion !== MODEL_VERSION);
  const validationLog = (state.validationLog || []).filter((row) => row.code !== 'screenshot-history-backfill');
  validationLog.push({
    batchId: BATCH_ID,
    createdAt: generatedAt,
    level: 'warning',
    code: 'screenshot-history-backfill',
    company: '',
    message: '2026-06-10 through 2026-08-21 history was digitized from the supplied chart image; values are visual references, not official ICE observations.',
  });
  const baseNote = String(state.methodology?.note || '').replace(/ Screenshot history[^.]*\./g, '').trim();
  return {
    ...state,
    generatedAt,
    derivedRows: [...liveRows, ...generateScreenshotBackfillRows()],
    validationLog,
    methodology: {
      ...(state.methodology || {}),
      note: `${baseNote}${baseNote ? ' ' : ''}Screenshot history is a digitized visual reference; live points use the ICE EOD conversion model.`,
    },
  };
}
