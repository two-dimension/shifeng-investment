# Final review fix report

## Baseline

- Branch: `codex/restore-announcement-monitor`
- Starting HEAD: `ba6e3f9d89e79921aa8b1b564306cc97c4324ce5`
- `node --test server/*.test.js server/api/*.test.js server/lib/*.test.js` (with loopback permission): 58 passed, 0 failed.

## RED

Command:

```text
node --test server/lib/researchSync.cninfo.test.js server/lib/cninfoAnnouncements.test.js server/lib/announcementJudgement.test.js
```

Result: 21 tests, 17 passed, 4 failed as expected.

1. `buildDirectCninfoSummary preserves the main announcement time on the research entry`
   - Expected `2026-08-20T09:20:00.000Z`; actual `undefined`.
2. `fetchCninfoMarketDay rejects when a later page changes the total record count`
   - Failed with `Missing expected rejection`, proving page 2 changing from 60 to 90 was accepted.
3. `cninfo automatic sync ignores an expired complete legacy day and fetches the latest weekday`
   - Expected direct request for `2026-08-21`; actual requests were `[]`, proving the old `2026-08-20` artifact globally short-circuited refresh.
4. `all sync reports failure when every source has zero attempts`
   - Expected `success: false`; actual was `true`.

The new explicit-date legacy-first regression test passed in the RED run, preserving the approved compatibility behavior.

## GREEN

- First focused GREEN run exposed one test-fixture conversion mistake only: timestamp `1787220000000` is `2026-08-20T10:00:00.000Z`, not `09:20`. The literal expectation was corrected; product logic was unchanged.
- `node --test server/lib/researchSync.cninfo.test.js server/lib/cninfoAnnouncements.test.js server/lib/announcementJudgement.test.js`: 21 passed, 0 failed.
- `node --test server/lib/cninfoAnnouncements.test.js server/lib/announcementJudgement.test.js server/lib/researchSync.cninfo.test.js server/api/research.test.js` (with loopback permission): 24 passed, 0 failed.

Minimal implementation changes:

1. Undated CNINFO sync now enumerates recent Shanghai weekdays regardless of unrelated legacy dates, imports only when that exact candidate date is complete, and otherwise uses direct CNINFO. It continues past empty direct days and stops after the first non-empty success or upstream failure.
2. CNINFO pagination locks `totalRecordNum` to page 1 and throws `CninfoUpstreamError` with `CNINFO_INCONSISTENT_TOTAL` if a later page differs.
3. Direct judgement entries map the chosen announcement timestamp to the existing ISO-string `time` field.
4. An empty `kind=all` sync now returns `success: false`, `error: 未找到可同步的数据源`, and zero attempts; a successful direct CNINFO result remains sufficient for `all` success when import-only sources are absent.

## Final verification

- Full server suite: 63 passed, 0 failed.
- Full standalone TypeScript suite: 13 passed, 0 failed.
- `npm run lint`: passed with exit code 0.
- `npm run build`: passed with exit code 0. Vite emitted the existing non-blocking large-chunk advisory.
