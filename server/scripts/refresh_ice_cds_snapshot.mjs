import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIceCdsPipelineFromEnv } from '../lib/iceCdsPipeline.js';
import {
  createIceCdsPublicClient,
  refreshIceCdsFromPublicSources,
} from '../lib/iceCdsPublicSource.js';

const pipeline = createIceCdsPipelineFromEnv();
const client = createIceCdsPublicClient();
const result = await refreshIceCdsFromPublicSources({ client, pipeline });
const workbookPath = path.relative(
  process.cwd(),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'ai-dashboard', 'ice-cds', 'ice-cds-history.xlsx'),
);

process.stdout.write(`${JSON.stringify({
  batchId: result.batchId,
  asOf: result.snapshot.creditRisk.cds5y.asOf,
  companies: result.snapshot.creditRisk.cds5y.companies.length,
  workbook: workbookPath,
}, null, 2)}\n`);
