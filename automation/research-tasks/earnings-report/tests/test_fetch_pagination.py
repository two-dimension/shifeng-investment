from __future__ import annotations

import pytest

import fetch_cninfo
import validate_input


def _rows(start: int, count: int) -> list[dict]:
    return [{"announcementId": str(value)} for value in range(start, start + count)]


def test_fetch_continues_when_server_returns_30_for_requested_50(monkeypatch):
    pages = {
        1: {"announcements": _rows(0, 30), "totalAnnouncement": 36},
        2: {"announcements": _rows(30, 6), "totalAnnouncement": 36},
    }
    calls: list[int] = []

    def fake_post_page(date_str, column, searchkey, page):
        calls.append(page)
        return pages[page]

    # 回归旧的请求口径：实际页长 30 小于请求的 50，仍必须抓第二页。
    monkeypatch.setattr(fetch_cninfo, "PAGE_SIZE", 50)
    monkeypatch.setattr(fetch_cninfo, "_post_page", fake_post_page)
    monkeypatch.setattr(fetch_cninfo.time, "sleep", lambda _: None)

    rows, stats = fetch_cninfo.fetch_query("2026-08-04", "sse", "年度报告")

    assert calls == [1, 2]
    assert len(rows) == 36
    assert stats["rows"] == stats["total_expected"] == 36
    assert stats["complete"] is True


def test_fetch_rejects_repeated_page_without_waiting_for_page_limit(monkeypatch):
    first_page = _rows(0, 30)
    calls: list[int] = []

    def fake_post_page(date_str, column, searchkey, page):
        calls.append(page)
        return {"announcements": first_page, "totalAnnouncement": 36}

    monkeypatch.setattr(fetch_cninfo, "_post_page", fake_post_page)
    monkeypatch.setattr(fetch_cninfo.time, "sleep", lambda _: None)

    with pytest.raises(fetch_cninfo.FetchError, match="分页无进展/返回重复公告"):
        fetch_cninfo.fetch_query("2026-08-04", "sse", "年度报告")

    assert calls == [1, 2]


def test_fetch_rejects_partial_overlap_between_pages(monkeypatch):
    pages = {
        1: {"announcements": _rows(0, 30), "totalAnnouncement": 36},
        2: {"announcements": _rows(29, 7), "totalAnnouncement": 36},
    }
    monkeypatch.setattr(fetch_cninfo, "_post_page", lambda date, column, key, page: pages[page])
    monkeypatch.setattr(fetch_cninfo.time, "sleep", lambda _: None)

    with pytest.raises(fetch_cninfo.FetchError, match="分页无进展/返回重复公告"):
        fetch_cninfo.fetch_query("2026-08-04", "sse", "年度报告")


def test_fetch_fails_when_empty_page_arrives_before_expected_total(monkeypatch):
    pages = {
        1: {"announcements": _rows(0, 30), "totalAnnouncement": "36"},
        2: {"announcements": [], "totalAnnouncement": "36"},
    }
    monkeypatch.setattr(fetch_cninfo, "_post_page", lambda date, column, key, page: pages[page])
    monkeypatch.setattr(fetch_cninfo.time, "sleep", lambda _: None)

    with pytest.raises(fetch_cninfo.FetchError, match="expected=36 actual=30"):
        fetch_cninfo.fetch_query("2026-08-04", "sse", "年度报告")


def test_missing_or_invalid_total_falls_back_to_empty_page(monkeypatch):
    pages = {
        1: {"announcements": _rows(0, 2)},
        2: {"announcements": _rows(2, 1), "totalAnnouncement": "invalid"},
        3: {"announcements": []},
    }
    monkeypatch.setattr(fetch_cninfo, "_post_page", lambda date, column, key, page: pages[page])
    monkeypatch.setattr(fetch_cninfo.time, "sleep", lambda _: None)

    rows, stats = fetch_cninfo.fetch_query("2026-08-04", "sse", "年度报告")

    assert len(rows) == 3
    assert stats["total_expected"] is None
    assert stats["pages"] == 3
    assert stats["stop_reason"] == "empty_page"


def test_watchlist_only_processes_matching_reports(monkeypatch, tmp_path):
    rows = [
        {
            "announcementId": "a",
            "secCode": "000001",
            "announcementTitle": "测试公司2026年半年度报告",
        },
        {
            "announcementId": "b",
            "secCode": "600000",
            "announcementTitle": "另一公司2026年半年度报告",
        },
    ]
    processed_codes = []

    monkeypatch.setattr(fetch_cninfo, "COLUMNS", ("sse",))
    monkeypatch.setattr(fetch_cninfo, "SEARCH_KEYS", ("半年度报告",))
    monkeypatch.setattr(fetch_cninfo, "load_watchlist", lambda: {"000001": {"name": "测试公司"}})
    monkeypatch.setattr(
        fetch_cninfo,
        "fetch_query",
        lambda *_args: (rows, {"complete": True, "rows": 2, "total_expected": 2}),
    )
    monkeypatch.setattr(fetch_cninfo.time, "sleep", lambda _: None)

    def fake_process(item, _raw_dir, _max_pdf_pages):
        processed_codes.append(item["secCode"])
        return {
            "证券代码": item["secCode"],
            "报告类型": "半年度报告",
            "全文解析状态": "ok",
            "指标覆盖数": 1,
        }

    monkeypatch.setattr(fetch_cninfo, "_process_one", fake_process)

    data = fetch_cninfo.fetch_for_date(
        "2026-08-28",
        tmp_path,
        watchlist_only=True,
    )

    assert processed_codes == ["000001"]
    assert data["fetch_summary"]["formal_report_rows"] == 2
    assert data["fetch_summary"]["included_report_rows"] == 1
    assert data["fetch_summary"]["watchlist_only"] is True


def test_validate_rejects_query_total_mismatch_even_if_fetch_complete_is_true(monkeypatch):
    monkeypatch.setattr(validate_input, "load_watchlist", lambda: {})
    data = {
        "project": "业绩报告",
        "date": "2026-08-04",
        "fetch_complete": True,
        "fetch_summary": {
            "formal_report_rows": 0,
            "included_report_rows": 0,
            "watchlist_report_rows": 0,
            "errors": [],
            "queries": [{
                "column": "sse",
                "searchkey": "年度报告",
                "rows": 30,
                "total_expected": 36,
                "complete": True,
            }],
        },
        "items": [],
    }

    errors, _ = validate_input.validate(data)

    assert any("expected=36 actual=30" in error for error in errors)
