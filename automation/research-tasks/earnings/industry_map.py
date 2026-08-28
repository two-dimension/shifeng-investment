#!/usr/bin/env python3
"""Industry/subset lookup shared by earnings-preview outputs."""
from __future__ import annotations

import csv
import os
from functools import lru_cache
from pathlib import Path


HERE = Path(__file__).resolve().parent
WATCHLIST_CSV = Path(os.environ.get(
    "EARNINGS_WATCHLIST_CSV",
    str(HERE.parent / "cninfo" / "watchlist.csv"),
))
DEFAULT_SUBSET = "其他"


def _norm_code(code) -> str:
    text = str(code or "").strip()
    if not text:
        return ""
    text = text.split(",")[0].strip()
    if text.endswith(".SZ") or text.endswith(".SH") or text.endswith(".BJ"):
        text = text[:6]
    return text.zfill(6) if text.isdigit() and len(text) <= 6 else text


@lru_cache(maxsize=1)
def load_stock_subsets(path: str = str(WATCHLIST_CSV)) -> dict[str, str]:
    """Return stock_code -> 'concept1;concept2' from the cninfo watchlist."""
    csv_path = Path(path)
    if not csv_path.exists():
        return {}

    by_code: dict[str, list[tuple[int, str]]] = {}
    with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            code = _norm_code(row.get("stock_code"))
            concept = (row.get("concept_name") or "").strip()
            if not code or not concept:
                continue
            try:
                rank = int(row.get("rank") or 9999)
            except ValueError:
                rank = 9999
            by_code.setdefault(code, []).append((rank, concept))

    out: dict[str, str] = {}
    for code, concepts in by_code.items():
        seen = set()
        ordered = []
        for _, concept in sorted(concepts, key=lambda x: (x[0], x[1])):
            if concept in seen:
                continue
            seen.add(concept)
            ordered.append(concept)
        out[code] = ";".join(ordered) if ordered else DEFAULT_SUBSET
    return out


def lookup_subset(code, default: str = DEFAULT_SUBSET) -> str:
    return load_stock_subsets().get(_norm_code(code), default)


def enrich_item_subset(item: dict) -> dict:
    subset = item.get("所属子集") or item.get("行业") or lookup_subset(item.get("证券代码") or item.get("code"))
    subset = subset or DEFAULT_SUBSET
    item["所属子集"] = subset
    item["行业"] = subset
    return item
