#!/usr/bin/env python3
"""巨潮资讯正式定期报告抓取与 PDF 财务指标抽取。"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Iterable

import requests

from extract_financials import extract_from_pdf_bytes
from industry_map import load_watchlist, lookup, normalize_code
from report_types import classify_report_title, clean_title


CNINFO_QUERY = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
CNINFO_PDF_PREFIX = "https://static.cninfo.com.cn/"
SEARCH_KEYS = ("年度报告", "半年度报告", "第一季度报告", "第三季度报告")
COLUMNS = ("sse", "szse")
# 巨潮的分页上限实际为 30；请求更大页容量时可能重复返回第一页。
PAGE_SIZE = 30
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Origin": "https://www.cninfo.com.cn",
    "Referer": "https://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice",
}
WEEKDAYS = "一二三四五六日"


class FetchError(RuntimeError):
    pass


def _parse_total_announcement(value: object) -> int | None:
    """将巨潮返回的总数转为非负整数；缺失或异常值按未提供处理。"""
    if value is None or isinstance(value, bool):
        return None
    try:
        total = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if total < 0:
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    return total


def _pagination_key(item: dict) -> str:
    """使用公告 ID 跟踪分页；无 ID 时使用公司、标题和附件地址作回退键。"""
    announcement_id = str(item.get("announcementId") or "").strip()
    if announcement_id:
        return f"id:{announcement_id}"
    fallback_parts = (
        str(item.get("secCode") or "").strip(),
        clean_title(item.get("announcementTitle") or ""),
        str(item.get("adjunctUrl") or "").strip(),
    )
    if any(fallback_parts):
        return "fallback:" + "|".join(fallback_parts)
    return "row:" + json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _post_page(date_str: str, column: str, searchkey: str, page: int, retries: int = 4) -> dict:
    payload = {
        "pageNum": str(page),
        "pageSize": str(PAGE_SIZE),
        "column": column,
        "tabName": "fulltext",
        "plate": "",
        "stock": "",
        "searchkey": searchkey,
        "secid": "",
        "category": "",
        "trade": "",
        "seDate": f"{date_str}~{date_str}",
        "sortName": "",
        "sortType": "",
        "isHLtitle": "true",
    }
    last_error = ""
    for attempt in range(1, retries + 1):
        try:
            response = requests.post(CNINFO_QUERY, data=payload, headers=HEADERS, timeout=30)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError("响应不是 JSON object")
            return data
        except Exception as exc:
            last_error = str(exc)
            print(
                f"[fetch] {column}/{searchkey} page={page} attempt={attempt}/{retries}: {last_error}",
                file=sys.stderr,
            )
            if attempt < retries:
                time.sleep(min(8, 2 ** (attempt - 1)))
    raise FetchError(f"{column}/{searchkey} page={page} 抓取失败: {last_error}")


def fetch_query(date_str: str, column: str, searchkey: str, max_pages: int = 200) -> tuple[list[dict], dict]:
    rows: list[dict] = []
    total_expected: int | None = None
    seen_keys: set[str] = set()
    pages = 0
    stop_reason = ""
    for page in range(1, max_pages + 1):
        data = _post_page(date_str, column, searchkey, page)
        pages += 1

        raw_batch = data.get("announcements")
        if raw_batch is None:
            batch: list[dict] = []
        elif isinstance(raw_batch, list) and all(isinstance(item, dict) for item in raw_batch):
            batch = raw_batch
        else:
            raise FetchError(f"{column}/{searchkey} page={page} announcements 格式异常")

        page_total = _parse_total_announcement(data.get("totalAnnouncement"))
        if page_total is not None:
            if total_expected is None:
                total_expected = page_total
            elif page_total != total_expected:
                raise FetchError(
                    f"{column}/{searchkey} 分页总数不一致: "
                    f"expected={total_expected} page={page} reported={page_total}"
                )

        batch_keys = [_pagination_key(item) for item in batch]
        duplicate_keys = seen_keys.intersection(batch_keys)
        if len(set(batch_keys)) != len(batch_keys) or duplicate_keys:
            raise FetchError(
                f"{column}/{searchkey} page={page} 分页无进展/返回重复公告，"
                "无法确认抓取完整"
            )

        rows.extend(batch)
        seen_keys.update(batch_keys)

        if total_expected is not None and len(rows) > total_expected:
            raise FetchError(
                f"{column}/{searchkey} 分页超出总数: "
                f"expected={total_expected} actual={len(rows)} pages={pages}"
            )
        if total_expected is not None and len(rows) == total_expected:
            stop_reason = "total_reached"
            break
        if not batch:
            stop_reason = "empty_page"
            break
        time.sleep(0.15)
    else:
        raise FetchError(
            f"{column}/{searchkey} 超过分页上限 {max_pages}: "
            f"expected={total_expected} actual={len(rows)}"
        )

    if total_expected is not None and len(rows) != total_expected:
        raise FetchError(
            f"{column}/{searchkey} 分页抓取不完整: "
            f"expected={total_expected} actual={len(rows)} pages={pages}"
        )

    return rows, {
        "column": column,
        "searchkey": searchkey,
        "pages": pages,
        "rows": len(rows),
        "total_expected": total_expected,
        "complete": True,
        "stop_reason": stop_reason,
    }


def deduplicate(items: Iterable[dict]) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for item in items:
        announcement_id = str(item.get("announcementId") or "").strip()
        fallback = f"{item.get('secCode')}|{clean_title(item.get('announcementTitle') or '')}|{item.get('adjunctUrl')}"
        key = announcement_id or fallback
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def _pdf_url(item: dict) -> str:
    adjunct = str(item.get("adjunctUrl") or "").strip()
    if adjunct.startswith("http://") or adjunct.startswith("https://"):
        return adjunct.replace("http://", "https://", 1)
    return CNINFO_PDF_PREFIX + adjunct.lstrip("/")


def _download(url: str, retries: int = 3) -> bytes:
    last_error = ""
    for attempt in range(1, retries + 1):
        try:
            response = requests.get(url, headers=HEADERS, timeout=90)
            response.raise_for_status()
            if not response.content.startswith(b"%PDF"):
                raise ValueError(f"响应不是 PDF ({response.headers.get('content-type')})")
            return response.content
        except Exception as exc:
            last_error = str(exc)
            if attempt < retries:
                time.sleep(min(6, attempt * 2))
    raise FetchError(f"PDF 下载失败: {last_error}")


def _safe_write(path: Path, data: bytes | str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    if isinstance(data, bytes):
        tmp.write_bytes(data)
    else:
        tmp.write_text(data, encoding="utf-8")
    tmp.replace(path)


def _process_one(item: dict, raw_dir: Path, max_pdf_pages: int) -> dict:
    title = clean_title(item.get("announcementTitle") or "")
    report = classify_report_title(title)
    if not report:
        raise ValueError(f"非目标标题进入处理队列: {title}")
    code = normalize_code(item.get("secCode"))
    wl = lookup(code) or {}
    announcement_id = str(item.get("announcementId") or "unknown")
    url = _pdf_url(item)
    pdf_path = raw_dir / "pdfs" / f"{announcement_id}.pdf"
    text_path = raw_dir / "text" / f"{announcement_id}.txt"
    try:
        pdf_data = pdf_path.read_bytes() if pdf_path.exists() else _download(url)
        if not pdf_path.exists():
            _safe_write(pdf_path, pdf_data)
        metrics, text, parse_meta = extract_from_pdf_bytes(
            pdf_data,
            max_pages=max_pdf_pages,
            report_type=report["报告类型"],
        )
        if text and not text_path.exists():
            _safe_write(text_path, text)
    except Exception as exc:
        metrics, parse_meta = extract_from_pdf_bytes(b"", report_type=report["报告类型"])[0], {
            "status": "download_error",
            "error": str(exc)[:500],
            "pages_total": 0,
            "pages_read": 0,
            "metrics_covered": 0,
        }

    subsets = wl.get("subsets") or []
    result = {
        "公告日期": item.get("announcementTime"),
        "证券代码": code,
        "证券简称": "".join(str(item.get("secName") or wl.get("name") or "").split()),
        "公告标题": title,
        "公告ID": announcement_id,
        "原文链接": url,
        "所属子集": ";".join(subsets) if subsets else "非watchlist",
        "watchlist命中": 1 if wl else 0,
        **report,
        **{k: v for k, v in metrics.items() if k != "抽取证据"},
        "全文解析状态": parse_meta.get("status"),
        "PDF总页数": parse_meta.get("pages_total"),
        "PDF已读页数": parse_meta.get("pages_read"),
        "解析错误": parse_meta.get("error", ""),
        "抽取证据": metrics.get("抽取证据", {}),
    }
    return result


def fetch_for_date(
    date_str: str,
    output_dir: Path,
    max_items: int | None = None,
    workers: int = 4,
    max_pdf_pages: int = 60,
    watchlist_only: bool = False,
) -> dict:
    datetime.strptime(date_str, "%Y-%m-%d")
    watchlist = load_watchlist()
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = output_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    all_rows: list[dict] = []
    query_stats: list[dict] = []
    errors: list[str] = []
    for column in COLUMNS:
        for searchkey in SEARCH_KEYS:
            try:
                rows, stats = fetch_query(date_str, column, searchkey)
                all_rows.extend(rows)
                query_stats.append(stats)
            except Exception as exc:
                errors.append(str(exc))
                query_stats.append({"column": column, "searchkey": searchkey, "error": str(exc)})
            time.sleep(0.2)

    deduped = deduplicate(all_rows)
    targets = []
    for item in deduped:
        report = classify_report_title(item.get("announcementTitle") or "")
        if report:
            targets.append(item)
    included_targets = [
        item for item in targets
        if not watchlist_only or normalize_code(item.get("secCode")) in watchlist
    ]
    included_targets.sort(key=lambda row: (normalize_code(row.get("secCode")), str(row.get("announcementId") or "")))
    if max_items is not None:
        included_targets = included_targets[: max(0, max_items)]
    watchlist_target_count = sum(
        1 for item in included_targets if normalize_code(item.get("secCode")) in watchlist
    )

    _safe_write(
        raw_dir / "announcements.json",
        json.dumps(
            {
                "date": date_str,
                "query_stats": query_stats,
                "errors": errors,
                "rows": deduped,
            },
            ensure_ascii=False,
            indent=2,
        ),
    )

    processed: list[dict] = []
    if included_targets:
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            futures = {
                pool.submit(_process_one, item, raw_dir, max_pdf_pages): item
                for item in included_targets
            }
            for future in as_completed(futures):
                source = futures[future]
                try:
                    processed.append(future.result())
                except Exception as exc:
                    errors.append(
                        f"处理失败 {source.get('secCode')} {clean_title(source.get('announcementTitle') or '')}: {exc}"
                    )
    processed.sort(key=lambda row: (row.get("报告类型", ""), row.get("证券代码", "")))

    parse_ok = sum(1 for row in processed if row.get("全文解析状态") == "ok")
    metric_ok = sum(1 for row in processed if int(row.get("指标覆盖数") or 0) > 0)
    data = {
        "schema_version": 1,
        "project": "业绩报告",
        "date": date_str,
        "weekday": f"星期{WEEKDAYS[datetime.strptime(date_str, '%Y-%m-%d').weekday()]}",
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "data_source": "巨潮资讯官方公告",
        "fetch_complete": not errors,
        "fetch_summary": {
            "query_count": len(COLUMNS) * len(SEARCH_KEYS),
            "queries": query_stats,
            "raw_rows": len(all_rows),
            "dedup_rows": len(deduped),
            "formal_report_rows": len(targets),
            "included_report_rows": len(included_targets),
            "watchlist_report_rows": watchlist_target_count,
            "watchlist_size": len(watchlist),
            "watchlist_only": watchlist_only,
            "pdf_parse_ok": parse_ok,
            "metric_parse_ok": metric_ok,
            "test_limit": max_items,
            "errors": errors,
        },
        "items": processed,
        "notes": [
            "收录正式定期报告全文及其英文版、更正后、修订版；摘要、单独更正公告、问询回复等已排除。",
            "财务数字来自 PDF 自动抽取，缺失值留空并保留原文链接。",
            (
                "云端只下载并解析 watchlist 内公司的正式报告。"
                if watchlist_only
                else "覆盖全部 A 股正式报告；watchlist 仅作为标记和子集归属，不作为准入条件。"
            ),
        ],
    }
    _safe_write(output_dir / "input.json", json.dumps(data, ensure_ascii=False, indent=2))
    return data


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("date", help="报告日 YYYY-MM-DD")
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--max-items", type=int, default=None, help="仅测试时限制处理条数")
    parser.add_argument("--watchlist-only", action="store_true", help="只下载并解析自选股的正式报告")
    parser.add_argument("--workers", type=int, default=int(os.environ.get("REPORT_FETCH_WORKERS", "4")))
    parser.add_argument("--max-pdf-pages", type=int, default=int(os.environ.get("REPORT_MAX_PDF_PAGES", "60")))
    args = parser.parse_args()
    data = fetch_for_date(
        args.date,
        args.output_dir,
        max_items=args.max_items,
        workers=args.workers,
        max_pdf_pages=args.max_pdf_pages,
        watchlist_only=args.watchlist_only,
    )
    summary = data["fetch_summary"]
    print(
        f"[fetch] date={args.date} raw={summary['dedup_rows']} formal={summary['formal_report_rows']} "
        f"included={summary['included_report_rows']} watchlist={summary['watchlist_report_rows']} "
        f"metrics={summary['metric_parse_ok']} "
        f"complete={data['fetch_complete']}"
    )
    return 0 if data["fetch_complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
