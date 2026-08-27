import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyScreenshotBackfill } from '../lib/iceCdsScreenshotBackfill.js';
import { buildIceCdsWorkbook, readIceCdsWorkbook } from '../lib/iceCdsWorkbook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ICE_CDS_DATA_DIR || path.join(__dirname, '../data/ai-dashboard/ice-cds');
const workbookFile = path.join(dataDir, 'ice-cds-history.xlsx');
const backupFile = path.join(dataDir, 'ice-cds-history.before-screenshot-backfill.xlsx');
const temporaryFile = path.join(dataDir, `ice-cds-history.${process.pid}.backfill.tmp.xlsx`);

const currentBuffer = await fs.promises.readFile(workbookFile);
const state = await readIceCdsWorkbook(currentBuffer);
const updated = applyScreenshotBackfill(state);
const screenshotRows = updated.derivedRows.filter((row) => row.modelVersion === 'screenshot-backfill-v1');

await fs.promises.copyFile(workbookFile, backupFile, fs.constants.COPYFILE_EXCL).catch((error) => {
  if (error.code !== 'EEXIST') throw error;
});
await fs.promises.writeFile(temporaryFile, await buildIceCdsWorkbook(updated));
await readIceCdsWorkbook(await fs.promises.readFile(temporaryFile));
await fs.promises.rename(temporaryFile, workbookFile);

process.stdout.write(`${JSON.stringify({
  companies: new Set(screenshotRows.map((row) => row.company)).size,
  historyPoints: screenshotRows.length,
  from: screenshotRows.map((row) => row.clearingDate).sort()[0],
  through: screenshotRows.map((row) => row.clearingDate).sort().at(-1),
  workbook: path.relative(process.cwd(), workbookFile),
}, null, 2)}\n`);
