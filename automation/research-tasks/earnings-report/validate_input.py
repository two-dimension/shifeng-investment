#!/usr/bin/env python3
"""业绩报告底稿完整性与数值合理性校验。"""
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path

from industry_map import load_watchlist, normalize_code
from report_types import classify_report_title


MONEY_LIMITS = {
    "营业收入亿元": 100000.0,
    "归母净利润亿元": 20000.0,
    "扣非净利润亿元": 20000.0,
    "经营现金流亿元": 50000.0,
}


def _nonnegative_int(value: object) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if number < 0 or (isinstance(value, float) and not value.is_integer()):
        return None
    return number


def validate(data: dict) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if data.get("project") != "业绩报告":
        errors.append("project 字段不是‘业绩报告’")
    if not re.fullmatch(r"20\d{2}-\d{2}-\d{2}", str(data.get("date") or "")):
        errors.append("date 不是 YYYY-MM-DD")
    if not data.get("fetch_complete"):
        errors.append("巨潮查询不完整，禁止生成并发送可能漏数的报告")

    summary = data.get("fetch_summary") or {}
    formal_count = int(summary.get("formal_report_rows") or 0)
    included_count = int(summary.get("included_report_rows", len(data.get("items") or [])) or 0)
    watchlist_count = int(summary.get("watchlist_report_rows") or 0)
    if formal_count < included_count:
        errors.append("纳入报告数大于全市场正式报告数，汇总口径异常")
    if included_count != len(data.get("items") or []):
        errors.append("纳入报告数与明细数不一致")
    if included_count < watchlist_count:
        errors.append("watchlist 报告数大于正式报告数，汇总口径异常")
    if summary.get("errors"):
        errors.extend(f"抓取错误: {message}" for message in summary["errors"])

    for index, query in enumerate(summary.get("queries") or [], 1):
        if not isinstance(query, dict):
            errors.append(f"第{index}个巨潮查询统计格式异常")
            continue
        label = f"{query.get('column', '?')}/{query.get('searchkey', '?')}"
        if query.get("complete") is False:
            errors.append(f"巨潮查询 {label} 标记为不完整")
        raw_total = query.get("total_expected")
        if raw_total is None:
            continue
        total_expected = _nonnegative_int(raw_total)
        row_count = _nonnegative_int(query.get("rows"))
        if total_expected is None or row_count is None:
            errors.append(f"巨潮查询 {label} 分页统计异常")
        elif row_count != total_expected:
            errors.append(
                f"巨潮查询 {label} 分页抓取不完整: "
                f"expected={total_expected} actual={row_count}"
            )

    watchlist = load_watchlist()
    seen: set[str] = set()
    items = data.get("items") or []
    valid_scanned_pdf_count = 0
    for index, item in enumerate(items, 1):
        label = f"第{index}条 {item.get('证券代码', '')}"
        announcement_id = str(item.get("公告ID") or "")
        if not announcement_id:
            errors.append(f"{label}: 公告ID为空")
        elif announcement_id in seen:
            errors.append(f"{label}: 公告ID重复 {announcement_id}")
        seen.add(announcement_id)

        code = normalize_code(item.get("证券代码"))
        expected_watchlist_hit = 1 if code in watchlist else 0
        if not classify_report_title(item.get("公告标题") or ""):
            errors.append(f"{label}: 公告标题不属于正式定期报告全文")
        if item.get("watchlist命中") != expected_watchlist_hit:
            errors.append(f"{label}: watchlist命中 标记与名单不一致")
        if item.get("报告类型") not in ("年度报告", "半年度报告", "第一季度报告", "第三季度报告"):
            errors.append(f"{label}: 报告类型异常")
        if not str(item.get("原文链接") or "").startswith("https://"):
            errors.append(f"{label}: 原文链接缺失或非 HTTPS")
        parse_status = item.get("全文解析状态")
        pages_total = _nonnegative_int(item.get("PDF总页数"))
        is_valid_scanned_pdf = (
            parse_status == "no_text" and pages_total is not None and pages_total > 0
        )
        if parse_status == "ok":
            pass
        elif is_valid_scanned_pdf:
            valid_scanned_pdf_count += 1
            warnings.append(
                f"{label}: PDF 为扫描件（{pages_total}页），无可提取文本，财务指标将留空"
            )
        elif parse_status == "no_text":
            errors.append(f"{label}: PDF 无可提取文本且缺少有效页数")
        else:
            errors.append(f"{label}: PDF 全文解析失败 ({parse_status or 'unknown'})")

        for field, limit in MONEY_LIMITS.items():
            value = item.get(field)
            if value is None:
                continue
            try:
                number = float(value)
            except (TypeError, ValueError):
                errors.append(f"{label}: {field} 不是数值")
                continue
            if not math.isfinite(number) or abs(number) > limit:
                errors.append(f"{label}: {field}={value} 超出合理上限 {limit}")
        for field in ("营业收入同比%", "归母净利润同比%", "扣非净利润同比%", "经营现金流同比%"):
            value = item.get(field)
            if value is None:
                continue
            try:
                number = float(value)
            except (TypeError, ValueError):
                errors.append(f"{label}: {field} 不是数值")
                continue
            if not math.isfinite(number) or abs(number) > 1_000_000:
                errors.append(f"{label}: {field}={value} 异常")
        if int(item.get("指标覆盖数") or 0) == 0:
            warnings.append(f"{label}: 核心财务指标未抽取，报告中将留空")

    if (
        items
        and valid_scanned_pdf_count != len(items)
        and not any(int(item.get("指标覆盖数") or 0) > 0 for item in items)
    ):
        errors.append("本批次存在正式报告，但所有报告的核心指标均抽取失败")

    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_json", type=Path)
    args = parser.parse_args()
    data = json.loads(args.input_json.read_text(encoding="utf-8"))
    errors, warnings = validate(data)
    for warning in warnings:
        print(f"[WARN] {warning}")
    for error in errors:
        print(f"[ERROR] {error}")
    if errors:
        print(f"[validate] FAILED errors={len(errors)} warnings={len(warnings)}")
        return 1
    print(f"[validate] OK items={len(data.get('items') or [])} warnings={len(warnings)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
