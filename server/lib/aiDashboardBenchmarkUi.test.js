import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const componentPath = path.join(__dirname, '../../src/pages/AIDashboard/AIDashboardSections.tsx');
const stylesPath = path.join(__dirname, '../../src/pages/AIDashboard/AIDashboardPanel.css');

test('Benchmark matrix removes the redundant evaluation-status column and exposes model specs', () => {
  const source = fs.readFileSync(componentPath, 'utf8');
  assert.equal(source.includes("title: '评测状态'"), false);
  assert.match(source, /title: '总参数'/);
  assert.match(source, /title: '激活参数'/);
  assert.match(source, /title: '上下文长度'/);
});

test('API Token table keeps all current vendor prices visible on its first page', () => {
  const source = fs.readFileSync(componentPath, 'utf8');
  const tokenPricingSource = source.slice(
    source.indexOf('function TokenPricing'),
    source.indexOf('function VideoPricing'),
  );

  assert.match(tokenPricingSource, /pagination=\{\{ pageSize: 25, showSizeChanger: false \}\}/);
});

test('Benchmark winner summary scrolls instead of creating a tall blank area below the matrix', () => {
  const styles = fs.readFileSync(stylesPath, 'utf8');
  const winnerListStyles = styles.slice(
    styles.indexOf('.ai-winner-list'),
    styles.indexOf('.ai-winner-row'),
  );

  assert.match(winnerListStyles, /max-height:/);
  assert.match(winnerListStyles, /overflow-y:\s*auto/);
});

test('AI dashboard card titles keep their width on mobile when an extra label is present', () => {
  const styles = fs.readFileSync(stylesPath, 'utf8');
  const mobileStyles = styles.slice(styles.indexOf('@media (max-width: 575px)'));

  assert.match(mobileStyles, /\.ai-section-card \.ant-card-head-wrapper/);
  assert.match(mobileStyles, /\.ai-section-card \.ant-card-head-title/);
  assert.match(mobileStyles, /flex:\s*1 1 100%/);
});
