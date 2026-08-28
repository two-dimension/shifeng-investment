#!/usr/bin/env python3
"""从巨潮资讯项目的 watchlist 加载证券范围与所属子集。"""
from __future__ import annotations

import csv
import os
from collections import defaultdict
from functools import lru_cache
from pathlib import Path


HERE = Path(__file__).resolve().parent
DEFAULT_WATCHLIST = HERE.parent / "cninfo" / "watchlist.csv"


def normalize_code(value: object) -> str:
    raw = str(value or "").strip().split(",")[0]
    digits = "".join(ch for ch in raw if ch.isdigit())
    return digits[-6:].zfill(6) if digits else ""


@lru_cache(maxsize=1)
def load_watchlist() -> dict[str, dict]:
    path = Path(os.environ.get("WATCHLIST_PATH", str(DEFAULT_WATCHLIST))).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"watchlist 不存在: {path}")
    grouped: dict[str, dict] = defaultdict(lambda: {"name": "", "subsets": []})
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            code = normalize_code(row.get("stock_code") or row.get("证券代码"))
            if not code:
                continue
            name = (row.get("stock_name") or row.get("证券简称") or "").strip()
            subset = (row.get("concept_name") or row.get("industry_name") or row.get("所属子集") or "").strip()
            if name:
                grouped[code]["name"] = name
            if subset and subset not in grouped[code]["subsets"]:
                grouped[code]["subsets"].append(subset)
    if not grouped:
        raise ValueError(f"watchlist 为空或字段不兼容: {path}")
    return dict(grouped)


def lookup(code: object) -> dict | None:
    return load_watchlist().get(normalize_code(code))
