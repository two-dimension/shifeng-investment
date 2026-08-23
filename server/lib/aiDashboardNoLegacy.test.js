import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const libDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(libDir, '../..');

function productionFiles() {
  const serverFiles = fs.readdirSync(libDir)
    .filter((name) => /^(?:ai|official).+\.js$/.test(name) && !name.includes('.test.'))
    .map((name) => path.join(libDir, name));
  const pageDir = path.join(rootDir, 'src/pages/AIDashboard');
  const pageFiles = fs.readdirSync(pageDir)
    .filter((name) => /\.(?:ts|tsx)$/.test(name) && !name.includes('.test.'))
    .map((name) => path.join(pageDir, name));
  return [...serverFiles, path.join(rootDir, 'server/api/ai_dashboard.js'), ...pageFiles];
}

test('AI dashboard production path contains no Feishu or aggregated OpenRouter Benchmark runtime', () => {
  const banned = [
    /\bfeishu\b/i,
    /open\.feishu\.cn/i,
    /normalizeFeishuWorkbook/,
    /\/api\/v1\/benchmarks/i,
    /OpenRouter\s+(?:Evals|Benchmark)/i,
    /飞书(?:源表|补数|模型基准)/,
  ];
  const violations = [];
  for (const file of productionFiles()) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const pattern of banned) {
      if (pattern.test(contents)) violations.push(`${path.relative(rootDir, file)}: ${pattern}`);
    }
  }
  assert.deepEqual(violations, []);
  assert.equal(fs.existsSync(path.join(libDir, 'aiDashboardData.js')), false);
  assert.equal(fs.existsSync(path.join(libDir, 'aiBenchmarkData.js')), false);
});
