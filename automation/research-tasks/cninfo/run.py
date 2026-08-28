#!/usr/bin/env python3
"""
A 股盘前公告研判 — 主流程 (T+1 单日扫描)
=====================================
按最新业务口径,启动日期 = T, 扫描 cninfo 公告日期 = T+1 的所有公告,串联 fetch → analyze → build。

典型用法:
  python3 run.py                              # 默认启动日 today, 扫描 today+1 单日
  python3 run.py --date 2026-06-15            # 指定启动日 2026-06-15, 扫描 2026-06-16
  python3 run.py --date 2026-06-10            # 指定启动日 2026-06-10, 扫描 2026-06-11
  python3 run.py --raw /path/to/raw.json      # 跳过抓取,直接用 raw JSON
  python3 run.py --skip-fetch                 # 复用同目录已有 raw JSON
  python3 run.py --no-excel                   # 只出 PDF
  python3 run.py --no-pdf                     # 只出 Excel

输出文件(命名规范):
  announcements_<start>_<end>.json      # 原始抓取
  processed_<start>_<end>.json         # 中间分析
  巨潮资讯-公告研判-<YYMMDD>.xlsx       # Excel (e.g. 巨潮资讯-公告研判-260610.xlsx)
  巨潮资讯-公告研判-<YYMMDD>.pdf        # PDF  (e.g. 巨潮资讯-公告研判-260610.pdf)

  T-日模式 (默认): 研判 T 日公告, 复盘 16:01 另跑 (--skip-recap 用于 7am 跑批, 不产复盘)
  手动模式 (--recap-only): 复盘 T 日报告 (16:01 launchd 走 run_recap.sh, 不走 run.py)
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import build_excel
import build_pdf
import fetch
import recap
import trading_calendar
import analyze


HERE = Path(__file__).parent.resolve()


def _log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}")


def _date_dir(iso_date: str) -> Path:
    """v9.15: dated 产物目录 output/<YYYY-MM-DD>/"""
    return HERE / "output" / iso_date


def _date_raw_dir(iso_date: str) -> Path:
    d = _date_dir(iso_date) / "raw"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _date_processed_dir(iso_date: str) -> Path:
    d = _date_dir(iso_date) / "processed"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _date_report_dir(iso_date: str) -> Path:
    d = _date_dir(iso_date)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _resolve_read(candidates: list) -> "Path | None":
    """v9.15: 找文件时优先 output/<date>/, fallback 根目录 (兼容旧跑批)"""
    return next((c for c in candidates if c.exists()), None)


def _run_pipeline(
    start_date: str,
    end_date: str,
    report_date: str = None,  # v6: 报告日(T+1=明日); None=用 end_date; 用于文件命名/output dir
    raw_path: Path = None,
    skip_fetch: bool = False,
    skip_recap: bool = False,
    make_excel: bool = True,
    make_pdf: bool = True,
) -> dict:
    """执行完整流程,返回最终 processed data"""
    label = start_date if start_date == end_date else f"{start_date}~{end_date}"
    _log(f"=== A 股 公告研判 | 范围 = {label} ===")
    _log(f"   报告日(report_date) = {report_date or end_date} (用于文件命名/邮件主题)")

    # Step 1: 抓取或复用 raw
    if raw_path:
        _log(f"Step 1/4: 复用 raw → {raw_path}")
        with open(raw_path, 'r', encoding='utf-8') as f:
            raw = json.load(f)
    elif skip_fetch:
        # 找同目录候选
        candidates = [
            _date_raw_dir(start_date) / f'announcements_{start_date}_{end_date}.json',
            _date_raw_dir(end_date) / f'announcements_{end_date}.json',
            HERE / f'announcements_{start_date}_{end_date}.json',
            HERE / f'announcements_{end_date}.json',
            HERE / 'announcements_prevday.json',
        ]
        raw_path = _resolve_read(candidates)
        if not raw_path:
            _log(f"❌ skip_fetch=True 但以下文件都不存在:")
            for c in candidates:
                _log(f"     - {c}")
            sys.exit(1)
        _log(f"Step 1/4: 复用 {raw_path}")
        with open(raw_path, 'r', encoding='utf-8') as f:
            raw = json.load(f)
    else:
        _log(f"Step 1/4: 抓取 cninfo ({start_date} ~ {end_date})")
        raw = fetch.fetch_range(start_date, end_date)
        out_raw = _date_raw_dir(start_date) / f'announcements_{start_date}_{end_date}.json'
        fetch.save_raw(raw, out_raw)
        raw_path = out_raw

    # Step 2: 分析
    _log(f"Step 2/4: 规则引擎打分 (raw {raw.get('total', len(raw.get('announcements', [])))} 条)")
    processed = analyze.process(raw)

    processed_path = _date_processed_dir(start_date) / f'processed_{start_date}_{end_date}.json'

    # Step 2.5: 复盘段 (T 日报告 在 T 日的市场反应验证)
    # 7am 跑批时 --skip-recap=True 跳过此步 (K 线未生成, 复盘交给 16:01 launchd 任务)
    if skip_recap:
        _log("Step 2.5/4: 跳过复盘 (--skip-recap, 16:01 任务负责)")
        processed['recap'] = {}
    else:
        # 研判与复盘是两条独立任务。研判跑批发生在目标交易日收盘前，不能把
        # 前一交易日 processed 冒充为当日复盘；16:01 任务会读取当日 processed。
        _log("Step 2.5/4: 主研判流程不生成复盘 (16:01 独立任务负责)")
        processed['recap'] = {}

    # v6: 报告日(明日)用于文件命名/邮件主题; scan 日(start_date/end_date)保持用于 raw/processed dir
    report_date = report_date or end_date
    if report_date != end_date and isinstance(processed.get("coverage"), dict):
        # v6 polish: 报告日与扫描日不同时, 显式标注 (body / PDF 头部用)
        processed["coverage"]["report_date"] = report_date
        processed["coverage"]["scan_date"] = end_date
        processed["coverage"]["range_label"] = f"{report_date} (扫描 {end_date})"
        # v6.1.1 fix: 顶层 date 字段也要跟随 report_date,
        # 否则 build_pdf 标题/头部"报告日期"仍会显示 end_date (旧 v5 行为)
        processed["date"] = report_date
        _log(f"   v6 报告日已注入 coverage: report_date={report_date} scan={end_date}")

    # 落盘 processed JSON (含 recap)
    with open(processed_path, 'w', encoding='utf-8') as f:
        json.dump(processed, f, ensure_ascii=False, indent=2)
    _log(f"   saved → {processed_path}")
    # Step 3 + 4: 主报告 (一二三四段, 不含复盘)
    # 命名规范: 巨潮资讯-公告研判-<YYMMDD>.{xlsx,pdf} (e.g. 260625 = 2026-06-25, 即报告日=明天)
    end_yymmdd = report_date[2:].replace("-", "") if len(report_date) >= 8 else report_date
    if make_excel:
        xlsx_path = _date_report_dir(report_date) / f'巨潮资讯-公告研判-{end_yymmdd}.xlsx'
        _log(f"Step 3/4: 主 Excel → {xlsx_path.name}")
        build_excel.render(processed, xlsx_path, raw=raw.get("announcements") if isinstance(raw, dict) else raw)
    if make_pdf:
        pdf_path = _date_report_dir(report_date) / f'巨潮资讯-公告研判-{end_yymmdd}.pdf'
        _log(f"Step 4/4: 主 PDF → {pdf_path.name}")
        build_pdf.render(processed_path, pdf_path)

    # 注: 7am 跑批 --skip-recap 不会到这里, 16:01 任务走 run_recap.sh (不经 run.py)
    if processed.get('recap') and processed['recap'].get('kline_avail', False):
        recap_date = processed['recap'].get('prev_date', '')
        if recap_date:
            # 命名: 巨潮资讯-今日复盘-<YYMMDD>.{xlsx,pdf} (e.g. 260610 = 2026-06-10)
            recap_yymmdd = recap_date[2:].replace("-", "") if len(recap_date) >= 8 else recap_date
            if make_excel:
                recap_xlsx = _date_report_dir(recap_date) / f'巨潮资讯-今日复盘-{recap_yymmdd}.xlsx'
                _log(f"Step 5/4: 复盘 Excel → {recap_xlsx.name}")
                build_excel.render_recap_workbook(processed_path, recap_xlsx)
            if make_pdf:
                recap_pdf = _date_report_dir(recap_date) / f'巨潮资讯-今日复盘-{recap_yymmdd}.pdf'
                _log(f"Step 5/4: 复盘 PDF → {recap_pdf.name}")
                build_pdf.render_recap_pdf(processed_path, recap_pdf)
    elif processed.get('recap'):
        _log(f"复盘产物: 跳过 (T 日 K 线未生成, 16:01 任务会重跑)")
    else:
        _log(f"复盘产物: 跳过 (无 T 日前一交易日数据)")

    _log(f"=== 完成 ===")
    return processed


def main() -> None:
    p = argparse.ArgumentParser(description="A 股 公告研判 (按 Skill 规范)")
    p.add_argument('--date', help='启动日(默认今天); 扫描 cninfo seDate=启动日+1 的公告')
    p.add_argument('--raw', help='直接指定 raw JSON,跳过抓取')
    p.add_argument('--skip-fetch', action='store_true', help='复用同目录已存在 raw')
    p.add_argument('--skip-recap', action='store_true', help='7am 跑批用,跳过复盘段 (Step 2.5); 16:01 复盘任务不应传此 flag')
    p.add_argument('--report-date', help='报告日(默认=扫描日=T+1); 用于文件命名 + 邮件主题. 也可走 env REPORT_DATE')
    p.add_argument('--no-excel', action='store_true', help='不出 Excel')
    p.add_argument('--no-pdf', action='store_true', help='不出 PDF')
    args = p.parse_args()

    # 最新口径: 启动日期 T -> 扫 cninfo 公告日期 T+1
    if args.raw:
        # 复用模式:从 raw 读 start/end
        with open(args.raw, 'r', encoding='utf-8') as f:
            raw = json.load(f)
        start_date = raw.get('start_date', raw.get('date', '?'))
        end_date = raw.get('end_date', start_date)
    else:
        launch_date = args.date or datetime.now().strftime('%Y-%m-%d')
        scan_date = (datetime.strptime(launch_date, '%Y-%m-%d') + timedelta(days=1)).strftime('%Y-%m-%d')
        start_date = end_date = scan_date
        dates = [scan_date]
        label = f"扫描 cninfo 公告日期 = {scan_date} (启动日+1)"
        _log(f"启动日期 = {launch_date}; 扫描公告日期 = 启动日+1 → {scan_date}")
        _log(f"{label}  dates={dates}")
    # report_date 优先级 --report-date > env REPORT_DATE > end_date(T+1扫描日)
    report_date = args.report_date or os.environ.get('REPORT_DATE') or end_date
    _log(f"报告日 = {report_date} (--report-date={args.report_date}, env REPORT_DATE={os.environ.get('REPORT_DATE')})")

    _run_pipeline(
        start_date=start_date,
        end_date=end_date,
        report_date=report_date,
        raw_path=Path(args.raw) if args.raw else None,
        skip_fetch=args.skip_fetch,
        skip_recap=args.skip_recap,
        make_excel=not args.no_excel,
        make_pdf=not args.no_pdf,
    )

if __name__ == '__main__':
    main()
