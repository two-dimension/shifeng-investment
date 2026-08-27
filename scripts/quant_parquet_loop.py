#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import re
import time
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from quant_paths import resolve_parquet_dir


ROOT = Path(__file__).resolve().parents[1]
PARQUET_DIR = resolve_parquet_dir()
OUTPUT_DIR = ROOT / "output/pdf/quant-loop"
STATE_DIR = ROOT / "state"
STATE_FILE = STATE_DIR / "state.md"
BENCHMARK_FILE = ROOT / "server/data/quant/benchmark-000300.json"
UNIVERSE_FILE = ROOT / "server/data/tmt-margin/eastmoney-universe.json"

START = pd.Timestamp("2013-01-04")
END = pd.Timestamp("2025-12-31")
MAX_POSITIONS = 30
TRADE_COST = 0.0015
MIN_ROWS = 252
TOLERANCE = 0.03
A_SHARE_PREFIXES = ("000", "001", "002", "003", "300", "301", "600", "601", "603", "605", "688")

FONT_REG = "Helvetica"
FONT_BOLD = "Helvetica-Bold"


def register_fonts() -> None:
    global FONT_REG, FONT_BOLD
    candidates = [
        ("/System/Library/Fonts/STHeiti Medium.ttc", "Heiti SC"),
        ("/System/Library/Fonts/Supplemental/Songti.ttc", "Songti SC"),
        ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", "Arial Unicode"),
    ]
    for path, name in candidates:
        if os.path.exists(path):
            try:
                pdfmetrics.registerFont(TTFont(name, path))
                FONT_REG = name
                FONT_BOLD = name
                return
            except Exception:
                continue


def pct(value: Optional[float], digits: int = 2) -> str:
    if value is None or not np.isfinite(value):
        return "-"
    return f"{value * 100:.{digits}f}%"


def num(value: Optional[float], digits: int = 2) -> str:
    if value is None or not np.isfinite(value):
        return "-"
    return f"{value:.{digits}f}"


def normalize_code(value: str) -> str:
    return str(value or "").strip().replace("sh", "").replace("sz", "").replace("bj", "").split(".")[0].zfill(6)


def is_st_name(name: str) -> bool:
    text = str(name or "")
    return bool(re.search(r"(^|\s|\*)ST", text, re.I))


def load_name_map() -> Dict[str, str]:
    if not UNIVERSE_FILE.exists():
        return {}
    payload = json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))
    return {
        normalize_code(item.get("code", "")): str(item.get("name", "")).strip()
        for item in payload.get("stocks", [])
    }


def ema(values: pd.Series, span: int) -> pd.Series:
    return values.ewm(span=span, adjust=False).mean()


def shifted(values: np.ndarray, periods: int) -> np.ndarray:
    out = np.full(values.shape, np.nan, dtype=float)
    if periods == 0:
        return values.astype(float, copy=True)
    out[periods:] = values[:-periods]
    return out


def gt(left: np.ndarray, right: np.ndarray, strict: bool) -> np.ndarray:
    if strict:
        return left > right
    return left >= right - np.abs(right) * TOLERANCE


def lt(left: np.ndarray, right: np.ndarray, strict: bool) -> np.ndarray:
    if strict:
        return left < right
    return left <= right + np.abs(right) * TOLERANCE


def date_key(value: np.datetime64) -> str:
    return str(value.astype("datetime64[D]"))


@dataclass
class MacdParams:
    fast_period: int = 12
    slow_period: int = 26
    signal_period: int = 9
    buy_red_window: int = 6
    buy_red_decrease_days: int = 3
    buy_red_increase_days: int = 3
    buy_green_decay_days: int = 3
    buy_green_cross_lookback: int = 5
    sell_red_window: int = 6
    sell_red_increase_days: int = 3
    sell_red_decrease_days: int = 3
    sell_green_expand_days: int = 3
    sell_green_cross_lookback: int = 5
    strict_monotonic: bool = True
    min_hist_strength: float = 0.0
    buy_signal_mode: str = "both"
    sell_on_hist_cross_down: bool = False
    sell_on_dif_cross_down: bool = False
    sell_hist_weak_days: int = 0


@dataclass
class TrendParams:
    close_ma_window: int = 20
    fast_ma_window: int = 5
    slow_ma_window: int = 10
    trend_logic: str = "or"


@dataclass
class VolumeParams:
    volume_ma_window: int = 5
    volume_multiplier: float = 1.0


@dataclass
class RiskParams:
    stock_trend_filter: str = "none"
    market_filter: str = "none"
    stop_loss_pct: float = 0.0
    max_hold_days: int = 0


@dataclass
class StrategyParams:
    macd: MacdParams
    trend: TrendParams
    volume: VolumeParams
    risk: RiskParams = field(default_factory=RiskParams)


@dataclass
class StockData:
    code: str
    name: str
    dates: np.ndarray
    open: np.ndarray
    close: np.ndarray
    volume: np.ndarray
    dif: np.ndarray
    dea: np.ndarray
    hist: np.ndarray
    first_trade_index: int
    macd_cache: Dict[Tuple[int, int, int], Tuple[np.ndarray, np.ndarray, np.ndarray]] = field(default_factory=dict)


@dataclass
class DataSummary:
    parquet_files: int
    a_share_files: int
    eligible_stocks: int
    excluded_bj_b: int
    excluded_st: int
    excluded_short: int
    excluded_missing_or_invalid: int
    start: str
    end: str
    rows: int
    caveat: str


@dataclass
class AttemptResult:
    attempt_id: str
    round_index: int
    indicator: str
    action: str
    reason: str
    active_indicators: List[str]
    accepted: bool
    params: StrategyParams
    metrics: Dict[str, float]
    failed_reasons: List[str]
    report_path: Optional[Path] = None


def load_stock_file(file: Path, name_map: Dict[str, str]) -> Tuple[Optional[StockData], Optional[str]]:
    code = file.stem
    if not code.startswith(A_SHARE_PREFIXES):
        return None, "non_a_share"
    name = name_map.get(code, "")
    if is_st_name(name):
        return None, "st"

    table = pq.read_table(file, columns=["date", "open", "high", "low", "close", "volume"])
    df = table.to_pandas()
    if df.empty:
        return None, "missing_or_invalid"
    df["date"] = pd.to_datetime(df["date"])
    df = df[(df["date"] >= START) & (df["date"] <= END)].sort_values("date").reset_index(drop=True)
    if len(df) < MIN_ROWS:
        return None, "short"
    required = ["date", "open", "high", "low", "close", "volume"]
    if df[required].isna().any().any():
        return None, "missing_or_invalid"
    invalid = (df["open"] <= 0) | (df["high"] <= 0) | (df["low"] <= 0) | (df["close"] <= 0) | (df["volume"] < 0)
    if bool(invalid.any()):
        return None, "missing_or_invalid"

    close = df["close"].astype(float)
    dif = ema(close, 12) - ema(close, 26)
    dea = ema(dif, 9)
    hist = dif - dea

    return StockData(
        code=code,
        name=name or code,
        dates=df["date"].values.astype("datetime64[D]"),
        open=df["open"].to_numpy(dtype=float),
        close=df["close"].to_numpy(dtype=float),
        volume=df["volume"].to_numpy(dtype=float),
        dif=dif.to_numpy(dtype=float),
        dea=dea.to_numpy(dtype=float),
        hist=hist.to_numpy(dtype=float),
        first_trade_index=MIN_ROWS,
    ), None


def load_stock_universe(parquet_dir: Path = PARQUET_DIR) -> Tuple[List[StockData], DataSummary]:
    name_map = load_name_map()
    files = sorted(parquet_dir.glob("*.parquet"))
    stocks: List[StockData] = []
    excluded = {
        "non_a_share": 0,
        "st": 0,
        "short": 0,
        "missing_or_invalid": 0,
    }
    rows = 0
    for file in files:
        stock, reason = load_stock_file(file, name_map)
        if stock is None:
            excluded[reason or "missing_or_invalid"] += 1
            continue
        rows += len(stock.dates)
        stocks.append(stock)

    summary = DataSummary(
        parquet_files=len(files),
        a_share_files=sum(1 for f in files if f.stem.startswith(A_SHARE_PREFIXES)),
        eligible_stocks=len(stocks),
        excluded_bj_b=excluded["non_a_share"],
        excluded_st=excluded["st"],
        excluded_short=excluded["short"],
        excluded_missing_or_invalid=excluded["missing_or_invalid"],
        start=str(START.date()),
        end=str(END.date()),
        rows=rows,
        caveat="parquet未提供历史ST状态；本版使用项目现有名称表剔除当前可识别ST/*ST。",
    )
    return stocks, summary


def load_benchmark() -> pd.DataFrame:
    payload = json.loads(BENCHMARK_FILE.read_text(encoding="utf-8"))
    df = pd.DataFrame(payload["rows"])
    df["date"] = pd.to_datetime(df["date"].astype(str))
    df = df[(df["date"] >= START) & (df["date"] <= END)].sort_values("date").reset_index(drop=True)
    df["date_key"] = df["date"].dt.strftime("%Y-%m-%d")
    return df[["date", "date_key", "open", "close"]]


def rolling_mean(values: np.ndarray, window: int) -> np.ndarray:
    series = pd.Series(values)
    return series.rolling(window, min_periods=window).mean().to_numpy(dtype=float)


def red_second_expand(hist: np.ndarray, p: MacdParams) -> np.ndarray:
    front = p.buy_red_decrease_days
    back = p.buy_red_increase_days
    window = p.buy_red_window
    if front + back != window:
        return np.zeros_like(hist, dtype=bool)
    vals = [shifted(hist, window - 1 - i) for i in range(window)]
    mask = np.ones_like(hist, dtype=bool)
    for arr in vals:
        mask &= arr > 0
    for i in range(front - 1):
        mask &= gt(vals[i], vals[i + 1], p.strict_monotonic)
    for i in range(front, window - 1):
        mask &= lt(vals[i], vals[i + 1], p.strict_monotonic)
    return mask


def red_second_shrink(hist: np.ndarray, p: MacdParams) -> np.ndarray:
    front = p.sell_red_increase_days
    back = p.sell_red_decrease_days
    window = p.sell_red_window
    if front + back != window:
        return np.zeros_like(hist, dtype=bool)
    vals = [shifted(hist, window - 1 - i) for i in range(window)]
    mask = np.ones_like(hist, dtype=bool)
    for arr in vals:
        mask &= arr > 0
    for i in range(front - 1):
        mask &= lt(vals[i], vals[i + 1], p.strict_monotonic)
    for i in range(front, window - 1):
        mask &= gt(vals[i], vals[i + 1], p.strict_monotonic)
    return mask


def has_red_to_green(hist: np.ndarray, lookback: int) -> np.ndarray:
    cross = np.zeros_like(hist, dtype=bool)
    for offset in range(lookback):
        current = shifted(hist, offset)
        previous = shifted(hist, offset + 1)
        cross |= (previous > 0) & (current < 0)
    return cross


def green_decay(hist: np.ndarray, days: int, lookback: int, strict: bool) -> np.ndarray:
    vals = [shifted(hist, days - 1 - i) for i in range(days)]
    mask = np.ones_like(hist, dtype=bool)
    for arr in vals:
        mask &= arr < 0
    for i in range(days - 1):
        mask &= lt(vals[i], vals[i + 1], strict)
    return mask & has_red_to_green(hist, lookback)


def green_expand(hist: np.ndarray, days: int, lookback: int, strict: bool) -> np.ndarray:
    vals = [shifted(hist, days - 1 - i) for i in range(days)]
    mask = np.ones_like(hist, dtype=bool)
    for arr in vals:
        mask &= arr < 0
    for i in range(days - 1):
        mask &= gt(vals[i], vals[i + 1], strict)
    return mask & has_red_to_green(hist, lookback)


def get_macd_arrays(stock: StockData, macd: MacdParams) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    key = (macd.fast_period, macd.slow_period, macd.signal_period)
    if key == (12, 26, 9):
        return stock.dif, stock.dea, stock.hist
    cached = stock.macd_cache.get(key)
    if cached is not None:
        return cached
    close = pd.Series(stock.close)
    dif = ema(close, macd.fast_period) - ema(close, macd.slow_period)
    dea = ema(dif, macd.signal_period)
    hist = dif - dea
    cached = (dif.to_numpy(dtype=float), dea.to_numpy(dtype=float), hist.to_numpy(dtype=float))
    stock.macd_cache[key] = cached
    return cached


def consecutive_decrease(values: np.ndarray, days: int, strict: bool) -> np.ndarray:
    if days <= 1:
        return np.zeros_like(values, dtype=bool)
    vals = [shifted(values, days - 1 - i) for i in range(days)]
    mask = np.ones_like(values, dtype=bool)
    for i in range(days - 1):
        mask &= gt(vals[i], vals[i + 1], strict)
    return mask


def stock_trend_mask(stock: StockData, trend_params: TrendParams, mode: str) -> np.ndarray:
    if mode == "none":
        return np.ones_like(stock.close, dtype=bool)
    close_ma = rolling_mean(stock.close, trend_params.close_ma_window)
    fast_ma = rolling_mean(stock.close, trend_params.fast_ma_window)
    slow_ma = rolling_mean(stock.close, trend_params.slow_ma_window)
    close_ok = stock.close > close_ma
    ma_ok = fast_ma > slow_ma
    if mode == "close_gt_ma":
        return close_ok
    if mode == "fast_gt_slow":
        return ma_ok
    if mode == "and":
        return close_ok & ma_ok
    return close_ok | ma_ok


def stock_masks(stock: StockData, active: Sequence[str], params: StrategyParams) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    macd = params.macd
    dif, dea, hist = get_macd_arrays(stock, macd)
    red_buy = red_second_expand(hist, macd)
    green_buy = green_decay(hist, macd.buy_green_decay_days, macd.buy_green_cross_lookback, macd.strict_monotonic)
    if macd.min_hist_strength > 0:
        strength_ok = np.abs(hist) / stock.close >= macd.min_hist_strength
        red_buy &= strength_ok
        green_buy &= strength_ok
    red_sell = red_second_shrink(hist, macd)
    green_sell = green_expand(hist, macd.sell_green_expand_days, macd.sell_green_cross_lookback, macd.strict_monotonic)
    if macd.sell_on_hist_cross_down:
        red_sell |= (shifted(hist, 1) > 0) & (hist < 0)
    if macd.sell_on_dif_cross_down:
        red_sell |= (shifted(dif, 1) >= shifted(dea, 1)) & (dif < dea)
    if macd.sell_hist_weak_days > 1:
        red_sell |= consecutive_decrease(hist, macd.sell_hist_weak_days, macd.strict_monotonic)
    if "MACD信号" in active:
        if macd.buy_signal_mode == "red_only":
            buy = red_buy
        elif macd.buy_signal_mode == "green_only":
            buy = green_buy
        else:
            buy = red_buy | green_buy
        sell = red_sell | green_sell
    else:
        buy = np.zeros_like(hist, dtype=bool)
        sell = np.zeros_like(hist, dtype=bool)

    score = np.full(hist.shape, 50.0, dtype=float)
    score += np.where(red_buy, 18.0, 0.0)
    score += np.where(green_buy, 14.0, 0.0)
    hist_strength = np.clip(np.nan_to_num(hist / stock.close * 1000, nan=0.0), -10, 10)
    score += hist_strength

    if "趋势项" in active:
        tp = params.trend
        trend_mode = "and" if tp.trend_logic == "and" else "or"
        trend = stock_trend_mask(stock, tp, trend_mode)
        buy &= trend
        score += np.where(trend, 8.0, 0.0)

    if params.risk.stock_trend_filter != "none":
        trend = stock_trend_mask(stock, params.trend, params.risk.stock_trend_filter)
        buy &= trend
        score += np.where(trend, 8.0, 0.0)

    if "固定项" in active:
        prev_dif = shifted(dif, 1)
        prev_dea = shifted(dea, 1)
        prev_hist = shifted(hist, 1)
        fixed = (dif > prev_dif) | (dea > prev_dea) | (hist > prev_hist)
        buy &= fixed
        score += np.where(fixed, 6.0, 0.0)

    if "量价项" in active:
        vp = params.volume
        vol_ma = rolling_mean(stock.volume, vp.volume_ma_window)
        volume_ok = stock.volume > vol_ma * vp.volume_multiplier
        buy &= volume_ok
        score += np.where(volume_ok, 6.0, 0.0)

    valid = np.arange(len(stock.dates)) >= stock.first_trade_index
    return buy & valid, sell, np.clip(score, 0, 100)


def build_events(stocks: Sequence[StockData], benchmark: pd.DataFrame, active: Sequence[str], params: StrategyParams):
    benchmark_dates = benchmark["date"].values.astype("datetime64[D]")
    next_by_signal = {benchmark_dates[i]: benchmark_dates[i + 1] for i in range(len(benchmark_dates) - 1)}
    buy_by_date: Dict[str, List[Tuple[float, str, float]]] = {}
    sell_masks: Dict[str, np.ndarray] = {}

    for stock in stocks:
        buy_mask, sell_mask, score = stock_masks(stock, active, params)
        sell_masks[stock.code] = sell_mask
        idxs = np.nonzero(buy_mask[:-1])[0]
        for i in idxs:
            signal_date = stock.dates[i]
            exec_date = next_by_signal.get(signal_date)
            if exec_date is None:
                continue
            if stock.dates[i + 1] != exec_date or not np.isfinite(stock.open[i + 1]) or stock.open[i + 1] <= 0:
                continue
            key = date_key(signal_date)
            buy_by_date.setdefault(key, []).append((float(score[i]), stock.code, float(stock.open[i + 1])))

    for values in buy_by_date.values():
        values.sort(reverse=True)
    return buy_by_date, sell_masks


def find_idx(stock: StockData, date_value: np.datetime64) -> Optional[int]:
    idx = int(np.searchsorted(stock.dates, date_value))
    if idx < len(stock.dates) and stock.dates[idx] == date_value:
        return idx
    return None


def week_key(date_string: str) -> str:
    ts = pd.Timestamp(date_string)
    year, week, _ = ts.isocalendar()
    return f"{year}-{int(week):02d}"


def benchmark_market_ok(benchmark: pd.DataFrame, mode: str) -> Dict[str, bool]:
    if mode == "none":
        return {}
    close = benchmark["close"].astype(float)
    if mode == "hs300_ma200":
        ok = close > close.rolling(200, min_periods=200).mean()
    elif mode == "hs300_ma120":
        ok = close > close.rolling(120, min_periods=120).mean()
    elif mode == "hs300_ma60":
        ok = close > close.rolling(60, min_periods=60).mean()
    elif mode == "hs300_ma20_slope":
        ma20 = close.rolling(20, min_periods=20).mean()
        ok = ma20 > ma20.shift(5)
    else:
        ok = pd.Series(True, index=benchmark.index)
    return dict(zip(benchmark["date_key"].tolist(), ok.fillna(False).astype(bool).tolist()))


def backtest(stocks: Sequence[StockData], benchmark: pd.DataFrame, active: Sequence[str], params: StrategyParams, data_summary: DataSummary):
    stock_by_code = {stock.code: stock for stock in stocks}
    buy_by_date, sell_masks = build_events(stocks, benchmark, active, params)
    benchmark_dates = benchmark["date"].values.astype("datetime64[D]")
    benchmark_keys = benchmark["date_key"].tolist()
    benchmark_close = benchmark["close"].astype(float).to_numpy()
    benchmark_open = benchmark["open"].astype(float).to_numpy()

    cash = 1.0
    positions: Dict[str, Dict[str, float]] = {}
    trades = []
    weekly_openings: Dict[str, int] = {}
    equity_curve = []
    bench_curve = []
    start_bench = benchmark_close[0]
    market_ok = benchmark_market_ok(benchmark, params.risk.market_filter)
    exit_reasons = {"signal": 0, "stop_loss": 0, "time_stop": 0}

    for i in range(1, len(benchmark_dates)):
        signal_date = benchmark_dates[i - 1]
        exec_date = benchmark_dates[i]
        signal_key = benchmark_keys[i - 1]
        exec_key = benchmark_keys[i]

        for code in list(positions.keys()):
            stock = stock_by_code[code]
            signal_idx = find_idx(stock, signal_date)
            if signal_idx is None or signal_idx + 1 >= len(stock.dates) or stock.dates[signal_idx + 1] != exec_date:
                continue
            exit_reason = None
            signal_close = stock.close[signal_idx]
            position = positions[code]
            if params.risk.stop_loss_pct > 0 and signal_close <= position["entry_price"] * (1 - params.risk.stop_loss_pct):
                exit_reason = "stop_loss"
            elif params.risk.max_hold_days > 0 and i - position["entry_benchmark_index"] >= params.risk.max_hold_days:
                exit_reason = "time_stop"
            elif sell_masks[code][signal_idx]:
                exit_reason = "signal"
            if exit_reason is None:
                continue
            exit_open = stock.open[signal_idx + 1]
            position = positions.pop(code)
            exit_value = position["shares"] * exit_open * (1 - TRADE_COST)
            cash += exit_value
            exit_reasons[exit_reason] = exit_reasons.get(exit_reason, 0) + 1
            trades.append({
                "code": code,
                "entry_date": position["entry_date"],
                "exit_date": exec_key,
                "exit_reason": exit_reason,
                "return": exit_value / position["cost"] - 1,
            })

        available = MAX_POSITIONS - len(positions)
        if params.risk.market_filter != "none" and not market_ok.get(signal_key, False):
            candidates = []
        else:
            candidates = [item for item in buy_by_date.get(signal_key, []) if item[1] not in positions]
        if available > 0 and candidates and cash > 0:
            buys = candidates[:available]
            budget = cash / len(buys)
            for _, code, exec_open in buys:
                if budget <= 0 or exec_open <= 0:
                    continue
                gross = min(cash, budget)
                shares = gross * (1 - TRADE_COST) / exec_open
                cash -= gross
                positions[code] = {
                    "shares": shares,
                    "cost": gross,
                    "entry_date": exec_key,
                    "entry_price": exec_open,
                    "entry_benchmark_index": i,
                }
                weekly_openings[week_key(exec_key)] = weekly_openings.get(week_key(exec_key), 0) + 1

        value = cash
        for code, position in positions.items():
            stock = stock_by_code[code]
            mark_idx = find_idx(stock, exec_date)
            mark = stock.close[mark_idx] if mark_idx is not None else position["entry_price"]
            value += position["shares"] * mark
        equity_curve.append({"date": exec_key, "equity": value, "positions": len(positions)})
        bench_curve.append({"date": exec_key, "equity": benchmark_close[i] / start_bench})

    metrics = calculate_metrics(equity_curve, bench_curve, trades, weekly_openings)
    metrics["data_eligible_stocks"] = data_summary.eligible_stocks
    metrics["data_rows"] = data_summary.rows
    metrics["signal_exit_count"] = exit_reasons.get("signal", 0)
    metrics["stop_loss_exit_count"] = exit_reasons.get("stop_loss", 0)
    metrics["time_stop_exit_count"] = exit_reasons.get("time_stop", 0)
    return {
        "metrics": metrics,
        "trades": trades,
        "equity_curve": equity_curve,
        "benchmark_curve": bench_curve,
        "buy_signal_dates": len(buy_by_date),
        "buy_signal_count": sum(len(v) for v in buy_by_date.values()),
    }


def rolling13_week_average(weekly_openings: Dict[str, int], equity_dates: Sequence[str]) -> float:
    weeks = sorted(set(week_key(date) for date in equity_dates) | set(weekly_openings.keys()))
    if len(weeks) < 13:
        return 0.0
    avgs = []
    for i in range(12, len(weeks)):
        window = weeks[i - 12:i + 1]
        avgs.append(sum(weekly_openings.get(w, 0) for w in window) / 13)
    return float(np.mean(avgs)) if avgs else 0.0


def calculate_metrics(equity_curve, benchmark_curve, trades, weekly_openings):
    equity = np.array([point["equity"] for point in equity_curve], dtype=float)
    bench = np.array([point["equity"] for point in benchmark_curve], dtype=float)
    returns = equity[1:] / equity[:-1] - 1 if len(equity) > 1 else np.array([])
    days = max(1, len(returns))
    cumulative = equity[-1] / equity[0] - 1 if len(equity) else 0
    annual = (equity[-1] / equity[0]) ** (252 / days) - 1 if len(equity) and equity[0] > 0 and equity[-1] > 0 else 0
    vol = float(np.std(returns, ddof=1) * math.sqrt(252)) if len(returns) > 1 else 0
    sharpe = annual / vol if vol > 0 else 0
    peaks = np.maximum.accumulate(equity) if len(equity) else np.array([1])
    drawdowns = 1 - equity / peaks if len(equity) else np.array([0])
    max_dd = float(np.max(drawdowns)) if len(drawdowns) else 0
    calmar = annual / max_dd if max_dd > 0 else 0
    bench_cum = bench[-1] / bench[0] - 1 if len(bench) else 0
    bench_annual = (bench[-1] / bench[0]) ** (252 / days) - 1 if len(bench) and bench[0] > 0 and bench[-1] > 0 else 0
    win_rate = sum(1 for trade in trades if trade["return"] > 0) / len(trades) if trades else 0
    opening_avg = rolling13_week_average(weekly_openings, [point["date"] for point in equity_curve])
    return {
        "cumulative_return": float(cumulative),
        "annual_return": float(annual),
        "benchmark_cumulative_return": float(bench_cum),
        "benchmark_annual_return": float(bench_annual),
        "excess_annual_return": float(annual - bench_annual),
        "volatility": float(vol),
        "sharpe": float(sharpe),
        "calmar": float(calmar),
        "max_drawdown": max_dd,
        "trade_count": len(trades),
        "win_rate": float(win_rate),
        "rolling13_week_openings": opening_avg,
        "start_date": equity_curve[0]["date"] if equity_curve else "",
        "end_date": equity_curve[-1]["date"] if equity_curve else "",
    }


def hard_gate(metrics: Dict[str, float]) -> Tuple[bool, List[str]]:
    failures = []
    if metrics["sharpe"] < 1:
        failures.append("Sharpe < 1")
    if metrics["calmar"] < 2:
        failures.append("Calmar < 2")
    if metrics["annual_return"] <= metrics["benchmark_annual_return"]:
        failures.append("年化收益未跑赢沪深300")
    if metrics["cumulative_return"] <= metrics["benchmark_cumulative_return"]:
        failures.append("累计收益未跑赢沪深300")
    return not failures, failures


def paragraph(text, style):
    return Paragraph(str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), style)


def make_table(rows, widths, body_style, header=False):
    data = []
    header_style = ParagraphStyle("TableHeader", parent=body_style, fontName=FONT_BOLD, textColor=colors.white, alignment=TA_CENTER)
    for ridx, row in enumerate(rows):
        style = header_style if header and ridx == 0 else body_style
        data.append([paragraph(cell, style) for cell in row])
    table = Table(data, colWidths=widths, hAlign="LEFT")
    commands = [
        ("FONTNAME", (0, 0), (-1, -1), FONT_REG),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("LEADING", (0, 0), (-1, -1), 11),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#D9D9D9")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]
    if header:
        commands.extend([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#263238")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ])
    else:
        commands.extend([
            ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#F5F7FA")),
            ("FONTNAME", (0, 0), (0, -1), FONT_BOLD),
        ])
    table.setStyle(TableStyle(commands))
    return table


def params_to_dict(params: StrategyParams) -> Dict[str, Dict[str, object]]:
    return {
        "macd": params.macd.__dict__,
        "trend": params.trend.__dict__,
        "volume": params.volume.__dict__,
        "risk": params.risk.__dict__,
    }


def write_pdf(attempt: AttemptResult, data_summary: DataSummary, backtest_result: Dict) -> Path:
    register_fonts()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"quant-parquet-loop-round{attempt.round_index:02d}-{attempt.indicator}-{attempt.attempt_id}-{datetime.now().strftime('%Y%m%d%H%M%S')}.pdf"
    output = OUTPUT_DIR / filename
    doc = SimpleDocTemplate(str(output), pagesize=A4, leftMargin=1.45 * cm, rightMargin=1.45 * cm, topMargin=1.35 * cm, bottomMargin=1.2 * cm)
    styles = getSampleStyleSheet()
    title = ParagraphStyle("TitleCN", parent=styles["Title"], fontName=FONT_BOLD, fontSize=17, leading=23, alignment=TA_CENTER)
    h2 = ParagraphStyle("H2CN", parent=styles["Heading2"], fontName=FONT_BOLD, fontSize=12, leading=16, spaceBefore=10, spaceAfter=6)
    body = ParagraphStyle("BodyCN", parent=styles["BodyText"], fontName=FONT_REG, fontSize=8.5, leading=12)
    note = ParagraphStyle("NoteCN", parent=body, fontSize=7.5, leading=10, textColor=colors.HexColor("#666666"))
    m = attempt.metrics
    story = [
        Paragraph("量化选股 Loop 回测报告", title),
        Paragraph(f"生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", note),
        Spacer(1, 10),
        Paragraph("一、本轮内容", h2),
        make_table([
            ["本轮", f"第 {attempt.round_index} 轮 - {attempt.indicator}"],
            ["动作", attempt.action],
            ["当前启用指标", "、".join(attempt.active_indicators) if attempt.active_indicators else "无"],
            ["是否保留", "保留" if attempt.accepted else "不保留"],
            ["原因", attempt.reason],
            ["下一步动作", "进入下一指标" if attempt.accepted else "参数优化/剔除后继续下一指标"],
        ], [3.6 * cm, 13.8 * cm], body),
        Paragraph("二、回测结果", h2),
        make_table([
            ["指标", "结果", "说明"],
            ["Sharpe", num(m["sharpe"]), "硬约束 >= 1"],
            ["Calmar", num(m["calmar"]), "硬约束 >= 2"],
            ["最大回撤", pct(m["max_drawdown"]), "诊断项"],
            ["策略累计收益", pct(m["cumulative_return"]), "2013-2025"],
            ["策略年化收益", pct(m["annual_return"]), "需跑赢沪深300"],
            ["沪深300累计收益", pct(m["benchmark_cumulative_return"]), "基准"],
            ["沪深300年化收益", pct(m["benchmark_annual_return"]), "基准"],
            ["超额年化", pct(m["excess_annual_return"]), "策略 - 沪深300"],
            ["开仓/周", num(m["rolling13_week_openings"], 1), "滚动13周平均"],
            ["交易笔数", str(m["trade_count"]), "已闭合交易"],
            ["胜率", pct(m["win_rate"]), "已闭合交易"],
            ["止损卖出", str(int(m.get("stop_loss_exit_count", 0))), "收盘触发，次日开盘卖出"],
            ["时间止损卖出", str(int(m.get("time_stop_exit_count", 0))), "达到最长持仓，次日开盘卖出"],
            ["信号卖出", str(int(m.get("signal_exit_count", 0))), "MACD反向卖出"],
        ], [4.2 * cm, 4.4 * cm, 8.8 * cm], body, header=True),
        Paragraph("三、数据口径", h2),
        make_table([
            ["数据源", str(PARQUET_DIR)],
            ["回测区间", f"{data_summary.start} 至 {data_summary.end}"],
            ["入池股票数", str(data_summary.eligible_stocks)],
            ["入池行数", f"{data_summary.rows:,}"],
            ["剔除北交/B股/其他", str(data_summary.excluded_bj_b)],
            ["剔除当前ST/*ST", str(data_summary.excluded_st)],
            ["剔除不足一年", str(data_summary.excluded_short)],
            ["剔除缺失/非法数据", str(data_summary.excluded_missing_or_invalid)],
            ["数据说明", data_summary.caveat],
        ], [4.2 * cm, 13.2 * cm], body),
        Paragraph("四、参数", h2),
        make_table([[k, json.dumps(v, ensure_ascii=False)] for k, v in params_to_dict(attempt.params).items()], [4.2 * cm, 13.2 * cm], body),
        Paragraph("五、信号统计", h2),
        make_table([
            ["买入信号日期数", str(backtest_result.get("buy_signal_dates", 0))],
            ["买入信号总数", str(backtest_result.get("buy_signal_count", 0))],
            ["失败原因", "、".join(attempt.failed_reasons) if attempt.failed_reasons else "通过"],
        ], [4.2 * cm, 13.2 * cm], body),
    ]
    doc.build(story)
    return output


def append_state(attempt: AttemptResult) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    lines = [
        f"## {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} Round {attempt.round_index} {attempt.indicator}",
        f"- action: {attempt.action}",
        f"- active_indicators: {', '.join(attempt.active_indicators)}",
        f"- accepted: {attempt.accepted}",
        f"- reason: {attempt.reason}",
        f"- sharpe: {attempt.metrics['sharpe']:.4f}",
        f"- calmar: {attempt.metrics['calmar']:.4f}",
        f"- annual_return: {attempt.metrics['annual_return']:.4f}",
        f"- benchmark_annual_return: {attempt.metrics['benchmark_annual_return']:.4f}",
        f"- cumulative_return: {attempt.metrics['cumulative_return']:.4f}",
        f"- benchmark_cumulative_return: {attempt.metrics['benchmark_cumulative_return']:.4f}",
        f"- max_drawdown: {attempt.metrics['max_drawdown']:.4f}",
        f"- report: {attempt.report_path}",
        "",
    ]
    with STATE_FILE.open("a", encoding="utf-8") as f:
        f.write("\n".join(lines))


def macd_candidates(base: StrategyParams) -> List[Tuple[str, StrategyParams]]:
    candidates = [("默认MACD参数", base)]
    candidates.append(("MACD strict_monotonic=False", replace(base, macd=replace(base.macd, strict_monotonic=False))))
    for window in [5, 6, 7, 8]:
        for down in [2, 3, 4]:
            up = window - down
            if up in [2, 3, 4]:
                candidates.append((f"买入红柱窗口{window}/{down}+{up}", replace(base, macd=replace(base.macd, buy_red_window=window, buy_red_decrease_days=down, buy_red_increase_days=up))))
    for days in [2, 3, 4, 5]:
        for lookback in [3, 5, 7, 10]:
            candidates.append((f"买入绿柱{days}日/红转绿{lookback}日", replace(base, macd=replace(base.macd, buy_green_decay_days=days, buy_green_cross_lookback=lookback))))
    for window in [5, 6, 7, 8]:
        for up in [2, 3, 4]:
            down = window - up
            if down in [2, 3, 4]:
                candidates.append((f"卖出红柱窗口{window}/{up}+{down}", replace(base, macd=replace(base.macd, sell_red_window=window, sell_red_increase_days=up, sell_red_decrease_days=down))))
    for days in [2, 3, 4, 5]:
        for lookback in [3, 5, 7, 10]:
            candidates.append((f"卖出绿柱{days}日/红转绿{lookback}日", replace(base, macd=replace(base.macd, sell_green_expand_days=days, sell_green_cross_lookback=lookback))))
    return candidates


def unique_candidates(candidates: List[Tuple[str, StrategyParams]]) -> List[Tuple[str, StrategyParams]]:
    seen = set()
    out = []
    for action, params in candidates:
        key = json.dumps(params_to_dict(params), sort_keys=True, ensure_ascii=False)
        if key in seen:
            continue
        seen.add(key)
        out.append((action, params))
    return out


def macd_micro_base() -> StrategyParams:
    return StrategyParams(
        MacdParams(
            buy_red_window=6,
            buy_red_decrease_days=4,
            buy_red_increase_days=2,
        ),
        TrendParams(),
        VolumeParams(),
    )


def macd_micro_candidates(base: StrategyParams) -> List[Tuple[str, StrategyParams]]:
    candidates: List[Tuple[str, StrategyParams]] = [
        ("MACD微调基准：承接上一轮最好红柱6/4+2", base),
    ]

    for mode, label in [("red_only", "仅红柱买入"), ("green_only", "仅绿柱买入"), ("both", "红绿柱同时买入")]:
        candidates.append((f"买入模式-{label}", replace(base, macd=replace(base.macd, buy_signal_mode=mode))))

    for threshold in [0.0001, 0.0002, 0.0005, 0.0010]:
        candidates.append((
            f"柱体强度阈值{threshold:.4%}",
            replace(base, macd=replace(base.macd, min_hist_strength=threshold)),
        ))
        candidates.append((
            f"仅红柱买入+柱体强度阈值{threshold:.4%}",
            replace(base, macd=replace(base.macd, buy_signal_mode="red_only", min_hist_strength=threshold)),
        ))

    for fast, slow, signal in [(6, 13, 5), (8, 17, 5), (10, 21, 7), (12, 26, 9), (15, 30, 9), (16, 32, 12)]:
        candidates.append((
            f"MACD周期{fast}/{slow}/{signal}",
            replace(base, macd=replace(base.macd, fast_period=fast, slow_period=slow, signal_period=signal)),
        ))
        candidates.append((
            f"仅红柱买入+MACD周期{fast}/{slow}/{signal}",
            replace(base, macd=replace(base.macd, buy_signal_mode="red_only", fast_period=fast, slow_period=slow, signal_period=signal)),
        ))

    candidates.extend([
        ("卖出加入hist下穿0", replace(base, macd=replace(base.macd, sell_on_hist_cross_down=True))),
        ("卖出加入DIF下穿DEA", replace(base, macd=replace(base.macd, sell_on_dif_cross_down=True))),
        ("卖出加入hist下穿0+DIF下穿DEA", replace(base, macd=replace(base.macd, sell_on_hist_cross_down=True, sell_on_dif_cross_down=True))),
        ("卖出hist连续转弱2日", replace(base, macd=replace(base.macd, sell_hist_weak_days=2))),
        ("卖出hist连续转弱3日", replace(base, macd=replace(base.macd, sell_hist_weak_days=3))),
        ("仅红柱买入+卖出hist连续转弱2日", replace(base, macd=replace(base.macd, buy_signal_mode="red_only", sell_hist_weak_days=2))),
        ("仅红柱买入+卖出hist下穿0", replace(base, macd=replace(base.macd, buy_signal_mode="red_only", sell_on_hist_cross_down=True))),
        ("仅红柱买入+卖出DIF下穿DEA", replace(base, macd=replace(base.macd, buy_signal_mode="red_only", sell_on_dif_cross_down=True))),
        ("仅红柱买入+阈值0.0200%+卖出hist连续转弱2日", replace(base, macd=replace(base.macd, buy_signal_mode="red_only", min_hist_strength=0.0002, sell_hist_weak_days=2))),
        ("仅红柱买入+阈值0.0500%+卖出hist连续转弱2日", replace(base, macd=replace(base.macd, buy_signal_mode="red_only", min_hist_strength=0.0005, sell_hist_weak_days=2))),
        ("MACD周期8/17/5+卖出hist连续转弱2日", replace(base, macd=replace(base.macd, fast_period=8, slow_period=17, signal_period=5, sell_hist_weak_days=2))),
        ("MACD周期10/21/7+卖出hist连续转弱2日", replace(base, macd=replace(base.macd, fast_period=10, slow_period=21, signal_period=7, sell_hist_weak_days=2))),
        ("仅红柱+MACD周期8/17/5+卖出hist连续转弱2日", replace(base, macd=replace(base.macd, buy_signal_mode="red_only", fast_period=8, slow_period=17, signal_period=5, sell_hist_weak_days=2))),
        ("仅红柱+MACD周期10/21/7+卖出hist连续转弱2日", replace(base, macd=replace(base.macd, buy_signal_mode="red_only", fast_period=10, slow_period=21, signal_period=7, sell_hist_weak_days=2))),
    ])

    return unique_candidates(candidates)


def risk_loop_base() -> StrategyParams:
    return StrategyParams(
        MacdParams(
            buy_signal_mode="green_only",
            buy_green_decay_days=3,
            buy_green_cross_lookback=5,
        ),
        TrendParams(),
        VolumeParams(),
        RiskParams(),
    )


def risk_loop_candidates(base: StrategyParams) -> List[Tuple[str, StrategyParams]]:
    candidates: List[Tuple[str, StrategyParams]] = [
        ("风险兜底基准：仅绿柱买入", base),
    ]

    trend_labels = {
        "or": "个股趋势OR(close>MA20或MA5>MA10)",
        "close_gt_ma": "个股close>MA20",
        "fast_gt_slow": "个股MA5>MA10",
        "and": "个股趋势AND(close>MA20且MA5>MA10)",
    }
    for mode, label in trend_labels.items():
        candidates.append((label, replace(base, risk=replace(base.risk, stock_trend_filter=mode))))

    for stop in [0.08, 0.10, 0.12, 0.15, 0.20]:
        candidates.append((
            f"仅绿柱买入+强制止损{stop:.0%}",
            replace(base, risk=replace(base.risk, stop_loss_pct=stop)),
        ))

    for hold in [20, 40, 60]:
        candidates.append((
            f"仅绿柱买入+时间止损{hold}日",
            replace(base, risk=replace(base.risk, max_hold_days=hold)),
        ))

    trend_base = replace(base, risk=replace(base.risk, stock_trend_filter="or"))
    for stop in [0.08, 0.10, 0.12, 0.15, 0.20]:
        candidates.append((
            f"个股趋势OR+强制止损{stop:.0%}",
            replace(trend_base, risk=replace(trend_base.risk, stop_loss_pct=stop)),
        ))
        for hold in [20, 40, 60]:
            candidates.append((
                f"个股趋势OR+强制止损{stop:.0%}+时间止损{hold}日",
                replace(trend_base, risk=replace(trend_base.risk, stop_loss_pct=stop, max_hold_days=hold)),
            ))

    for market in ["hs300_ma60", "hs300_ma120", "hs300_ma200", "hs300_ma20_slope"]:
        candidates.append((
            f"个股趋势OR+市场过滤{market}",
            replace(trend_base, risk=replace(trend_base.risk, market_filter=market)),
        ))
        for stop in [0.10, 0.15, 0.20]:
            candidates.append((
                f"个股趋势OR+市场过滤{market}+强制止损{stop:.0%}",
                replace(trend_base, risk=replace(trend_base.risk, market_filter=market, stop_loss_pct=stop)),
            ))
            candidates.append((
                f"个股趋势OR+市场过滤{market}+强制止损{stop:.0%}+时间止损40日",
                replace(trend_base, risk=replace(trend_base.risk, market_filter=market, stop_loss_pct=stop, max_hold_days=40)),
            ))

    return unique_candidates(candidates)


def trend_candidates(base: StrategyParams) -> List[Tuple[str, StrategyParams]]:
    out = []
    for close_w in [10, 20, 30, 60]:
        for fast in [3, 5, 7, 10]:
            for slow in [10, 15, 20, 30]:
                if fast >= slow:
                    continue
                for logic in ["or", "and"]:
                    out.append((f"趋势 close{close_w}/fast{fast}/slow{slow}/{logic}", replace(base, trend=TrendParams(close_w, fast, slow, logic))))
    return out


def volume_candidates(base: StrategyParams) -> List[Tuple[str, StrategyParams]]:
    return [
        (f"量价 MA{window} x{mult}", replace(base, volume=VolumeParams(window, mult)))
        for window in [3, 5, 10, 20]
        for mult in [1.0, 1.1, 1.2, 1.5]
    ]


def fixed_candidates(base: StrategyParams) -> List[Tuple[str, StrategyParams]]:
    return [("固定项无参数", base)]


def candidate_params(indicator: str, base: StrategyParams) -> List[Tuple[str, StrategyParams]]:
    if indicator == "MACD信号":
        return macd_candidates(base)
    if indicator == "趋势项":
        return trend_candidates(base)
    if indicator == "固定项":
        return fixed_candidates(base)
    if indicator == "量价项":
        return volume_candidates(base)
    return [("默认", base)]


def run_loop(args) -> Dict:
    started = time.time()
    print(f"[quant-loop] loading parquet universe from {args.parquet_dir}", flush=True)
    stocks, data_summary = load_stock_universe(Path(args.parquet_dir))
    print(
        f"[quant-loop] loaded {data_summary.eligible_stocks} eligible stocks, "
        f"{data_summary.rows:,} rows in {time.time() - started:.1f}s",
        flush=True,
    )
    benchmark = load_benchmark()
    if args.risk_loop:
        params = risk_loop_base()
    elif args.macd_micro:
        params = macd_micro_base()
    else:
        params = StrategyParams(MacdParams(), TrendParams(), VolumeParams())
    accepted: List[str] = []
    rejected: List[str] = []
    attempts: List[AttemptResult] = []
    indicator_pool = ["MACD信号"] if args.macd_micro or args.risk_loop else ["MACD信号", "趋势项", "固定项", "量价项"]

    for round_index, indicator in enumerate(indicator_pool, 1):
        active = accepted + [indicator]
        best_attempt: Optional[AttemptResult] = None
        if args.risk_loop and indicator == "MACD信号":
            candidates = risk_loop_candidates(params)
        elif args.macd_micro and indicator == "MACD信号":
            candidates = macd_micro_candidates(params)
        else:
            candidates = candidate_params(indicator, params)
        for attempt_no, (action, test_params) in enumerate(candidates, 1):
            if args.max_attempts and len(attempts) >= args.max_attempts:
                break
            attempt_started = time.time()
            print(
                f"[quant-loop] round={round_index} attempt={attempt_no} "
                f"indicator={indicator} action={action}",
                flush=True,
            )
            result = backtest(stocks, benchmark, active, test_params, data_summary)
            passed, failures = hard_gate(result["metrics"])
            accepted_this = passed
            reason = "通过硬约束，保留当前指标" if passed else "未通过：" + "、".join(failures)
            attempt = AttemptResult(
                attempt_id=f"{round_index}-{attempt_no}",
                round_index=round_index,
                indicator=indicator,
                action=action,
                reason=reason,
                active_indicators=active,
                accepted=accepted_this,
                params=test_params,
                metrics=result["metrics"],
                failed_reasons=failures,
            )
            attempt.report_path = write_pdf(attempt, data_summary, result)
            append_state(attempt)
            attempts.append(attempt)
            duration = time.time() - attempt_started
            print(
                f"[quant-loop] done id={attempt.attempt_id} accepted={attempt.accepted} "
                f"sharpe={attempt.metrics['sharpe']:.2f} calmar={attempt.metrics['calmar']:.2f} "
                f"annual={attempt.metrics['annual_return']:.2%} benchmark={attempt.metrics['benchmark_annual_return']:.2%} "
                f"pdf={attempt.report_path} duration={duration:.1f}s",
                flush=True,
            )
            if passed:
                best_attempt = attempt
                params = test_params
                accepted.append(indicator)
                break

        if best_attempt is None:
            rejected.append(indicator)
            if indicator == "MACD信号":
                print(
                    "[quant-loop] MACD core signal failed all parameter candidates; "
                    "filter indicators will not be tested without a core buy signal.",
                    flush=True,
                )
                break
        if args.max_attempts and len(attempts) >= args.max_attempts:
            break

    return {
        "generated_at": datetime.now().isoformat(),
        "duration_seconds": time.time() - started,
        "accepted": accepted,
        "rejected": rejected,
        "attempts": [
            {
                "id": attempt.attempt_id,
                "round": attempt.round_index,
                "indicator": attempt.indicator,
                "action": attempt.action,
                "accepted": attempt.accepted,
                "metrics": attempt.metrics,
                "report": str(attempt.report_path),
            }
            for attempt in attempts
        ],
        "data_summary": data_summary.__dict__,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parquet-dir", default=str(PARQUET_DIR))
    parser.add_argument("--max-attempts", type=int, default=0)
    parser.add_argument("--macd-micro", action="store_true", help="only run the second-stage MACD micro-tuning loop")
    parser.add_argument("--risk-loop", action="store_true", help="run green MACD plus trend/stop-loss/time-stop risk loop")
    parser.add_argument("--summary-json", default=str(ROOT / "output/pdf/quant-loop/quant-parquet-loop-summary.json"))
    args = parser.parse_args()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    summary = run_loop(args)
    Path(args.summary_json).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
