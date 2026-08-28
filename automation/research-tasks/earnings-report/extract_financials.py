#!/usr/bin/env python3
"""从中英文正式定期报告 PDF 文本中保守抽取核心财务指标。"""
from __future__ import annotations

import math
import re
from io import BytesIO

import pypdf


NUMBER_RE = re.compile(
    r"(?<![\d.,，])(?P<paren>\()?\s*"
    r"(?P<num>[-−－]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?)\s*"
    r"(?P<unit>亿元|万元|亿|万|元|股|(?:RMB|CNY)\s*(?:billions?|millions?|thousands?|yuan)|"
    r"(?:billions?|millions?|thousands?)\s*(?:RMB|CNY|yuan)|yuan)?\s*(?P<pct>%)?\s*(?(paren)\))"
    r"(?![\d.,，])",
    re.I,
)

FULL_NUMBER_RE = re.compile(
    r"[-−－]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?"
)
INCOMPLETE_COMMA_TAIL_RE = re.compile(
    r"(?<![\d.,，])(?P<num>[-−－]?\d{1,3}(?:[,，]\d{3})*[,，]\d{0,2})\s*$"
)
INCOMPLETE_DOT_TAIL_RE = re.compile(
    r"(?<![\d.,，])(?P<num>[-−－]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)\.)\s*$"
)
ONE_DECIMAL_TAIL_RE = re.compile(
    r"(?<![\d.,，])(?P<num>[-−－]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)\.\d)\s*$"
)
LEADING_NUMBER_FRAGMENT_RE = re.compile(r"^\s*(?P<num>\d[\d,，.]*)")
MALFORMED_NUMBER_RE = re.compile(
    r"(?<![\d.,，])[-−－]?\d{1,3}(?:[,，]\d{3})*[,，]\d{0,2}(?![\d.,，])"
    r"|(?<![\d.,，])[-−－]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)\.(?!\d)"
)

METRICS = (
    ("扣非净利润", (
        "归属于上市公司股东的扣除非经常性损益的净利润",
        "扣除非经常性损益后的净利润",
        "Net profit attributable to shareholders of the listed company after deducting non-recurring gains and losses",
        "Net profit attributable to owners of the parent after deducting non-recurring gains and losses",
    ), "money"),
    ("归母净利润", (
        "归属于上市公司股东的净利润",
        "归属于母公司所有者的净利润",
        "Net profit attributable to shareholders of the listed company",
        "Net profit attributable to owners of the parent",
    ), "money"),
    ("营业收入", ("营业收入", "Operating income", "Operating revenue"), "money"),
    ("经营现金流", (
        "经营活动产生的现金流量净额",
        "经营活动产生的现金流量净",
        "Net cash flows from operating activities",
        "Net cash flow generated from operating activities",
    ), "money"),
    ("基本每股收益", ("基本每股收益", "Basic earnings per share"), "per_share"),
    ("加权ROE", ("加权平均净资产收益率", "Weighted average ROE", "Weighted average return on equity"), "percent"),
)


def pdf_bytes_to_text(data: bytes, max_pages: int = 60) -> tuple[str, dict]:
    if not data:
        return "", {"status": "empty_pdf", "pages_total": 0, "pages_read": 0}
    try:
        reader = pypdf.PdfReader(BytesIO(data), strict=False)
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:
                pass
        chunks = []
        pages_read = min(len(reader.pages), max_pages)
        for page in reader.pages[:pages_read]:
            try:
                chunks.append(page.extract_text() or "")
            except Exception:
                chunks.append("")
        text = "\n".join(chunks)
        status = "ok" if text.strip() else "no_text"
        return text, {"status": status, "pages_total": len(reader.pages), "pages_read": pages_read}
    except Exception as exc:
        return "", {"status": "pdf_error", "error": str(exc)[:300], "pages_total": 0, "pages_read": 0}


def _compact(value: str) -> str:
    return re.sub(r"\s+", "", value or "")


def _label_compact(value: str) -> str:
    """移除表格数值和标点，用于匹配被换行或数字列打断的中英文标签。"""
    without_numbers = NUMBER_RE.sub("", value or "")
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "", without_numbers).lower()


def _is_incomplete_number(value: str) -> bool:
    return bool(
        INCOMPLETE_COMMA_TAIL_RE.fullmatch(value.strip())
        or INCOMPLETE_DOT_TAIL_RE.fullmatch(value.strip())
    )


def _join_wrapped_number_tail(current: str, following: str) -> str | None:
    """只合并可由相邻行无歧义还原的数字尾部。"""
    leading = LEADING_NUMBER_FRAGMENT_RE.match(following)
    if not leading:
        return None
    leading_number = leading.group("num")

    tail = INCOMPLETE_COMMA_TAIL_RE.search(current)
    if not tail:
        tail = INCOMPLETE_DOT_TAIL_RE.search(current)
    if tail:
        candidate = tail.group("num") + leading_number
        if FULL_NUMBER_RE.fullmatch(candidate):
            return current[:tail.start("num")] + candidate + following[leading.end():]

    # pypdf 偶尔把小数第二位单独换行；仅在下一行恰为一位数字时合并。
    tail = ONE_DECIMAL_TAIL_RE.search(current)
    if tail and re.fullmatch(r"\s*\d\s*", following):
        candidate = tail.group("num") + following.strip()
        if FULL_NUMBER_RE.fullmatch(candidate):
            return current[:tail.start("num")] + candidate
    return None


def _normalize_wrapped_numbers(lines: list[str]) -> list[str]:
    """保守还原窄表格中被 pypdf 拆到多行的金额。"""
    normalized = list(lines)
    index = 0
    while index < len(normalized) - 1:
        current = normalized[index]
        following = normalized[index + 1]

        # 独立负号只在下一行本身明确是未完数字时拼接，避免把空值占位误作负号。
        if current.strip() in ("-", "−", "－") and _is_incomplete_number(following):
            normalized[index] = current.strip() + following.lstrip()
            del normalized[index + 1]
            continue

        joined = _join_wrapped_number_tail(current, following)
        if joined is not None:
            normalized[index] = joined
            del normalized[index + 1]
            continue
        index += 1
    return normalized


def _is_page_header(line: str) -> bool:
    value = (line or "").strip()
    return bool(
        re.search(r"Full\s+text\s+of\s+the\s+20\d{2}\s+Annual\s+Report", value, re.I)
        or re.fullmatch(r"\d{1,4}", value)
    )


def _is_year_token(raw: str, unit: str, pct: bool) -> bool:
    if unit or pct or "." in raw or "," in raw or "，" in raw:
        return False
    try:
        value = int(raw)
    except ValueError:
        return False
    return 1900 <= abs(value) <= 2100


def _tokens(text: str) -> list[dict]:
    out = []
    for match in NUMBER_RE.finditer(text or ""):
        raw = match.group("num")
        unit = match.group("unit") or ""
        pct = bool(match.group("pct"))
        if _is_year_token(raw, unit, pct):
            continue
        try:
            value = float(raw.replace(",", "").replace("，", "").replace("−", "-").replace("－", "-"))
        except ValueError:
            continue
        if match.group("paren") and value > 0:
            value = -value
        out.append({
            "value": value,
            "unit": unit,
            "percent": pct,
            "raw": match.group(0).strip(),
            "start": match.start(),
            "end": match.end(),
        })
    return out


def _mixed_table_tokens(text: str) -> list[dict]:
    """保留“不适用”占位，供三季报双口径表按列定位。"""
    values = [dict(token, token_type="number") for token in _tokens(text)]
    values.extend(
        {
            "token_type": "na",
            "raw": match.group(0),
            "value": None,
            "unit": "",
            "percent": False,
            "start": match.start(),
            "end": match.end(),
        }
        for match in re.finditer(r"不适用", text or "")
    )
    return sorted(values, key=lambda token: token["start"])


def _context_unit(lines: list[str], index: int) -> str:
    context = "".join(lines[max(0, index - 15): index + 2])
    matches = re.findall(r"单位[:：]?\s*(亿元|万元|元)", context)
    if matches:
        return matches[-1]
    english = re.findall(
        r"(?:Unit|Currency)\s*[:：]?\s*((?:RMB|CNY)\s*(?:billions?|millions?|thousands?|yuan)|yuan)",
        context,
        re.I,
    )
    return english[-1] if english else "元"


def _money_to_yi(value: float, inline_unit: str, context_unit: str) -> float:
    unit = inline_unit or context_unit or "元"
    if unit in ("亿元", "亿"):
        return value
    if unit in ("万元", "万"):
        return value / 10000.0
    english_unit = re.sub(r"\s+", "", unit).lower()
    if "billion" in english_unit:
        return value * 10.0
    if "million" in english_unit:
        return value / 100.0
    if "thousand" in english_unit:
        return value / 100000.0
    return value / 100000000.0


def _clean_number(value: float | None, digits: int = 4) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(value, digits)


def _is_q3_dual_table(lines: list[str], index: int, report_type: str | None) -> bool:
    if report_type != "第三季度报告":
        return False
    context = _compact("".join(lines[max(0, index - 20): index + 1]))
    return "本报告期" in context and "年初至报告期末" in context


def _looks_like_value_continuation(line: str) -> bool:
    value = (line or "").strip()
    if not value:
        return False
    if "不适用" in value:
        return True
    return bool(
        re.match(r"^(?:[-−－(]?\s*\d|增加|减少|上升|下降|a\s+(?:drop|rise)|an\s+increase)", value, re.I)
    )


def _metric_window(lines: list[str], start: int, label_span: int, max_extra: int = 24) -> str:
    """取得当前表格行，遇到下一条文字标签即停止，避免吸入下一指标。"""
    label_end = start + label_span
    parts = list(lines[start: label_end + 1])
    has_values = bool(_tokens(" ".join(parts))) or any("不适用" in part for part in parts)
    stop = min(len(lines), label_end + 1 + max_extra)
    for position in range(label_end + 1, stop):
        line = lines[position]
        if has_values and not _looks_like_value_continuation(line):
            break
        parts.append(line)
        if _tokens(line) or "不适用" in line:
            has_values = True
    return " ".join(parts)


def _plain_disclosed_yoy(lines: list[str], index: int, plain: list[dict]) -> dict | None:
    """按表头列位识别未逐行携带百分号的已披露同比。"""
    context = _compact(" ".join(lines[max(0, index - 70): index + 1]))
    has_yoy_percent_column = bool(
        re.search(r"(?:增减|变动幅度)[^%]{0,20}%", context, re.I)
        or re.search(r"(?:increase|decrease|change)[^%]{0,20}%", context, re.I)
    )
    if not has_yoy_percent_column:
        return None
    yoy_index = 3 if "调整后" in context and "调整前" in context else 2
    return plain[yoy_index] if len(plain) > yoy_index else None


def _find_metric(lines: list[str], aliases: tuple[str, ...], kind: str, report_type: str | None) -> dict:
    for idx, line in enumerate(lines):
        label_line = _label_compact(line)
        if not label_line:
            continue
        matched_alias = None
        matched_span = 0
        for alias_raw in aliases:
            alias = _label_compact(alias_raw)
            for span in range(6):
                combined = _label_compact(" ".join(lines[idx: idx + span + 1]))
                matched = alias in combined if span == 0 else combined.startswith(alias)
                if matched:
                    matched_alias = alias_raw
                    matched_span = span
                    break
            if matched_alias:
                break
        if not matched_alias:
            continue
        window = _metric_window(lines, idx, matched_span)
        for alias in aliases:
            window = re.sub(re.escape(alias), " ", window, flags=re.I)
            window = re.sub("\\s*".join(map(re.escape, alias)), " ", window, flags=re.I)
        if MALFORMED_NUMBER_RE.search(window):
            # 无法无歧义还原的数字残片不得拆成合法前缀或后缀继续计算。
            continue
        dual_q3 = _is_q3_dual_table(lines, idx, report_type)
        if dual_q3:
            columns = _mixed_table_tokens(window)
            if len(columns) >= 3 and columns[2]["token_type"] == "number":
                target = columns[2]
                if kind == "percent":
                    return {"value": _clean_number(target["value"]), "raw": target["raw"], "line": idx + 1}
                if kind == "per_share":
                    return {"value": _clean_number(target["value"]), "raw": target["raw"], "line": idx + 1}
                unit = _context_unit(lines, idx)
                current_yi = _money_to_yi(target["value"], target["unit"], unit)
                yoy = None
                if len(columns) >= 4 and columns[3]["token_type"] == "number":
                    yoy = columns[3]["value"]
                return {
                    "value_yi": _clean_number(current_yi),
                    "previous_yi": None,
                    "yoy_pct": _clean_number(yoy, 2),
                    "raw": target["raw"],
                    "line": idx + 1,
                    "unit_context": unit,
                    "period_basis": "年初至报告期末",
                }
        values = _tokens(window)
        if kind == "percent":
            pct_values = [x for x in values if x["percent"]]
            if pct_values:
                return {"value": _clean_number(pct_values[0]["value"]), "raw": pct_values[0]["raw"], "line": idx + 1}
            continue
        if kind == "per_share":
            plain = [x for x in values if not x["percent"] and abs(x["value"]) < 1000]
            if plain:
                return {"value": _clean_number(plain[0]["value"]), "raw": plain[0]["raw"], "line": idx + 1}
            continue

        plain = [x for x in values if not x["percent"]]
        if not plain:
            continue
        unit = _context_unit(lines, idx)
        current_yi = _money_to_yi(plain[0]["value"], plain[0]["unit"], unit)
        previous_yi = _money_to_yi(plain[1]["value"], plain[1]["unit"], unit) if len(plain) > 1 else None
        pct_values = [x for x in values if x["percent"]]
        yoy = pct_values[0]["value"] if pct_values else None
        if yoy is None:
            disclosed_yoy = _plain_disclosed_yoy(lines, idx, plain)
            yoy = disclosed_yoy["value"] if disclosed_yoy else None
        if yoy is None and len(plain) == 2 and previous_yi not in (None, 0):
            yoy = (current_yi - previous_yi) / abs(previous_yi) * 100
        return {
            "value_yi": _clean_number(current_yi),
            "previous_yi": _clean_number(previous_yi),
            "yoy_pct": _clean_number(yoy, 2),
            "raw": plain[0]["raw"],
            "line": idx + 1,
            "unit_context": unit,
        }
    return {}


def extract_financial_metrics(text: str, report_type: str | None = None) -> dict:
    lines = [re.sub(r"[\u00a0\t]+", " ", line).strip() for line in (text or "").splitlines()]
    lines = _normalize_wrapped_numbers([line for line in lines if line])
    lines = [line for line in lines if not _is_page_header(line)]
    result: dict = {}
    evidence: dict = {}
    for key, aliases, kind in METRICS:
        found = _find_metric(lines, aliases, kind, report_type)
        evidence[key] = found
        if kind == "money":
            result[f"{key}亿元"] = found.get("value_yi")
            result[f"{key}同比%"] = found.get("yoy_pct")
        elif kind == "per_share":
            result["基本每股收益元"] = found.get("value")
        else:
            result["加权ROE%"] = found.get("value")
    covered = sum(
        result.get(key) is not None
        for key in ("营业收入亿元", "归母净利润亿元", "扣非净利润亿元", "经营现金流亿元")
    )
    result["指标覆盖数"] = covered
    result["抽取证据"] = evidence
    return result


def extract_from_pdf_bytes(
    data: bytes,
    max_pages: int = 60,
    report_type: str | None = None,
) -> tuple[dict, str, dict]:
    text, meta = pdf_bytes_to_text(data, max_pages=max_pages)
    metrics = extract_financial_metrics(text, report_type=report_type) if text else extract_financial_metrics("", report_type=report_type)
    meta["metrics_covered"] = metrics.get("指标覆盖数", 0)
    return metrics, text, meta
