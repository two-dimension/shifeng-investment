import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUTPUT_ENV_KEYS = [
  'CNINFO_OUTPUT_DIR',
  'EARNINGS_OUTPUT_DIR',
  'EARNINGS_REPORT_OUTPUT_DIR',
  'RISK_OUTPUT_DIR',
];

test('SHIFENG_TASKS_DIR resolves every recovered research task on the current computer', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shifeng-research-paths-'));
  const tasksRoot = path.join(tempRoot, '石锋平台要用的');
  const expected = {
    cninfo: path.join(tasksRoot, '巨潮资讯', 'output'),
    earnings: path.join(tasksRoot, '业绩预告', '业绩预告'),
    'earnings-report': path.join(tasksRoot, '业绩报告', '业绩报告'),
    risk: path.join(tasksRoot, '风险提示', 'output'),
  };

  Object.values(expected).forEach((directory) => fs.mkdirSync(directory, { recursive: true }));

  const previousTasksRoot = process.env.SHIFENG_TASKS_DIR;
  const previousOutputs = Object.fromEntries(
    OUTPUT_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  process.env.SHIFENG_TASKS_DIR = tasksRoot;
  OUTPUT_ENV_KEYS.forEach((key) => delete process.env[key]);

  try {
    const moduleUrl = new URL(`./researchSync.js?task-path-test=${Date.now()}`, import.meta.url);
    const { getResearchSourceStatus } = await import(moduleUrl.href);
    const status = getResearchSourceStatus();

    assert.equal(status.cninfo.root, expected.cninfo);
    assert.equal(status.earnings.root, expected.earnings);
    assert.equal(status['earnings-report'].root, expected['earnings-report']);
    assert.equal(status.risk.root, expected.risk);
  } finally {
    if (previousTasksRoot === undefined) delete process.env.SHIFENG_TASKS_DIR;
    else process.env.SHIFENG_TASKS_DIR = previousTasksRoot;

    OUTPUT_ENV_KEYS.forEach((key) => {
      if (previousOutputs[key] === undefined) delete process.env[key];
      else process.env[key] = previousOutputs[key];
    });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
