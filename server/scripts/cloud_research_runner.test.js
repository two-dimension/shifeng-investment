import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildResearchManifest,
  isPublishableResearchSummary,
  resolveResearchRunPlan,
  runResearchPlan,
} from './cloud_research_runner.mjs';

const KINDS = ['cninfo', 'earnings', 'earnings-report', 'risk'];

test('run plan uses four portable task groups in the required order', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'research-plan-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  for (const [kind, filenames] of Object.entries({
    cninfo: ['run.py'],
    earnings: ['fetch_cninfo.py', 'build_report.py'],
    'earnings-report': ['run.py'],
    risk: ['run.py'],
  })) {
    await fs.promises.mkdir(path.join(root, kind), { recursive: true });
    for (const filename of filenames) {
      await fs.promises.writeFile(path.join(root, kind, filename), '# fake task\n');
    }
  }

  const plan = resolveResearchRunPlan('2026-08-28', root, { pythonBin: 'python-test' });
  assert.deepEqual(plan.map((group) => group.kind), KINDS);
  assert.deepEqual(plan[0].commands[0].args, [
    path.join(root, 'cninfo', 'run.py'),
    '--date', '2026-08-27',
    '--report-date', '2026-08-28',
    '--skip-recap',
  ]);
  assert.equal(plan[1].commands.length, 2);
  assert.deepEqual(plan[2].commands[0].args.slice(-4), ['--date', '2026-08-28', '--no-mail', '--force']);
  assert.deepEqual(plan[3].commands[0].args.slice(-2), ['--scan-date', '2026-08-28']);
  assert.ok(plan.every((group) => group.outputRoot.startsWith(root)));
  assert.doesNotMatch(JSON.stringify(plan), /\/Users\/|Downloads|石锋平台要用的/);

  const calls = [];
  await runResearchPlan(plan, {
    env: { SAFE_TEST_VALUE: 'yes' },
    runProcess: async (command, args, options) => {
      calls.push({ command, args, options });
      assert.equal(command, 'python-test');
      assert.equal(options.shell, false);
      assert.equal(options.env.SAFE_TEST_VALUE, 'yes');
      assert.equal(await fs.promises.stat(args[0]).then((stat) => stat.isFile()), true);
    },
  });
  assert.equal(calls.length, 5);
});

test('manifest keeps one usable summary per ready kind and rewrites report URLs', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'research-manifest-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data');
  const reportsRoot = path.join(root, 'reports');
  const targetDate = '2026-08-28';

  for (const [index, kind] of KINDS.entries()) {
    const dataDir = path.join(dataRoot, kind);
    const reportDir = path.join(reportsRoot, kind, targetDate);
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.mkdir(reportDir, { recursive: true });
    const filename = `${kind}.pdf`;
    await fs.promises.writeFile(path.join(reportDir, filename), `report-${kind}`);
    await fs.promises.writeFile(path.join(dataDir, `${targetDate}.json`), JSON.stringify({
      kind,
      date: targetDate,
      generatedAt: '2026-08-28T12:00:00.000Z',
      totalCount: index + 1,
      topGood: [],
      topBad: [],
      files: [{ filename, type: 'pdf', size: 1, url: 'file:///local-only' }],
    }));
  }

  const manifest = await buildResearchManifest({
    jobId: 'job-123',
    generatedAt: '2026-08-28T12:30:00.000Z',
    targetDate,
    researchDataDir: dataRoot,
    reportsDir: reportsRoot,
    syncResult: {
      results: KINDS.map((kind) => ({ kind, date: targetDate, success: true })),
    },
  });

  assert.equal(manifest.jobId, 'job-123');
  assert.equal(manifest.summaries.length, 4);
  assert.equal(manifest.files.length, 4);
  assert.deepEqual(manifest.summaries.map((summary) => summary.kind), KINDS);
  assert.equal(
    manifest.summaries[0].files[0].url,
    '/api/research/files/cninfo/2026-08-28/cninfo.pdf',
  );
  assert.equal(manifest.files[0].path, path.join(reportsRoot, 'cninfo', targetDate, 'cninfo.pdf'));
  assert.doesNotMatch(JSON.stringify(manifest), /石锋平台要用的|Downloads/);
});

test('empty placeholder summaries are not publishable', () => {
  assert.equal(isPublishableResearchSummary({ totalCount: 1 }), true);
  assert.equal(isPublishableResearchSummary({ totalCount: 0, allItems: [{}] }), true);
  assert.equal(isPublishableResearchSummary({ totalCount: 0, topBad: [{}] }), true);
  assert.equal(isPublishableResearchSummary({ totalCount: 0, files: [{}] }), false);
  assert.equal(isPublishableResearchSummary(null), false);
});
