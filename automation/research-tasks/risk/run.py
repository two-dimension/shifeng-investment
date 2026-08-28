#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""风险提示主流程。"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timedelta
from pathlib import Path

import analyze
import build_excel
import build_pdf
import fetch


HERE = Path(__file__).parent.resolve()
CNINFO_DIR = Path(os.environ.get("RESEARCH_CNINFO_DIR", str(HERE.parent / "cninfo")))


def _log(msg: str) -> None:
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}")


def _date_dir(iso_date: str) -> Path:
    d = HERE / "output" / iso_date
    d.mkdir(parents=True, exist_ok=True)
    return d


def _raw_dir(iso_date: str) -> Path:
    d = _date_dir(iso_date) / "raw"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _processed_dir(iso_date: str) -> Path:
    d = _date_dir(iso_date) / "processed"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _scan_date(run_date: str) -> str:
    return (datetime.strptime(run_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")


def _find_cninfo_raw(scan_date: str) -> Path | None:
    candidates = [
        CNINFO_DIR / "output" / scan_date / "raw" / f"announcements_{scan_date}_{scan_date}.json",
        CNINFO_DIR / "output" / scan_date / "raw" / f"announcements_{scan_date}.json",
        CNINFO_DIR / f"announcements_{scan_date}_{scan_date}.json",
        CNINFO_DIR / f"announcements_{scan_date}.json",
    ]
    return next((p for p in candidates if p.exists()), None)


def _load_or_fetch_raw(scan_date: str, raw_path: Path | None = None, skip_fetch: bool = False) -> tuple[dict, Path]:
    local_raw = _raw_dir(scan_date) / f"announcements_{scan_date}_{scan_date}.json"
    if raw_path:
        _log(f"复用指定 raw: {raw_path}")
        raw = json.loads(Path(raw_path).read_text(encoding="utf-8"))
        shutil.copyfile(raw_path, local_raw)
        return raw, local_raw
    if local_raw.exists():
        _log(f"复用本项目 raw: {local_raw}")
        return json.loads(local_raw.read_text(encoding="utf-8")), local_raw
    cninfo_raw = _find_cninfo_raw(scan_date)
    if cninfo_raw:
        _log(f"复用巨潮资讯 raw: {cninfo_raw}")
        shutil.copyfile(cninfo_raw, local_raw)
        return json.loads(local_raw.read_text(encoding="utf-8")), local_raw
    if skip_fetch:
        raise FileNotFoundError(f"skip-fetch=True, 但未找到 {scan_date} 的本地或巨潮资讯 raw")
    _log(f"未找到可复用 raw, 开始抓取巨潮公告: {scan_date}")
    raw = fetch.fetch_range(scan_date, scan_date)
    fetch.save_raw(raw, local_raw)
    return raw, local_raw


def run(scan_date: str, raw_path: Path | None, skip_fetch: bool, make_excel: bool, make_pdf: bool) -> dict:
    raw, raw_file = _load_or_fetch_raw(scan_date, raw_path=raw_path, skip_fetch=skip_fetch)
    _log(f"开始风险评分: raw={raw.get('total', len(raw.get('announcements', [])))}")
    processed = analyze.process(raw)
    proc_path = _processed_dir(scan_date) / f"processed_{scan_date}_{scan_date}.json"
    proc_path.write_text(json.dumps(processed, ensure_ascii=False, indent=2), encoding="utf-8")
    _log(f"processed saved: {proc_path}")

    yymmdd = scan_date[2:].replace("-", "")
    if make_excel:
        xlsx = _date_dir(scan_date) / f"风险提示-公告扫描-{yymmdd}.xlsx"
        build_excel.render(processed, xlsx)
        _log(f"Excel saved: {xlsx}")
    if make_pdf:
        pdf = _date_dir(scan_date) / f"风险提示-公告扫描-{yymmdd}.pdf"
        build_pdf.render(processed, pdf)
        _log(f"PDF saved: {pdf}")

    sent = processed.get("sentiment", {})
    _log(f"完成: 风险 {sent.get('risk_count', 0)} 条, 重大/高风险 {sent.get('major_risk_company_count', 0)} 家")
    return processed


def main() -> None:
    p = argparse.ArgumentParser(description="风险提示公告扫描")
    p.add_argument("--date", help="启动日 YYYY-MM-DD; 默认今天。扫描日=启动日+1")
    p.add_argument("--scan-date", help="直接指定扫描公告日 YYYY-MM-DD")
    p.add_argument("--raw", help="直接指定 raw JSON")
    p.add_argument("--skip-fetch", action="store_true", help="只复用 raw, 不抓取")
    p.add_argument("--no-excel", action="store_true")
    p.add_argument("--no-pdf", action="store_true")
    args = p.parse_args()

    run_date = args.date or datetime.now().strftime("%Y-%m-%d")
    scan_date = args.scan_date or _scan_date(run_date)
    _log(f"=== 风险提示 | 启动日={run_date} 扫描日={scan_date} ===")
    run(
        scan_date=scan_date,
        raw_path=Path(args.raw) if args.raw else None,
        skip_fetch=args.skip_fetch,
        make_excel=not args.no_excel,
        make_pdf=not args.no_pdf,
    )


if __name__ == "__main__":
    main()
