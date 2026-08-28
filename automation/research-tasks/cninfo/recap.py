#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
今日复盘 (Post-close recap)
============================
拉 T 日报告的 top_good/top_bad 全量标的, 用 T 日前一交易日 close → T 日 close 跨日算涨跌幅, 按强度分档统计.

业务口径: 跨日涨跌幅 = (T 日 close - T 日前一交易日 close) / T 日前一交易日 close
跟 A 股"涨跌幅"习惯一致 (同花顺 / 东方财富)

决策点 (用户拍板 2026-06-10):
  1. 复盘范围: 全量入榜公司
  2. 准确率: 按强度分档 + 列每只标的涨跌幅
  3. 位置: PDF 第二部分 (今日推荐) 后, 五、附录前

数据源: 新浪财经 (akshare 当前 ConnectionError, 改用 urllib 直调)

边界:
  - T 日 K 线尚未生成 (盘前 7am / 盘中 15:00 前) -> 用 T 日前一交易日收盘价 + 标"盘前" / "盘中"
  - 新浪拉价失败 -> 标"数据缺失"
"""
from __future__ import annotations
import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Optional

try:
    import trading_calendar
    _HAVE_TRADING_CALENDAR = True
except ImportError:
    _HAVE_TRADING_CALENDAR = False

HERE = Path(__file__).parent.resolve()
PRICE_CACHE_DIR = HERE / ".cache_prices"
PRICE_CACHE_DIR.mkdir(exist_ok=True)
PRICE_CACHE_FILE = PRICE_CACHE_DIR / "recap_prices.json"

_PRICE_MEM: Dict[str, Optional[list]] = {}
_HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}


def _is_earnings_forecast_title(title: str) -> bool:
    """v10.1: 业绩预告类公告不进入研判或复盘产物。"""
    return bool(re.search(
        r"业绩预告|业绩预增|业绩预减|业绩预亏|业绩快报|业绩修正|业绩预告修正|"
        r"预计净利润.*(?:增长|下降)|扭亏为盈|净利润为负",
        title or "",
    ))


def _load_file_cache() -> None:
    if PRICE_CACHE_FILE.exists():
        try:
            data = json.loads(PRICE_CACHE_FILE.read_text(encoding="utf-8"))
            # v9.15b: 清理历史 None 污染 (line 171 _build_items_parallel 旧 bug:
            # _sina_kline 失败时把 None 写进 cache, 导致后续跑批全 None)
            cleaned = {k: v for k, v in data.items() if v is not None}
            if len(cleaned) < len(data):
                print(
                    f"[recap] cache clean: 移除 {len(data) - len(cleaned)} 个 None 污染条目 "
                    f"(剩 {len(cleaned)}/{len(data)})",
                    file=sys.stderr,
                )
            _PRICE_MEM.update(cleaned)
        except Exception:
            pass


def _save_file_cache() -> None:
    try:
        PRICE_CACHE_FILE.write_text(
            json.dumps(_PRICE_MEM, ensure_ascii=False, indent=0),
            encoding="utf-8",
        )
    except Exception:
        pass


_load_file_cache()


def _sina_prefix(code: str) -> str:
    if code.startswith(("60", "688", "900", "5")):
        return "sh"
    if code.startswith(("00", "30", "20")):
        return "sz"
    if code.startswith(("8", "4", "92")):
        return "bj"
    return "sh"


def _sina_kline(code: str, datalen: int = 10) -> Optional[list]:
    symbol = f"{_sina_prefix(code)}{code}"
    url = (
        f"https://quotes.sina.cn/cn/api/jsonp_v2.php/var=/"
        f"CN_MarketDataService.getKLineData?symbol={symbol}&scale=240&datalen={datalen}"
    )
    last_err = None
    for attempt in range(2):
        try:
            req = urllib.request.Request(url, headers=_HEADERS)
            resp = urllib.request.urlopen(req, timeout=10)
            raw = resp.read().decode("gbk", errors="ignore")
            m = re.search(r"\((.*)\)", raw, re.S)
            if not m:
                return None
            data = json.loads(m.group(1))
            return data if isinstance(data, list) and data else None
        except Exception as e:
            last_err = e
            time.sleep(0.5 * (2 ** attempt))
    print(f"[recap] sina {code} 失败: {type(last_err).__name__}", file=sys.stderr)
    return None


def _classify_strength(score: int) -> str:
    if score >= 7:
        return "强利多"
    if score >= 4:
        return "中利多"
    if score >= 1:
        return "弱利多"
    if score <= -7:
        return "强利空"
    if score <= -4:
        return "中利空"
    return "弱利空"


def _pct_change(c_from: float, c_to: float) -> float:
    if c_from <= 0:
        return 0.0
    return (c_to - c_from) / c_from * 100.0


def _classify_limit(pct: float) -> Optional[str]:
    if abs(pct) >= 9.5:
        return "涨停" if pct > 0 else "跌停"
    return None


def _compute_market_ctx(prev_date: str, items: Optional[List[dict]] = None) -> Dict:
    """计算当日入榜标的的前收→收盘样本均值。

    历史实现遍历整个价格缓存并称作“全市场均值”，同一代码的多个缓存 key
    会重复计数，结果还会随缓存增长而漂移。当前只使用本次复盘明细，按代码
    去重后计算，因此口径可复现；用户可见文案明确称“入榜样本”，不冒充市场。
    """
    pcts = []
    seen_codes = set()
    for item in items or []:
        code = str(item.get("code") or "")
        pct = item.get("pct")
        if not code or code in seen_codes or pct is None:
            continue
        try:
            pcts.append(float(pct))
            seen_codes.add(code)
        except (ValueError, TypeError):
            continue

    if not pcts:
        return {}

    avg = sum(pcts) / len(pcts)
    if avg > 0.8:
        label = "入榜样本普涨"
        note = "样本整体偏强, 利空方向检验需结合指数背景解读"
    elif avg < -0.8:
        label = "入榜样本普跌"
        note = "样本整体偏弱, 利好方向检验需结合指数背景解读"
    else:
        label = "入榜样本平稳"
        note = "样本平均涨跌幅接近中性"

    t_minus_1 = "?"
    if _HAVE_TRADING_CALENDAR:
        try:
            t_minus_1 = trading_calendar.prev_trade_date(prev_date)
        except Exception:
            pass

    return {
        "prev_date": prev_date,
        "t_minus_1": t_minus_1,
        "avg_pct": round(avg, 2),
        "sample_n": len(pcts),
        "label": label,
        "note": note,
    }


def _build_one_item(it: dict, kline: Optional[list], date_from: str, date_to: str, today_kline_avail: bool) -> dict:
    code = it.get("code", "")
    rec = {
        "code": code,
        "company": it.get("company", ""),
        "industry": it.get("industry", ""),
        "score": it.get("best_score", 0),
        "strength": _classify_strength(it.get("best_score", 0)),
        "event": (it.get("best_title") or "")[:36],
        # v9.4: 透传主信号标签, 1.4 反思按 signal 归类 (限制性股票激励计划 / 高管增持 / 新药注册 等)
        "primary_signal": (it.get("best_signals") or [[None, 0]])[0][0] if it.get("best_signals") else None,
        "signals": [s[0] for s in (it.get("best_signals") or []) if s and s[0]],
        "rank": it.get("rank", ""),
    }
    if not kline:
        return {**rec, "open": None, "close": None, "pct": None, "tag": "数据缺失"}

    # 业务口径: T 日涨跌幅 = T 日 close 相对前一交易日 close; 收红/收绿按这个字段判断。
    # 新浪 K 线按日期正序, date_to 一定在最末一根或次末根
    t1_idx = next((i for i, r in enumerate(kline) if r.get("day") == date_to), None)
    if t1_idx is None or t1_idx <= 0:
        return {**rec, "open": None, "close": None, "pct": None, "tag": "数据缺失"}
    row_prev = kline[t1_idx - 1]
    row_t1 = kline[t1_idx]
    prev_close = float(row_prev.get("close") or 0)
    cp_t1 = float(row_t1.get("close") or 0)
    if prev_close <= 0 or cp_t1 <= 0:
        return {**rec, "open": round(prev_close, 2), "close": round(cp_t1, 2), "pct": None, "tag": "数据缺失"}
    pct = _pct_change(prev_close, cp_t1)
    tag = _classify_limit(pct) or ""
    return {**rec, "open": round(prev_close, 2), "close": round(cp_t1, 2), "pct": round(pct, 2), "tag": tag}


def _build_items_parallel(entries: List[dict], date_from: str, date_to: str, today_kline_avail: bool) -> List[dict]:
    items: List[Optional[dict]] = [None] * len(entries)
    if not entries:
        return []

    def _task(idx_it):
        idx, it = idx_it
        code = it.get("code", "")
        if not code:
            return idx, None
        cache_key = f"{code}|{date_from}|{date_to}"
        # v9.15b: 命中 None 表示历史污染, 重新抓; 抓成功才写 cache
        kline = _PRICE_MEM.get(cache_key)
        if kline is not None and not any(r.get("day") == date_to for r in kline):
            kline = None
        if kline is None:
            kline = _sina_kline(code, datalen=10)
            if kline:
                _PRICE_MEM[cache_key] = kline
        return idx, _build_one_item(it, kline, date_from, date_to, today_kline_avail)

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = [ex.submit(_task, (i, it)) for i, it in enumerate(entries)]
        for f in as_completed(futures):
            try:
                idx, rec = f.result()
                items[idx] = rec
            except Exception as e:
                print(f"[recap] task 失败: {type(e).__name__}: {e}", file=sys.stderr)
    _save_file_cache()
    return [it for it in items if it is not None]


def _bucket_stats(items: List[dict], side: str) -> Dict:
    # 跨日涨跌幅: T 日 close vs T 日前一交易日 close; 数据缺失 (pct=None 或 close=None) 也不算方向命中
    valid = [it for it in items if it.get("pct") is not None and it.get("close") is not None]
    by_strength: Dict[str, dict] = {}
    for it in valid:
        b = by_strength.setdefault(it["strength"], {"count": 0, "hit": 0, "sum_pct": 0.0, "items": []})
        b["count"] += 1
        b["sum_pct"] += it["pct"]
        is_hit = (side == "good" and it["pct"] > 0) or (side == "bad" and it["pct"] < 0)
        if is_hit:
            b["hit"] += 1
        b["items"].append({"code": it["code"], "company": it["company"], "pct": it["pct"], "tag": it.get("tag", "")})

    summary = []
    order = ["强利多", "中利多", "弱利多"] if side == "good" else ["强利空", "中利空", "弱利空"]
    for b in order:
        s = by_strength.get(b)
        if not s:
            continue
        avg = round(s["sum_pct"] / s["count"], 2) if s["count"] else 0
        rate = round(s["hit"] / s["count"] * 100, 1) if s["count"] else 0
        summary.append({"strength": b, "count": s["count"], "hit": s["hit"], "hit_rate": rate, "avg_pct": avg})
    return {"buckets": summary, "items": valid}


def build_recap(prev_processed_path: Path, target_trade_date: Optional[str] = None) -> Dict:
    """今日复盘: 验证 T 日报告 推荐标的 在 T 日前一交易日收盘 → T 日收盘 跨日涨跌幅

    业务逻辑:
      - 复盘对象: T 日 (prev_date 字段, 概念上是 T 日前一交易日) 报告里的全量入榜标的 (top_good + top_bad)
      - 验证口径: T 日收盘 vs T 日前一交易日收盘 跨日涨跌幅 = (T 日 close - T 日前一交易日 close) / T 日前一交易日 close (A 股"涨跌幅"习惯)
      - 数据源: 新浪 K 线, datalen=10 拿够, 按 day 字段匹配 T 日
      - K 线状态: T 日已收盘, 不再有"盘前"边界; 数据缺失则标"数据缺失"
    """
    if not prev_processed_path.exists():
        return {}
    try:
        prev = json.loads(prev_processed_path.read_text(encoding="utf-8"))
    except Exception:
        return {}

    source_entry_date = prev.get("end_date") or prev.get("start_date")
    if not source_entry_date:
        return {}
    target_trade_date = target_trade_date or source_entry_date

    top_good = [
        it for it in (prev.get("top_good", []) or [])
        if not _is_earnings_forecast_title(it.get("best_title") or it.get("event") or "")
    ]
    top_bad = [
        it for it in (prev.get("top_bad", []) or [])
        if not _is_earnings_forecast_title(it.get("best_title") or it.get("event") or "")
    ]
    if not top_good and not top_bad:
        return {}

    sample = (top_good + top_bad)[0] if (top_good or top_bad) else None
    sample_code = sample.get("code", "") if sample else ""
    sample_kline = _sina_kline(sample_code, datalen=10) if sample_code else None
    kline_avail = bool(sample_kline and any(r.get("day") == target_trade_date for r in sample_kline))

    good_items = _build_items_parallel(top_good, source_entry_date, target_trade_date, kline_avail)
    bad_items = _build_items_parallel(top_bad, source_entry_date, target_trade_date, kline_avail)

    return {
        "prev_date": target_trade_date,
        "source_entry_date": source_entry_date,
        "target_trade_date": target_trade_date,
        "kline_avail": kline_avail,
        "market_ctx": _compute_market_ctx(target_trade_date, good_items + bad_items),
        "top_good": top_good,
        "top_bad": top_bad,
        "good_items": good_items,
        "bad_items": bad_items,
        "good_stats": _bucket_stats(good_items, "good"),
        "bad_stats": _bucket_stats(bad_items, "bad"),
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("用法: python3 recap.py <prev_processed.json>", file=sys.stderr)
        sys.exit(1)
    out = build_recap(Path(sys.argv[1]))
    print(json.dumps(out, ensure_ascii=False, indent=2))
