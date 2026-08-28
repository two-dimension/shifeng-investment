import json
from pathlib import Path

import validate_input
from build_report import build_excel, build_pdf
from validate_input import validate


def test_empty_disclosure_day_is_valid_and_renderable(tmp_path: Path):
    data = {
        "schema_version": 1,
        "project": "业绩报告",
        "date": "2026-07-21",
        "weekday": "星期二",
        "generated_at": "2026-07-20T22:20:00+08:00",
        "data_source": "巨潮资讯官方公告",
        "fetch_complete": True,
        "fetch_summary": {
            "query_count": 8,
            "queries": [],
            "raw_rows": 0,
            "dedup_rows": 0,
            "formal_report_rows": 0,
            "included_report_rows": 0,
            "watchlist_report_rows": 0,
            "watchlist_size": 1,
            "pdf_parse_ok": 0,
            "metric_parse_ok": 0,
            "test_limit": None,
            "errors": [],
        },
        "items": [],
        "notes": ["测试空披露日"],
    }
    errors, _ = validate(data)
    assert errors == []
    xlsx = tmp_path / "empty.xlsx"
    pdf = tmp_path / "empty.pdf"
    build_excel(data, xlsx)
    build_pdf(data, pdf)
    assert xlsx.stat().st_size > 1000
    assert pdf.stat().st_size > 1000


def test_non_watchlist_formal_report_is_valid(monkeypatch):
    monkeypatch.setattr(validate_input, "load_watchlist", lambda: {"000001": {"name": "测试"}})
    data = {
        "project": "业绩报告",
        "date": "2026-07-22",
        "fetch_complete": True,
        "fetch_summary": {
            "formal_report_rows": 1,
            "included_report_rows": 1,
            "watchlist_report_rows": 0,
            "errors": [],
        },
        "items": [{
            "证券代码": "688613",
            "公告ID": "1225435955",
            "公告标题": "奥精医疗：2025年年度报告(更正后)",
            "watchlist命中": 0,
            "报告类型": "年度报告",
            "原文链接": "https://static.cninfo.com.cn/example.pdf",
            "全文解析状态": "ok",
            "指标覆盖数": 1,
        }],
    }
    errors, _ = validate(data)
    assert errors == []
