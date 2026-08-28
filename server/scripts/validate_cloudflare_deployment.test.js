import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

test('routes static assets through the Worker so workers.dev access control cannot be bypassed', () => {
  const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'wrangler.jsonc'), 'utf8'));

  assert.equal(config.workers_dev, true);
  assert.equal(config.assets.run_worker_first, true);
});
