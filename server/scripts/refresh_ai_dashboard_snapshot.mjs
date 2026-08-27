import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAiDashboardSeedPayload } from '../lib/aiDashboardSeedData.js';
import { enqueueIceCdsSnapshotWrite } from '../lib/iceCdsSnapshotWriteQueue.js';
import {
  createAiDashboardServiceFromEnv,
  createEmptyAiDashboardSnapshot,
  DEFAULT_AI_DASHBOARD_FILE,
} from '../lib/aiDashboardService.js';
import { DASHBOARD_SOURCE_KEYS } from '../lib/publicSourceRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_FILE = path.join(__dirname, '../data/ai-dashboard/research-ledger.json');

async function writeSnapshot(file, snapshot) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.seed.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await fs.promises.rename(temporary, file);
}

async function readExistingSnapshot(file) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function localDate(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export async function seedDashboardSnapshot({
  dataFile = DEFAULT_AI_DASHBOARD_FILE,
  ledgerFile = LEDGER_FILE,
  now = new Date(),
} = {}) {
  return enqueueIceCdsSnapshotWrite(async () => {
    const generatedAt = now.toISOString();
    const ledger = JSON.parse(await fs.promises.readFile(ledgerFile, 'utf8'));
    const payload = buildAiDashboardSeedPayload(ledger, { generatedAt, now });
    const empty = createEmptyAiDashboardSnapshot(generatedAt);
    const previous = await readExistingSnapshot(dataFile);
    const snapshot = {
      ...empty,
      ...(previous || {}),
      ...payload,
      schemaVersion: 2,
      generatedAt,
      sources: {
        ...empty.sources,
        ...(previous?.sources || {}),
        growth: {
          status: 'ready', stale: true, asOf: localDate(now), syncedAt: generatedAt,
          url: 'https://www.yipitdata.com/',
          message: '已从核验台账载入 Yipit 独立估算与公司官网 ARR / run-rate revenue，等待实时官网刷新',
        },
        capital: {
          status: 'ready', stale: true, asOf: localDate(now), syncedAt: generatedAt,
          url: 'https://www.anthropic.com/news/series-h',
          message: '已从核验台账载入融资事件，等待官网与监管源刷新',
        },
      },
    };
    await writeSnapshot(dataFile, snapshot);
    return snapshot;
  }, { lockFile: `${dataFile}.lock` });
}

export async function refreshDashboardSnapshot({
  argv = [],
  seed = seedDashboardSnapshot,
  createService = createAiDashboardServiceFromEnv,
  output = process.stdout,
} = {}) {
  const seedOnly = argv.includes('--seed-only');
  const sourceOption = argv.find((arg) => arg.startsWith('--sources='));
  const sources = sourceOption ? sourceOption.slice('--sources='.length).split(',').filter(Boolean) : DASHBOARD_SOURCE_KEYS;
  if (seedOnly) {
    await seed();
    output.write('AI dashboard schema-v2 seed snapshot written.\n');
    return;
  }
  const service = createService();
  const snapshot = await service.refresh({ sources, force: true });
  const statuses = Object.fromEntries(Object.entries(snapshot.sources).map(([key, value]) => [key, value.status]));
  output.write(`${JSON.stringify({ generatedAt: snapshot.generatedAt, statuses }, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  return refreshDashboardSnapshot({ argv });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
