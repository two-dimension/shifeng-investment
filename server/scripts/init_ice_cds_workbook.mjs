import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICE_CDS_CONTRACT_REGISTRY } from '../lib/iceCdsRegistry.js';
import { buildIceCdsWorkbook } from '../lib/iceCdsWorkbook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ICE_CDS_DATA_DIR || path.join(__dirname, '../data/ai-dashboard/ice-cds');
const workbookFile = path.join(dataDir, 'ice-cds-history.xlsx');
const force = process.argv.includes('--force');

await fs.promises.mkdir(dataDir, { recursive: true });
if (!force && fs.existsSync(workbookFile)) {
  console.log(`[ice-cds] workbook already exists: ${workbookFile}`);
  process.exit(0);
}

const generatedAt = new Date().toISOString();
const state = {
  schemaVersion: 1,
  batchId: 'ice-empty-v1',
  generatedAt,
  rawRows: [],
  derivedRows: [],
  curves: [],
  registry: ICE_CDS_CONTRACT_REGISTRY.map((row) => ({ ...row, aliases: [...row.aliases], symbols: [...row.symbols] })),
  validationLog: [{
    batchId: 'ice-empty-v1',
    createdAt: generatedAt,
    level: 'info',
    code: 'initialized-empty',
    company: '',
    message: 'Initialized without screenshot or DTCC values; waiting for the first ICE EOD Price import.',
  }],
  methodology: {
    modelVersion: 'ice-isda-compatible-v1',
    priceTolerance: 0.005,
    relativeBenchmarkTolerance: 0.01,
    note: 'Model-derived unless an official spread benchmark passes validation.',
  },
};
const tempFile = `${workbookFile}.${process.pid}.tmp`;
await fs.promises.writeFile(tempFile, await buildIceCdsWorkbook(state));
await fs.promises.rename(tempFile, workbookFile);
console.log(`[ice-cds] initialized empty audit workbook: ${workbookFile}`);
