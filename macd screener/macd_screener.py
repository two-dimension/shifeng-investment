#!/usr/bin/env python3
"""
MACD拐点选股工具 — 豆包方案完整实现
- 筛选A股中MACD出现拐点的股票（DIF先跌后涨）
- 输出豆包文档三个版本：基础版/进阶版/终极版拐点判断
- 同时输出日线/15分钟/30分钟/60分钟DIF值
- 数据源：Sina 新浪财经
"""

import requests
import pandas as pd
import numpy as np
from datetime import datetime
from typing import Optional, List, Dict, Tuple
import time
import json
import os
from pathlib import Path

# ---------- 配置 ----------
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "*/*",
    "Referer": "http://finance.sina.com.cn",
}
SINA_HQ = "http://hq.sinajs.cn/list="
SINA_KLINE = "http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData"
SINA_REQUEST_TIMEOUT = 5
MACD_DAILY_BARS = 90
MACD_15M_BARS = 100
MACD_WORKERS = 18

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
WATCHLIST_PATH = Path(
    os.environ.get("MACD_WATCHLIST_PATH", PROJECT_ROOT / "server" / "data" / "funds.json")
)
OUTPUT_DIR = Path(os.environ.get("MACD_OUTPUT_DIR", SCRIPT_DIR))


# ---------- 工具函数 ----------
def normalize_stock_code(raw_code) -> str:
    c = str(raw_code).strip().strip("'")
    if c.endswith(".0"):
        c = c[:-2]
    if c.startswith(("sh", "sz", "bj")) and len(c) == 8:
        return c
    c = c.zfill(6)
    if c.startswith(("600", "601", "603", "605", "688")):
        return f"sh{c}"
    if c.startswith(("000", "001", "002", "003", "300")):
        return f"sz{c}"
    if c.startswith(("4", "8", "9")) and len(c) == 6:
        return f"bj{c}"
    return ""


def parse_float(value) -> Optional[float]:
    try:
        if value is None:
            return None
        text = str(value).replace(",", "").replace("%", "").strip()
        if text in ("", "--", "nan", "None"):
            return None
        return float(text)
    except Exception:
        return None


def _empty_watchlist_meta(name="", price=None) -> Dict:
    return {
        "股票名称": str(name or "").strip(),
        "现价": parse_float(price),
        "涨幅": "",
        "涨幅数值": None,
        "换手": "",
        "成交额": "",
        "所属行业": "",
    }


def _load_platform_funds(path: Path) -> Tuple[List[str], Dict[str, Dict]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    codes = []
    meta = {}
    for fund in payload.get("funds", []):
        for position in fund.get("positions", []):
            code = normalize_stock_code(position.get("code"))
            if not code:
                continue
            if code not in meta:
                codes.append(code)
            meta[code] = _empty_watchlist_meta(
                position.get("name", ""),
                position.get("currentPrice"),
            )
    return codes, meta


def _load_legacy_watchlist(path: Path) -> Tuple[List[str], Dict[str, Dict]]:
    df = pd.read_csv(path, encoding="utf-16", sep="\t")
    codes = []
    meta = {}
    for _, row in df.iterrows():
        raw_code = row.get("代码")
        if pd.isna(raw_code):
            continue
        code = normalize_stock_code(raw_code)
        if not code:
            continue
        if code not in meta:
            codes.append(code)
        meta[code] = {
            "股票名称": str(row.get("名称", "")).strip(),
            "现价": parse_float(row.get("最新")),
            "涨幅": str(row.get("涨幅", "")).strip(),
            "涨幅数值": parse_float(row.get("涨幅")),
            "换手": str(row.get("换手", "")).strip(),
            "成交额": str(row.get("成交额", "")).strip(),
            "所属行业": str(row.get("所属行业", "")).strip(),
        }
    return codes, meta


def load_watchlist_meta() -> Tuple[List[str], Dict[str, Dict]]:
    if WATCHLIST_PATH.suffix.lower() == ".json":
        return _load_platform_funds(WATCHLIST_PATH)
    return _load_legacy_watchlist(WATCHLIST_PATH)


def load_watchlist() -> List[str]:
    codes, _ = load_watchlist_meta()
    return codes


def get_kline(code: str, scale: int = 240, num: int = 60) -> Optional[pd.DataFrame]:
    url = f"{SINA_KLINE}?symbol={code}&scale={scale}&ma=no&datalen={num}"
    try:
        r = requests.get(url, headers=HEADERS, timeout=SINA_REQUEST_TIMEOUT)
        raw = r.text
        if not raw or raw == "null":
            return None
        data = json.loads(raw)
        if not isinstance(data, list) or len(data) < 10:
            return None
        df = pd.DataFrame(data)
        df["close"] = df["close"].astype(float)
        return df.reset_index(drop=True)
    except Exception:
        return None


def calc_dif_series(closes: pd.Series, fast: int = 12, slow: int = 26) -> Optional[pd.Series]:
    if len(closes) < slow + 4:
        return None
    ema_fast = closes.ewm(span=fast, adjust=False).mean()
    ema_slow = closes.ewm(span=slow, adjust=False).mean()
    return ema_fast - ema_slow


# ---------- 拐点判断（三版本） ----------
def 拐点_基础版(dif_series: Optional[pd.Series]) -> bool:
    """
    基础版：日线单周期拐点
    上一期DIF < 上上期DIF（先跌），最新DIF > 上一期DIF（后涨）
    """
    if dif_series is None or len(dif_series) < 4:
        return False
    h = dif_series.iloc[-3:].values
    d2, d1, d0 = h[0], h[1], h[2]  # 上上期, 上一期, 最新
    return (d1 < d2) and (d0 > d1)


def 拐点_进阶版(dif_series: Optional[pd.Series]) -> bool:
    """
    进阶版：过滤80%假信号
    - DIF连续2期下跌（d3<d2 且 d2<d1）
    - 上涨幅度覆盖前一轮下跌的50%
    - DIF在零轴附近（|d4|<1.0，过滤超跌反弹）
    """
    if dif_series is None or len(dif_series) < 5:
        return False
    h = dif_series.iloc[-5:].values
    d0, d1, d2, d3, d4 = h  # T-4, T-3, T-2, T-1, T
    if not (d3 < d2 and d2 < d1):
        return False
    drop = d2 - d3
    rise = d4 - d3
    if rise <= 0 or rise < drop * 0.5:
        return False
    if abs(d4) > 1.0:
        return False
    return True


def 拐点_终极版(dif_daily: Optional[pd.Series], dif_15m: Optional[pd.Series]) -> bool:
    """
    终极版：日线+15分钟双周期共振
    - 日线DIF先跌后涨（大趋势止跌）
    - 15分钟DIF确认止跌（当前DIF高于近期最低点）
    """
    if not 拐点_基础版(dif_daily):
        return False
    if dif_15m is None or len(dif_15m) < 4:
        return False
    h = dif_15m.iloc[-4:].values
    min_idx = h.argmin()
    return min_idx > 0 and h[3] > h[min_idx]


def get_dif3(dif_series: Optional[pd.Series]) -> Tuple:
    """获取DIF最新3期值：最新、上一期、上上期"""
    if dif_series is None or len(dif_series) < 3:
        return None, None, None
    v = dif_series.iloc[-3:].values
    return round(v[2], 4), round(v[1], 4), round(v[0], 4)


def get_stock_names(codes: List[str]) -> Dict[str, Tuple[str, str]]:
    """批量获取股票(名称, 现价)"""
    names = {}
    batch_size = 50
    for i in range(0, len(codes), batch_size):
        batch = codes[i:i + batch_size]
        url = SINA_HQ + ",".join(batch)
        try:
            r = requests.get(url, headers=HEADERS, timeout=8)
            lines = r.text.strip().split("\n")
            for line in lines:
                try:
                    sym_raw = line.split("=")[0].split("_")[-1].strip('"')
                    content = line.split("=")[1].strip('"')
                    if not content:
                        continue
                    fields = content.split(",")
                    if len(fields) > 1:
                        names[sym_raw] = (fields[0], fields[1])
                except Exception:
                    continue
        except Exception:
            pass
        time.sleep(0.3)
    return names


def clamp(value: float, floor: float, ceiling: float) -> float:
    return max(floor, min(ceiling, value))


def calc_macd(closes: pd.Series):
    ef = closes.ewm(span=12, adjust=False).mean()
    es = closes.ewm(span=26, adjust=False).mean()
    dif = ef - es
    dea = dif.ewm(span=9, adjust=False).mean()
    hist = dif - dea
    return dif, dea, hist


def series_latest(series: Optional[pd.Series], offset: int = 1) -> Optional[float]:
    if series is None or len(series) < offset:
        return None
    return float(series.iloc[-offset])


def is_rising(series: Optional[pd.Series]) -> bool:
    if series is None or len(series) < 2:
        return False
    return float(series.iloc[-1]) > float(series.iloc[-2])


def is_expanding_red(hist: Optional[pd.Series]) -> bool:
    if hist is None or len(hist) < 3:
        return False
    h0 = float(hist.iloc[-1])
    h1 = float(hist.iloc[-2])
    h2 = float(hist.iloc[-3])
    return h0 > 0 and h0 > h1 and h1 >= h2


def m15_confirms(dif_15: Optional[pd.Series], hist_15: Optional[pd.Series]) -> bool:
    if dif_15 is None or len(dif_15) < 4:
        return False
    h = dif_15.iloc[-4:].values
    min_idx = h.argmin()
    dif_rebound = min_idx > 0 and h[-1] > h[min_idx]
    return dif_rebound or is_rising(hist_15)


def classify_macd_signal(
    dif_daily: pd.Series,
    dea_daily: pd.Series,
    hist_daily: pd.Series,
    dif_15: Optional[pd.Series],
    dea_15: Optional[pd.Series],
    hist_15: Optional[pd.Series],
    price: Optional[float],
    pct_change: Optional[float],
) -> Dict:
    dif_latest = float(dif_daily.iloc[-1])
    dea_latest = float(dea_daily.iloc[-1])
    hist_latest = float(hist_daily.iloc[-1])
    hist_prev = float(hist_daily.iloc[-2]) if len(hist_daily) >= 2 else hist_latest
    m15_hist_latest = series_latest(hist_15) or 0.0
    m15_hist_prev = series_latest(hist_15, 2) or m15_hist_latest

    daily_turn = bool(拐点_基础版(dif_daily))
    advanced_turn = bool(拐点_进阶版(dif_daily))
    m15_confirm = bool(m15_confirms(dif_15, hist_15))
    daily_golden = bool(dif_latest > dea_latest)
    hist_positive = bool(hist_latest > 0)
    hist_expanding = bool(is_expanding_red(hist_daily))
    m15_golden = bool((series_latest(dif_15) or 0.0) > (series_latest(dea_15) or 0.0))
    m15_positive = bool(m15_hist_latest > 0)
    m15_rising = bool(m15_hist_latest > m15_hist_prev)
    m15_weakening = bool(m15_hist_latest < 0 and m15_hist_latest < m15_hist_prev)

    normalized_strength = 0.0
    dif_pct = 0.0
    if price and price > 0:
        normalized_strength = hist_latest / price * 100
        dif_pct = dif_latest / price * 100
    near_zero = bool(abs(dif_pct) <= 2.0)
    bottom_repair = bool(dif_pct < 0 and daily_turn and hist_latest > hist_prev)
    high_chase = bool(pct_change is not None and pct_change >= 8)

    score = 0.0
    if daily_turn:
        score += 25
    if advanced_turn:
        score += 12
    if m15_confirm:
        score += 18
    if hist_positive:
        score += 14
    else:
        score -= 8
    if hist_expanding:
        score += 12
    if near_zero:
        score += 8
    if m15_positive:
        score += 8
    if m15_rising:
        score += 5
    score += clamp(normalized_strength * 25, -10, 10)
    if high_chase:
        score -= 6
    if m15_weakening:
        score -= 8
    score = round(clamp(score, 0, 100), 1)

    tags = []
    if daily_turn:
        tags.append("日线拐点")
    if advanced_turn:
        tags.append("进阶拐点")
    if m15_confirm:
        tags.append("15M确认")
    if hist_expanding:
        tags.append("红柱扩张")
    elif hist_positive:
        tags.append("红柱")
    if near_zero:
        tags.append("近零轴")
    if bottom_repair:
        tags.append("水下修复")
    if daily_golden:
        tags.append("日线多头")
    else:
        tags.append("日线空头")
    if m15_golden:
        tags.append("15M多头")
    if m15_weakening:
        tags.append("15M转弱")
    if high_chase:
        tags.append("当日涨幅偏大")

    if daily_turn and m15_confirm and score >= 60:
        level = "强信号"
    elif daily_turn or bottom_repair:
        level = "拐点观察"
    elif daily_golden and hist_positive and hist_expanding and score >= 45:
        level = "趋势延续"
    elif daily_golden and hist_positive:
        level = "趋势跟踪"
    elif (not daily_golden) or hist_latest < 0 or m15_weakening:
        level = "转弱风险"
    else:
        level = "无信号"

    is_candidate = level in ("强信号", "拐点观察", "趋势延续")
    return {
        "信号等级": level,
        "信号分": score,
        "信号标签": tags,
        "是否候选": is_candidate,
        "日线状态": "多头" if daily_golden else "空头",
        "分钟状态": "15M确认" if m15_confirm else ("15M转弱" if m15_weakening else "15M未确认"),
        "日线拐点": daily_turn,
        "进阶拐点": advanced_turn,
        "十五分钟确认": m15_confirm,
        "红柱扩张": hist_expanding,
        "近零轴": near_zero,
        "标准化强度": round(normalized_strength, 4),
        "观察理由": " / ".join(tags[:4]) if tags else level,
    }


# ---------- 主流程 ----------
def main():
    today = datetime.today().strftime("%Y%m%d")
    print(f"[{datetime.now().strftime('%H:%M:%S')}] MACD拐点选股（豆包方案）...")
    print(f"1. 读取自选股列表...")
    all_codes = load_watchlist()
    print(f"   共 {len(all_codes)} 个股票")

    print(f"2. 遍历计算各周期DIF，判断三版本拐点...")
    results = []
    total = len(all_codes)

    for idx, code in enumerate(all_codes):
        df_daily = get_kline(code, scale=240, num=60)
        if df_daily is None:
            continue
        closes_daily = df_daily["close"]
        dif_daily = calc_dif_series(closes_daily)
        if dif_daily is None:
            continue

        df15 = get_kline(code, scale=15, num=100)
        dif15_series = calc_dif_series(df15["close"]) if df15 is not None else None

        df30 = get_kline(code, scale=30, num=100)
        dif30_series = calc_dif_series(df30["close"]) if df30 is not None else None

        df60 = get_kline(code, scale=60, num=100)
        dif60_series = calc_dif_series(df60["close"]) if df60 is not None else None

        v_basic = 拐点_基础版(dif_daily)
        v_adv   = 拐点_进阶版(dif_daily)
        v_final = 拐点_终极版(dif_daily, dif15_series)

        # 只保留基础版通过
        if not v_basic:
            continue

        d_d0, d_d1, d_d2 = get_dif3(dif_daily)
        d15_0, d15_1, d15_2 = get_dif3(dif15_series)
        d30_0, d30_1, d30_2 = get_dif3(dif30_series)
        d60_0, d60_1, d60_2 = get_dif3(dif60_series)

        # 日线MACD直方图（用于排序）
        ef = closes_daily.ewm(span=12, adjust=False).mean()
        es = closes_daily.ewm(span=26, adjust=False).mean()
        dif_series = ef - es
        dif_latest = float(dif_series.iloc[-1])
        dea_latest = float(dif_series.ewm(span=9, adjust=False).mean().iloc[-1])
        hist_latest = dif_latest - dea_latest

        # 获取现价
        price = None
        try:
            r = requests.get(SINA_HQ + code, headers=HEADERS, timeout=SINA_REQUEST_TIMEOUT)
            fields = r.text.split("=")[1].strip('"').split(",")
            if len(fields) > 1 and fields[1] != '0.00':
                price = float(fields[1])
        except Exception:
            pass
        if price is None:
            price = float(closes_daily.iloc[-1])

        results.append({
            "股票代码": code,
            "现价": price,
            "日K_DIF_最新": d_d0,
            "日K_DIF_上一期": d_d1,
            "日K_DIF_上上期": d_d2,
            "15分钟_DIF_最新": d15_0,
            "15分钟_DIF_上一期": d15_1,
            "15分钟_DIF_上上期": d15_2,
            "30分钟_DIF_最新": d30_0,
            "30分钟_DIF_上一期": d30_1,
            "30分钟_DIF_上上期": d30_2,
            "60分钟_DIF_最新": d60_0,
            "60分钟_DIF_上一期": d60_1,
            "60分钟_DIF_上上期": d60_2,
            "拐点_基础版": "是" if v_basic else "否",
            "拐点_进阶版": "是" if v_adv else "否",
            "拐点_终极版": "是" if v_final else "否",
            "MACD直方图": round(hist_latest, 4),
        })

        if (idx + 1) % 50 == 0:
            print(f"   进度: {idx+1}/{total}，已命中 {len(results)} 个...")

        time.sleep(0.15)

    print(f"   拐点候选: {len(results)} 只")

    print(f"3. 获取股票名称...")
    names_map = get_stock_names([r["股票代码"] for r in results])
    for r in results:
        code = r["股票代码"]
        if code in names_map:
            r["股票名称"] = names_map[code][0]
        else:
            r["股票名称"] = ""

    print(f"4. 输出Excel...")
    df_result = pd.DataFrame(results)
    if df_result.empty:
        print("没有找到符合条件的股票")
        return

    cols = ["股票代码", "股票名称", "现价",
            "日K_DIF_最新", "日K_DIF_上一期", "日K_DIF_上上期",
            "15分钟_DIF_最新", "15分钟_DIF_上一期", "15分钟_DIF_上上期",
            "30分钟_DIF_最新", "30分钟_DIF_上一期", "30分钟_DIF_上上期",
            "60分钟_DIF_最新", "60分钟_DIF_上一期", "60分钟_DIF_上上期",
            "拐点_基础版", "拐点_进阶版", "拐点_终极版", "MACD直方图"]
    df_result = df_result[[c for c in cols if c in df_result.columns]]
    if "MACD直方图" in df_result.columns:
        df_result = df_result.sort_values("MACD直方图", ascending=False).reset_index(drop=True)
    else:
        df_result = df_result.reset_index(drop=True)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / f"MACD拐点_{today}.xlsx"
    df_result.to_excel(out_path, index=False, sheet_name="MACD拐点")
    print(f"完成！输出: {out_path}")
    print(f"共 {len(df_result)} 只通过基础版拐点")
    adv_count = (df_result["拐点_进阶版"] == "是").sum()
    final_count = (df_result["拐点_终极版"] == "是").sum()
    print(f"  其中进阶版通过: {adv_count} 只")
    print(f"  其中终极版通过: {final_count} 只")


if __name__ == "__main__":
    import sys, time, json as _json
    if len(sys.argv) > 1 and sys.argv[1] == '--api':
        # API模式：输出JSON，使用并行请求
        from concurrent.futures import ThreadPoolExecutor, as_completed
        import requests as _req
        import pandas as _pd

        def fetch_stock(code):
            try:
                url = f"{SINA_KLINE}?symbol={code}&scale={{}}&ma=no&datalen={{}}"
                # Fetch daily and 15m bars for this stock
                r_d = _req.get(url.format(240, MACD_DAILY_BARS), headers=HEADERS, timeout=SINA_REQUEST_TIMEOUT)
                r15 = _req.get(url.format(15, MACD_15M_BARS), headers=HEADERS, timeout=SINA_REQUEST_TIMEOUT)
                raw_d = r_d.text
                raw_15 = r15.text
                if not raw_d or raw_d == "null" or not raw_15 or raw_15 == "null":
                    return None
                df_d = _pd.DataFrame(_json.loads(raw_d))
                df_15 = _pd.DataFrame(_json.loads(raw_15))
                if len(df_d) < 10 or len(df_15) < 10:
                    return None
                closes_d = df_d['close'].astype(float)
                closes_15 = df_15['close'].astype(float)
                dif_d, dea_d, hist_d = calc_macd(closes_d)
                dif_15, dea_15, hist_15 = calc_macd(closes_15)
                meta = watchlist_meta.get(code, {})
                price = meta.get("现价") or float(closes_d.iloc[-1])
                signal = classify_macd_signal(
                    dif_d,
                    dea_d,
                    hist_d,
                    dif_15,
                    dea_15,
                    hist_15,
                    price,
                    meta.get("涨幅数值"),
                )
                return {
                    '股票代码': code,
                    '股票名称': meta.get("股票名称", ""),
                    '现价': round(float(price), 3) if price is not None else None,
                    '涨幅': meta.get("涨幅", ""),
                    '涨幅数值': meta.get("涨幅数值"),
                    '换手': meta.get("换手", ""),
                    '成交额': meta.get("成交额", ""),
                    '所属行业': meta.get("所属行业", ""),
                    '日K_DIF': round(float(dif_d.iloc[-1]), 4),
                    '日K_DEA': round(float(dea_d.iloc[-1]), 4),
                    '日K_MACD': round(float(hist_d.iloc[-1]), 4),
                    '日K_DIF_上一期': round(float(dif_d.iloc[-2]), 4),
                    '日K_DEA_上一期': round(float(dea_d.iloc[-2]), 4),
                    '日K_MACD_上一期': round(float(hist_d.iloc[-2]), 4),
                    'M15_DIF': round(float(dif_15.iloc[-1]), 4),
                    'M15_DEA': round(float(dea_15.iloc[-1]), 4),
                    'M15_MACD': round(float(hist_15.iloc[-1]), 4),
                    'M15_DIF_上一期': round(float(dif_15.iloc[-2]), 4),
                    'M15_DEA_上一期': round(float(dea_15.iloc[-2]), 4),
                    'M15_MACD_上一期': round(float(hist_15.iloc[-2]), 4),
                    **signal,
                }
            except Exception:
                return None

        codes, watchlist_meta = load_watchlist_meta()
        results = []
        with ThreadPoolExecutor(max_workers=min(MACD_WORKERS, max(1, len(codes)))) as pool:
            futures = {pool.submit(fetch_stock, code): code for code in codes}
            for future in as_completed(futures):
                r = future.result()
                if r:
                    results.append(r)
        names_map = dict(get_stock_names([r['股票代码'] for r in results]))
        for r in results:
            r['股票名称'] = names_map.get(r['股票代码'], (r.get('股票名称') or '未知',''))[0]
        results.sort(key=lambda x: (not x.get("是否候选", False), -float(x.get("信号分", 0)), -float(x.get("日K_MACD", 0))))
        print(_json.dumps(results, ensure_ascii=False))
    else:
        main()
