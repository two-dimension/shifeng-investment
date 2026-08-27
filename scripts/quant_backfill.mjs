#!/usr/bin/env node
import { getQuantOverview, runQuantHistoryBackfill } from '../server/lib/quantStrategy.js';

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    batches: 1,
    batchSize: 200,
    concurrency: 4,
    delay: 0,
    timeoutMs: 30000,
    failureCooldownHours: 24,
    retryFailures: false,
    stopCoverage: 1,
    source: 'tencent',
  };

  for (const arg of args) {
    const [rawKey, rawValue] = arg.replace(/^--/, '').split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = rawValue ?? 'true';
    if (key === 'retryFailures') {
      options.retryFailures = value !== 'false';
    } else if (key === 'source') {
      options.source = value;
    } else if (key in options) {
      options[key] = Number(value);
    }
  }
  return options;
};

const pct = (value) => `${((Number(value) || 0) * 100).toFixed(2)}%`;

const main = async () => {
  const options = parseArgs();
  const initial = await getQuantOverview();
  console.log(`[quant-backfill] start coverage=${pct(initial.dataStatus.coverage)} cached=${initial.dataStatus.cachedStockCount}/${initial.dataStatus.eligibleUniverseCount ?? initial.dataStatus.universeCount}`);

  for (let batch = 1; batch <= options.batches; batch += 1) {
    const before = await getQuantOverview();
    if (before.dataStatus.coverage >= options.stopCoverage) {
      console.log(`[quant-backfill] stop: coverage reached ${pct(before.dataStatus.coverage)}`);
      break;
    }

    const result = await runQuantHistoryBackfill({
      maxCodes: options.batchSize,
      concurrency: options.concurrency,
      delay: options.delay,
      timeoutMs: options.timeoutMs,
      failureCooldownHours: options.failureCooldownHours,
      retryFailures: options.retryFailures,
      source: options.source,
    });

    const after = result.after;
    console.log(JSON.stringify({
      batch,
      fetched: result.fetched.length,
      failed: result.failed.length,
      pendingTried: result.pending,
      skippedRecentFailures: result.skippedRecentFailures,
      totalIncomplete: result.totalIncomplete,
      coverage: pct(after.coverage),
      cached: `${after.cachedStockCount}/${after.eligibleUniverseCount ?? after.universeCount}`,
      shortHistoryStockCount: after.shortHistoryStockCount,
      source: options.source,
      concurrency: options.concurrency,
      sampleFetched: result.fetched.slice(0, 5).map((item) => `${item.code} ${item.name}`),
      sampleFailed: result.failed.slice(0, 5),
    }, null, 2));

    if (result.pending === 0 || (result.fetched.length === 0 && result.failed.length === 0)) {
      console.log('[quant-backfill] no eligible pending symbols in this pass');
      break;
    }
    if (result.fetched.length === 0 && result.failed.length > 0) {
      console.log('[quant-backfill] stop: data source returned only failures in this batch');
      break;
    }
  }

  const final = await getQuantOverview();
  console.log(`[quant-backfill] final coverage=${pct(final.dataStatus.coverage)} cached=${final.dataStatus.cachedStockCount}/${final.dataStatus.eligibleUniverseCount ?? final.dataStatus.universeCount}`);
};

main().catch((error) => {
  console.error('[quant-backfill] failed:', error);
  process.exitCode = 1;
});
