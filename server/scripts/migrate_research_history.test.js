import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildHistoryManifest,
  migrateResearchHistory,
} from './migrate_research_history.mjs';

async function createFixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'research-history-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data');
  const reportsRoot = path.join(root, 'reports');
  const summaries = [
    {
      kind: 'risk',
      date: '2026-08-28',
      totalCount: 2,
      files: [{ filename: '风险.pdf', type: 'pdf', size: 1, url: 'file:///old' }],
    },
    {
      kind: 'cninfo',
      date: '2026-08-27',
      totalCount: 3,
      files: [
        { filename: '公告.pdf', type: 'pdf', size: 1, url: 'file:///old' },
        { filename: 'missing.pdf', type: 'pdf', size: 1, url: 'file:///missing' },
      ],
    },
  ];
  for (const summary of summaries) {
    const dataDir = path.join(dataRoot, summary.kind);
    const reportDir = path.join(reportsRoot, summary.kind, summary.date);
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.mkdir(reportDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dataDir, `${summary.date}.json`),
      JSON.stringify(summary),
    );
  }
  await fs.promises.writeFile(path.join(reportsRoot, 'cninfo', '2026-08-27', '公告.pdf'), 'pdf');
  await fs.promises.writeFile(path.join(reportsRoot, 'cninfo', '2026-08-27', '附表.xlsx'), 'xlsx');
  await fs.promises.writeFile(path.join(reportsRoot, 'risk', '2026-08-28', '风险.pdf'), 'risk');
  return { root, dataRoot, reportsRoot };
}

test('history manifest is deterministic, rewrites URLs, and warns for missing files', async (t) => {
  const fixture = await createFixture(t);
  const warnings = [];
  const manifest = await buildHistoryManifest({
    researchDataDir: fixture.dataRoot,
    reportsDir: fixture.reportsRoot,
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(manifest.summaries.map(({ kind, date }) => `${kind}/${date}`), [
    'cninfo/2026-08-27',
    'risk/2026-08-28',
  ]);
  assert.deepEqual(manifest.files.map(({ kind, date, filename }) => `${kind}/${date}/${filename}`), [
    'cninfo/2026-08-27/公告.pdf',
    'cninfo/2026-08-27/附表.xlsx',
    'risk/2026-08-28/风险.pdf',
  ]);
  assert.deepEqual(manifest.summaries[0].files.map((file) => file.filename), ['公告.pdf']);
  assert.equal(
    manifest.summaries[0].files[0].url,
    '/api/research/files/cninfo/2026-08-27/%E5%85%AC%E5%91%8A.pdf',
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing\.pdf/);
});

test('migration resumes after one uploaded file and never logs its token', async (t) => {
  const fixture = await createFixture(t);
  const manifest = await buildHistoryManifest({
    researchDataDir: fixture.dataRoot,
    reportsDir: fixture.reportsRoot,
    warn() {},
  });
  const checkpointPath = path.join(fixture.root, 'checkpoint.json');
  const uploaded = [];
  const logs = [];
  const token = 'migration-secret-token';
  let attempts = 0;
  const uploadFile = async ({ file }) => {
    attempts += 1;
    if (attempts === 2) throw new Error('planned interruption');
    uploaded.push(`file:${file.kind}/${file.date}/${file.filename}`);
  };

  await assert.rejects(migrateResearchHistory({
    manifest,
    checkpointPath,
    baseUrl: 'https://research.example',
    token,
    uploadFile,
    uploadSummary: async () => {},
    log: (message) => logs.push(message),
  }), /planned interruption/);

  const checkpoint = JSON.parse(await fs.promises.readFile(checkpointPath, 'utf8'));
  assert.deepEqual(checkpoint.uploadedFiles, ['cninfo/2026-08-27/公告.pdf']);

  await migrateResearchHistory({
    manifest,
    checkpointPath,
    baseUrl: 'https://research.example',
    token,
    uploadFile: async ({ file }) => uploaded.push(`file:${file.kind}/${file.date}/${file.filename}`),
    uploadSummary: async ({ summary }) => uploaded.push(`summary:${summary.kind}/${summary.date}`),
    log: (message) => logs.push(message),
  });

  assert.equal(uploaded.filter((value) => value.endsWith('/公告.pdf')).length, 1);
  assert.deepEqual(uploaded.slice(-2), [
    'summary:cninfo/2026-08-27',
    'summary:risk/2026-08-28',
  ]);
  assert.ok(logs.every((line) => !line.includes(token)));
});

test('invalid historical summary JSON is rejected', async (t) => {
  const fixture = await createFixture(t);
  await fs.promises.writeFile(path.join(fixture.dataRoot, 'cninfo', '2026-08-27.json'), '{bad');
  await assert.rejects(
    buildHistoryManifest({
      researchDataDir: fixture.dataRoot,
      reportsDir: fixture.reportsRoot,
      warn() {},
    }),
    /invalid JSON.*cninfo\/2026-08-27/,
  );
});
