#!/usr/bin/env python3
"""业绩报告日报端到端入口：抓取、校验、渲染、邮件。"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import sys
import traceback
from datetime import date, datetime, timedelta
from pathlib import Path

from build_report import build_excel, build_pdf
from fetch_cninfo import fetch_for_date
from validate_input import validate


HERE = Path(__file__).resolve().parent
STATE_DIR = Path(os.environ.get("EARNINGS_REPORT_STATE_DIR", str(HERE / "state")))
LOCK_PATH = STATE_DIR / "run.lock"


def _default_report_date() -> str:
    return (date.today() + timedelta(days=1)).isoformat()


def _write_state(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {**payload, "updated_at": datetime.now().astimezone().isoformat(timespec="seconds")}
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def run(args: argparse.Namespace) -> int:
    report_date = args.date or os.environ.get("REPORT_DATE") or _default_report_date()
    datetime.strptime(report_date, "%Y-%m-%d")
    if args.max_items is not None and not (args.no_mail or args.dry_run_mail):
        raise ValueError("--max-items 只能和 --no-mail / --dry-run-mail 一起使用，禁止发送不完整样本")

    output_dir = HERE / "output" / report_date
    input_path = output_dir / "input.json"
    marker = output_dir / "input.json.sent"
    state_path = output_dir / "run_state.json"
    if marker.exists() and not args.force:
        print(f"[run] SKIP date={report_date} 已成功发送（使用 --force 强制重跑）")
        return 0

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("a+") as lock_handle:
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(f"[run] SKIP date={report_date} 另一个业绩报告任务正在执行")
            return 0

        _write_state(state_path, {"status": "running", "date": report_date})
        try:
            if args.skip_fetch:
                if not input_path.exists():
                    raise FileNotFoundError(f"--skip-fetch 但底稿不存在: {input_path}")
                data = json.loads(input_path.read_text(encoding="utf-8"))
                print(f"[run] reuse {input_path}")
            else:
                print(f"[run] step 1/4 fetch date={report_date}")
                data = fetch_for_date(
                    report_date,
                    output_dir,
                    max_items=args.max_items,
                    workers=args.workers,
                    max_pdf_pages=args.max_pdf_pages,
                )

            print("[run] step 2/4 validate")
            errors, warnings = validate(data)
            for warning in warnings:
                print(f"[WARN] {warning}")
            if errors:
                raise ValueError("底稿校验失败:\n- " + "\n- ".join(errors))

            print("[run] step 3/4 build")
            xlsx_path = output_dir / f"A股业绩报告-{report_date}.xlsx"
            pdf_path = output_dir / f"A股业绩报告-{report_date}.pdf"
            build_excel(data, xlsx_path)
            build_pdf(data, pdf_path)

            mail_result = {"status": "disabled"}
            print("[run] step 4/4 mail disabled in cloud task")

            _write_state(state_path, {
                "status": "success",
                "date": report_date,
                "items": len(data.get("items") or []),
                "metric_parse_ok": data.get("fetch_summary", {}).get("metric_parse_ok", 0),
                "warnings": warnings,
                "outputs": [str(xlsx_path), str(pdf_path)],
                "mail": mail_result,
            })
            print(f"[run] OK date={report_date} items={len(data.get('items') or [])}")
            return 0
        except Exception as exc:
            _write_state(state_path, {
                "status": "failed",
                "date": report_date,
                "error": str(exc),
                "traceback": traceback.format_exc(limit=20),
            })
            print(f"[run] FAILED date={report_date}: {exc}", file=sys.stderr)
            return 1
        finally:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", help="报告日 YYYY-MM-DD；默认明天，也可用 REPORT_DATE")
    parser.add_argument("--skip-fetch", action="store_true")
    parser.add_argument("--no-mail", action="store_true")
    parser.add_argument("--dry-run-mail", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--max-items", type=int)
    parser.add_argument("--workers", type=int, default=int(os.environ.get("REPORT_FETCH_WORKERS", "4")))
    parser.add_argument("--max-pdf-pages", type=int, default=int(os.environ.get("REPORT_MAX_PDF_PAGES", "60")))
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
