from __future__ import annotations

import pytest

import validate_input


def _data(*items: dict) -> dict:
    return {
        "project": "业绩报告",
        "date": "2026-08-13",
        "fetch_complete": True,
        "fetch_summary": {
            "formal_report_rows": len(items),
            "included_report_rows": len(items),
            "watchlist_report_rows": 0,
            "errors": [],
            "queries": [],
        },
        "items": list(items),
    }


def _item(announcement_id: str, *, status: str, pages_total: object) -> dict:
    return {
        "证券代码": "688001",
        "公告ID": announcement_id,
        "公告标题": "测试股份：2025年年度报告",
        "watchlist命中": 0,
        "报告类型": "年度报告",
        "原文链接": f"https://static.cninfo.com.cn/{announcement_id}.pdf",
        "全文解析状态": status,
        "PDF总页数": pages_total,
        "指标覆盖数": 0,
        "营业收入亿元": None,
        "营业收入同比%": None,
        "归母净利润亿元": None,
        "归母净利润同比%": None,
        "扣非净利润亿元": None,
        "扣非净利润同比%": None,
        "经营现金流亿元": None,
        "经营现金流同比%": None,
    }


@pytest.mark.parametrize("pages_total", [1, 128])
def test_valid_scanned_pdf_with_empty_metrics_is_warning_only(monkeypatch, pages_total):
    monkeypatch.setattr(validate_input, "load_watchlist", lambda: {})
    item = _item("scan-1", status="no_text", pages_total=pages_total)

    errors, warnings = validate_input.validate(_data(item))

    assert errors == []
    assert item["原文链接"].startswith("https://")
    assert all(item[field] is None for field in validate_input.MONEY_LIMITS)
    assert any("扫描件" in warning and f"{pages_total}页" in warning for warning in warnings)
    assert any("核心财务指标未抽取" in warning for warning in warnings)
    assert not any("所有报告的核心指标均抽取失败" in error for error in errors)


def test_batch_of_valid_scanned_pdfs_allows_zero_metric_coverage(monkeypatch):
    monkeypatch.setattr(validate_input, "load_watchlist", lambda: {})
    items = [
        _item("scan-1", status="no_text", pages_total=6),
        _item("scan-2", status="no_text", pages_total=12),
    ]

    errors, warnings = validate_input.validate(_data(*items))

    assert errors == []
    assert sum("扫描件" in warning for warning in warnings) == 2


@pytest.mark.parametrize(
    ("status", "pages_total", "expected_error"),
    [
        ("download_error", 5, "PDF 全文解析失败 (download_error)"),
        ("empty_pdf", 5, "PDF 全文解析失败 (empty_pdf)"),
        ("pdf_error", 5, "PDF 全文解析失败 (pdf_error)"),
        ("no_text", None, "PDF 无可提取文本且缺少有效页数"),
        ("no_text", 0, "PDF 无可提取文本且缺少有效页数"),
        ("no_text", -1, "PDF 无可提取文本且缺少有效页数"),
        ("no_text", "invalid", "PDF 无可提取文本且缺少有效页数"),
    ],
)
def test_fatal_pdf_statuses_remain_errors(
    monkeypatch, status, pages_total, expected_error
):
    monkeypatch.setattr(validate_input, "load_watchlist", lambda: {})
    item = _item("fatal-1", status=status, pages_total=pages_total)

    errors, _ = validate_input.validate(_data(item))

    assert any(expected_error in error for error in errors)
