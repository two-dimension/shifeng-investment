# Platform Runtime Data Recovery Report

## Trigger

The merged code passed automated tests, but the live Vite page at `http://localhost:5173` still showed empty non-AI cards.

## Root-cause evidence before recovery

- Current runtime data: `server/data` was 12 MiB; the legacy repository held 2.5 GiB.
- Current research summaries and published reports: 0 files.
- Legacy research summaries: 208 files; legacy published reports: 596 files.
- Live API before recovery:
  - `/api/research/cninfo/latest`: `200 null`
  - `/api/research/earnings/latest`: `200 null`
  - `/api/research/risk/latest`: `200 null`
  - `/api/macd`: `500`, `MACD script returned no data`
  - `/api/tmt-margin`: `503`, no compatible cache and refresh failed
  - `/api/etf-monitor/overview`: `503`, the independent port 8000 service was absent
- The port 3000 Node process started at 13:48, before the non-AI backend fusion commits at 13:58-14:04 and before the local merge at 14:18.
- `researchSync.js` still pointed to `/Users/rayw/Documents/...`, while the recovered tasks are under `/Users/ray_wang/Downloads/石锋平台要用的`.
- Price refresh used the system `python3`, which did not have `requests` or `openpyxl`.

## Recovery policy

- Preserve all existing current-machine runtime files.
- Restore only missing legacy files.
- Exclude `server/data/ai-dashboard/**` from legacy data copying.
- Merge news archive entries by id, with current-machine entries winning conflicts.
- Keep runtime data and reports outside Git.

## Recovery results

- Restored 5,283 missing non-AI runtime files (2.67 GB transferred) while excluding the legacy AI dashboard directory.
- Restored 208 research summary files and 596 published PDF/XLSX report files.
- Restored 5,046 quant files, 28 TMT files, the legacy MACD cache, and four MACD workbooks.
- Merged the current 11-entry news archive with the legacy 50-entry archive into 61 entries; all source entry ids were retained.
- Removed copied or stale lock files before restarting services.
- Added `SHIFENG_TASKS_DIR` support and current-machine fallback discovery for all four research task roots.
- Added a project-local Python runtime resolver and installed the legacy platform requirements in the ignored `server/data/python-venv` directory.
- Replaced the MACD script's `/Users/rayw` paths with portable defaults. It now reads the platform's `server/data/funds.json`, deduplicates the portfolio positions, and still accepts the legacy UTF-16 watchlist through `MACD_WATCHLIST_PATH`.
- The research task path, Python runtime, research API, and startup tests pass.
- A fresh MACD run at 2026-08-27 14:51 generated 400 rows from the restored platform watchlist; this is not the 269-row legacy cache.
- Live UI verification returned 1,168 CNINFO announcements, 400 MACD rows, a compatible 40-day standard-TMT history, 404 flattened news items, 83 portfolios, and populated calendar events.

## Verification

- Node test suite: 248 tests passed. The first sandboxed run was rejected by macOS with `listen EPERM`; the same full suite passed outside the network-listen sandbox.
- Python test suite: 28 tests passed, including the new MACD path regression test.
- Quant strategy regression test passed.
- TypeScript and Vite production build passed.
- All AI dashboard preservation hashes passed.

## Honest degraded states

- The home news card says there is no current hot-news item because the restored archive ends on August 18 and the latest refresh added no non-duplicate August 27 items. The news page itself contains the restored history.
- Standard TMT is populated but warns that its August 14 margin snapshot is three trading days stale. A live refresh currently fails the upstream four-industry completeness gate, so the platform correctly preserves the last good cache.

## Remaining external dependency

The ETF card depends on a separate `etf_monitor` FastAPI project at port 8000. That project is not present in either supplied folder on this computer, so it cannot be recovered from the supplied sources.
