import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureProjectPythonRuntime } from './pythonRuntime.js';

test('project Python runtime drives every legacy Python task without overriding explicit settings', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shifeng-python-runtime-'));
  const pythonBin = path.join(projectRoot, 'server', 'data', 'python-venv', 'bin', 'python3');
  fs.mkdirSync(path.dirname(pythonBin), { recursive: true });
  fs.writeFileSync(pythonBin, '');

  const env = {
    PATH: '/usr/bin:/bin',
    PRICE_TRACKING_PYTHON: '/custom/price-python',
  };

  try {
    const resolved = configureProjectPythonRuntime({ env, projectRoot });

    assert.equal(resolved, pythonBin);
    assert.equal(env.PATH, `${path.dirname(pythonBin)}:/usr/bin:/bin`);
    assert.equal(env.PYTHON, pythonBin);
    assert.equal(env.PRICE_TRACKING_PYTHON, '/custom/price-python');
    assert.equal(env.NEWS_INTELLIGENCE_PYTHON, pythonBin);
    assert.equal(env.QUANT_PYTHON_BIN, pythonBin);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
