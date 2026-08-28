#!/usr/bin/env python3
"""
A 股交易日历工具 — 算 T 扫描范围 (v5: 周一 3 天, 其他 1 天)
- 数据源:akshare.tool_trade_date_hist_sina() (含 1990-12 到 2026-12)
- 跳过周末、节假日、休市 (用于 is_trade_date 判断)
- v5 规则:
  · 周一跑批 → 扫描 seDate = [上周六, 上周日, 周一] 3 天 (因为周末公司仍可能发公告)
  · 周二~五跑批 → 扫描 seDate = T 单天
  · 周六/周日/节假日不跑 (launchd 跳过)
- ⚠️ 0 条或非 0 条均为正常, 不应掉以轻心
- 保留 akshare 仍用于: 节假日判断 / 跑批时跳非交易日 (未来扩展)
"""
import sys
from datetime import datetime, timedelta
from functools import lru_cache
from typing import List, Optional, Tuple

try:
    import akshare as ak
    HAVE_AKSHARE = True
except ImportError:
    HAVE_AKSHARE = False


@lru_cache(maxsize=1)
def _load_trade_dates() -> List[str]:
    """加载所有 A 股交易日(YYYY-MM-DD 字符串列表,升序)

    异常兜底:akshare 调新浪失败时(如 DNS 解析失败)返回 [],触发上层
    "工作日倒推"启发式(见 prev_trade_date),避免单点失败阻塞主流程。
    """
    if not HAVE_AKSHARE:
        return []
    try:
        df = ak.tool_trade_date_hist_sina()
        return sorted(df['trade_date'].astype(str).tolist())
    except Exception as e:
        # AGENTS.md 兜底承诺:akshare 不可用时退到工作日倒推;这里把"调失败"也视作"不可用"
        import sys
        print(f"[trading_calendar] akshare 调新浪失败,退到工作日倒推: {type(e).__name__}: {e}", file=sys.stderr)
        return []


def is_trade_date(d: str) -> bool:
    """判断某日是否为 A 股交易日"""
    return d in _load_trade_dates()


def prev_trade_date(d: Optional[str] = None) -> str:
    """
    返回 d 的前一个 A 股交易日
    - d 为 None 时,使用今天
    - 若 d 不在交易日历中,会向前找最近的交易日
    - 若 akshare 不可用,回退到"工作日倒推"启发式
    """
    if d is None:
        d = datetime.now().strftime('%Y-%m-%d')

    trade_dates = _load_trade_dates()
    if trade_dates:
        for td in reversed(trade_dates):
            if td < d:
                return td
        return trade_dates[0]

    cur = datetime.strptime(d, '%Y-%m-%d')
    for _ in range(30):
        cur = cur - timedelta(days=1)
        if cur.weekday() < 5:
            return cur.strftime('%Y-%m-%d')
    raise ValueError(f"无法在 30 天内找到 {d} 的前一个交易日")


def t_minus_1() -> str:
    """
    T 日前一交易日 = 离今天最近的、且严格小于今天的 A 股交易日
    (开盘前执行时,这个就是"上一交易日")
    """
    return prev_trade_date(datetime.now().strftime('%Y-%m-%d'))


def t_today(today: Optional[str] = None) -> Tuple[str, str, List[str], str]:
    """
    v5 规则: 跑批当日 seDate 范围

    业务逻辑:
    - 7am 跑批 → 扫 cninfo 公告日期 = T 的全量公告
    - 周一特殊: 周末公司可能挂出公告, 扫 [上周六, 上周日, 周一] 3 天
    - 周二~五: 扫 T 单天

    返回: (start_date, end_date, date_list, label)
    - start_date: 范围起点 YYYY-MM-DD (用于 cninfo seDate)
    - end_date:   范围终点 YYYY-MM-DD
    - date_list:  [start_date, ..., end_date] YYYY-MM-DD 列表
    - label:      人类可读描述, 含星期

    适用场景:
    - launchd 7am 触发: today = 今天, 7am 周一跑 → 扫 [上周六, 上周日, 周一]
    - 用户手动跑: today = --date 指定
    """
    if today is None:
        today = datetime.now().strftime('%Y-%m-%d')
    cn_wk = ['一', '二', '三', '四', '五', '六', '日']
    dt = datetime.strptime(today, '%Y-%m-%d')
    wk = dt.weekday()  # 0=Mon, 6=Sun

    if wk == 0:
        # 周一: 覆盖 [上周六, 上周日, 周一] 3 天
        days_back = [2, 1, 0]  # 上周六, 上周日, T(周一)
        date_list = [(dt - timedelta(days=d)).strftime('%Y-%m-%d') for d in days_back]
        start_date, end_date = date_list[0], date_list[-1]
        wk_T = cn_wk[dt.weekday()]
        wk_T1 = cn_wk[(dt - timedelta(days=1)).weekday()]
        wk_T2 = cn_wk[(dt - timedelta(days=2)).weekday()]
        label = f"扫描 cninfo 公告日期 = {start_date}(周{wk_T2}) ~ {end_date}(周{wk_T}) [周一三日]"
    else:
        # 周二~五: T 单天
        date_list = [today]
        start_date = end_date = today
        wk_T = cn_wk[dt.weekday()]
        label = f"扫描 cninfo 公告日期 = {today}(周{wk_T})"

    return start_date, end_date, date_list, label


# 兼容旧 API
def t_minus_1_range(today: Optional[str] = None) -> Tuple[List[str], str]:
    """
    [已弃用] 旧版按"日期范围"算 T 日前一交易日区间, 跟 trader 实际需求不符 (T 日前一交易日全天 vs 昨夜今晨窗口)
    保留仅为兼容旧脚本, 新代码请用 t_window
    """
    import warnings
    warnings.warn("t_minus_1_range 已弃用, 请用 t_window", DeprecationWarning, stacklevel=2)
    if today is None:
        today = datetime.now().strftime('%Y-%m-%d')
    dt = datetime.strptime(today, '%Y-%m-%d')
    weekday = dt.weekday()
    if weekday == 0:
        days = [
            (dt - timedelta(days=3)).strftime('%Y-%m-%d'),
            (dt - timedelta(days=2)).strftime('%Y-%m-%d'),
            (dt - timedelta(days=1)).strftime('%Y-%m-%d'),
        ]
        label = f"T 日前三日~T 日前一交易日 ({days[0]}~{days[-1]})"
    else:
        days = [prev_trade_date(today)]
        label = f"T 日前一交易日 ({days[0]})"
    return days, label


if __name__ == '__main__':
    # 自检
    today = datetime.now().strftime('%Y-%m-%d')
    print(f"今日(系统)  : {today}  {'(交易日)' if is_trade_date(today) else '(非交易日)'}")
    print(f"T 日前一交易日(前交易日): {t_minus_1()}")
    print(f"2026-06-08 前一交易日: {prev_trade_date('2026-06-08')}")
    print(f"2026-06-05 前一交易日: {prev_trade_date('2026-06-05')}")
    print(f"2026-06-01(周一) 前一交易日: {prev_trade_date('2026-06-01')}  # 应跳过周末")
    print(f"2026-10-01(国庆) 前一交易日: {prev_trade_date('2026-10-01')}  # 应跳过国庆假期")

    # v5: t_today 自检
    print("\n=== t_today (v5) ===")
    for d in ['2026-06-09', '2026-06-10', '2026-06-15']:
        s, e, dates, label = t_today(d)
        print(f"{d} -> {label}")
        print(f"   dates={dates}  span={s} ~ {e}")
