#!/usr/bin/env python3
"""
业绩预告 input.json 质量闸门。

目标：抓取后的结构化字段如果明显异常，直接失败，阻止继续生成日报或同步平台。
"""
import json
import sys
from pathlib import Path


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def implied_previous_values(low_wan, high_wan, low_pct, high_pct):
    values = []
    for current in (low_wan, high_wan):
        for pct in (low_pct, high_pct):
            if not is_number(current) or not is_number(pct):
                continue
            denom = 1 + pct / 100
            if abs(denom) < 1e-6:
                continue
            implied = current / denom
            if implied > 0:
                values.append(implied)
    return values


def check_item(item):
    issues = []
    code = item.get("证券代码", "")
    name = item.get("证券简称", "")
    prefix = f"{code} {name}".strip()

    low_wan = item.get("下限万元")
    high_wan = item.get("上限万元")
    prev_wan = item.get("上年同期万元")
    low_pct = item.get("同比下限%")
    high_pct = item.get("同比上限%")
    forecast_type = str(item.get("预告类型", ""))
    url = item.get("公告链接")

    if not url:
        issues.append(f"{prefix}: 缺少公告链接")

    if not is_number(low_wan) or not is_number(high_wan):
        issues.append(f"{prefix}: 净利润区间未抓取")
        return issues

    has_yoy = (is_number(low_pct) and low_pct != 0) or (is_number(high_pct) and high_pct != 0)

    if low_wan == 0 and high_wan == 0 and has_yoy:
        issues.append(f"{prefix}: 净利润区间为 0/0 但已有同比，疑似净利润未抓取")

    if (
        max(abs(low_wan), abs(high_wan)) <= 10
        and (abs(low_pct or 0) >= 50 or abs(high_pct or 0) >= 50)
    ):
        issues.append(f"{prefix}: 净利润区间异常小 {low_wan}~{high_wan} 万元，疑似误抓日期或每股收益")

    if low_pct == 0 and high_pct == 0 and (low_wan != 0 or high_wan != 0):
        issues.append(f"{prefix}: 同比区间为 0/0，疑似同比未抓取")

    if forecast_type in {"预减", "首亏", "略减", "增亏"}:
        if is_number(low_pct) and low_pct > 0:
            issues.append(f"{prefix}: {forecast_type} 同比下限为正数 {low_pct}%，应为负向")
        if is_number(high_pct) and high_pct > 0:
            issues.append(f"{prefix}: {forecast_type} 同比上限为正数 {high_pct}%，应为负向")

    if (
        is_number(prev_wan)
        and prev_wan > 100
        and low_wan > 0
        and high_wan > 0
        and has_yoy
    ):
        implied_values = implied_previous_values(low_wan, high_wan, low_pct, high_pct)
        if implied_values:
            best_error = min(abs(value - prev_wan) / max(abs(prev_wan), 1) for value in implied_values)
            if best_error > 0.30:
                implied_preview = "、".join(f"{value:.2f}" for value in implied_values[:4])
                issues.append(
                    f"{prefix}: 上年同期 {prev_wan} 万元与当期净利润/同比不自洽，"
                    f"反推约 {implied_preview} 万元"
                )

    if prev_wan in ("", None) and is_number(low_wan) and is_number(high_wan) and not has_yoy:
        issues.append(f"{prefix}: 缺少上年同期且缺少有效同比")

    return issues


def main():
    if len(sys.argv) < 2:
        print("Usage: validate_input.py <input.json>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("items", [])
    issues = []
    for item in items:
        issues.extend(check_item(item))

    if issues:
        print(f"[validate_input] FAILED {path}: {len(issues)} issues", file=sys.stderr)
        for issue in issues:
            print(f"- {issue}", file=sys.stderr)
        return 1

    print(f"[validate_input] OK {path}: {len(items)} items")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
