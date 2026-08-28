from __future__ import annotations

import importlib.util
from pathlib import Path


TASKS_ROOT = Path(__file__).resolve().parents[1]


def _load_fetch_module():
    source = TASKS_ROOT / "cninfo" / "fetch.py"
    spec = importlib.util.spec_from_file_location("cninfo_fetch_under_test", source)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _page(total: int, *announcement_ids: str):
    return {
        "totalAnnouncement": total,
        "announcements": [
            {"announcementId": announcement_id}
            for announcement_id in announcement_ids
        ],
    }


def test_fetch_range_skips_duplicate_column_feed(monkeypatch):
    fetch = _load_fetch_module()
    calls = []
    pages = {
        ("sse", 1): _page(3, "a", "b"),
        ("sse", 2): _page(3, "c"),
        ("szse", 1): _page(3, "a", "b"),
        ("szse", 2): _page(3, "c"),
    }

    def fake_fetch_page(page, column, _se_date):
        calls.append((column, page))
        return pages[(column, page)]

    monkeypatch.setattr(fetch, "PAGE_SIZE", 2)
    monkeypatch.setattr(fetch, "_fetch_page", fake_fetch_page)
    monkeypatch.setattr(fetch.time, "sleep", lambda _seconds: None)

    result = fetch.fetch_range("2026-08-28")

    assert calls == [("sse", 1), ("szse", 1), ("sse", 2)]
    assert result["total"] == 3
    assert result["columns"]["szse"]["skipped_duplicate"] is True
    assert result["columns"]["szse"]["duplicate_of"] == "sse"


def test_fetch_range_keeps_distinct_column_feeds(monkeypatch):
    fetch = _load_fetch_module()
    calls = []
    pages = {
        ("sse", 1): _page(2, "a", "b"),
        ("szse", 1): _page(2, "c", "d"),
    }

    def fake_fetch_page(page, column, _se_date):
        calls.append((column, page))
        return pages[(column, page)]

    monkeypatch.setattr(fetch, "PAGE_SIZE", 2)
    monkeypatch.setattr(fetch, "_fetch_page", fake_fetch_page)
    monkeypatch.setattr(fetch.time, "sleep", lambda _seconds: None)

    result = fetch.fetch_range("2026-08-28")

    assert calls == [("sse", 1), ("szse", 1)]
    assert result["total"] == 4
    assert "skipped_duplicate" not in result["columns"]["szse"]
