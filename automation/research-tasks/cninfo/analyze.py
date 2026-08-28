#!/usr/bin/env python3
"""
A 股公告利好/利空判定引擎
==========================
严格按 Skill 规范的 14 条规则判定 + 强度分级 + 公司合并 + TOP5 排序。

输入:announcements_<date_range>.json (来自 fetch.py)
输出:processed_<date_range>.json (含 TOP5 利好/利空 + 概览 + 短线参考)

强度映射:
  强利多 +10: 长周期头部客户大额订单
  强利多 +7 : 新建产能/扩产 / 大股东大额增持 / 中标/重大合同
  中利多 +2 : 员工持股落地 / 员工持股筹划
  中利多 +5 : 大额产业补贴 / 新药/专利/资质获批
  中利多 +4 : 股份回购
  弱利多 +2 : 战略合作 / 高分红
  弱利空 -2 : 董监高小额减持 / 离职 / 定增可转债 / 停牌
  弱利空 -3 : 监管问询函 / 题材澄清 / 股东减持(含比例)
  中利空 -5 : 大股东减持
  强利空 -7 : 大额资产减值 / 重大诉讼担保代偿 / ST 风险 / ≥2% 大股东减持
  强利空 -10: 立案调查 / 监管处罚 / 退市风险

排除分支(bug fix):
  - "自愿不减持/承诺锁定" 类公告 → 减持类利空转 +3 自愿不减持
  - 股权激励配套的"股份回购" → 中性化(分数 = 0)
"""

# v9.33: 用户偏好 — 利空只显示 -7 ~ -10 (强利空)
# 弱/中利空 (-1 ~ -6) 是噪音 (董监高离职/异常波动/小额减持/监管问询 等),
# 老板 6/16 拍: "利空我只看 -7 到 -10 分的", 强利空才是有意义的方向性利空
# 实施: analyze.py 输出阶段只保留 best_score <= -7 的利空
#       (top_bad / all_bad_companies / bad_sectors / strong_bad_count)
# 不影响: bad_count (sentiment, 全口径 = -1~-10 全部计数) / signal scoring
import json
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from placement_analysis import analyze_placement_plan, is_canonical_placement_plan

STRONG_BAD_DISPLAY_THRESHOLD = -7


def is_earnings_forecast_title(title: str) -> bool:
    """v10.1: 业绩预告类公告不进入公告研判任何产物。"""
    return bool(re.search(
        r"业绩预告|业绩预增|业绩预减|业绩预亏|业绩快报|业绩修正|业绩预告修正|"
        r"预计净利润.*(?:增长|下降)|扭亏为盈|净利润为负",
        title or "",
    ))

# PDF 缓存目录 (按 announcementId 缓存, 避免重复下载)
PDF_CACHE = Path(__file__).parent / '.cache_pdfs'
PDF_CACHE.mkdir(exist_ok=True)

# ===== 股价数据缓存 (v6: 股价低位增持 / 股价高位减持 信号升级) =====
PRICE_CACHE = Path(__file__).parent / '.cache_prices'
PRICE_CACHE.mkdir(exist_ok=True)
PRICE_CACHE_TTL_DAYS = 1

try:
    import akshare as _ak
    _HAVE_AKSHARE_PRICE = True
except ImportError:
    _HAVE_AKSHARE_PRICE = False


def _get_price_position(code, as_of_date: Optional[str] = None):
    """
    拉取截至 as_of_date 的近 60 个交易日数据, 返回
    dict: {current, avg_60d, high_60d, low_60d, ratio_vs_avg, pos_60d}

    as_of_date 用于历史重跑防前视偏差；None 保持原有“截至今日”行为。
    失败/不可用时返回 None
    """
    if not code:
        return None
    today_str = datetime.now().strftime("%Y-%m-%d")
    end_iso = as_of_date or today_str
    cache_suffix = end_iso.replace("-", "") if as_of_date else "latest"
    cache_file = PRICE_CACHE / f"{code}_{cache_suffix}.json"
    if cache_file.exists():
        mtime = datetime.fromtimestamp(cache_file.stat().st_mtime)
        is_historical = bool(as_of_date and end_iso < today_str)
        if is_historical or (datetime.now() - mtime).days < PRICE_CACHE_TTL_DAYS:
            try:
                return json.loads(cache_file.read_text(encoding="utf-8"))
            except Exception:
                pass
    # 3 次重试, 退避 1/2/4s (akshare 远程限流常见)
    df = None
    if _HAVE_AKSHARE_PRICE:
        for attempt in range(3):
            try:
                end_date = datetime.strptime(end_iso, "%Y-%m-%d")
                end_dt = end_date.strftime("%Y%m%d")
                start_dt = (end_date - timedelta(days=120)).strftime("%Y%m%d")
                df = _ak.stock_zh_a_hist(
                    symbol=code,
                    period="daily",
                    adjust="qfq",
                    start_date=start_dt,
                    end_date=end_dt,
                    timeout=5,
                )
                break
            except Exception as e:
                wait = 1 * (2 ** attempt)
                print(f"[analyze] _get_price_position {code} retry {attempt+1}/3 after {wait}s: {type(e).__name__}", file=sys.stderr)
                time.sleep(wait)
    closes = None
    if df is not None and len(df) >= 5:
        closes = [float(v) for v in df["收盘"].astype(float).tail(60)]

    # akshare 东财接口被限流时，用新浪日 K 线做只读回退。历史重跑必须
    # 先截断到 as_of_date，避免把公告日之后的行情带入评分。
    if not closes or len(closes) < 5:
        if str(code).startswith(("60", "688", "900", "5")):
            prefix = "sh"
        elif str(code).startswith(("00", "30", "20")):
            prefix = "sz"
        elif str(code).startswith(("8", "4", "92")):
            prefix = "bj"
        else:
            prefix = "sh"
        url = (
            "https://quotes.sina.cn/cn/api/jsonp_v2.php/var=/"
            "CN_MarketDataService.getKLineData?"
            f"symbol={prefix}{code}&scale=240&datalen=240"
        )
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as response:
                raw = response.read().decode("gbk", errors="ignore")
            match = re.search(r"\((.*)\)", raw, re.S)
            rows = json.loads(match.group(1)) if match else []
            closes = [
                float(row.get("close") or 0)
                for row in rows
                if row.get("day") and row.get("day") <= end_iso and float(row.get("close") or 0) > 0
            ][-60:]
        except Exception as e:
            print(f"[analyze] _get_price_position {code} sina fallback: {type(e).__name__}", file=sys.stderr)
            closes = None

    if not closes or len(closes) < 5:
        return None
    current = float(closes[-1])
    avg_60d = float(sum(closes) / len(closes))
    high_60d = float(max(closes))
    low_60d = float(min(closes))
    ratio = current / avg_60d if avg_60d > 0 else 1.0
    pos_60d = (current - low_60d) / (high_60d - low_60d) if (high_60d - low_60d) > 0 else 0.5
    result = {
        "as_of_date": end_iso,
        "current": current,
        "avg_60d": round(avg_60d, 3),
        "high_60d": round(high_60d, 3),
        "low_60d": round(low_60d, 3),
        "ratio_vs_avg": round(ratio, 3),
        "pos_60d": round(pos_60d, 3),
    }
    cache_file.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return result



def _parse_buyback_amount_wan(facts: List[str], title: str = '') -> Optional[float]:
    """v9.11: 从 best_facts_final 或 标题 抽增持金额 (统一为万元), 找不到返回 None。
    老板 6/11 原话: "增持要看一下比例, 金额不绝对; 500 万公司层面其实意义不大"
    支持格式: "增持金额 >= 500 万元" / "增持金额 ≥ 2.51 亿元" / "增持 550,000 股" (股数按均价兜底)
    v9.11 fix: 标题含 "亿元" / "万元" 也走, 避免 fetch_pdf 失败时 一刀切降级
    """
    if not facts and not title:
        return None
    for f in list(facts or []) + [title]:
        m = re.search(r'增持金额[^0-9]*([0-9][0-9,.]*)\s*(亿|万)\s*元', f)
        if m:
            num = float(m.group(1).replace(',', ''))
            unit = m.group(2)
            return num * (10000.0 if unit == '亿' else 1.0)
    return None


def _parse_holding_ratio(facts: List[str], title: str = '') -> Optional[float]:
    """v9.12: 抓增持比例(占总股本/流通股本) — 老板 6/11 原话"金额不是绝对参考, 就要看增持的比例"
    支持格式: "占总股本 0.05%" / "占公司总股本 0.042%" / "股份比例 0.1444%" / "持股比例 0.5%"
    返回 float (e.g. 0.05 = 0.05%), 多个匹配取最大值
    """
    if not facts and not title:
        return None
    candidates = []
    for f in list(facts or []) + [title]:
        # 1. "占总股本 0.05%" / "占公司总股本 0.042%"
        for m in re.finditer(r'占[^0-9]{0,6}总?股?本?[^0-9]{0,4}([0-9]+(?:\.[0-9]+)?)\s*%', f):
            candidates.append(float(m.group(1)))
        # 2. "比例 0.05%" / "股份比例 0.05%"
        for m in re.finditer(r'(?:股份)?比例[^0-9]{0,4}([0-9]+(?:\.[0-9]+)?)\s*%', f):
            candidates.append(float(m.group(1)))
        # 3. "持股比例 0.5%"
        for m in re.finditer(r'持股比例[^0-9]{0,4}([0-9]+(?:\.[0-9]+)?)\s*%', f):
            candidates.append(float(m.group(1)))
    if not candidates:
        return None
    return max(candidates)


def _append_ratio_fact(entry: Dict[str, Any]) -> Dict[str, Any]:
    """v9.13: 增持 最佳事实补 "增持比例 X.XX%" (主动算, 不依赖 PDF 披露)
    老板 6/11 原话"增持也要看一下比例, 金额不是绝对的参考指标"
    """
    sigs = entry.get('best_signals', [])
    labels = {s[0] for s in sigs}
    if not any(lbl in labels for lbl in ('大股东大额增持', '董监高/管理层增持', '股价低位增持')):
        return entry  # 非增持类, 不处理
    facts = entry.get('best_facts', [])
    code = entry.get('code', '')
    # 已含 "增持比例" / "占总股本" 则不重复加
    if any('增持比例' in f or '占总股本' in f for f in facts):
        return entry
    ratio = _compute_increase_ratio_pct(code, facts, entry.get('best_title', ''))
    if ratio is not None:
        # 标注: 主动算 vs PDF披露
        is_pdf = _parse_holding_ratio(facts, entry.get('best_title', '')) is not None
        tag = '占总股本' if is_pdf else '估算增持比例'
        # 放在 facts 最前 (数字优先, title 限定词在后)
        facts.insert(0, f'{tag} {ratio:.4f}%')
        entry['best_facts'] = facts
        entry['holding_ratio'] = ratio
    return entry


def _handle_dual_signal(entry: Dict[str, Any]) -> Dict[str, Any]:
    """v9.12: 增持 双信号去重 (老板 6/11 原话)。
    规则:
      1. 单纯公司层面增持 ("大股东大额增持" +3) 不变
      2. 单纯高管增持 ("董监高/管理层增持" +5) 不变
      3. 同一人既是控股股东/实控人 又是 董监高(典型: 实际控制人+董事长)→ 去重, 只算 +5
      4. 命中 "股价低位增持" 不去重 (已升级到 +10, 跳过避免回退)
    附加: 增持类 entry 补 "占总股本 X.XX%" fact (金额不是绝对, 比例给 trader 看)
    """
    sigs = entry.get('best_signals', [])
    labels = {s[0] for s in sigs}
    if '股价低位增持' in labels:
        return _append_ratio_fact(entry)  # 已升级 +10, 跳过双信号去重
    has_big = '大股东大额增持' in labels
    has_mgr = '董监高/管理层增持' in labels
    if has_big and has_mgr:
        # 双信号去重: 只保留 "董监高/管理层增持" +5
        new_sigs = [(lbl, w) for (lbl, w) in sigs if lbl != '大股东大额增持']
        entry['best_signals'] = new_sigs
        entry['best_score'] = sum(w for _, w in new_sigs)
        entry['is_dual_signal_deduped'] = True
    return _append_ratio_fact(entry)



# v9.13: 主动算 增持比例 (增持金额 / 估算均价 / 总股本) — 不依赖 PDF 是否披露
def _compute_increase_ratio_pct(code: str, facts: List[str], title: str = '') -> Optional[float]:
    """
    主动算 增持比例 (%) — 老板 6/11 原话"增持要看一下比例, 金额不是绝对"
    输入: code, facts, title
    优先级:
      1. PDF 已有 "占总股本 X%" / "比例 X%" → 直接用
      2. PDF 增持股数 + TOTAL_SHARES → 算比例
      3. 增持金额 + 估算均价 (兜底 5 元/股) + TOTAL_SHARES → 估算
    返回 float (e.g. 0.05 = 0.05%)
    """
    # 1. PDF 已有比例
    r = _parse_holding_ratio(facts, title)
    if r is not None:
        return r
    # 2. 增持股数 / 总股本
    shares = None
    for f in list(facts or []) + [title]:
        m = re.search(r'增持[^\d]{0,8}([0-9,]+)\s*股', f)
        if m:
            v = int(m.group(1).replace(',', ''))
            if v > 1000:
                shares = v
                break
    if shares and code in TOTAL_SHARES:
        return shares / TOTAL_SHARES[code] * 100
    # 3. 增持金额 → 估算股数 (5 元/股 兜底) → 比例
    amount_wan = _parse_buyback_amount_wan(facts, title)
    if amount_wan and code in TOTAL_SHARES:
        est_shares = amount_wan * 10000 / 5  # 5 元/股 兜底
        return est_shares / TOTAL_SHARES[code] * 100
    return None


# v9.13: 主动算 收入贡献比例 (合同金额 / 公司年营收)
def _compute_revenue_impact_pct(code: str, contract_amount_wan: float) -> Optional[float]:
    """
    收入贡献比例 = 合同金额 / 公司年营收
    老板 6/11 原话"1300万美元贡献多少收入, 比例大 +5, 不大 +3"
    """
    if not contract_amount_wan or code not in COMPANY_REVENUE:
        return None
    revenue_wan = COMPANY_REVENUE[code]
    if revenue_wan <= 0:
        return None
    return contract_amount_wan / revenue_wan * 100


# v9.13: 收入类信号 (中标/重大合同 / 技术许可 / 战略合作) 按收入贡献比例调档
INCOME_SIGNAL_LABELS = {'中标/重大合同', '技术许可协议', '战略合作'}

def _enrich_income_signal_by_revenue(entry: Dict[str, Any]) -> Dict[str, Any]:
    """
    收入类信号按 收入贡献比例 调档:
      比例 >= 20% → +5 (中利多, 大合同)
      5% <= 比例 < 20% → +3 (弱利多, 中等合同)
      比例 < 5% → 维持默认 (e.g. +2)
    """
    sigs = entry.get('best_signals', [])
    if not sigs:
        return entry
    labels = {s[0] for s in sigs}
    if not labels & INCOME_SIGNAL_LABELS:
        return entry
    code = entry.get('code', '')
    if code not in COMPANY_REVENUE:
        return entry
    # 找合同金额
    contract_wan = None
    facts = entry.get('best_facts', [])
    title = entry.get('best_title', '')
    for f in list(facts or []) + [title]:
        m = re.search(r'([0-9][0-9,.]*)\s*万?美元', f)
        if m:
            # 单位换算: 1 USD = 7.2 CNY, 1 万美元 = 7.2 万人民币 (1:1 万单位)
            # 例: 1300 万美元 -> 1300 * 7.2 = 9,360 万人民币
            contract_wan = float(m.group(1).replace(',', '')) * 7.2
            break
        m = re.search(r'金额[^\d]{0,6}([0-9][0-9,.]*)\s*亿', f)
        if m:
            contract_wan = float(m.group(1).replace(',', '')) * 10_000
            break
        m = re.search(r'金额[^\d]{0,6}([0-9][0-9,.]*)\s*万', f)
        if m:
            contract_wan = float(m.group(1).replace(',', ''))
            break
    if not contract_wan:
        return entry
    ratio = _compute_revenue_impact_pct(code, contract_wan)
    if ratio is None:
        return entry
    entry['revenue_impact_pct'] = ratio
    new_sigs = []
    for lbl, w in sigs:
        if lbl in INCOME_SIGNAL_LABELS:
            if ratio >= 20:
                new_w = 5
            elif ratio >= 5:
                new_w = 3
            else:
                new_w = w
            if new_w != w:
                entry['is_revenue_adjusted'] = True
            new_sigs.append((lbl, new_w))
        else:
            new_sigs.append((lbl, w))
    entry['best_signals'] = new_sigs
    entry['best_score'] = sum(w for _, w in new_sigs)
    if ratio and not any('占年营收' in f for f in facts):
        facts.insert(0, f'占年营收 {ratio:.2f}%')
        entry['best_facts'] = facts
    return entry






def _enrich_price_position(entry):
    """
    v6 信号升级: 根据股价位置升级 best_score 和 best_signals
    - 命中"大股东大额增持" + 当前价低位 (ratio<0.9 或 pos_60d<0.3) -> +10 「股价低位增持」
    - 命中"≥2% 大股东减持" / "大股东减持" + 当前价高位 (ratio>1.1 或 pos_60d>0.7) -> -10 「股价高位减持」
    - akshare 不可用时回退到原分数
    """
    sigs = entry.get("best_signals", [])
    sig_labels = {s[0] for s in sigs}
    code = entry.get("code", "")

    if "大股东大额增持" in sig_labels and entry["best_score"] > 0:
        pos = _get_price_position(code, as_of_date=entry.get("best_date"))
        if pos and (pos["ratio_vs_avg"] < 0.9 or pos["pos_60d"] < 0.3):
            new_sigs = [(lbl, w) for (lbl, w) in sigs if lbl != "大股东大额增持"]
            new_sigs.append(("股价低位增持", 10))
            entry["best_signals"] = new_sigs
            entry["best_score"] = sum(w for _, w in new_sigs)
            entry["is_price_upgraded"] = "low"
        if pos:
            entry["best_price_position"] = pos
            entry["best_price_position_tag"] = (
                f"60日均价 {pos['avg_60d']}, 当前价 {pos['current']} "
                f"(ratio {pos['ratio_vs_avg']}, 60日位置 {int(pos['pos_60d']*100)}%)"
            )
        return entry

    if (("≥2% 大股东减持" in sig_labels) or ("大股东减持" in sig_labels)) and entry["best_score"] < 0:
        pos = _get_price_position(code, as_of_date=entry.get("best_date"))
        if pos and (pos["ratio_vs_avg"] > 1.1 or pos["pos_60d"] > 0.7):
            new_sigs = []
            upgraded = False
            for (lbl, w) in sigs:
                if lbl in ("≥2% 大股东减持", "大股东减持") and not upgraded:
                    new_sigs.append(("股价高位减持", -10))
                    upgraded = True
                else:
                    new_sigs.append((lbl, w))
            entry["best_signals"] = new_sigs
            entry["best_score"] = sum(w for _, w in new_sigs)
            entry["is_price_upgraded"] = "high"
        if pos:
            entry["best_price_position"] = pos
            entry["best_price_position_tag"] = (
                f"60日均价 {pos['avg_60d']}, 当前价 {pos['current']} "
                f"(ratio {pos['ratio_vs_avg']}, 60日位置 {int(pos['pos_60d']*100)}%)"
            )
        return entry

    return entry


def _v9_20_buyback_amount_gate(entry):
    """v9.20 股份回购金额门槛 — PDF 抓到"回购金额" < 1 亿元 降档为 +3 弱利多; 无金额降为 +2"""
    if not entry.get('best_signals'):
        return entry
    has_buyback = any('股份回购' in lbl for lbl, _ in entry['best_signals'])
    if not has_buyback:
        return entry
    buyback_amt_yi = None
    for f in entry.get('best_facts', []) or []:
        m = re.search(r'回购金额\s*[:≥≤≈]?\s*([0-9][0-9,.]*)\s*(亿|万)元', f)
        if m:
            amt = float(m.group(1).replace(',', ''))
            unit = m.group(2)
            if unit == '万':
                amt = amt / 10000.0
            buyback_amt_yi = amt
            break
    if buyback_amt_yi is not None and buyback_amt_yi >= 1.0:
        return entry
    if buyback_amt_yi is not None and buyback_amt_yi < 1.0:
        target_score = 3
    else:
        target_score = 2
    new_signals = []
    for lbl, sc in entry['best_signals']:
        if '股份回购' in lbl and sc == 4:
            new_signals.append((lbl, target_score))
        else:
            new_signals.append((lbl, sc))
    entry['best_signals'] = new_signals
    entry['best_score'] = sum(sc for _, sc in new_signals)
    entry['_v9_20_gate_applied'] = True
    return entry


def _v9_26_bid_downgrade(entry):
    """v9.26: 预中标/日常经营合同降档 — 标题含'预中标'时 +7 → +3 (弱利多, 存在不确定性)
    v9.28 扩展: "中标.*提示性公告" / "中标.*提示" / "日常经营合同" 同样降档 (提示性 = 待确认; 日常经营 = 持续小额)
    """
    if not entry.get('best_signals'):
        return entry
    has_contract = any('中标' in lbl or '重大合同' in lbl for lbl, _ in entry['best_signals'])
    if not has_contract:
        return entry
    title = entry.get('best_title', '')
    # v9.28 扩展降档触发条件
    if not re.search(
        r'预中标|拟中标|日常.*合同|日常.*订单|日常经营合同|中标.*提示性公告|中标.*提示$|关于.*中标.*提示|'
        r'^.*中标.*的提示性公告|提示性公告.*中标|'
        r'中标通知书(?!.*[0-9])',
        title,
    ):
        return entry
    new_signals = []
    for lbl, sc in entry['best_signals']:
        if ('中标' in lbl or '重大合同' in lbl) and sc == 7:
            new_signals.append((lbl, 3))
        else:
            new_signals.append((lbl, sc))
    entry['best_signals'] = new_signals
    entry['best_score'] = sum(sc for _, sc in new_signals)
    entry['_v9_26_bid_downgrade'] = True
    return entry


# ============================================================
# v9.28 新增函数 — 增持计划阶段/激励执行类/部分撤销 ST/欧派专项核查
# ============================================================
def _v9_28_increase_plan_downgrade(entry):
    """v9.28: 增持计划阶段降档 — 标题含"增持计划"但未含"完成"/"实施进展"时 +5 → +3
    例: ST易购 002024 标题"部分董事、高管及核心业务骨干增持股份计划的进展公告"
    实施进展 应走 +5, 纯计划 (无"完成"/"实施进展") 应走 +3
    """
    if not entry.get('best_signals'):
        return entry
    has_increase = any('增持' in lbl for lbl, _ in entry['best_signals'])
    if not has_increase:
        return entry
    title = entry.get('best_title', '')
    # 命中"增持股份计划"或"增持计划"且 未命中"完成/实施进展/已增持"
    if not re.search(r'增持.*?计划|增持计划', title):
        return entry
    if re.search(r'完成|实施进展|已增持|增持结果|增持完毕|增持达', title):
        return entry
    new_signals = []
    for lbl, sc in entry['best_signals']:
        if '董监高/管理层增持' in lbl and sc == 5:
            new_signals.append((lbl, 3))
        elif '增持' in lbl and sc in (3, 5, 7, 10):
            new_signals.append((lbl, min(sc, 3)))  # 计划阶段 不超过 +3
        else:
            new_signals.append((lbl, sc))
    entry['best_signals'] = new_signals
    entry['best_score'] = sum(sc for _, sc in new_signals)
    entry['_v9_28_plan_downgrade'] = True
    return entry


def _v9_28_increase_amount_gate(entry):
    """v9.28: 增持金额极小降档 — PDF 抓到"增持金额" < 100 万元 → +5 → +3
    例: 杭叉集团 603298 24万增持 (占总股本 0.0008%) 极小, 利好弱
    """
    if not entry.get('best_signals'):
        return entry
    has_increase = any('董监高/管理层增持' in lbl or '大股东大额增持' in lbl for lbl, _ in entry['best_signals'])
    if not has_increase:
        return entry
    # 已经有比例 fact, 跟 100万 阈值比较
    title = entry.get('best_title', '')
    if '实施进展' in title or '增持结果' in title or '增持完成' in title:
        return entry  # 已实施不算计划
    facts = entry.get('best_facts', [])
    _fact_text = ' '.join(facts or [])
    # 提取金额 (万元)
    m_amt = re.search(r'增持金额[^0-9]{0,4}([0-9.]+)\s*万', _fact_text)
    if not m_amt:
        return entry
    amt_wan = float(m_amt.group(1))
    if amt_wan >= 100:
        return entry  # ≥ 100 万 维持 +5
    # < 100 万 → +3
    new_signals = []
    for lbl, sc in entry['best_signals']:
        if '董监高/管理层增持' in lbl and sc == 5:
            new_signals.append((lbl, 3))
        else:
            new_signals.append((lbl, sc))
    entry['best_signals'] = new_signals
    entry['best_score'] = sum(sc for _, sc in new_signals)
    entry['_v9_28_amount_gate'] = True
    return entry


def _v9_28_incentive_procedural_v2(title: str) -> bool:
    """v9.28: 扩展 v9.19 _is_procedural_incentive, 命中更多执行/程序类公告
    例: 羚锐制药 600285 "解锁条件成就"
         恒铭达 002947 / 精研科技 300709 "登记完成"
         实朴检测 301228 "自查表"
         益方生物 688382 / 剑桥科技 603083 "激励对象名单" / "名单公示"
    """
    if not re.search(r'限制性股票|股票期权|股权激励|员工持股', title):
        return False
    # 执行/程序类关键词
    return bool(re.search(
        r'解锁条件成就|解锁.*暨上市|'
        r'登记完成|首次授予登记完成|授予完成|'
        r'激励对象名单|名单公示|名单审核公示|'
        r'自查表|内幕信息知情人|'
        r'调整.*授予价格|调整.*价格|调整.*数量|调整.*相关事项|'
        r'注销.*期权|注销.*股票|'
        r'作废|失效',
        title,
    ))


def _v9_28_lawyer_special_audit(title: str) -> bool:
    """v9.28: 律师事务所专项核查意见 中性化
    例: 欧派家居 603833 "广东信达律师事务所...实际控制人的一致行动人免于以要约方式增持股份的专项核查意见"
    这种是 律师事务对增持行为 出具的 核查意见, 不是真的 增持公告 本身
    """
    return bool(re.search(
        r'律师事务所.*专项核查意见|律师事务所.*法律意见|律师.*见证|律师.*法律意见|'
        r'专项核查意见.*增持|专项核查意见.*减持|'
        r'免于以要约方式.*增持.*专项核查意见',
        title,
    ))


def _v9_28_st_partial_revoke(title: str) -> bool:
    """v9.28: ST 撤销部分 → 中性 (撤销部分 + 继续被ST)
    例: 002872 ST天圣 "关于撤销部分其他风险警示暨继续被实施其他风险警示的公告"
    """
    return bool(re.search(
        r'撤销部分其他风险警示|撤销.*风险警示.*继续|撤销.*其他风险警示.*继续',
        title,
    ))

def _v9_29_st_full_revoke(title: str) -> bool:
    """v9.29: ST 撤销全撤 → 中性 (摘帽/摘星, 不带"部分"/"继续"字样)
    例: 000908 ST景峰 "关于公司股票撤销其他风险警示暨停复牌的公告"  → 摘帽
         300093 ST金刚 "关于公司股票交易撤销退市风险警示及其他风险警示暨股票停复牌的公告"  → 摘星
    与 v9.28 partial_revoke 区分:
      - v9.28 partial: 标题含"撤销部分"或"继续" → 仅撤销部分警示
      - v9.29 full: 标题含"撤销" + "风险警示" 但不带"部分"/"继续" → 全撤 (摘帽/摘星)
    6 铁律合规: 不破任何铁律 (异常波动 = -2 是 -2 弱利空, 不涉及 ST 类)
    """
    # v9.28 partial 优先 (002872 ST天圣: 撤销部分 + 继续被ST)
    if _v9_28_st_partial_revoke(title):
        return False
    return bool(re.search(
        r'撤销(?!部分).{0,15}风险警示',  # 排除"撤销部分", 命中"撤销其他风险警示" / "撤销退市风险警示" 等
        title,
    ))


def _v9_30_incentive_strict(title: str) -> bool:
    """v9.30: 激励严格化 (老板铁律) — 任何激励类公告, 不含"草案"或"正式发布" → 中性
    配合 _v9_28_incentive_procedural_v2 覆盖 9+ 类执行/程序类公告

    老板原话: "激励公告只有草案和正式发布的两个算利好, 其余的都算中性过滤掉"
    例 (利好保留):
        "关于公司股权激励计划草案的公告"          → 含"草案" → 利好
        "关于公司股权激励计划正式发布的公告"      → 含"正式发布" → 利好
    例 (中性过滤):
        "关于公司股权激励计划首次授予的公告"      → 不含草案/正式发布 → 中性
        "关于公司股权激励计划授予完成的公告"      → 不含草案/正式发布 → 中性
        "关于公司股权激励计划解锁条件成就的公告"  → 不含草案/正式发布 → 中性
        "关于公司2024年限制性股票激励计划获股东大会通过的公告" → 不含草案/正式发布 → 中性 (实际: 草案通过 应也算利好, 老板铁律严格化走中性)
    """
    if not re.search(r'限制性股票|股票期权|股权激励|员工持股', title):
        return False
    # 利好状态: 仅 草案 / 正式发布 (老板铁律)
    return not bool(re.search(r'草案|正式发布', title))


def _v9_30_increase_progress(title: str) -> bool:
    """v9.30: 增持后续披露 → 中性 (老板铁律) — 第一次披露 = 利好, 进展/完成 = 中性
    老板原话: "增持公告, 第一次披露的时候是利好, 但是增持进展算中性过滤掉"

    例 (中性过滤):
        "关于股东增持股份计划进展公告"            → 含"增持"+"进展" → 中性
        "关于公司控股股东完成增持股份计划的公告"  → 含"增持"+"完成" → 中性
        "关于股东增持计划实施完毕的公告"          → 含"增持"+"实施完毕" → 中性
        "关于高管增持股份结果的公告"              → 含"增持"+"结果" → 中性
    例 (利好保留):
        "关于公司控股股东增持股份计划的公告"      → 仅"增持计划"无"进展/完成" → 利好
        "关于公司拟增持股份的公告"                → 仅"拟增持"无"进展/完成" → 利好
    """
    if not re.search(r'增持|拟增持', title):
        return False
    return bool(re.search(r'进展|完成|结果|实施完毕|实施完成', title))


def _v9_30_capital_reduction(title: str) -> bool:
    """v9.30: 注销减资 → 中性 (老板铁律)
    老板原话: "注销减资换成中性"
    排除 限制性股票/股权激励/股票期权 类 (那些已由 is_incentive_buyback 单独处理)
    """
    if re.search(r'限制性股票|股权激励|股票期权', title):
        return False
    return bool(re.search(r'注销减资|减资公告|减少注册资本', title))


def _v9_30_daily_contract(title: str) -> bool:
    """v9.30: 日常经营合同 → 中性 (老板铁律) — 覆盖 中标/重大合同 +7
    老板原话: "重大合同按意义大小排序 (虽然重大但意义不大要降级)"
    例: 三晖电气 "关于公司签订日常经营合同的公告" → 日常经营合同 → 中性
    """
    return bool(re.search(r'日常经营合同', title))


def _v9_30_neutral_neg_bucket(entry: Dict[str, Any]) -> bool:
    """v9.30.1: -6 ~ -1 弱/中利空 不再分流 (用户 6/15 删 PDF "五、中性" 段后, 分流目的消失)
    老板 6/15 决策: "五、中性这部分删掉吧, 不需要啊"
    保留函数定义以兼容旧 caller, 改返回 False 关闭分流
    实施: -6 ~ -1 弱/中利空 现在保留在 all_bad_companies, 进利空一览表
    """
    return False

# 这部分会被注入到 analyze.py 顶部
import re
from pathlib import Path
from typing import Dict, List, Tuple

SPEC_PATH = Path(__file__).parent / 'references' / 'signals_spec.md'


def _parse_spec_table(md_text: str) -> Tuple[List[Tuple[str, int, str]], Dict[str, str]]:
    """
    Parse signals_spec.md -> (SIGNALS, LOGIC_TEMPLATES)
    """
    signals = []
    logic_templates = {}
    in_table = False
    for line in md_text.splitlines():
        line = line.strip()
        if not line.startswith('|'):
            in_table = False
            continue
        cells = [c.strip() for c in line.strip('|').split('|')]
        if not in_table:
            if cells and cells[0] == 'label':
                in_table = True
            continue
        if all(c.replace('-', '').strip() == '' for c in cells):
            continue
        if len(cells) < 3:
            continue
        label, score_str, pattern = cells[0], cells[1], cells[2]
        judge = cells[3] if len(cells) >= 4 else ''
        try:
            score = int(score_str)
        except ValueError:
            continue
        if not label or not pattern:
            continue
        # md 里用 ; 分隔多个备选 pattern, 加载时还原成 | (regex OR)
        pattern = pattern.replace(";", "|")
        signals.append((pattern, score, label))
        if judge:
            logic_templates[label] = judge
    return signals, logic_templates
def _parse_neutral_table(md_text: str) -> List[Tuple[str, str]]:
    """parse 中性公告过滤表 → [(pattern, reason), ...]

    v9.8 修复: 允许多张表连续出现 (spec 用了空行分隔两张 filter 表),
    只在非空行且非 `|` 开头时重置 in_table,避免漏读第二张表。
    """
    filters: List[Tuple[str, str]] = []
    in_table = False
    for raw_line in md_text.splitlines():
        if not raw_line.strip():
            # 空行: 跳过但不重置 in_table (v9.8 允许多表连续)
            continue
        line = raw_line.strip()
        if not line.startswith('|'):
            in_table = False
            continue
        cells = [c.strip() for c in line.strip('|').split('|')]
        if not in_table:
            if cells and cells[0] == 'pattern':
                in_table = True
            continue
        if all(c.replace('-', '').strip() == '' for c in cells):
            continue
        if len(cells) < 2:
            continue
        pattern, reason = cells[0], cells[1]
        if not pattern or not reason:
            continue
        pattern = pattern.replace(";", "|")
        filters.append((pattern, reason))
    return filters


# 启动时加载 spec
try:
    _spec_text = SPEC_PATH.read_text(encoding='utf-8')
    SIGNALS, LOGIC_TEMPLATES = _parse_spec_table(_spec_text)
    NEUTRAL_FILTERS = _parse_neutral_table(_spec_text)
except Exception as _e:
    # 兜底: 至少保证 SIGNALS/NEUTRAL_FILTERS 不为 None
    SIGNALS: List[Tuple[str, int, str]] = []
    LOGIC_TEMPLATES: Dict[str, str] = {}
    NEUTRAL_FILTERS: List[Tuple[str, str]] = []
    import sys as _sys
    import time as _time
    print(f"⚠️  signals_spec.md 加载失败: {_e}", file=_sys.stderr)



def is_neutral(title: str) -> Optional[str]:
    for pat, reason in NEUTRAL_FILTERS:
        if re.search(pat, title):
            return reason
    return None


# ============================================================
# 3. 行业/赛道推断
# ============================================================
INDUSTRY_HINTS = {
    '半导体/芯片': [r'半导体|芯片|集成电路|晶圆|封测|存储|DRAM|NAND|GPU|CPU|SoC', r'韦尔|兆易|长电|通富|华虹|中芯|寒武|海光|景嘉微|龙芯'],
    'AI/算力': [r'大模型|人工智能|算力|GPU|服务器|超算|数据中心', r'浪潮|紫光|中科曙光|工业富联|海光|寒武纪|商汤'],
    '新能源/锂电': [r'锂电|电池|正极|负极|隔膜|电解液|光伏|风电|储能|氢能|新能源', r'宁德|比亚迪|亿纬|赣锋|天齐|阳光|隆基|通威'],
    '机器人/智能制造': [r'机器人|减速器|伺服|谐波|工业自动化|智能制造|机器视觉', r'绿的|汇川|埃斯顿|拓斯达|机器人|克来机电|双环|中大力德'],
    '医药/生物': [r'药品|疫苗|创新药|CRO|CMO|医疗器械|生物制品|细胞治疗|基因|兽药|新兽药', r'恒瑞|药明|百济神州|信达|君实|复星|瑞普|回盛|一品红'],
    '消费': [r'白酒|食品|饮料|家电|纺织|服装|零售|电商', r'茅台|五粮液|伊利|海天|美的|格力|永辉|东鹏'],
    '金融': [r'银行|保险|证券|信托|金融|资管|基金|租赁', r'工农中建|招行|平安|国寿|中信|海通|华泰'],
    '地产/基建': [r'房地产|物业|建筑|建材|水泥|钢铁|基建', r'万科|保利|碧桂园|海螺|宝钢|中建|中铁'],
    '汽车': [r'汽车|整车|零部件|新能源车|智能驾驶|车联网|无人驾驶', r'比亚迪|长城|吉利|蔚来|小鹏|理想|赛轮|福耀'],
    '军工/航天': [r'军工|航空|航天|船舶|兵器|核工业', r'中航|沈飞|航发|中船|洪都|航天'],
}


# 代码→行业 精确表 (Top5 高频命中, 比 INDUSTRY_HINTS 正则更准)
# 单一来源: 维护在这里, 不分散
INDUSTRY_MAP: Dict[str, str] = {
    # v9.2 扩充: 6/9 复盘 112 只入榜标的的精确行业 (代码→行业)
    # 单一来源: 维护在这里; 新增标的先查这里, 查不到才走 INDUSTRY_HINTS
    # 医药/生物
    '688575': '医疗器械/体外诊断',  # 亚辉龙
    '688105': '生物科技/分子诊断',  # 诺唯赞
    '688117': '生物科技/核酸药物',  # 圣诺生物
    '300204': '医药/创新药',        # 舒泰神
    '600535': '医药/中药',          # 天士力
    '600521': '医药/原料药',        # 华海药业
    '600566': '医药/中成药',        # 济川药业
    '600161': '医药/血液制品',      # 天坛生物
    '603739': '生物科技/酶制剂',    # 蔚蓝生物
    '000623': '医药/中药',          # 吉林敖东
    '688265': '生物科技/模式动物',  # 南模生物
    '002688': '医药/兽药',          # 金河生物
    '688098': '生物科技/兽用疫苗',  # 申联生物
    '002262': '医药/麻醉',          # 恩华药业
    '688317': '生物科技/分子诊断',  # 之江生物
    # 食品/消费
    '600873': '食品/氨基酸',        # 梅花生物
    '300858': '食品/益生菌',        # 科拓生物
    '003012': '建材/瓷砖',          # 东鹏控股
    '603195': '家电/插座',          # 公牛集团
    '000759': '零售/超市',          # 中百集团
    # 化工/新材料
    '002597': '化工/食品添加剂',    # 金禾实业
    '002145': '化工/钛白粉',        # 钛能化学
    '601568': '化工/PVC',           # 北元化工
    '002440': '化工/染料',          # 闰土股份
    '603823': '化工/染料',          # 百合花
    '600378': '化工/新材料',        # 昊华科技
    '002254': '化工/芳纶',          # 泰和新材
    '002361': '化工/粉末涂料',      # 神剑股份
    '300478': '化工/塑料',          # 杭州高新
    '000545': '化工/钛白粉',        # 金浦钛业
    '603078': '化工/电子化学品',    # 江化微
    '002386': '化工/PVC',           # 天原股份
    # 电气设备/智能电网
    '002560': '电缆/电气设备',      # 通达股份
    '601096': '输变电/铁塔',        # 宏盛华源
    '601567': '电气设备/智能电网',  # 三星电气
    '688517': '电气设备/智能电网',  # 金冠电气
    '002606': '电力/绝缘子',        # 大连电瓷
    '688681': '电气设备/智能电网',  # 科汇股份
    # 半导体/集成电路
    '688478': '半导体/硅材料',      # 晶升股份
    '688549': '半导体/电子特气',    # 中巨芯
    '688322': '半导体/3D视觉',      # 奥比中光
    '603929': '半导体/洁净室',      # 亚翔集成
    # 电子/PCB
    '002579': 'PCB',                 # 中京电子
    '001298': '电子/分销',          # 好上好
    '002636': 'PCB/覆铜板',         # 金安国纪
    '002138': '电子/电感',          # 顺络电子
    '688628': '电子/仪器仪表',      # 优利德
    # 软件/工业软件
    '688695': '软件/信息安全',      # 中创股份
    '002987': '软件/金融IT',        # 京北方
    '002421': '软件/智慧医疗',      # 达实智能
    '603859': '软件/工业互联网',    # 能科科技
    '688507': '软件/CAE仿真',       # 索辰科技
    '688083': '软件/工业软件',      # 中望软件
    # 机器人/智能制造
    '002896': '机器人/智能制造',    # 中大力德
    '002747': '机器人/智能制造',    # 埃斯顿
    '688017': '机器人/谐波减速器',  # 绿的谐波
    '688160': '机器人/工控',        # 步科股份
    '002444': '工具/智能制造',      # 巨星科技
    '920108': '家电/智能制造',      # 宏海科技
    '300953': '机械/精密模具',      # 震裕科技
    '002795': '机械/阀门',          # 永和智控
    '001288': '机械/输送',          # 运机集团
    '002931': '机械/园林工具',      # 锋龙股份
    '603135': '机械/冶金',          # 中重科技
    '001400': '机械/风电',          # 江顺科技
    '002164': '机械/齿轮',          # 宁波东力
    '300790': '光学/安防',          # 宇瞳光学
    # 汽车/零部件
    '002708': '汽车零部件',         # 光洋股份
    '601799': '汽车/车灯',          # 星宇股份
    '605128': '汽车零部件/座椅',    # 上海沿浦
    '600148': '汽车零部件',         # 长春一东
    # 军工/航天
    '003009': '军工/航天',          # 中天火箭
    '688146': '工业气体/军工',      # 中船特气
    # 传媒/AI
    '600770': '传媒/AI',            # 综艺股份
    '600959': '传媒/广电',          # 江苏有线
    '002354': '传媒/AI',            # 天娱数科
    # 地产/家居
    '600622': '房地产',             # 光大嘉宝
    '000668': '房地产',             # 荣丰控股
    '000797': '建筑/地产',          # 中国武夷
    '000517': '房地产',             # 荣安地产
    '000785': '家居/智能家居',      # 居然智家
    '002631': '家居/地板',          # 德尔未来
    # 环保
    '600388': '环保/大气',          # 龙净环保
    '000068': '环保/水务',          # 华控赛格
    '688501': '环保/大气',          # 青达环保
    # 物流/港口
    '600717': '港口/物流',          # 天津港
    '001228': '物流/化工',          # 永泰运
    # 新能源
    '002531': '新能源/风电',         # 天顺风能
    '001283': '电池/锂电',          # 豪鹏科技
    # 钢铁/金属
    '603969': '钢铁/金属制品',      # 银龙股份
    '000055': '钢铁/新材料',        # 方大集团
    '688186': '钢铁/特殊钢',        # 广大特材
    '002160': '铝/新材料',          # 常铝股份
    '002613': '玻璃/建筑',          # 北玻股份
    '600552': '新材料/玻璃',        # 凯盛科技
    '688398': '新材料/真空绝热',    # 赛特新材
    # 金融设备
    '002376': '物联网/金融设备',    # 新北洋
    # 农业
    '300087': '农业/种业',          # 荃银高科
    # 多元化/医药水泥
    '600668': '医药/水泥',          # 尖峰集团
    # 煤炭
    '600403': '煤炭',               # 大有能源
    # ST/退市风险 (扩充)
    '002214': 'ST/退市风险',         # ST大立
    '600187': 'ST/退市风险',         # ST国中
    '002856': 'ST/退市风险',         # ST美芝
    '603843': 'ST/退市风险',         # ST正平
    '600543': 'ST/退市风险',         # ST莫高
    '600243': 'ST/退市风险',         # ST海华
    '000821': 'ST/退市风险',         # ST京机
    '002898': 'ST/退市风险',         # ST赛隆
    # 电力/能源线缆
    '300265': '电力/能源线缆',   # 通光线缆
    '002471': '电力/电缆',       # 中超控股
    # 航运/远洋运输
    '920571': '航运/远洋运输',   # 国航远洋
    # 钛白粉/化工
    '002601': '钛白粉/化工',     # 龙佰集团
    # 半导体设计(SoC)
    '300458': '半导体设计(SoC)',  # 全志科技
    # 硅基新材料
    '301059': '硅基新材料',      # 金三江
    # 工业气体
    '002971': '工业气体',        # 和远气体
    # ST/退市
    '600608': 'ST/退市风险',     # ST沪科
    '300396': 'ST/退市风险',     # ST迪瑞
    '300198': 'ST/退市风险',     # *ST纳川
    '300152': 'ST/退市风险',     # *ST动力
    '688287': 'ST/退市风险',     # 退市观典
    # 输配电/碳化硅
    '300831': '输配电/碳化硅',    # 派瑞股份
    # 激光器
    '688025': '激光器',          # 杰普特
    # 新材料
    '920580': '新材料',          # 科创新材
    # 央企工程
    '601868': '央企工程/能源',   # 中国能建
    '600502': '基建/工程',       # 安徽建工
    '688070': '低空经济/无人机',  # 纵横股份
    '603713': '化工物流',        # 密尔克卫
    '002208': '地产/城建',       # 合肥城建
    # 央企控股半导体
    '002415': '安防/视频',       # 海康威视
    '600036': '银行',            # 招商银行
    # v9.12 扩充: 6/11 跑批 TOP 标的行业补充 (94 条, 老板 6/11 反馈'其他'太多)
    '000029': '房地产',                   # 深深房Ａ
    '000048': '农业/畜牧',                 # 京基智农
    '000504': 'ST/退市风险',               # ST生物
    '000833': '化工/糖业',                 # 粤桂股份
    '000908': 'ST/退市风险',               # ST景峰
    '001299': '公用事业/天然气',              # 美能能源
    '002120': '物流/快递',                 # 韵达股份
    '002148': '通信',                    # 北纬科技
    '002209': '包装机械',                  # 达意隆
    '002306': 'ST/退市风险',               # ST云网
    '002350': '电气设备/配电',               # 北京科锐
    '002517': '传媒/游戏',                 # 恺英网络
    '002585': '化工/BOPET',              # 双星新材
    '002599': '印刷',                    # 盛通股份
    '002605': '传媒/游戏',                 # 姚记科技
    '002607': '教育',                    # 中公教育
    '002669': '化工/胶粘剂',                # 康达新材
    '002698': '机器人/智能装备',              # 博实股份
    '002758': '农资流通',                  # 浙农股份
    '002766': '汽车电子',                  # 索菱股份
    '002918': '建材/瓷砖',                 # 蒙娜丽莎
    '003026': '半导体/硅材料',               # 中晶科技
    '003043': '半导体设备',                 # 华亚智能
    '300076': '显示/视讯',                 # GQY视讯
    '300093': 'ST/退市风险',               # ST金刚
    '300411': '风机/通风设备',               # 金盾股份
    '300456': '半导体/MEMS',              # 赛微电子
    '300738': 'IDC/云计算',               # 奥飞数据
    '301369': '半导体设备',                 # 联动科技
    '600021': '公用事业/电力',               # 上海电力
    '600129': '医药/中药',                 # 太极集团
    '600141': '化工/磷化工',                # 兴发集团
    '600180': 'ST/退市风险',               # ST瑞茂
    '600193': 'ST/退市风险',               # 退市创兴
    '600239': 'ST/退市风险',               # ST云城
    '600248': '建筑',                    # 陕建股份
    '600279': '港口/物流',                 # 重庆港
    '600332': '医药/中药',                 # 白云山
    '600421': 'ST/退市风险',               # 退市华嵘
    '600499': '机械/陶瓷设备',               # 科达制造
    '600500': '化工/综合',                 # 中化国际
    '600509': '公用事业/电力',               # 天富能源
    '600567': '造纸/包装',                 # 山鹰国际
    '600568': 'ST/退市风险',               # ST中珠
    '600587': '医药/医疗器械',               # 新华医疗
    '600664': '医药/中药',                 # 哈药股份
    '600730': 'ST/退市风险',               # ST高科
    '600763': '医药/医疗服务',               # 通策医疗
    '601155': '房地产',                   # 新城控股
    '601500': '轮胎/橡胶',                 # 通用股份
    '601800': '建筑',                    # 中国交建
    '603002': '电子/PCB',                # 宏昌电子
    '603065': '化工/光稳定剂',               # 宿迁联盛
    '603087': '医药/胰岛素',                # 甘李药业
    '603118': '通信/光模块',                # 共进股份
    '603207': '医药/外用制剂',               # 小方制药
    '603272': 'ST/退市风险',               # ST联翔
    '603319': '化工/塑料',                 # 美湖股份
    '603606': '电气设备/电缆',               # 东方电缆
    '603669': '医药/中药',                 # 灵康药业
    '603711': '食品/饮料',                 # 香飘飘
    '603803': '通信',                    # 瑞斯康达
    '603822': 'ST/退市风险',               # ST嘉澳
    '603890': '电子/笔电结构件',              # 春秋电子
    '603893': '半导体/SoC',               # 瑞芯微
    '603987': '医药/医疗器械',               # 康德莱
    '605006': '建材/玻纤',                 # 山东玻纤
    '605288': '汽车零部件',                 # 凯迪股份
    '605318': '建材/吊顶',                 # 法狮龙
    '605376': '金属粉体',                  # 博迁新材
    '605589': '化工/合成树脂',               # 圣泉集团
    '688011': '军工/光电',                 # 新光光电
    '688082': '半导体设备',                 # 盛美上海
    '688091': '医药/创新药',                # 上海谊众
    '688107': '半导体/FPGA',              # 安路科技
    '688127': '光学元件',                  # 蓝特光学
    '688137': '生物科技/蛋白',               # 近岸蛋白
    '688143': '光纤/通信',                 # 长盈通
    '688157': '化工/涂料',                 # 松井股份
    '688167': '半导体/激光',                # 炬光科技
    '688175': '通信',                    # 高凌信息
    '688198': '医药/医疗器械',               # 佰仁医疗
    '688225': '软件/网络安全',               # 亚信安全
    '688230': '半导体/功率器件',              # 芯导科技
    '688239': '军工/航空发动机',              # 航宇科技
    '688268': '半导体/电子特气',              # 华特气体
    '688271': '医疗器械/影像',               # 联影医疗
    '688297': '军工/无人机',                # 中无人机
    '688456': '金属粉体',                  # 有研粉材
    '688472': '光伏/组件',                 # 阿特斯
    '688556': '光伏/切割设备',               # 高测股份
    '688662': '半导体/热电',                # 富信科技
    '688783': '半导体/硅材料',               # 西安奕材
    '688786': '金属粉体/3D打印',             # 悦安新材
    # v9.21: INDUSTRY_MAP 扩充 (7 天 6/4~6/12 入榜标的中落 "其他" 的 80 家, 按 "具体行业做什么" 命名)
    # 数据源: 7 天 processed JSON by_company/all_good_companies+all_bad_companies 去重 524 家, "其他" 351 家, top 80 by |score|
    # 命名规范: 精细到子领域, e.g. "半导体/电源管理芯片" 比 "半导体/芯片" 更好 (用户原话)
    # 不动 INDUSTRY_HINTS (模糊匹配, INDUSTRY_MAP 优先)
    # ── ST/退市风险 (19 家, 含 *ST / ST / 退市前缀) ──
    '600753': 'ST/退市风险',             # *ST海钦
    '000793': 'ST/退市风险',             # *ST华闻
    '300225': 'ST/退市风险',             # *ST金泰
    '600228': 'ST/退市风险',             # *ST返利
    '605081': 'ST/退市风险',             # *ST太和
    '600696': 'ST/退市风险',             # 退市岩石
    '600636': 'ST/退市风险',             # 退市国化
    '600599': 'ST/退市风险',             # 退市熊猫
    '600421': 'ST/退市风险',             # 退市华嵘
    '600193': 'ST/退市风险',             # *ST创兴
    '003032': 'ST/退市风险',             # *ST传智
    '002529': 'ST/退市风险',             # *ST海源
    '002058': 'ST/退市风险',             # *ST威尔
    '300343': 'ST/退市风险',             # ST联创
    '000632': 'ST/退市风险',             # ST三木
    '002323': 'ST/退市风险',             # *ST雅博
    '002872': 'ST/退市风险',             # ST天圣
    '300044': 'ST/退市风险',             # ST赛为
    '000711': 'ST/退市风险',             # ST京蓝
    # ── 化工 (8 家) ──
    '601568': '化工/氯碱/PVC',           # 北元化工
    '603120': '化工/分子筛',             # 肯特催化
    '002597': '化工/食品添加剂',         # 金禾实业
    '300995': '化工/塑料',               # 奇德新材
    '002258': '化工/农药',               # 利尔化学
    '600596': '化工/有机硅',             # 新安股份
    '002092': '化工/化肥',               # 中泰化学
    '002226': '化工/锂电材料',           # 江南化工
    # ── 医药 (10 家) ──
    '002262': '医药/中枢神经',           # 恩华药业
    '688189': '医药/创新药',             # 南新制药
    '301089': '医药/原料药',             # 拓新药业
    '301293': '医药/医疗服务/神经专科',  # 三博脑科
    '688105': '医药/生命科学试剂',       # 诺唯赞
    '688117': '医药/核酸药物',           # 圣诺生物
    '600873': '食品/氨基酸',             # 梅花生物
    '688575': '医疗器械/体外诊断',       # 亚辉龙
    '688180': '医疗器械/血液净化',       # 君实生物
    '600276': '医药/中药',               # 恒瑞医药
    # ── 半导体 (5 家) ──
    '688045': '半导体/电源管理芯片',     # 必易微
    '301629': '半导体/探针台',           # 矽电股份
    '688110': '半导体/材料',             # 东芯科技
    '688234': '半导体/测试设备',         # 天岳先进
    '600460': '半导体/硅片',             # 士兰微
    # ── 输配电 / 电气 (7 家) ──
    '601096': '输配电/铁塔',             # 宏盛华源
    '601567': '电气/智能电表',           # 三星电气
    '603969': '输配电/预应力钢材',       # 银龙股份
    '688517': '输配电/避雷器',           # 金冠电气
    '002606': '输配电/绝缘子',           # 大连电瓷
    '300141': '电力/储能',               # 和顺电气
    '002857': '电气/电能表',             # 三晖电气
    # ── 电线电缆 (4 家) ──
    '920682': '电线电缆',                # 球冠电缆 (北交所)
    '001208': '电线电缆',                # 华菱线缆
    '002300': '电线电缆',                # 太阳电缆
    '603618': '电线电缆',                # 杭电股份
    # ── 通信 (4 家) ──
    '002560': '通信/射频',               # 通达股份
    '603887': '通信/IDC',                # 城地香江
    '603220': '通信/网络优化',           # 中贝通信
    '300047': '通信/IT服务',             # 天源迪科
    # ── 电力/能源 (3 家) ──
    '002090': '电力/智能电网',           # 金智科技
    '300201': '电力工程/高空作业车',     # 海伦哲
    '600157': '煤炭/电力',               # 永泰能源
    # ── 环保 (3 家) ──
    '605069': '环保/生态修复',           # 正和生态
    '000551': '环保/洁净',               # 创元科技
    '601330': '环保/垃圾发电',           # 绿色动力
    # ── 智能制造 / 工业 (6 家) ──
    '300378': '工业软件/ERP',            # 鼎捷数智
    '002376': '智能装备/打印终端',       # 新北洋
    '688367': '轨交信号',                # 工大高科
    '603915': '智能制造/工控',           # 凯众股份
    '600345': '通信/光模块',             # 长江通信
    '300188': 'IT服务/智慧政务',         # 国投智能
    # ── 家居 / 消费 (6 家) ──
    '002795': '卫浴/阀门',               # 永和智控
    '002853': '家居/橱柜',               # 皮阿诺
    '300616': '家居/定制',               # 尚品宅配
    '301498': '宠物食品',                # 乖宝宠物
    '002572': '家居/卫浴',               # 索菲亚
    '000860': '农业/白酒',               # 顺鑫农业
    # ── 金融 / 传媒 / 检测 (4 家) ──
    '000567': '金融/AMC',                # 海德股份
    '600959': '传媒/广电',               # 江苏有线
    '600770': '综合(新能源+芯片+彩票)',  # 综艺股份
    '300012': '检测认证',                # 华测检测
    # ── 其他制造业 (6 家) ──
    '000935': '建材/水泥',               # 四川双马
    '001337': '有色/黄金',               # 四川黄金
    '301063': '风电/锻件',               # 海锅股份
    '002373': '智慧交通',                # 千方科技
    '300465': 'IT服务/金融科技',         # 高伟达
    '603733': '造纸/特种纸',             # 仙鹤股份
    '002072': '纺织',                    # 凯瑞德
    '605138': '纺织/面料',               # 盛泰集团
    '002457': '建材/管道',               # 青龙管业
    '920964': '节水灌溉',                # 润农节水 (北交所)
    '600622': '房地产',                  # 光大嘉宝
    # v9.22: INDUSTRY_MAP 扩充第二批 (top 81~150, 70 家, 6/4~6/12 入榜标的中仍落 "其他" 的)
    # 数据源: 7 天 processed JSON 去重 524 家, v9.21 后仍 311 家落 "其他", 排名 81~150
    # ── ST/退市风险 (3 家) ──
    '300205': 'ST/退市风险',             # *ST天喻
    '600337': 'ST/退市风险',             # ST美克
    '603825': 'ST/退市风险',             # ST华扬
    # ── 母婴/家居/消费 (4 家) ──
    '301078': '母婴/连锁零售',           # 孩子王
    '603833': '家居/定制',               # 欧派家居
    '002511': '生活用纸',                # 中顺洁柔
    '301135': '家电/智能控制器',         # 瑞德智能
    # ── 工业/机械/材料 (10 家) ──
    '002438': '工业/阀门',               # 江苏神通
    '301529': '汽车/精密结构件',         # 福赛科技
    '301132': 'PCB',                     # 满坤科技
    '002571': '玻璃/器皿',               # 德力股份
    '001316': '航空/航材分销',           # 润贝航科
    '603163': '工程/洁净室',             # 圣晖集成
    '688257': '工业/硬质合金',           # 新锐股份
    '603150': '磁材/稀土永磁',           # 万朗磁塑
    '301381': '跨境电商',                # 赛维时代
    '301338': '工业/SMT设备',            # 凯格精机
    # ── 半导体/科技 (10 家) ──
    '688206': '半导体/EDA',              # 概伦电子
    '301589': '显示/控制卡',             # 诺瓦星云
    '300420': '机械/停车设备',           # 五洋自控
    '300209': '传媒/广告营销',           # 行云科技
    '688012': '半导体/刻蚀设备',         # 中微公司
    '002920': '汽车电子/智能座舱',       # 德赛西威
    '688627': '半导体/测试设备',         # 精智达
    '603324': '半导体/工艺废气',         # 盛剑科技
    '688478': '半导体/晶体生长设备',     # 晶升股份
    '688383': '半导体/固晶机',           # 新益昌
    # ── PCB/电子 (2 家) ──
    '002579': 'PCB',                     # 中京电子
    '002981': '电子/电声',               # 朝阳科技
    '001298': '电子/元器件分销',         # 好上好
    # ── 能源/材料/有色 (8 家) ──
    '300332': '天然气/清洁能源',         # 天壕能源
    '300001': '输配电/箱变',             # 特锐德
    '002334': '工控/变频器',             # 英威腾
    '601212': '有色/铅锌铜',             # 白银有色
    '000960': '有色/锡',                 # 锡业股份
    '002531': '风电/塔筒',               # 天顺风能
    '002080': '建材/玻纤',               # 中材科技
    '920195': '新材料/镁合金',           # 三祥科技 (北交所)
    '600961': '有色/铅锌',               # 株冶集团
    '603132': '有色/铅锌',               # 金徽股份
    # ── 医药/医疗 (6 家) ──
    '688317': '医疗器械/分子诊断',       # 之江生物
    '300453': '医疗器械/血液净化',       # 三鑫医疗
    '000590': '医药/中药',               # 古汉医药
    '603014': '医疗器械/血液净化',       # 威高血净
    '688289': '医疗器械/分子诊断',       # 圣湘生物
    '300601': '医药/疫苗',               # 康泰生物
    # ── 食品/农业 (3 家) ──
    '002626': '食品/营养品',             # 金达威
    '603363': '农业/畜牧',               # 傲农生物
    '605016': '食品/功能糖',             # 百龙创园
    # ── 化工/电池 (4 家) ──
    '301487': '化工/电池材料',           # 盟固利
    '688359': '化工/电子化学品',         # 三孚新科
    '603125': '化工/光刻胶单体',         # 常青科技
    '001283': '电池/镍氢',               # 豪鹏科技
    # ── 军工 (2 家) ──
    '301357': '军工/特种车',             # 北方长龙
    '000801': '军工/雷达',               # 四川九洲
    '600654': '安防/智能建筑',           # 中安科
    # ── 软件/通信/AI (4 家) ──
    '603039': '软件/协同OA',             # 泛微网络
    '688207': 'AI/计算机视觉',           # 格灵深瞳
    '688521': '芯片IP',                  # 芯原股份
    '300250': '通信/SDN',                # 初灵信息
    '300800': '环保/检测',               # 力合科技
    '002338': '光电/光学元件',           # 奥普光电
    # ── 汽车/其他 (3 家) ──
    '605128': '汽车/座椅骨架',           # 上海沿浦
    '603197': '汽车/TPMS',               # 保隆科技
    '688656': '医疗器械/诊断试剂',       # 浩欧博
    # ── 房地产/能源/港口 (3 家) ──
    '000514': '房地产/区域开发',         # 渝开发
    '600310': '电力/水电',               # 广西能源
    '601022': '港口/航运',               # 宁波远洋
    # ── 电力/电源 (1 家) ──
    '300713': '电力/电源',               # 英可瑞
    # v9.23: INDUSTRY_MAP 扩充第三批 (top 151~250, 100 家, v9.22 后仍落 "其他" 的)
    # 数据源: 7 天去重 524 家, v9.22 后 251 家落 "其他", 排名 151~250
    # ── ST/退市风险 (10 家) ──
    '000010': 'ST/退市风险',             # *ST美丽
    '000677': 'ST/退市风险',             # ST海龙
    '601718': 'ST/退市风险',             # ST际华
    '002082': 'ST/退市风险',             # ST万邦
    '000056': 'ST/退市风险',             # *ST皇庭
    '002581': 'ST/退市风险',             # *ST未名
    '600745': 'ST/退市风险',             # *ST闻泰
    '000792': 'ST/退市风险',             # *ST盐湖
    '600191': 'ST/退市风险',             # *ST华资
    '002077': 'ST/退市风险',             # ST大港
    # ── 化工/材料/能源 (15 家) ──
    '002493': '石化/炼化',               # 荣盛石化
    '603215': '家电/小家电',             # 比依股份
    '300827': '电力/光伏逆变器',         # 上能电气
    '003038': '光伏/铝边框',             # 鑫铂股份
    '002972': '轨交/信号',               # 科安达
    '002225': '耐火材料',                # 濮耐股份
    '002381': '橡胶/输送带',             # 双箭股份
    '002006': '光伏/支架',               # 精工科技
    '603020': '化工/食品配料',           # 爱普股份
    '688299': '新能源/BOPA膜',           # 长阳科技
    '300174': '化工/活性炭',             # 元力股份
    '300207': '电池/锂电PACK',           # 欣旺达
    '002079': '半导体/二极管',           # 苏州固锝
    '002409': '半导体/光刻胶',           # 雅克科技
    '600595': '铝/电解铝',               # 中孚实业
    # ── 医药/医疗 (10 家) ──
    '688428': '医药/创新药',             # 诺诚健华
    '688389': '医疗器械/治疗',           # 普门科技
    '002864': '医药/中药',               # 盘龙药业
    '688382': '医药/创新药',             # 益方生物
    '301220': '化工/香料',               # 亚香股份
    '300639': '医疗器械/分子诊断',       # 凯普生物
    '300701': '传感器/气体',             # 森霸传感
    '301335': '宠物食品',                # 天元宠物
    '300576': 'PCB/感光油墨',            # 容大感光
    '002947': '精密结构件',              # 恒铭达
    '600285': '医药/中药',               # 羚锐制药
    '301228': '检测认证',                # 实朴检测
    # ── 半导体/电子 (10 家) ──
    '301282': 'PCB',                     # 金禄电子
    '002993': '电子/充电器',             # 奥海科技
    '002291': '传媒/短视频',             # 遥望科技
    '603256': '电子/玻纤布',             # 宏和科技
    '688295': '新材料/碳纤维',           # 中复神鹰
    '688602': '新材料/电子化学品',       # 康鹏科技
    '301577': '电子/磁性元件',           # 美信科技
    '002552': '船舶/铸件',               # 宝鼎科技
    '000970': '稀土永磁',                # 中科三环
    '603186': '新材料/复合材料',         # 华正新材
    '002951': '包装/印刷',               # 金时科技
    '600178': '汽车/发动机',             # 东安动力
    '002119': '半导体/引线框架',         # 康强电子
    '600353': '电子/真空器件',           # 旭光电子
    '300706': '半导体/靶材',             # 阿石创
    '300666': '半导体/靶材',             # 江丰电子
    '688020': '电子/电磁屏蔽膜',         # 方邦股份
    '688141': '半导体/电源管理芯片',     # 杰华特
    '688589': '芯片/通信',               # 力合微
    '688325': '半导体/电池管理',         # 赛微微电
    # ── 制造/机械/能源 (10 家) ──
    '603179': '汽车/内外饰',             # 新泉股份
    '601619': '电力/风电运营',           # 嘉泽新能
    '301179': '电力/智能电网',           # 泽宇智能
    '002843': '机械/锯切',               # 泰嘉股份
    '300904': '机械/风电减速器',         # 威力传动
    '002398': '建材/外加剂',             # 垒知集团
    '603817': '环保/水务',               # 海峡环保
    '301149': '化工/PBAT',               # 隆华新材
    '001696': '机械/发动机',             # 宗申动力
    '301630': '新材料/PCB上游',          # 同宇新材
    '600186': '食品/味精',               # 莲花控股
    '603773': '光电/玻璃',               # 沃格光电
    '001360': '机械/破碎设备',           # 南矿集团
    '600280': '零售/百货',               # 中央商场
    '603155': '化工/有机硅',             # 新亚强
    '603477': '农业/生猪',               # 巨星农牧
    '000968': '能源/煤气层',             # 蓝焰控股
    '002165': '化工/聚醚',               # 红宝丽
    # ── 家电/物流/AI/传感 (8 家) ──
    '002362': 'AI/OCR',                  # 汉王科技
    '603225': '化工/涤纶长丝',           # 新凤鸣
    '603303': '家电/LED照明',            # 得邦照明
    '605222': '电线电缆',                # 起帆电缆
    '603083': '通信/光模块',             # 剑桥科技
    '301339': '交通/ETC',                # 通行宝
    '688600': '检测/仪器仪表',           # 皖仪科技
    '301001': '电商/代运营',             # 凯淳股份
    '300681': '新能源/电控',             # 英搏尔
    '300264': '传媒/视频',               # 佳创视讯
    # ── 传媒/其他 (6 家) ──
    '000725': '面板/显示',               # 京东方A
    '300097': '机械/智能装备',           # 智云股份
    '688550': '化工/液晶材料',           # 瑞联新材
    '300133': '传媒/影视',               # 华策影视
    '601686': '建材/钢管',               # 友发集团
    '000620': '房地产/区域',             # 盈新发展
    '300200': '化工/胶粘剂',             # 高盟新材
    '603655': '精密/密封件',             # 朗博科技
    '000910': '家居/木地板',             # 大亚圣象
    '600665': '房地产',                  # 天地源
    '001229': '电子/AV设备',             # 魅视科技
    '300576': 'PCB/感光油墨',            # 容大感光 (重复)
    '000966': '电力/火电',               # 长源电力
    '688530': '新材料/稀土抛光',         # 欧莱新材
    '603650': '化工/橡胶助剂',           # 彤程新材
    '688448': '机械/磁悬浮',             # 磁谷科技
    '688689': '半导体/分立器件',         # 银河微电
    '603616': '建材/管道',               # 韩建河山
    # v9.14 补充: 63 家近期入榜但缺失行业的公司
    # 建材/水泥
    '000401': '建材/水泥',               # 金隅冀东
    # 工程机械
    '000528': '工程机械',               # 柳工
    # 汽车零部件
    '000757': '汽车零部件',             # 浩物股份
    # ST/退市风险
    '002024': 'ST/退市风险',            # ST易购
    '002667': 'ST/退市风险',            # ST威领
    # 造纸
    '002078': '造纸',                   # 太阳纸业
    # 医疗器械
    '002223': '医疗器械/家用医疗器械',  # 鱼跃医疗
    # 锂电
    '002245': '锂电/锂电池',           # 蔚蓝锂芯
    # 医药
    '002332': '医药/甾体激素',          # 仙琚制药
    '002393': '医药/化学药',            # 力生制药
    '002940': '医药/化学药',            # 昂利康
    '300406': '医药/体外诊断',          # 九强生物
    '300702': '医药/原料药',            # 天宇股份
    '603590': '医药/化学药',            # 康辰药业
    '688166': '医药/化学药',            # 博瑞医药
    '688513': '医药/化学药',            # 苑东生物
    '688767': '医药/生物试剂',          # 博拓生物
    # 化工
    '002388': '化工/电子化学品',        # 新亚制程
    '002637': '化工/表面活性剂',        # 赞宇科技
    '688669': '化工/高分子材料',        # 聚石化学
    # CDMO
    '300363': '医药/CDMO',             # 博腾股份
    # 通信
    '002929': '通信/通信工程',          # 润建股份
    # 物流
    '002930': '物流/石化仓储',          # 宏川智慧
    # 塑料
    '003018': '塑料/包装',              # 金富科技
    # 环保
    '300334': '环保/膜技术',            # 津膜科技
    '603568': '环保/垃圾发电',          # 伟明环保
    # 仪表
    '300371': '仪表/超声水表',          # 汇中股份
    # 电子/PCB
    '300476': '电子/PCB',              # 胜宏科技
    '603228': '电子/PCB',              # 景旺电子
    '603175': '电子/覆铜板',            # 超颖电子
    '688183': '电子/覆铜板',            # 生益电子
    # 软件/IT
    '300525': '软件/政务信息化',        # 博思软件
    '301236': 'IT服务/软件外包',        # 软通动力
    # 精密制造
    '300709': '精密制造/MIM',           # 精研科技
    '300988': '精密制造/连接器',        # 津荣天宇
    '301210': '精密制造/弹簧',          # 金杨精密
    '301568': '电子/检测设备',          # 思泰克
    '301319': '电子/助焊剂',            # 唯特偶
    # 安防
    '301042': '安防/视频监控',          # 安联锐视
    # 阀门
    '301151': '阀门/节能阀门',          # 冠龙节能
    # 汽车电子
    '301221': '汽车电子/智能座舱',      # 光庭信息
    # 数字创意
    '301313': '传媒/数字展厅',          # 凡拓数创
    # 铜加工
    '600255': '有色/铜加工',            # 鑫科材料
    # 房地产
    '600376': '房地产',                 # 首开股份
    # 钢结构
    '600496': '建筑/钢结构',            # 精工钢构
    # 化纤
    '600810': '化工/化纤',              # 神马股份
    # 新能源
    '600821': '新能源/光伏发电',        # 金开新能
    # 调味品
    '600872': '食品/调味品',            # 中炬高新
    # 包装
    '603058': '包装/烟标',              # 永吉股份
    # 口腔护理
    '603059': '日化/口腔护理',          # 倍加洁
    # 小家电
    '603277': '家电/商用冷柜',          # 银都股份
    # 叉车
    '603298': '机械/叉车',              # 杭叉集团
    # 新材料
    '603681': '新材料/胶带',            # 永冠新材
    # 电气设备
    '603861': '电气/配电设备',          # 白云电器
    '605066': '电气/低压电器',          # 天正电气
    # 乳制品
    '605337': '食品/乳制品',            # 李子园
    # 激光设备
    '688092': '设备/激光加工',          # 爱科科技
    # 生物医药设备
    '688114': '医疗器械/基因测序',      # 华大智造
    # 网络
    '688292': '通信/网络可视化',        # 浩瀚深度
    # 新材料
    '920438': '新材料/光学玻璃',        # 戈碧迦
    '002653': '医药/化学药',            # 海思科
    '603210': '汽车零部件',             # 泰鸿万立
    '688708': '军工/隐身材料',          # 佳驰科技
    # ── v9.27 扩充 (2026-06-12 其他 = 19/94=20.2% → 压到 4/94=4.3%) ──
    # 汽车制动
    '001285': '汽车/制动系统',            # 瑞立科密
    # LED / 化合物半导体
    '600703': '半导体/LED',                # 三安光电
    # ST / 退市
    '300716': 'ST/退市风险',               # ST泉为
    '002514': 'ST/退市风险',               # ST宝馨
    '002055': 'ST/退市风险',               # ST得润
    '603813': 'ST/退市风险',               # ST原尚
    # 烟标
    '002191': '包装/烟标',                 # 劲嘉股份
    # 汽车零部件
    '603202': '汽车零部件',                # 天有为 (点火线圈)
    # 高分子材料
    '002838': '化工/高分子材料',           # 道恩股份
    # 家居
    '603180': '家居/定制',                 # 金牌家居
    # 园林
    '301098': '环保/园林工程',             # 金埔园林
    # 矿业
    '001203': '矿业/铁矿',                 # 大中矿业
    # 广电
    '600831': '传媒/广电',                 # 广电网络
    # 连接器
    '002937': '电子/连接器',               # 兴瑞科技
    # 航空维修
    '300424': '军工/航空维修',             # 航新科技
    # 电池结构件
    '002850': '锂电/电池结构件',           # 科达利
    # 家禽
    '002982': '农业/家禽',                 # 湘佳股份
    # 电子纸带
    '002859': '电子/纸带',                 # 洁美科技
    # PCB
    '000823': 'PCB/电子',                  # 超声电子
    # ── v9.27.1 扩充 (6/11 补 11 家) ──
    # ST / 退市
    '600107': 'ST/退市风险',                # ST尔雅
    '002726': 'ST/退市风险',                # ST龙大
    '600370': 'ST/退市风险',                # ST三房
    '300237': 'ST/退市风险',                # ST美晨
    '002634': 'ST/退市风险',                # ST棒杰
    # 玩具
    '002575': '轻工/玩具',                  # 群兴玩具
    # 散热
    '301626': '电子/散热',                  # 苏州天脉
    # 光伏
    '603105': '新能源/光伏',                # 芯能科技
    # 化工 / 聚酰胺
    '605166': '化工/聚酰胺',                # 聚合顺
    # 医药连锁
    '603233': '医药/连锁药店',              # 大参林
    # 医药 / CDMO
    '688131': '医药/CDMO',                  # 皓元医药
}


# v9.13: 公司基础数据 (静态表) — 用于 主动算 增持比例 + 收入贡献比例
# 数据来源: 2024 年报披露 (cninfo 公开); 单位: 万元
# 用途:
#   - TOTAL_SHARES: 增持类算 增持股数/总股本 比例
#   - COMPANY_REVENUE: 合同类算 合同金额/年营收 比例, 决定 +5/+3/+2 档
# 新增标的: 跑批发现缺数据时, 补这里 (跟 INDUSTRY_MAP 一样是 single source of truth)
COMPANY_REVENUE: Dict[str, float] = {
    # 单位: 万元 (2024 年报披露)
    '001299': 90_700,        # 美能能源
    '002517': 510_000,       # 恺英网络
    '688297': 65_000,        # 中无人机
    '002607': 306_000,       # 中公教育
    '600763': 304_000,       # 通策医疗
    '600509': 870_000,       # 天富能源
    '603987': 220_000,       # 康德莱
    '600239': 114_000,       # ST云城
    '002597': 536_000,       # 金禾实业
    '601800': 70_620_000,    # 中国交建
    '688167': 58_500,        # 炬光科技
    '603606': 800_000,       # 东方电缆
    '600664': 145_000,       # 哈药股份
    '600248': 1_640_000,     # 陕建股份
    '002350': 200_000,       # 北京科锐
    '688091': 21_000,        # 上海谊众
    '600332': 760_000,       # 白云山
    '600587': 100_000,       # 新华医疗
    '600129': 1_300_000,     # 太极集团
    '688198': 35_000,        # 佰仁医疗
    '600567': 2_700_000,     # 山鹰国际
    '002758': 4_500_000,     # 浙农股份
    '603118': 1_050_000,     # 共进股份
    '688472': 4_200_000,     # 阿特斯
    '002120': 4_500_000,     # 韵达股份
    '605288': 130_000,       # 凯迪股份
    '688239': 110_000,       # 航宇科技
    '688082': 380_000,       # 盛美上海
    '300738': 65_000,        # 奥飞数据
    '301369': 35_000,        # 联动科技
    '002918': 600_000,       # 蒙娜丽莎
    '688271': 1_100_000,     # 联影医疗
    '603893': 320_000,       # 瑞芯微
    '600141': 2_500_000,     # 兴发集团
    '600021': 4_200_000,     # 上海电力
    '002605': 580_000,       # 姚记科技
    '002148': 80_000,        # 北纬科技
    '603207': 38_000,        # 小方制药
    '603087': 280_000,       # 甘李药业
}

TOTAL_SHARES: Dict[str, int] = {
    # 单位: 股 (2024 年报披露; 总股本)
    '001299': 314_336_876,    # 美能能源 (反推: 34,011,250 / 10.82%)
    '002517': 2_136_443_234,  # 恺英网络
    '688297': 670_000_000,    # 中无人机
    '002607': 4_000_000_000,  # 中公教育
    '600763': 449_500_000,    # 通策医疗
    '600509': 1_150_000_000,  # 天富能源
    '603987': 590_000_000,    # 康德莱
    '600239': 1_500_000_000,  # ST云城
    '002597': 570_000_000,    # 金禾实业
    '601800': 16_200_000_000, # 中国交建
    '688167': 90_000_000,     # 炬光科技
    '600332': 1_630_000_000,  # 白云山
    '603606': 690_000_000,    # 东方电缆
}




def infer_industry(name: str, code: str = '') -> str:
    # 优先用代码精确表
    if code and code in INDUSTRY_MAP:
        return INDUSTRY_MAP[code]
    # 兜底: 公司名关键词正则
    for ind, patterns in INDUSTRY_HINTS.items():
        for p in patterns:
            if re.search(p, name):
                return ind
    return '其他'


# ============================================================
# v9.32.1: watchlist 加载 (申万一级行业 + 留观股过滤)
# ============================================================
_WATCHLIST_CODES = set()
_WATCHLIST_INDUSTRY = {}
_WATCHLIST_LOADED = False


def _load_watchlist(path: str = 'watchlist.json') -> None:
    # 读 watchlist.json -> _WATCHLIST_CODES / _WATCHLIST_INDUSTRY
    # 失败兜底: 文件不存在或 JSON 损坏 -> 留空 (跑批全过, 行为退回 v9.32 之前)
    global _WATCHLIST_LOADED
    if _WATCHLIST_LOADED:
        return
    _WATCHLIST_LOADED = True
    p = Path(path)
    if not p.exists():
        return
    try:
        with open(p, 'r', encoding='utf-8') as f:
            wl = json.load(f)
    except (OSError, json.JSONDecodeError):
        return
    # v2 (Wind 热门概念指数) 用 concept_groups, v1 (申万 YTD top 15) 用 ytd_top_15
    # 任一格式都支持, 自动检测
    groups_v2 = wl.get('concept_groups')
    if groups_v2:
        for grp in groups_v2 or []:
            grp_name = (grp.get('concept_name') or grp.get('industry_name') or '').strip()
            if not grp_name:
                continue
            for s in grp.get('stocks', []) or []:
                code = str(s.get('code', '')).strip()
                if not code:
                    continue
                _WATCHLIST_CODES.add(code)
                # multi-concept: 同一 code 在多个概念里, 用 ; 拼接
                prev = _WATCHLIST_INDUSTRY.get(code, '')
                if grp_name not in prev.split(';'):
                    _WATCHLIST_INDUSTRY[code] = (prev + ';' + grp_name).lstrip(';')
    else:
        for ind in wl.get('ytd_top_15', []) or []:
            ind_name = ind.get('industry_name', '').strip()
            if not ind_name:
                continue
            for s in ind.get('stocks', []) or []:
                code = str(s.get('code', '')).strip()
                if code:
                    _WATCHLIST_CODES.add(code)
                    _WATCHLIST_INDUSTRY[code] = ind_name


# ============================================================
# 4. 单条公告打分 (含排除分支)
# ============================================================
def analyze_title(title: str, company: str = "") -> Tuple[int, List[Tuple[str, int]], List[str]]:
    """单条公告打分(v3 修复版:不减持/激励回购 排除分支)
    company 参数 (v9.16b): is_st_buyback 检测合并 title+company,
    让 *ST国中/*ST明德 等公司名前缀 ST 走排除分支
    """
    score = 0
    hits: List[Tuple[str, int]] = []
    cats: List[str] = []

    is_no_sell = bool(re.search(
        r'自愿.*不减持|承诺.*不减持|承诺.*锁定|自愿锁定|不减持承诺|未减持|提前终止.*减持计划|终止.*减持计划',
        title,
    ))
    is_incentive_buyback = bool(re.search(r'股权激励|限制性股票|股票期权|员工持股计划', title))
    # 排除分支 (v3.1): 持有人会议只是程序性步骤, 不是真落地, 不算利好
    is_holder_meeting = bool(re.search(r'持有人会议', title))
    # 排除分支 (v9.16b): ST/退市风险公司公告回购 → "自救"信号, 不计利好
    # 检测合并 title+company, 让 *ST国中/*ST明德 等公司名前缀 ST 也能触发
    is_st_buyback = bool(
        re.search(r'ST|退市风险|被实施.*ST|实施ST|被ST', title + ' ' + company)
    ) and bool(
        re.search(r'回购报告书|集中竞价.*回购|首次回购|以集中竞价方式回购|回购方案|回购股份', title)
    )
    # 排除分支: 限制性股票/股权激励的合规披露 (内幕信息知情人/注销/调整价格)
    # 不构成利好, pattern 层无法用负向预查 (被 ; → | 替换破坏), 故在 code 层排除
    is_procedural_incentive = bool(
        re.search(r'限制性股票|股票期权|股权激励', title)
    ) and bool(
        re.search(r'内幕信息知情人|注销.*期权|注销.*股票|调整.*授予价格|调整.*价格|调整.*数量|调整.*相关事项', title)
    )
    # v9.28: 扩展激励执行/程序类 (解锁条件成就/登记完成/激励对象名单/名单公示/自查表)
    is_procedural_incentive_v2 = _v9_28_incentive_procedural_v2(title)
    # v9.28: 律师事务所专项核查意见 中性化
    is_lawyer_special_audit = _v9_28_lawyer_special_audit(title)
    # v9.28: ST 撤销部分 中性化
    is_st_partial_revoke = _v9_28_st_partial_revoke(title)
    # v9.29: ST 撤销全撤 (摘帽/摘星) 中性化
    is_st_full_revoke = _v9_29_st_full_revoke(title)
    # v9.30: 激励严格化 (铁律) — 仅 草案/正式发布 算利好
    is_incentive_strict = _v9_30_incentive_strict(title)
    # v9.30: 增持后续披露 (铁律) — 进展/完成/结果 = 中性
    is_increase_progress = _v9_30_increase_progress(title)
    # v9.30: 注销减资 (铁律) — 换中性
    is_capital_reduction = _v9_30_capital_reduction(title)
    # v9.30: 日常经营合同 (铁律) — 覆盖 中标/重大合同 +7, 中性
    is_daily_contract = _v9_30_daily_contract(title)

    # v9.25: 减持/增持 双计分 bug 修复
    # 同一公告可能同时命中"5%股东.*减持.*结果" + "股东减持.*结果" + "5%以上股东.*减持.*%比例"等
    # 旧逻辑把它们全加起来 (-2 + -5 + -7 = -14), 重复扣分
    # 修复: 第一遍只收集, 第二遍 dedup 按 |score| 取最大
    reduce_hits: List[Tuple[str, int]] = []  # 减持类待 dedup
    increase_hits: List[Tuple[str, int]] = []  # 增持类待 dedup
    other_hits: List[Tuple[str, int]] = []  # 其他信号正常累加
    for pat, w, label in SIGNALS:
        if not re.search(pat, title):
            continue
        if is_no_sell and ('减持' in label or '股东减持' in label):
            score += 3
            hits.append(('自愿不减持', 3))
            cats.append('自愿不减持')
            continue
        if is_incentive_buyback and label == '股份回购':
            hits.append((label + '(激励类)', 0))
            continue
        if is_st_buyback and label == '股份回购':
            hits.append((label + '(ST自救)', 0))
            continue
        if is_procedural_incentive and label == '限制性股票激励计划':
            hits.append((label + '(程序性)', 0))
            continue
        # v9.28: 扩展激励执行/程序类 (解锁条件成就/登记完成/激励对象名单/名单公示/自查表)
        if is_procedural_incentive_v2 and label == '限制性股票激励计划':
            hits.append((label + '(执行/程序类v28)', 0))
            continue
        # v9.28: 律师事务所专项核查意见 — 不应触发增持类信号 (走中性)
        if is_lawyer_special_audit and '增持' in label:
            hits.append((label + '(律师核查v28)', 0))
            continue
        # v9.28: ST 撤销部分 → 中性化 (不触发 -7 ST 风险警示)
        if is_st_partial_revoke and ('ST' in label or '退市' in label):
            hits.append((label + '(撤销部分v28)', 0))
            continue
        # v9.29: ST 撤销全撤 → 中性化 (摘帽/摘星, 不触发 -7 ST 风险警示 + -10 退市风险)
        if is_st_full_revoke and ('ST' in label or '退市' in label):
            hits.append((label + '(撤销全v29)', 0))
            continue
        # v9.30: 激励严格化 → 中性化 (任何非 草案/正式发布 状态)
        if is_incentive_strict and label == '限制性股票激励计划':
            hits.append((label + '(v930严格)', 0))
            continue
        # v9.30: 增持后续披露 → 中性化 (进展/完成/结果)
        if is_increase_progress and ('增持' in label or '大股东' in label):
            hits.append((label + '(v930进展)', 0))
            continue
        # v9.30: 注销减资 → 中性化 (覆盖 股份回购 等)
        if is_capital_reduction and label in ('股份回购',):
            hits.append((label + '(v930减资)', 0))
            continue
        # v9.30: 日常经营合同 → 中性化 (覆盖 中标/重大合同 +7)
        if is_daily_contract and ('中标' in label or '重大合同' in label):
            hits.append((label + '(v930日常)', 0))
            continue
        # 减持/增持 分类: 涉及"减持"/"增持" 关键字的信号, 后续 dedup
        if '减持' in label:
            reduce_hits.append((label, w))
        elif '增持' in label:
            increase_hits.append((label, w))
        else:
            other_hits.append((label, w))
    # 减持 dedup: 按 |score| 取最大, 不重复计分
    if reduce_hits:
        best_reduce = max(reduce_hits, key=lambda x: abs(x[1]))
        score += best_reduce[1]
        hits.append(best_reduce)
        cats.append(best_reduce[0])
    # 增持 dedup: 同理
    if increase_hits:
        best_increase = max(increase_hits, key=lambda x: abs(x[1]))
        score += best_increase[1]
        hits.append(best_increase)
        cats.append(best_increase[0])
    # 其他信号: 正常累加 (无重复风险)
    for label, w in other_hits:
        score += w
        hits.append((label, w))
        cats.append(label)

    return score, hits, cats


# ============================================================
# 5. TOP5 判断逻辑生成
# ============================================================
def derive_logic(item: Dict[str, Any]) -> str:
    """
    生成 TOP5 判断逻辑(含每信号分数 + 评分构成)

    格式: "匹配 spec「<label>」(<score>): <判断>;;...;;评分构成: +10+7+5 = +22"
    """
    sigs = item.get("best_signals") or item.get("signals", [])
    sigs_sorted = sorted(sigs, key=lambda x: -abs(x[1]))

    parts = []
    used_labels = set()
    score_breakdown = []

    # 不去重: 同一个 label 在 sigs 里出现几次, 分数就累加几次 (例: 国投智能 3 个自愿不减持 → +3+3+3 = +9)
    for label, score in sigs_sorted:
        if score != 0:
            score_breakdown.append(f"{score:+d}")
        template = LOGIC_TEMPLATES.get(label)
        if not template:
            # 分数累加了但没模板, 跳过后续模板拼接
            continue
        # 首段只显示一次, 后续重复的同 label 只作为附注不重复前缀
        is_first_of_label = label not in used_labels
        if is_first_of_label:
            used_labels.add(label)
        if not template:
            continue
        chunks = [c.strip() for c in template.split(";;") if c.strip()]
        if not chunks:
            continue
        first = f"匹配 spec「{label}」({score:+d}): {chunks[0]}"
        parts.append(first)
        for extra in chunks[1:]:
            parts.append(extra)

    if not parts:
        sig_labels = {s[0] for s in sigs}
        if "自愿不减持" in sig_labels:
            tpl = LOGIC_TEMPLATES.get("自愿不减持", "5% 以上股东及董监高不减持承诺,锁仓减少抛压。")
            return f"匹配 spec「自愿不减持」(+3): {tpl}。评分构成: +3 = +3"
        return "未匹配到明确的强弱信号,默认按中性处理。"

    if score_breakdown:
        total = sum(int(s) for s in score_breakdown)
        breakdown_str = f"评分构成: {' + '.join(score_breakdown)} = {total:+d}"
        # 用 "。" 句号分隔, 阅读更顺畅, 避免 ; 出现在句子中间造成割裂
        return "; ".join(parts) + "。" + breakdown_str
    return "; ".join(parts) + "。"
def derive_conclusion(item: Dict[str, Any]) -> str:
    sigs = {s[0] for s in (item.get('best_signals') or item.get('signals', []))}
    score = item.get('best_score', item.get('score', 0))
    if score >= 7:  return "高强度利好"
    if score >= 4:  return "中等利好"
    if score >= 1:  return "弱利好"
    if score <= -7: return "高强度利空"
    if score <= -4: return "中等利空"
    if score <= -1: return "弱利空"
    return "中性"


# ============================================================
# 6. 主流程
# ============================================================



# ============================================================
# 7. 关键数字提取(去公告 PDF 原文找)
# ============================================================
def _classify_announcement(title: str, signals: List[Tuple[str, int]]) -> str:
    """
    给公告打"业务类型"标签, 用于决定抓哪些字段。
    比 spec 的"信号"更细, 专门用于 best_facts 抓数。
    """
    # v9.26: 拆分 ST 风险警示 / 重整 / 退市 三种, 避免 ST 风险警示 -7 错套"退市整理期"模板
    # 旧逻辑: "退市" in s[0] or "ST" in s[0] → 退市 (太宽, 把 ST 风险警示 / ST 板块重整 都当退市)
    # 新逻辑: 仅"退市" word 才走退市; ST 风险警示 走 ST; 重整 类 (含 ST 板块重整 / 控股股东破产重整) 走 重整
    if any("退市" in s[0] for s in signals):  # 仅 退市/ST 风险 -10 含 "退市" word
        return "退市"
    # v9.39: 业绩预告 独立类型 (老板 6/23 拍, 一句话模板要 "公司公告半年度业绩预告, 预计净利润 X~Y 万元, 同比增长 +Z%")
    if any("业绩预告" in s[0] for s in signals):  # 业绩预告涨幅>20% / 业绩预告跌幅
        return "业绩预告"
    # v9.39: 重组完成/上市 独立类型
    if any("重组" in s[0] for s in signals):  # 重组完成/上市
        return "重组"
    # v9.39: 限制性股票激励 独立类型
    if any("限制性股票" in s[0] for s in signals):  # 限制性股票激励计划
        return "激励"
    # v10.2: 定增募投扩产需要单独展示募投/稀释/定价事实，不套普通扩产模板。
    if is_canonical_placement_plan(title):
        return "定增"
    if any("新建产能" in s[0] or "扩产" in s[0] for s in signals):
        return "扩产"
    if any(s[0] == "ST 风险警示" for s in signals):  # ST 风险警示 -7 严格匹配, 不误伤 ST 板块重整
        return "ST"
    if any("重整" in s[0] for s in signals):  # ST 板块重整 -10 / 控股股东破产重整 -10
        return "重整"
    if any("监管处罚" in s[0] for s in signals):
        return "处罚"
    if any("立案调查" in s[0] for s in signals):
        return "立案"
    if any("股东减持" in s[0] or "≥2% 大股东减持" in s[0] for s in signals):
        return "减持"
    if any("大股东大额增持" in s[0] for s in signals):
        return "增持"
    if any("股份回购" in s[0] for s in signals):
        return "回购"
    if any("中标" in s[0] or "重大合同" in s[0] for s in signals):
        return "合同"
    if any("员工持股" in s[0] for s in signals):
        return "员工持股"
    if any("新药" in s[0] or "专利" in s[0] or "资质" in s[0] for s in signals):
        return "新药"
    if any("战略合作" in s[0] for s in signals):
        return "战略"
    return "其他"


def _fmt_money(v: str) -> str:
    """1.5亿元 / 7,345万元 加空格"""
    m = re.match(r"^([0-9][0-9,.]*)([一-龥]+)$", v)
    return m.group(1) + " " + m.group(2) if m else v


# 通用金额正则: 元 / 万元 / 亿元 / 万美元 / 美元
_MONEY_RE = r"[0-9][0-9,.]+\s*(?:万|亿)?(?:元|美元|港币)"


# 标题级限定词: PDF 抓不到数字时, 标题本身的"预中标/草案/提示性"也是关键信息
_TITLE_QUALIFIERS = [
    # (regex, 显示文字)
    (r"预中标|拟中标",          "状态: 预中标（非正式合同, 存在不确定性）"),
    (r"草案|预案",              "状态: 草案阶段（尚未经股东大会审议）"),
    (r"提示性公告|提示公告",     "状态: 提示性公告（具体细节以后续公告为准）"),
    (r"意向|框架协议|战略合作",  "状态: 意向/框架协议（不具备强制约束力）"),
    (r"拟?减持",                "状态: 计划减持（尚未实际减持）"),
    (r"拟?增持",                "状态: 计划增持（尚未实际增持）"),
    (r"首次公开发行|IPO",       "状态: 上市公告"),
    (r"回购.*用于注销|注销.*回购", "用途: 注销减资（利好权重更高）"),
    (r"回购.*用于股权激励|股权激励.*回购", "用途: 股权激励配套（中性化处理）"),
]


def _extract_title_qualifiers(title: str) -> List[str]:
    """从标题提取限定信息, 喂给 PDF 抓不到时的 fallback 显示"""
    out: List[str] = []
    for pat, label in _TITLE_QUALIFIERS:
        if re.search(pat, title):
            out.append(label)
    return out


def _build_one_liner(title: str, facts: List[str], ann_type: str, signals: List[Tuple[str, int]] = None, is_price_upgraded: str = None, company_name: str = '') -> str:
    """
    业务类型驱动的一句话概括: 完整中文短句, 主谓宾齐全, ≤60 字。

    策略: 按 ann_type 选句子模板, 从 facts 提取的字段顺序填入占位符, 缺位自动跳过。

    输出示例:
      公告预中标重大合同, 公示期 3 日, 预计占 2025 年营收 4.86%。 (具体细节以后续公告为准)
      披露重大合同进展, 合同金额 623.22 万美元, 单船 89000 载重吨。
      控股股东及董高计划增持公司股份, 金额不低于 4500 万元。
      员工持股计划召开第一次持有人会议, 正式落地。
      5% 以上股东减持公司股份 1,099,940 股, 占总股本 9.33%。
      股票进入退市整理期, 共 15 个交易日。
      收到证监会《行政处罚事先告知书》, 涉嫌信息披露违规。

    v9.39 (老板 6/23 拍, 老板原话: "一句话靠阔这一部份, 你应该写一个完整的句子, 主谓宾都要有"):
    - 兜底 else 分支必须带主语 (公司名), 不再出"草案阶段xx元xx%"这种看不懂的片段
    - 新增 业绩预告 / 重组 / 激励 / 回购 四个业务类型模板
    """
    if not facts and not signals:
        return ""

    # ===== 1. 把 facts 解析成命名空间 (status/progress/nums/subject/...) =====
    F = {
        "status": "",          # 状态标签 (如: 预中标/计划减持/退市/事先告知书)
        "progress": "",        # 进度词 (如: 持有人会议/届满/完成)
        "subject": "",         # 主体 (如: 5% 以上股东/控股股东)
        "amount": "",          # 金额 (如: 4500 万元)
        "shares": "",          # 股数 (如: 1,099,940 股)
        "ratio": "",           # 比例 (如: 9.33%)
        "extra": "",           # 杂项 (单船 89000 载重吨 / 公示期 3 日 / 期限 15 个交易日)
        "regulator": "",       # 监管机关 (证监会)
        "violation": "",       # 违规类型 (信息披露)
        "hint": "",            # 尾部提示
    }

    def _strip_prefix(s: str) -> str:
        return re.sub(
            r"^(合同金额|总金额|金额|总投资|投资金额|项目投资|产能|年产|建设期|分期|标的|单船|公示期|合同期|退市整理期|增持金额|回购金额|回购价|回购股数|已减持|拟减持|计划上限|占总股本|占股本|占\s*2025\s*营收|比例)\s*[:≥≤≈]?\s*",
            "", s).strip()

    for f in facts or []:
        if f.startswith("违规类型:"):
            F["violation"] = f.split(":", 1)[1].strip()
        elif f.startswith("监管机关:"):
            F["regulator"] = f.split(":", 1)[1].strip()
        elif f.startswith(("减持人:", "增持主体:", "客户:", "合作方:")):
            if not F["subject"]:
                sub = f.split(":", 1)[1].strip()
                # 去掉"关于/拟/将"等无意义前缀
                sub = re.sub(r"^(关于|拟|将|拟将)\s*", "", sub)
                F["subject"] = sub
        elif f.startswith("状态:"):
            short = f.split(":", 1)[1].split("（")[0].strip()
            if short == "提示性公告":
                F["hint"] = "具体细节以后续公告为准"
            elif not F["status"]:
                F["status"] = short
        elif f.startswith(("用途:", "类型:")):
            short = f.split(":", 1)[1].split("（")[0].strip()
            if not F["status"]:
                F["status"] = short
        elif f.startswith("进展:"):
            F["progress"] = f.split(":", 1)[1].split("（")[0].strip()
        elif f.startswith(("完成", "解锁")):
            F["progress"] = f
        elif f.startswith("方式:"):
            continue  # 集中竞价 -> 默认主体行为, 不进一句
        elif f.startswith(("增持金额", "回购金额", "合同金额", "总金额", "金额", "总投资", "投资金额", "项目投资")):
            if not F["amount"]:
                F["amount"] = _strip_prefix(f)
        elif f.startswith(("已减持", "拟减持", "计划上限", "回购股数")):
            if not F["shares"]:
                F["shares"] = _strip_prefix(f)
        elif f.startswith(("占总股本", "占股本", "占 2025 营收", "比例")):
            if not F["ratio"]:
                F["ratio"] = _strip_prefix(f)
        elif f.startswith(("单船", "标的", "公示期", "合同期", "退市整理期", "产能", "年产", "建设期", "分期")):
            # 保留语义标签 (如"公示期 3 日" 不要剥成"3 日")
            F["extra"] = f
        else:
            # 其它数字(罕见) -> 暂塞 extra
            if not F["extra"]:
                F["extra"] = _strip_prefix(f)

    primary_label = ""
    if signals:
        primary_label = max(signals, key=lambda s: abs(s[1]))[0]

    # ===== 1.5 标题兜底: 当 PDF 没抓到主体时, 从标题关键词推断 =====
    if not F["subject"]:
        if ann_type == "增持":
            if re.search(r"控股股东|实际控制人", title):
                F["subject"] = "控股股东"
            elif re.search(r"董事|高级管理人员|高管", title):
                F["subject"] = "董事及高级管理人员"
            else:
                F["subject"] = "公司"
        elif ann_type == "减持":
            if re.search(r"5%以上股东", title):
                F["subject"] = "5% 以上股东"
            elif re.search(r"控股股东|实际控制人", title):
                F["subject"] = "控股股东"
            else:
                F["subject"] = "股东"
        elif ann_type == "合同":
            pass

    # ===== 2. 按 ann_type 选模板 =====
    def _clean_num(s: str) -> str:
        # 去掉前面残留的 "≥" "≤" "≈"
        return re.sub(r"^[≥≤≈]\s*", "", s).strip()

    F["amount"] = _clean_num(F["amount"])
    F["shares"] = _clean_num(F["shares"])
    F["ratio"] = _clean_num(F["ratio"])
    F["extra"] = _clean_num(F["extra"])

    s = ""
    if ann_type == "合同":
        # 合同: 主体+合同动词+金额+附加
        verb = "披露重大合同" if "进展" in title else "公告"
        prefix = "预中标重大合同" if F["status"] == "预中标" else "重大合同"
        if F["status"] == "预中标":
            s = f"公告预中标重大合同"
        elif "进展" in title:
            s = f"披露重大合同进展"
        else:
            s = f"{verb}重大合同"
        details = []
        if F["amount"]:
            details.append(f"合同金额 {F['amount']}")
        if F["extra"]:
            details.append(F["extra"])
        if F["ratio"]:
            details.append(f"占 2025 营收 {F['ratio']}")
        if details:
            s += ", " + ", ".join(details)
        s += "。"
    elif ann_type == "增持":
        sub = F["subject"] or "公司"
        prefix_str = "股价低位时, " if is_price_upgraded == "low" else ""
        s = f"{prefix_str}{sub}计划增持公司股份"
        if F["amount"]:
            s += f", 金额 {F['amount']}"
        s += "。"
    elif ann_type == "减持":
        sub = F["subject"] or "股东"
        prefix_str = "股价高位时, " if is_price_upgraded == "high" else ""
        s = f"{prefix_str}{sub}减持公司股份"
        if F["shares"]:
            s += f" {F['shares']}"
        if F["ratio"]:
            s += f", 占总股本 {F['ratio']}"
        s += "。"
    elif ann_type == "员工持股":
        # 主体用"员工持股计划"或进度词组句
        if F["progress"] == "持有人会议":
            if F["progress"] == "筹划" or F["progress"] == "草案":
                s = "员工持股计划处于筹划/草案阶段,【筹划】尚未落地,待持有人会议召开后落地。"
            s = "员工持股计划召开第一次持有人会议, 计划正式落地。"
        elif F["progress"] == "届满":
            s = "员工持股计划锁定期届满。"
        elif F["progress"] == "完成":
            s = "员工持股计划完成实施, 正式落地。"
        elif F["progress"] == "解锁":
            s = "员工持股计划股票解锁。"
        else:
            s = "员工持股计划相关进展, 详见公告。"
    elif ann_type == "退市":
        s = "股票进入退市整理期"
        if F["extra"]:
            # 去掉"退市整理期"重复标签 (如"退市整理期 15 个交易日" -> "15 个交易日")
            extra = re.sub(r"^退市整理期\s*", "", F["extra"])
            s += f", {extra}"
        s += "。"
    # v9.26: ST 风险警示 -7 独立模板, 不再错套"退市整理期"
    elif ann_type == "ST":
        if "撤销" in title:
            s = "撤销部分其他风险警示, 仍被实施ST风险警示。"
        else:
            s = "被实施ST风险警示, 板块资金恐慌性出逃概率高。"
    # v9.26: 重整类 (ST 板块重整 -10 / 控股股东破产重整 -10) 独立模板
    elif ann_type == "重整":
        if "控股股东" in title and "破产" in title:
            s = "控股股东被申请破产重整, 实控端债务危机, 股权不稳定。"
        elif "重整计划" in title:
            s = "重整计划实施, 涉及资本公积金转增股本, 经营持续承压。"
        elif "债权人会议" in title:
            s = "预重整/第一次债权人会议召开, 进入重整法律程序。"
        elif "招募" in title or "投资人" in title:
            s = "公开招募重整投资人, 经营持续恶化。"
        else:
            s = "公司进入重整/预重整程序, 经营持续承压。"
    elif ann_type == "处罚":
        # v9.25: 监管主体分层 (证监会 -10 vs 行业 -3)
        # 旧版一律"收到证监会《行政处罚事先告知书》, 涉嫌信息披露违规" → 错杀环保/安监/消防/税务
        # 新版按 监管主体 分支: 证监会用事先告知书模板, 行业用决定书模板
        reg = F["regulator"] or ""
        reg_norm = re.sub(r"省|市|区|县|乡|", "", reg)  # 去掉行政区划, 便于匹配
        if "证监会" in reg or "证券" in reg:
            doc_name = "《行政处罚事先告知书》"
            violation = F["violation"] or "信息披露"
            s = f"收到证监会《{doc_name}》, 涉嫌{violation}违规。"
        elif "生态环境" in reg or "环保" in reg or "生态" in reg:
            s = f"下属分公司/子公司收到生态环境局《行政处罚决定书》, 涉嫌环保违规。"
        elif "应急管理" in reg or "安监" in reg or "安全生产" in reg:
            s = f"收到应急管理局《行政处罚决定书》, 涉嫌安全生产违规。"
        elif "消防" in reg:
            s = f"收到消防部门《行政处罚决定书》, 涉嫌消防安全违规。"
        elif "税务" in reg or "国税" in reg:
            s = f"收到税务局《行政处罚决定书》, 涉嫌税务违规。"
        elif "工商" in reg or "市场监管" in reg:
            s = f"收到市场监督管理局《行政处罚决定书》, 涉嫌经营违规。"
        else:
            # 兜底: 通用行政处罚 (行业级, 非证监会)
            reg_display = reg if reg else "监管部门"
            s = f"收到{reg_display}《行政处罚决定书》, 涉嫌违规。"
    elif ann_type == "定增":
        sub = company_name or "公司"

        def _placement_fact(prefix: str) -> str:
            for fact in facts or []:
                if fact.startswith(prefix):
                    return fact.split(":", 1)[1].strip() if ":" in fact else ""
            return ""

        total_raise = _placement_fact("募资总额:")
        industrial_pct = _placement_fact("产业项目占比:")
        dilution_pct = _placement_fact("发行上限占发行前股本:")
        s = f"{sub}拟定增"
        if total_raise:
            s += f"募资{total_raise}"
        if industrial_pct:
            s += f"，其中{industrial_pct}投向高景气主业扩产/产业化项目"
        if dilution_pct:
            s += f"，发行上限为发行前股本{dilution_pct}"
        s += "。"
    elif ann_type == "扩产":
        sub = company_name or "公司"
        s = f"{sub}公告新建产能/扩产项目"
        amount = ""
        capacity = ""
        phase = ""
        for f in facts or []:
            if f.startswith(("总投资", "投资金额", "项目投资")) and not amount:
                amount = _strip_prefix(f)
            elif f.startswith(("产能", "年产")) and not capacity:
                capacity = _strip_prefix(f)
            elif f.startswith("分期") and not phase:
                phase = _strip_prefix(f)
        details = []
        if amount:
            details.append(f"总投资 {amount}")
        if capacity:
            details.append(capacity)
        if phase:
            details.append(phase)
        if details:
            s += ", " + ", ".join(details)
        s += "。"
    elif ann_type == "新药":
        s = "新药/专利获批, 详见公告。"  # PDF 抓到的细节已在 best_facts 展示
    elif ann_type == "战略":
        s = "签署战略合作框架协议。"
    elif ann_type == "业绩预告":
        # v9.39 模板: "公司公告半年度业绩预告, 预计净利润 X~Y 万元, 同比增长 +Z%"
        period = ""
        if re.search(r"半年", title):
            period = "半年度"
        elif re.search(r"前三季", title):
            period = "前三季度"
        elif re.search(r"三季", title):
            period = "三季度"
        elif re.search(r"一季", title):
            period = "一季度"
        elif re.search(r"年度", title):
            period = "年度"
        else:
            period = "本期"
        sub = company_name or "公司"
        s = f"{sub}公告{period}业绩预告"
        np_fact = ""
        pct_fact = ""
        for f in facts or []:
            if "预计净利润" in f and not np_fact:
                np_fact = f.replace("预计净利润", "").strip()
            elif "业绩预告同比" in f and not pct_fact:
                pct_fact = f.replace("业绩预告同比", "同比增长").strip()
        if np_fact:
            s += f", 预计净利润 {np_fact}"
        if pct_fact:
            s += f", {pct_fact}"
        s += "。"
    elif ann_type == "重组":
        # v9.39 模板: "公司公告重大资产重组完成, 涉及金额 X 万元"
        sub = company_name or "公司"
        s = f"{sub}公告重大资产重组完成"
        # 优先 万元/亿元 单位的金额, 跳过 单一"X 元" (通常是 per-share price)
        best_amount = ""
        for f in facts or []:
            m = re.search(r"([0-9][0-9,.]+)\s*(万元|亿元|元)", f)
            if m:
                if m.group(2) in ("万元", "亿元") and not best_amount:
                    best_amount = f"{m.group(1)} {m.group(2)}"
        if best_amount:
            s += f", 涉及金额 {best_amount}"
        s += "。"
    elif ann_type == "激励":
        # v9.39 模板: "公司公告限制性股票激励计划草案, 授予价格 X 元/股, 约占总股本 Y%"
        sub = company_name or "公司"
        s = f"{sub}公告限制性股票激励计划"
        if F["status"] and "草案" in F["status"]:
            s += "草案"
        grant_price = ""
        for f in facts or []:
            if re.search(r"\d+(?:\.\d+)?\s*元", f) and "万元" not in f and "亿元" not in f:
                grant_price = f.replace("金额", "").strip()
                break
        if grant_price:
            s += f", 授予价格 {grant_price}"
        if F["ratio"]:
            s += f", 约占总股本 {F['ratio']}"
        s += "。"
    elif ann_type == "回购":
        # v9.39 模板: "公司公告股份回购, 回购金额 X 万元, 用途: 注销/股权激励"
        sub = company_name or "公司"
        s = f"{sub}公告股份回购"
        if F["amount"]:
            s += f", 回购金额 {F['amount']}"
        if F["shares"]:
            s += f", 回购股数 {F['shares']}"
        purpose = ""
        for f in facts or []:
            if f.startswith("用途:"):
                purpose = f.split(":", 1)[1].split("（")[0].strip()
                break
        if purpose:
            s += f", 用途: {purpose}"
        s += "。"
    else:
        # v9.39 兜底: 完整主谓宾句子, trader 一眼能读懂
        # 老板原话: "你光一个草案阶段xx元xx%, 谁他妈的看得懂啊"
        sub = company_name or F["subject"] or "公司"
        verb = primary_label or F["status"] or F["progress"] or "公告事项"
        s = f"{sub}{verb}"
        tail = []
        for k in ("amount", "shares", "ratio", "extra"):
            if F[k]:
                tail.append(F[k])
        if tail:
            s += ", " + ", ".join(tail)
        s += "。"

    # 尾部 hint
    if F["hint"]:
        s += f" ({F['hint']})"
    # 截断
    if len(s) > 70:
        s = s[:69] + "…"
    return s


def _read_pdf_text(ann_id: str, url: str, timeout: int = 15) -> str:
    """读取公告 PDF 正文, 复用本地缓存。失败时返回空字符串。"""
    if not ann_id or not url:
        return ""
    cache_path = PDF_CACHE / f"{ann_id}.PDF"
    try:
        PDF_CACHE.mkdir(exist_ok=True)
        if not cache_path.exists():
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                cache_path.write_bytes(r.read())
        import fitz
        doc = fitz.open(str(cache_path))
        return "\n".join(p.get_text() for p in doc)
    except Exception:
        return ""


def _assess_private_placement_announcement(
    title: str,
    ann_id: str,
    url: str,
    code: str,
    as_of_date: str,
    timeout: int = 15,
) -> Optional[Dict[str, Any]]:
    """v10.2: 只读定增预案主文，按募投/稀释/定价/认购方情景重新评分。

    PDF 失败时返回 None，让标题规则保留 -2 的保守回退；配套附件
    不是预案主文，不会重复计分。
    """
    if not is_canonical_placement_plan(title):
        return None
    text = _read_pdf_text(ann_id, url, timeout=timeout)
    if not text:
        return None
    price_position = _get_price_position(code, as_of_date=as_of_date)
    current_price = price_position.get("current") if price_position else None
    assessment = analyze_placement_plan(
        title,
        text,
        current_price=current_price,
        price_position=price_position,
    )
    return assessment if assessment.get("is_placement_plan") else None


def _extract_capacity_expansion_facts(text: str) -> List[str]:
    """从扩产/新产能项目公告正文提取展示用关键事实。"""
    out: List[str] = []
    seen = set()
    compact = re.sub(r"\s+", " ", text or "")

    def _add(s: str) -> None:
        s = re.sub(r"\s+", " ", s).strip(" ,，。；;")
        if s and s not in seen and len(out) < 5:
            seen.add(s)
            out.append(s)

    m = re.search(
        r"(?:总投资(?:金额|额|上限)?|投资总额|项目总投资|投资金额)[^0-9]{0,20}([0-9][0-9,.]*\s*[亿万]元)",
        compact,
    )
    if m:
        _add(f"总投资 {_fmt_money(m.group(1).replace(chr(0x20), ''))}")

    m = re.search(r"年产[^，。；;\n]{0,90}", compact)
    if m:
        _add(f"产能 {m.group(0)}")
    elif re.search(r"新增|形成|提升|扩大", compact) and "产能" in compact:
        m = re.search(r"(?:新增|形成|提升|扩大)[^，。；;\n]{0,80}产能[^，。；;\n]{0,50}", compact)
        if m:
            _add(f"产能 {m.group(0)}")

    m = re.search(r"(分[两二三四五]期建设|一期[^。；;\n]{0,40}二期[^。；;\n]{0,40})", compact)
    if m:
        _add(f"分期 {m.group(1)}")

    m = re.search(r"建设期[^。；;\n]{0,80}", compact)
    if m:
        _add(m.group(0))

    return out


def _score_capacity_expansion_announcement(title: str, ann_id: str, url: str, timeout: int = 15) -> Tuple[int, str]:
    """
    v9.40: 项目类公告标题未直接写"扩产/新建产能"时, 读 PDF 正文确认是否为扩产项目。
    命中后按老板 6/26 口径: 新建产能/扩产 = 强利好 +7；
    前期筹备/意向阶段命中则给 +5（你要的先标记规则，不算落地）。
    """
    # 标题可不直接写“扩产/新建产能”，但要有“项目/投资建设”等核心词
    title_candidate = bool(re.search(
        r"(投资建设|投建|扩建|新建|年产|生产基地|制造基地).{0,40}(项目|生产线|基地|工厂|产能|产线)|"
        r"(项目|生产线|基地|工厂|产能|产线).{0,40}(投资建设|投建|扩建|新建|年产|建设)",
        title,
    ))
    hard_exclude = bool(re.search(
        r"研发中心|总部大楼|办公楼|产业基金|股权投资|信息化项目|补充流动资金|补流|购买理财|委托理财",
        title,
    ))
    if hard_exclude and not re.search(r"生产|产能|年产|制造|工厂|产线|生产线|生产基地", title):
        return (0, "")

    if not title_candidate and not re.search(
        r"对外投资|投资协议书|签署.*协议|投资.*新建|投资.*扩建|新建.*项目|扩建.*项目|前期筹备|投资.*项目|建设.*项目|开工|签署|投建|扩产|新建|年产|生产基地|制造基地",
        title,
    ):
        return (0, "")

    text = _read_pdf_text(ann_id, url, timeout=timeout)
    if not text:
        return (0, "")

    combined = title + "\n" + text
    if not title_candidate and not re.search(
        r"对外投资|投资协议书|签署.*协议|投资.*新建|投资.*扩建|新建.*项目|扩建.*项目|前期筹备",
        combined,
    ):
        return (0, "")

    production_evidence = bool(re.search(
        r"年产|产能|生产线|产线|生产基地|制造基地|生产项目|扩产|扩建|投产|分[两二三四五]期建设|"
        r"形成[^。；;\n]{0,40}生产能力|新增[^。；;\n]{0,40}生产能力",
        combined,
    ))
    investment_evidence = bool(re.search(
        r"总投资|投资总额|项目总投资|投资金额|投资上限|一期|二期|分期建设|建设期",
        combined,
    ))
    exclude_only = bool(re.search(
        r"研发中心|总部大楼|办公楼|产业基金|股权投资|信息化项目|补充流动资金|补流|购买理财|委托理财",
        combined,
    )) and not production_evidence

    if not production_evidence or not investment_evidence or exclude_only:
        return (0, "")

    is_plan_stage = bool(re.search(
        r"前期筹备|前期筹备阶段|尚处于前期|目前进展.*筹备|尚处于.*阶段|拟建|拟.*(建设|签署)|计划于|拟投入|项目目前进展.*(?:筹备|前期)",
        combined,
    ))
    if is_plan_stage:
        return (5, "新建产能/扩产")
    return (7, "新建产能/扩产")


def _score_forecast_announcement(title: str, ann_id: str, url: str, timeout: int = 15) -> Tuple[int, str, List[str]]:
    """
    v10.1: 业绩预告不再作为公告研判指标, 保留函数壳用于兼容旧调用。
    """
    return (0, '', [])
    if not ann_id or not url or '业绩预告' not in title:
        return (0, '', [])
    # 排除分支: 这些标题已有专用规则(预增/扭亏 +10 / 预减/预亏 -10), 新规则不抢分
    if re.search(r'预增|预减|预亏|扭亏|净利润为负', title):
        return (0, '', [])
    cache_path = PDF_CACHE / f"{ann_id}.PDF"
    try:
        if not cache_path.exists():
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                cache_path.write_bytes(r.read())
        import fitz
        doc = fitz.open(str(cache_path))
        text = "\n".join(p.get_text() for p in doc)
    except Exception:
        return (0, '', [])
    # 找方向: "比上年同期(增长|上升|下降|减少|下滑): X% [至 Y%]"
    # 例: "归属于上市公司股东的净利润 90,000 万元–100,000 万元, 比上年同期增长: 110.76% – 134.18%"
    # v9.39 修订: 增加全角 tilde ～ 字符 (U+FF5E) 支持, 部分公司 PDF (如 卫星化学)
    # 使用全角"～"分隔范围, 旧 regex [–\-至~到] 未覆盖, 导致 high 值匹配不到
    m = re.search(
        r'比上年同期(增长|上升|下降|减少|下滑)[^0-9\-]{0,10}?([0-9]+(?:\.[0-9]+)?)\s*%(?:\s*[–\-至~到～]\s*([0-9]+(?:\.[0-9]+)?)\s*%)?',
        text,
    )
    if not m:
        return (0, '', [])
    direction = m.group(1)
    low = float(m.group(2))
    high = float(m.group(3)) if m.group(3) else low
    midpoint = (low + high) / 2.0
    is_up = direction in ('增长', '上升')
    # v9.39: 业务类型 业绩预告 缺 净利润 数字会让 one-liner 拼不出主谓宾;
    # 从 PDF 抓 净利润范围 (归属于上市公司股东的净利润 X~Y 万元) 作为展示事实
    facts = [f"业绩预告同比 {'+' if is_up else ''}{low:g}% ~ {'+' if is_up else ''}{high:g}%"]
    # v9.39 修订: 净利润 范围 单位 (万元/亿元) 可能在表格另一列 (例: 卫星化学
    # "归属于上市公司 股东的净利润 600,000 ～ 700,000" + 表格单位行"万元")
    # → 旧 regex 强制要求数字后跟单位, 改用"前看后找"模式
    m_np = re.search(
        r'归属于上市公司\s*股东的?\s*净利润\s*[\n]?\s*([0-9][0-9,.]+)\s*[–\-~至到～]?\s*([0-9][0-9,.]+)?',
        text,
    )
    if m_np:
        low_np = m_np.group(1)
        high_np = m_np.group(2) or low_np
        # 找单位: 范围之后的 [万元|亿元|元] (通常在表格下一行)
        m_unit = re.search(rf'归属于上市公司\s*股东的?\s*净利润\s*[\n]?\s*[0-9][0-9,.]+\s*[–\-~至到～]?\s*[0-9]?[0-9,.]?\s*[\n\s]{{0,30}}?(万元|亿元|元)', text)
        unit = m_unit.group(1) if m_unit else "万元"
        facts.append(f"预计净利润 {low_np} {unit}至{high_np} {unit}")
    if is_up:
        if midpoint > 20.0:
            return (10, '业绩预告涨幅>20%', facts)
        else:
            return (0, '', facts)  # 0-20% 涨幅按中性, 老板没明说但保守
    else:
        # 任何跌幅都算强利空 (老板原话)
        return (-10, '业绩预告跌幅', facts)


def _fetch_pdf_numbers(title: str, ann_id: str, url: str, signals: List[Tuple[str, int]], timeout: int = 15) -> List[str]:
    """
    按公告业务类型,从 PDF 抓取**该类型真正相关**的关键数字。
    旧版一刀切抓"金额/比例/锁定期", 导致减持公告抓到"锁定期 6 个月"等无关数据。
    现在按 _classify_announcement 的标签只抓对应字段。

    返回格式: ["增持 12,000,000 股", "占股本 0.5%"]
    """
    if not ann_id or not url:
        return []
    cache_path = PDF_CACHE / f"{ann_id}.PDF"
    try:
        if not cache_path.exists():
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                cache_path.write_bytes(r.read())
        import fitz
        doc = fitz.open(str(cache_path))
        text = "\n".join(p.get_text() for p in doc)
    except Exception:
        return []

    ann_type = _classify_announcement(title, signals)
    out: List[str] = []
    seen = set()

    def _add(s: str) -> None:
        s = s.strip()
        if s and s not in seen and len(out) < 5:
            seen.add(s)
            out.append(s)

    # ===== 类型 A: 减持公告 =====
    if ann_type == "减持":
        # v9.35 修复: 比例提取要按"减持/拟减持" 关键词就近匹配, 避免抓到"持有公司股份 X%"
        # 京泉华 6/22 案例: 旧逻辑 re.search 全文第一个 "X 股 ... Y%" → 抓到"持有 34,015,472 股(12.56%)" 的 12.56% (持股比例)
        # 应该是: 拟减持 8,127,507 股, 占总股本 3.00% (拟减持比例) = 强利空 -7, 但数字写对
        # 关键: "减持" 必须出现在 "X 股" 之前 (避免 "持有" 段误抓)
        is_predisclosure = bool(re.search(r"预披露|拟减持", title))
        is_completion = bool(re.search(r"减持结果|期限届满|届满|实施完成|减持完成|减持结束", title))

        # 1) 减持股数 (按公告类型分别抓, 避免把"持股 X%" 误标为"已减持")
        if is_predisclosure:
            # 预披露: 抓 "拟减持 X 股" (计划减持, 尚未实际减持)
            # 注: PDF 换行会把"本次拟\n减持的股份合计为 8,127,507 股" 拆开, 需 \s* 兼容
            m = re.search(r"拟\s*减持[^,。\n]{0,80}?([0-9,]+)\s*股", text, re.DOTALL)
            if m:
                _add(f"拟减持 {m.group(1)} 股")
        else:
            # 减持结果/完成/普通: 抓 "已减持 X 股" (已完成减持)
            for pat in [
                r"已[^,。\n]{0,30}?减持[^,。\n]{0,10}?([0-9,]+)\s*股",
                r"减持[^,。\n]{0,10}?([0-9,]+)\s*股",
                r"本次权益变动[^,。\n]{0,40}?([0-9,]+)\s*股",
            ]:
                m = re.search(pat, text)
                if m:
                    _add(f"已减持 {m.group(1)} 股")
                    break

        # 2) 减持股数比例 - 优先找"减持/拟减持" 关键词附近的比例 (避免误抓"持有 X%")
        # 策略 (按优先级):
        #   A. "拟减持 ... 不超过公司总股本的 X%" (预披露/计划 公告最准)
        #   B. "拟减持 ... 占公司总股本的 X%" (备选)
        #   C. "减持 ... X 股 ... 占总股本 X%" (减持结果 table 格式, 要求 "减持" 在前)
        #   D. 兜底: 旧 "first X%" 逻辑
        pct_m = None
        if is_predisclosure:
            # 关键: 排除只排除 。\n (句号/换行), 允许 ,  和 , (中英文逗号) — 因为
            # 京泉华 PDF: "拟减持 ... 8,127,507 股，即不超过公司总股本的 3.00%" — 中间有中文逗号
            # 注: PDF 换行 "本次拟\n减持" 拆开, "拟\s*减持" 兼容
            for pat in [
                r"拟\s*减持[^。\n]{0,200}?不超过公司总股本的?[^,。\n]{0,5}?([0-9.]+)\s*%",
                r"拟\s*减持[^。\n]{0,200}?占(?:公司)?总股本[^,。\n]{0,5}?(?:的?|比例[为是]?)?[^,。\n]{0,5}?([0-9.]+)\s*%",
            ]:
                pct_m = re.search(pat, text, re.DOTALL)
                if pct_m:
                    break
        if pct_m is None:
            # 减持结果/完成/普通: "减持 ... X 股 ... 占总股本 X%" (table 或 prose)
            # 必须 "减持" 出现在 "X 股" 之前 (避免 "持有 X% 持有" 上下文误抓)
            # 同样允许 Chinese comma 在窗口内 (table/prose 格式常见)
            for pat in [
                r"减持[^。\n]{0,100}?([0-9,]+)\s*股[^。\n]{0,30}?占(?:公司)?总股本[^,。\n]{0,5}?(?:的?|比例[为是]?)?[^,。\n]{0,5}?([0-9.]+)\s*%",
            ]:
                pct_m = re.search(pat, text, re.DOTALL)
                if pct_m:
                    # 修复: 原 type('M') hack 引用了正在被赋值的 pct_m → lambda 递归死循环
                    # 这里 ratio 在 group(2), 我们把它"前移"到 group(1) 让下游代码统一用 group(1)
                    # 用闭包抓 orig 避免再赋值的 pct_m 被 lambda 误抓
                    orig = pct_m
                    pct_m = type('M', (), {'group': lambda self, n, _o=orig: _o.group(2) if n == 1 else _o.group(n)})()
                    break
        if pct_m:
            _add(f"占总股本 {pct_m.group(1)}%")
        else:
            # 兜底: 旧 "first X%" 逻辑 (保留兼容, 但已被 v9.35 多数 case 覆盖)
            legacy_pct = re.search(r"([0-9,]+)\s*股[^,。\n]{0,30}?(?:占[^,。\n]{0,10}?总股本[^,。\n]{0,5}?)?([0-9.]+)\s*%", text)
            if legacy_pct:
                _add(f"占总股本 {legacy_pct.group(2)}%")
            else:
                m = re.search(r"(?:占公司总股本比例?|占公司总股本的?|占[本]?公司总股本)\s*[为是]?\s*([0-9.]+)\s*%", text)
                if m:
                    _add(f"占总股本 {m.group(1)}%")
        # 3) 计划减持上限
        m = re.search(r"(?:不超过|不[超]?过|拟减持)[^,。\n]{0,30}?([0-9,]+)\s*股", text)
        if m:
            _add(f"计划上限 {m.group(1)} 股")
        # 4) 减持方式
        if "集中竞价" in text:
            _add("方式: 集中竞价")
        elif "大宗交易" in text:
            _add("方式: 大宗交易")
        # 5) 减持人
        m = re.search(r"([^,。\n]{2,30}?)减持[的]?(?:股份|股票)", text)
        if m:
            _add(f"减持人: {m.group(1).strip()}")
        # 兜底
        if not out:
            m = re.search(r"([0-9,]+)\s*股", text)
            if m:
                _add(f"涉及股数 {m.group(1)} 股")

    # ===== 类型 B: 增持公告 =====
    elif ann_type == "增持":
        m = re.search(r"增持\s*(?:金额)?(?:不[少低]于)?(?:人民币)?\s*([0-9,.]+\s*[亿万]元)", text)
        if m:
            _add(f"增持金额 ≥ {_fmt_money(m.group(1).replace(chr(0x20), ''))}")
        m = re.search(r"增持(?:不[少低]于)?\s*([0-9,.]+)\s*股", text)
        if m:
            _add(f"增持 {m.group(1)} 股")
        m = re.search(r"(?:占|占公司总股本)\s*([0-9.]+)\s*%", text)
        if m:
            _add(f"占总股本 {m.group(1)}%")
        # 增持主体
        m = re.search(r"(控股股东|实际控制人|董事|监事|高级管理人员|核心骨干员工)(?:计划|拟)?增持", text)
        if m:
            _add(f"增持主体: {m.group(1)}")

    # ===== 类型 C: 回购公告 =====
    elif ann_type == "回购":
        m = re.search(r"回购(?:资金|金额)(?:不[少于低]?)?\s*([0-9,.]+\s*[亿万]元)", text)
        if m:
            _add(f"回购金额 ≥ {_fmt_money(m.group(1).replace(chr(0x20), ''))}")
        m = re.search(r"回购价格(?:不[超过高]?)?\s*([0-9,.]+)\s*元\s*/\s*股", text)
        if m:
            _add(f"回购价 ≤ {m.group(1)} 元/股")
        m = re.search(r"回购(?:股份)?(?:数量)?(?:不[少于低])?\s*([0-9,]+)\s*股", text)
        if m:
            _add(f"回购股数 ≥ {m.group(1)} 股")
        m = re.search(r"(?:注销|减少注册资本|维护公司价值)", text)
        if m and "注销" in m.group(0):
            _add("用途: 注销减资")
        m = re.search(r"集中竞价交易方式", text)
        if m:
            _add("方式: 集中竞价")

    # ===== 类型 D: 中标/合同公告 =====
    elif ann_type == "合同":
        # 1) 合同金额 (人民币 或 美元)
        m = re.search(r"合同(?:金额|总价|总金额|标的金额|签约金额|涉及金额|订单金额|金额)\s*[为约]?\s*([0-9][0-9,.]*\s*[亿万]元|[0-9][0-9,.]*\s*万[美]?元|[0-9][0-9,.]*\s*亿[美]?元)", text)
        if m:
            _add(f"合同金额 {_fmt_money(m.group(1).replace(chr(0x20), ''))}")
        # 2) 兜底: 抓"总金额 X 万元/亿元" 或 "X 万美元"
        if not any("合同金额" in x for x in out):
            m = re.search(r"(?:总金额|合计金额|总价)\s*[为约]?\s*([0-9][0-9,.]*\s*[亿万]元|[0-9][0-9,.]*\s*万[美]?元)", text)
            if m:
                _add(f"总金额 {_fmt_money(m.group(1).replace(chr(0x20), ''))}")
        # 2.5) 占营收比例 (强信号, 单独抓)
        m = re.search(r"(?:约占|占)\s*[0-9]*年?(?:度)?(?:营业收入|营收|总收入)?(?:总额)?的?\s*([0-9.]+)\s*%", text)
        if m:
            _add(f"占营收 {m.group(1)}%")
        # 2.6) 表格里的"中标金额 (万元)" 列, 数字无单位
        if not any("金额" in x for x in out):
            m = re.search(r"(?:中标|合同)金额.{0,30}?([0-9][0-9,.]+)\b", text)
            if m and 4 <= len(m.group(1).replace(",", "")) <= 9 and not m.group(1).startswith("20") and not m.group(1).startswith("19"):
                # 不匹配 "2025" / "2026" 这种年份开头, 至少 4 位数字才算金额
                _add(f"中标金额 {m.group(1)} 万元")
        # 2.7) 兜底: 万美元
        if not any("金额" in x for x in out):
            m = re.search(r"([0-9][0-9,.]+\s*万[美]?元)", text)
            if m:
                _add(f"金额 {_fmt_money(m.group(1).replace(chr(0x20), ''))}")
        # 3) 标的数量 (船舶 4 艘 / X 载重吨)
        m = re.search(r"([0-9]+)\s*艘", text)
        if m:
            _add(f"标的 {m.group(1)} 艘")
        m = re.search(r"([0-9,.]+)\s*(载重吨|吨位|立方米|兆瓦|公里)", text)
        if m:
            _add(f"单船 {m.group(1)} {m.group(2)}")
        # 4) 客户
        m = re.search(r"(?:甲方|买方|发包人|客户|采购方)\s*[为:]?\s*([^\n,。]{4,30})", text)
        if m:
            _add(f"客户: {m.group(1).strip()}")
        # 5) 合同期限
        m = re.search(r"合同期限[为]?\s*([0-9]+)\s*年", text)
        if m:
            _add(f"合同期 {m.group(1)} 年")
        # 6) 公示期 (预中标常见)
        m = re.search(r"公示期[自]?[为]?\s*[自从]?\s*[0-9]+\s*年[0-9]+\s*月[0-9]+\s*日起?\s*([0-9]+)\s*[日天]", text)
        if m:
            _add(f"公示期 {m.group(1)} 日")
        # 7) 兜底: 任何"数字 + 万/亿 + 元/美元" 数字都抓
        if not any("金额" in x or "总金额" in x for x in out):
            # 优先抓 万美元 / 万亿元 (国航远洋等外贸合同)
            m = re.search(r"([0-9][0-9,.]+\s*万[美]?元)", text)
            if m:
                _add(f"金额 ≈ {_fmt_money(m.group(1).replace(chr(0x20), ''))}")
            else:
                m = re.search(r"([0-9][0-9,.]+\s*亿[元美])", text)
                if m:
                    _add(f"金额 ≥ {_fmt_money(m.group(1).replace(chr(0x20), ''))}")
        # 8) 营收占比 (通光线缆类: "约占 2025 年营收 X%")
        if not any("营收" in x for x in out):
            m = re.search(r"约占?\s*[0-9]+\s*年(?:经审计)?\s*(?:营业)?收入?\s*(?:总额)?\s*的?\s*([0-9.]+)\s*%", text)
            if m:
                _add(f"占 2025 营收 {m.group(1)}%")

    # ===== 类型 D2: 新建产能/扩产项目 =====
    elif ann_type == "扩产":
        for fact in _extract_capacity_expansion_facts(text):
            _add(fact)

    # ===== 类型 E: 员工持股 =====
    elif ann_type == "员工持股":
        m = re.search(r"员工持股计划[的]?(?:拟[的]?)?(?:筹集|金额|资金)\s*([0-9,.]+\s*[亿万]元)", text)
        if m:
            _add(f"计划金额 {_fmt_money(m.group(1).replace(chr(0x20), ''))}")
        m = re.search(r"(?:占|占公司总股本)\s*([0-9.]+)\s*%", text)
        if m:
            _add(f"占总股本 {m.group(1)}%")
        m = re.search(r"(?:购买价格|受让价格)\s*([0-9,.]+)\s*元\s*/\s*股", text)
        if m:
            _add(f"购股价 {m.group(1)} 元/股")
        m = re.search(r"锁定期[为]?\s*([0-9]+)\s*个?月", text)
        if m:
            _add(f"锁定期 {m.group(1)} 个月")
        m = re.search(r"(完成|持有人会议|解锁|届满)", text)
        if m:
            _add(f"进展: {m.group(1)}")
        m = re.search(r"(筹划|草案)(?!.*通过)", text)
        if m:
            _add(f"阶段: {m.group(1)}")

    # ===== 类型 F: 新药/资质 =====
    elif ann_type == "新药":
        m = re.search(r"(药品|新兽药|医疗器械|专利)(?:注册证书)?(?:编号)?\s*[为:]?\s*([A-Z0-9]+)", text)
        if m:
            _add(f"{m.group(1)}注册证 {m.group(2)}")
        m = re.search(r"(?:有效期|至)\s*([0-9]+)\s*年", text)
        if m:
            _add(f"有效期至 {m.group(1)} 年")
        m = re.search(r"(临床试验|上市许可|注册分类)\s*[为:]?\s*([^\n,。]{4,20})", text)
        if m:
            _add(f"分类: {m.group(1).strip()}")
        if not out:
            m = re.search(r"(新兽药|药品|医疗器械|专利|注册证书|临床试验|获批|获得)", text)
            if m:
                _add(f"类型: {m.group(1)}")

    # ===== 类型 G: 退市 =====
    elif ann_type == "退市":
        m = re.search(r"退市整理期[为的]?\s*([0-9]+)\s*个?交易日", text)
        if m:
            _add(f"退市整理期 {m.group(1)} 个交易日")
        m = re.search(r"进入退市整理期[首日初]?[的]?起[至止]\s*([0-9-]+)", text)
        if m:
            _add(f"起止: {m.group(1)}")
        m = re.search(r"终止上市|退市", text)
        if m:
            _add(f"状态: {m.group(0)[:10]}")

    # ===== 类型 H: 处罚 =====
    elif ann_type == "处罚":
        # v9.26: 标题优先判监管机关, 避免 PDF 抓到“证监会” 错误覆盖环保/安监类
        # 顺鑫农业案例: 标题有“北京市顺义区生态环境局” → 实际为环保 -3
        # 旧版 仅 PDF 抓取时 可能会抓到“证监会”或“信息披露” (公告必提“公司信披事务”), 错判为 -10
        if "生态环境" in title or "环保" in title or "生态" in title:
            _add("监管机关: 生态环境局")
        elif "应急管理" in title or "安监" in title or "安全生产" in title or "应急管理局" in title:
            _add("监管机关: 应急管理局")
        elif "消防" in title:
            _add("监管机关: 消防部门")
        elif "税务" in title or "国税" in title or "税局" in title:
            _add("监管机关: 税务局")
        elif "工商" in title or "市场监管" in title:
            _add("监管机关: 市场监督管理局")
        elif "证监会" in title or "证券" in title:
            _add("监管机关: 证监会")
        m = re.search(r"(?:拟[对公]?)(?:对.*?)(?:罚款|处罚)\s*([0-9,.]+\s*[亿万]元)", text)
        if m:
            _add(f"拟处罚金额 {_fmt_money(m.group(1).replace(chr(0x20), ''))}")
        m = re.search(r"(?:责令|警告|没收|罚款)\s*([0-9,.]+\s*[亿万]元)", text)
        if m:
            _add(f"处罚金额 {_fmt_money(m.group(1).replace(chr(0x20), ''))}")
        # v9.26: 收紧违规类型 regex, 要求上下文包含"违反/涉嫌/构成"等关键词
        # 旧版裸匹配"信息披露" 会误抓公告通用段落"公司信披事务...", 顺鑫农业错判为“信披违规”
        m = re.search(r"(?:违反|涉嫌|构成|存在)[^\n。;]{0,30}(信息披露违规|内幕交易|操纵市场|虚假记载|误导性陈述|重大遗漏|欺诈发行|环保违规|安全生产违规|消防安全违规|税务违规|经营违规)", text)
        if m:
            _add(f"违规类型: {m.group(1)}")
        # 证监会类: PDF 也需复核, 避免错判
        m = re.search(r"(中国证券监督管理委员会|证监会)", text)
        if m and not any(f.startswith("监管机关:") for f in out):
            _add("监管机关: 证监会")
        # 状态: 事先告知书 vs 决定书
        if "事先告知书" in text:
            _add("状态: 事先告知书（尚未正式处罚）")
        elif "决定书" in text and "处罚" in text:
            _add("状态: 决定书（已正式处罚）")


    # ===== 类型 I: 战略合作 =====
    elif ann_type == "战略":
        m = re.search(r"(?:合作金额|涉及金额|订单金额)\s*([0-9,.]+\s*[亿万]元)", text)
        if m:
            _add(f"合作金额 {_fmt_money(m.group(1).replace(chr(0x20), ''))}")
        m = re.search(r"(?:合作方|签署方|甲方|乙方)\s*[为:]?\s*([^\n,。]{4,30})", text)
        if m:
            _add(f"合作方: {m.group(1).strip()}")
        m = re.search(r"(合作期限|有效期)[为]?\s*([0-9]+)\s*年", text)
        if m:
            _add(f"合作期 {m.group(2)} 年")

    # ===== 兜底 =====
    # 通用兜底: 仅在 out 完全为空时跑, 避免覆盖业务分支的结果
    # (旧版 len(out) < 3 会在 龙佰集团(增持) 这种 业务分支只抓到 1 条 时, 兜底重复抓 元/%, 出现"金额 4500 / 4500 / 3000" 噪声)
    if not out:
        for m in re.finditer(r"(" + _MONEY_RE + ")", text):
            num_part = m.group(1).replace(',', '').split()[0]
            # 跳过纯年份 / 短数字 (2025 / 5 等噪音)
            if len(num_part) <= 3 or (num_part.startswith(("19", "20")) and len(num_part) == 4):
                continue
            v = _fmt_money(m.group(1).replace(chr(0x20), ''))
            tag = f"金额 {v}"
            if tag not in out:
                _add(tag)
            if len(out) >= 5:
                break
        for m in re.finditer(r"([0-9.]+)\s*%", text):
            tag = f"比例 {m.group(1)}%"
            if tag not in out:
                _add(tag)
            if len(out) >= 5:
                break

    if not out:
        return []
    return out


def _extract_scale(facts, kind: str) -> float:
    """v9.8: 从 best_facts 抽"排序用标尺数字", 权重 best_score 不变, 仅影响列表顺序。

    Args:
        facts: best_facts_final 列表, 形如 ["占总股本 9.33%", "增持金额 >= 4500 万元"]
        kind: "reduce" (减持, 取占总股本 %) / "increase" (增持, 优先比例%, fallback 金额万元)

    Returns:
        float, 0.0 表示无标尺 (按 best_score 兜底)
    """
    if not facts:
        return 0.0
    if kind == "reduce":
        # 减持: 优先 占总股本 X%, fallback 减持 X%
        for f in facts:
            m = re.search(r'占[总]?股本[ ]*([0-9]+(?:\.[0-9]+)?)[ ]*%', f)
            if m:
                return float(m.group(1))
        for f in facts:
            m = re.search(r'(?:已)?减持[ ]*([0-9]+(?:\.[0-9]+)?)[ ]*%', f)
            if m:
                return float(m.group(1))
        return 0.0
    else:  # increase
        # 增持: 优先 比例 X% (权益变动 / 增持占比), fallback 增持金额 X 万元 (粗略按 万元/10 凑成"百分比")
        for f in facts:
            m = re.search(r'比例[ ]*([0-9]+(?:\.[0-9]+)?)[ ]*%', f)
            if m:
                return float(m.group(1))
        for f in facts:
            m = re.search(r'增持.*?(?:金额|不低于|不高于)?[ ]*([0-9]+(?:\.[0-9]+)?)[ ]*万[元股]', f)
            if m:
                # 金额 / 10 凑成"百分比"标尺, 仅用于排序 (单位不一致但内部一致)
                return float(m.group(1)) / 10.0
        return 0.0



def _coverage_weekend_note(start_date: str, end_date: str, raw_anns: list) -> dict:
    """v9.37: 计算实际数据日 + 周中/周末提示 note
    - 老板痛点: 周一跑 3 天范围, 但周末 cninfo 0 公告, Excel "今日全部公告" 全是 T 日,
      trader 一看以为是漏扫. 此函数给老板一目了然 "扫描范围 vs 实际数据日" 的对比.
    - 返回 {actual_dates: [...], pre_watchlist_total: int, weekend_empty_note: str}
    """
    actual_dates_set = set()
    for a in raw_anns:
        ts = a.get('announcementTime')
        if not ts:
            continue
        # cninfo announcementTime 是 UTC ms, 转 Asia/Shanghai (+8)
        dt = datetime.fromtimestamp(ts / 1000, tz=timezone(timedelta(hours=8)))
        actual_dates_set.add(dt.strftime('%Y-%m-%d'))
    actual_dates = sorted(actual_dates_set)
    pre_wl_total = len(raw_anns)

    if start_date == end_date:
        day_count = 1
    else:
        day_count = (datetime.strptime(end_date, '%Y-%m-%d') - datetime.strptime(start_date, '%Y-%m-%d')).days + 1

    if day_count >= 2 and len(actual_dates) < day_count:
        empty_dates = sorted(set(
            (datetime.strptime(start_date, '%Y-%m-%d') + timedelta(days=i)).strftime('%Y-%m-%d')
            for i in range(day_count)
        ) - set(actual_dates))
        # 标记每个空日期的星期
        empty_with_wk = []
        for d in empty_dates:
            wd = datetime.strptime(d, '%Y-%m-%d').weekday()  # 0=Mon ... 6=Sun
            wk_label = '周一' if wd == 0 else '周二' if wd == 1 else '周三' if wd == 2 else '周四' if wd == 3 else '周五' if wd == 4 else '周六' if wd == 5 else '周日'
            empty_with_wk.append(f'{d}({wk_label})')
        actual_label = ', '.join(actual_dates) if actual_dates else '无日期'
        actual_phrase = f"{actual_label} 有数据" if actual_dates else "没有实际数据日"
        note = (
            f"扫描 {day_count} 天范围 [{start_date} ~ {end_date}], "
            f"{actual_phrase} ({len(actual_dates)}/{day_count} 天有公告, "
            f"共 {pre_wl_total} 条); "
            f"其余 {', '.join(empty_with_wk)} cninfo 0 公告 (周末/节假日常态, 非漏扫)."
        )
    else:
        note = ''
    return {
        'actual_dates': actual_dates,
        'pre_watchlist_total': pre_wl_total,
        'weekend_empty_note': note,
    }


def process(raw_data: Dict, output_path: Optional[Path] = None) -> Dict[str, Any]:
    anns = raw_data.get('announcements', [])
    start_date = raw_data.get('start_date', raw_data.get('date', '?'))
    end_date = raw_data.get('end_date', start_date)
    fetch_meta = raw_data.get('columns', {})
    # v9.37: 实际数据日 + 周末提示由 _coverage_weekend_note 计算

    # v9.32.1: 加载 watchlist 留观股池 (申万 YTD top 15 成分股), 入口过滤 + 行业覆写
    _load_watchlist()
    if _WATCHLIST_CODES:
        anns = [a for a in anns if str(a.get('secCode', '')).strip() in _WATCHLIST_CODES]
    # v10.1: 业绩预告类公告彻底排除, 不进入利好/利空/中性明细或任何产物。
    anns = [a for a in anns if not is_earnings_forecast_title(a.get('announcementTitle', '').strip())]

    processed_items: List[Dict[str, Any]] = []
    neutral_reasons: Counter = Counter()
    neutral_announcements: List[Dict[str, Any]] = []  # 中性过滤明细 (含公司/标题/原因)
    for a in anns:
        title = a.get('announcementTitle', '').strip()
        if not title:
            continue
        neutral_reason = is_neutral(title)
        if neutral_reason:
            neutral_reasons[neutral_reason] += 1
            _ts = a.get('announcementTime', 0) / 1000
            _dt = datetime.fromtimestamp(_ts) if a.get('announcementTime') else None
            neutral_announcements.append({
                'time': _dt.strftime('%Y-%m-%d %H:%M:%S') if _dt else '',
                'ann_date': _dt.strftime('%Y-%m-%d') if _dt else '',
                'code': a.get('secCode', ''),
                'name': a.get('secName', '').replace('*', '').replace(' ', ''),
                'title': title,
                'reason': neutral_reason,
                'url': f"http://static.cninfo.com.cn/{a.get('adjunctUrl', '')}",
            })
            continue
        score, hits, cats = analyze_title(title, a.get("secName", ""))
        _forecast_facts_here = []  # v9.39: 默认空, 命中后填
        # v10.1: 业绩预告 PDF 抽数评分已关闭。
        # v10.2: 定增预案主文按募投/稀释/定价/认购方情景重新评分，覆盖标题 -2 基准分。
        ann_id = a.get("announcementId", "")
        url = 'http://static.cninfo.com.cn/' + a.get("adjunctUrl", "")
        _ann_ts = a.get('announcementTime', 0) / 1000
        _ann_dt = datetime.fromtimestamp(_ann_ts) if a.get('announcementTime') else None
        _ann_as_of_date = _ann_dt.strftime('%Y-%m-%d') if _ann_dt else end_date
        placement_assessment = _assess_private_placement_announcement(
            title,
            ann_id,
            url,
            str(a.get('secCode', '')).strip(),
            _ann_as_of_date,
        )
        if placement_assessment is not None:
            score = int(placement_assessment.get('score', 0))
            hits = [tuple(signal) for signal in placement_assessment.get('signals', [])]
            cats = [label for label, _ in hits]
        # v9.40: 项目类标题未直接写"扩产/新建产能"时, 读 PDF 正文确认扩产后给 +7
        if score == 0 and placement_assessment is None:
            cap_score, cap_label = _score_capacity_expansion_announcement(title, ann_id, url)
            if cap_score != 0 and cap_label:
                score = cap_score
                hits = [(cap_label, cap_score)]
                cats = [cap_label]
        if score == 0:
            neutral_label = (
                '定增情景多空平衡/关键要素未定'
                if placement_assessment is not None
                else '其他弱信号/无明确方向'
            )
            neutral_reasons[neutral_label] += 1
            _ts = a.get('announcementTime', 0) / 1000
            _dt = datetime.fromtimestamp(_ts) if a.get('announcementTime') else None
            neutral_announcements.append({
                'time': _dt.strftime('%Y-%m-%d %H:%M:%S') if _dt else '',
                'ann_date': _dt.strftime('%Y-%m-%d') if _dt else '',
                'code': a.get('secCode', ''),
                'name': a.get('secName', '').replace('*', '').replace(' ', ''),
                'title': title,
                'reason': neutral_label,
                'url': f"http://static.cninfo.com.cn/{a.get('adjunctUrl', '')}",
            })
            continue
        _ts = a.get('announcementTime', 0) / 1000
        _dt = datetime.fromtimestamp(_ts) if a.get('announcementTime') else None
        processed_items.append({
            'time': _dt.strftime('%Y-%m-%d %H:%M:%S') if _dt else '',
            'ann_date': _dt.strftime('%Y-%m-%d') if _dt else '',  # 公告发布日期
            'code': a.get('secCode', ''),
            'name': a.get('secName', '').replace('*', '').replace(' ', ''),
            'title': title,
            'announcementId': a.get('announcementId', ''),
            'url': f"http://static.cninfo.com.cn/{a.get('adjunctUrl', '')}",
            'adjunctUrl': a.get('adjunctUrl', ''),
            'orgId': a.get('orgId', ''),
            'industry': _WATCHLIST_INDUSTRY.get(str(a.get('secCode', '')).strip()) or infer_industry(a.get('secName', ''), a.get('secCode', '')),
            'categories': cats,
            'score': score,
            'signals': hits,
            'url': f"http://static.cninfo.com.cn/{a.get('adjunctUrl', '')}",  # 公告 PDF 链接
            'forecast_facts': _forecast_facts_here if '业绩预告' in title else [],  # v9.39: 业绩预告 facts (从预扫描), one-liner 拼主谓宾需要
            'placement_assessment': placement_assessment,
        })

    # v9.10: 双方向 best_item — 同公司同日可能有多个方向 (利好 + 利空), 两边都入榜
    by_company: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
        'items': [],
        'best_good_item': None, 'best_good_abs': -1,
        'best_bad_item': None, 'best_bad_abs': -1,
    })
    for it in processed_items:
        code = it['code']
        s = it['score']
        by_company[code]['items'].append(it)
        if s > 0 and (by_company[code]['best_good_item'] is None or s > by_company[code]['best_good_abs']):
            by_company[code]['best_good_abs'] = s
            by_company[code]['best_good_item'] = it
        elif s < 0 and (by_company[code]['best_bad_item'] is None or abs(s) > by_company[code]['best_bad_abs']):
            by_company[code]['best_bad_abs'] = abs(s)
            by_company[code]['best_bad_item'] = it

    pos_companies, neg_companies = [], []
    for code, info in by_company.items():
        # v9.10: 同公司可能在利好和利空各出现一次 (各取该方向 |score| 最大的 best)
        for best in (info['best_good_item'], info['best_bad_item']):
            if best is None:
                continue
            # v9.17: 新药/专利/资质获批 concurrent 利空抑制 (5 天 6 档 11/23 miss 根因)
            # 同公司已有 best_bad_item (任意利空) 时, 新药/专利类信号不构成有效利好, 抑制
            if best is info['best_good_item'] and info['best_bad_item'] is not None:
                bsigs = [s[0] for s in best.get('signals', [])]
                if any('新药' in lbl or '专利' in lbl or '资质' in lbl for lbl in bsigs):
                    continue
            # v9.18: 减持类 concurrent 利好抑制 (镜像 v9.17; 5 天 6 档 强利空 8/12 miss 根因)
            # 同公司已有 best_good_item (任意利好) 时, 减持类信号是 "利空出尽" 噪音, 抑制不入榜
            if best is info['best_bad_item'] and info['best_good_item'] is not None:
                bsigs = [s[0] for s in best.get('signals', [])]
                if any('减持' in lbl for lbl in bsigs):
                    continue
            # 去 PDF 原文提取关键数字 (按公告业务类型抓对应字段, 避免抓到无关数据)
            best_placement_assessment = best.get('placement_assessment') or {}
            best_pdf_facts = list(best_placement_assessment.get('facts') or [])
            if not best_pdf_facts:
                best_pdf_facts = _fetch_pdf_numbers(
                    best.get('title', ''),
                    best.get('announcementId', ''),
                    best.get('url', ''),
                    best.get('signals', []),
                )
            # v9.25b: 减持类 facts-based 升级 (Bug 4: 5%+ 大股东标题无 5%/比例 → PDF 升级)
            # 标题只命中"股东减持(无比例) -2", 但 PDF 主体含"5%以上"或"≥2% 比例" → 升级
            # 实控人/5% 大股东走 -5, ≥2% 走 -7
            best_signals_now = best.get('signals', [])
            if best.get('score', 0) < 0 and any('减持' in lbl for lbl, _ in best_signals_now):
                _facts_text = ' '.join(best_pdf_facts or [])
                _has_5pct = re.search(r'5[%％]以上|持股5%以上股东|占[^总]{0,4}总股本[^0-9]{0,4}[2-9]', _facts_text)
                _has_2pct = re.search(r'占总股本[^0-9]{0,4}([0-9.]+)[ ]*[%％]', _facts_text)
                _pct = float(_has_2pct.group(1)) if _has_2pct else 0
                new_label = None
                new_score = None
                # 优先级: ≥2% 比例 → -7 强利空; 否则 5% 以上 → -5 中利空
                if _pct >= 2:
                    new_label, new_score = '≥2% 大股东减持', -7
                elif _has_5pct:
                    new_label, new_score = '大股东减持', -5
                if new_label:
                    for i, (lbl, sc) in enumerate(best_signals_now):
                        if lbl in ('股东减持(无比例)', '股东减持(含比例)'):
                            old_sc = sc
                            best_signals_now[i] = (new_label, new_score)
                            best['signals'] = best_signals_now
                            best['score'] = best['score'] - old_sc + new_score
                            break
            # PDF 抓不到数字时, 用标题限定词补位 (如"预中标/草案/提示性")
            title_qualifiers = _extract_title_qualifiers(best.get('title', ''))
            # v9.39: 业绩预告 facts (从预扫描) 必须置顶, 否则 _fetch_pdf_numbers 兜底
            # 会覆盖成"比例 118.68%" 等抓数, 丢失 业绩预告同比/预计净利润
            forecast_facts = best.get('forecast_facts', []) or []
            # 合并: PDF 数字在前, 标题限定词在后
            if best_pdf_facts:
                # 如果 PDF 已抓到"进展: X"等事件性事实, 过滤掉"提示性公告"等冗余状态
                has_event = any(f.startswith(("进展:", "完成", "解锁")) for f in best_pdf_facts)
                if has_event:
                    title_qualifiers = [q for q in title_qualifiers if "提示性公告" not in q]
                # 业绩预告 facts 优先级最高 (主谓宾句子的核心数字来源)
                best_facts_final = forecast_facts + best_pdf_facts + title_qualifiers
            else:
                # 抓数失败时限定词放最前, 让用户先看到"这是草案/预中标"
                # 业绩预告 facts 仍需置顶 (即使 PDF 没抓到)
                best_facts_final = (forecast_facts + title_qualifiers) if title_qualifiers else (forecast_facts or best_pdf_facts)
            entry = {
                'code': best['code'],
                'company': best['name'],
                'industry': best['industry'],
                'best_score': best['score'],
                'ann_count': len(info['items']),
                'best_title': best['title'],
                'best_signals': best['signals'],
                'best_time': best['time'],
                'best_date': best.get('ann_date', ''),
                'best_url': best.get('url', ''),
                'best_facts': best_facts_final,  # PDF数字 + 标题限定词, 喂给 PDF/Excel 渲染
                'best_placement_assessment': best_placement_assessment,
            }
            # v9.8: 减持/增持 按"百分比"标尺排序 (权重 best_score 不变, 仅影响列表顺序)
            if entry['best_score'] < 0:
                entry['reduce_pct'] = _extract_scale(best_facts_final, 'reduce')
            elif entry['best_score'] > 0:
                entry['increase_scale'] = _extract_scale(best_facts_final, 'increase')
            # v9.12: 增持 双信号去重 + 补比例 fact (老板 6/11 原话"双信号只 +5, 不重复" + "金额不是绝对, 要看比例")
            entry = _handle_dual_signal(entry)
            # v9.13: 收入类信号 (中标/重大合同 / 技术许可 / 战略合作) 按 收入贡献比例 调档
            entry = _enrich_income_signal_by_revenue(entry)
            # v9.26: 预中标/日常经营合同降档 — 标题含'预中标'时 +7 → +3 (必须在 revenue enrichment 之后, 避免双重降档)
            entry = _v9_26_bid_downgrade(entry)
            # v9.28: 增持计划阶段降档 — 标题含"增持计划"未含"完成/实施进展"时 +5 → +3
            entry = _v9_28_increase_plan_downgrade(entry)
            # v9.28: 增持金额极小降档 — PDF 抓到金额 < 100 万时 +5 → +3
            entry = _v9_28_increase_amount_gate(entry)
            # v6: 股价位置信号升级 (低位增持 / 高位减持) — 必须先于 _build_one_liner
            # 否则 sentence 拿不到 is_price_upgraded 标志
            entry = _enrich_price_position(entry)
            # v9.20: 股份回购金额门槛 — PDF 抓到"回购金额" < 1 亿元 → 降档 (中利多 +4 → 弱利多 +3)
            # 必须先于 _build_one_liner, 这样 _build_one_liner 看到的 signals 已是降档后的
            entry = _v9_20_buyback_amount_gate(entry)
            # 一句话概括 (业务定性 + 关键数字), enrich 后再 build 才能反映股价位置
            entry['best_summary'] = _build_one_liner(
                best.get('title', ''),
                best_facts_final,
                _classify_announcement(best.get('title', ''), best.get('signals', [])),  # 用原 signals
                entry['best_signals'],
                entry.get('is_price_upgraded'),
                company_name=best.get('name', '') or entry.get('name', ''),
            )
            if entry['best_score'] > 0:
                pos_companies.append(entry)
            elif entry['best_score'] < 0:
                neg_companies.append(entry)

    # v9.9 排序规则 (6/11 老板拍): 分数是主键, 减持/增持比例是同分时的 tiebreaker
    #   利好: best_score DESC (大→小), increase_scale DESC (大→小, 无标尺排同分末尾)
    #   利空: best_score ASC (小→大, 即最利空在前), reduce_pct DESC (大→小, 无标尺排同分末尾)
    # 没标尺的 (reduce_pct/increase_scale=0) 在同分内放末尾
    pos_companies.sort(key=lambda x: (-x['best_score'], x.get('increase_scale', 0) == 0, -x.get('increase_scale', 0)))
    neg_companies.sort(key=lambda x: (x['best_score'], x.get('reduce_pct', 0) == 0, -x.get('reduce_pct', 0)))

    # v9.30: -6 ~ -1 弱/中利空 → 中性但保持负分 (老板铁律)
    # 原因: 弱/中利空 (董监高离职/小额减持/问询函/题材澄清 等) 是噪音, 不应污染利空段
    # 实施: neg_companies 中 best_score in [-6, -1] 的 entry 移到 neu_with_neg_score
    # 注意: 不删 entry, 不改 best_score, 仅按规则分流; -7~-10 强利空 保留在 neg_companies
    neu_with_neg_score = []
    _filtered_neg = []
    for _entry in neg_companies:
        if _v9_30_neutral_neg_bucket(_entry):
            neu_with_neg_score.append(_entry)
        else:
            _filtered_neg.append(_entry)
    neg_companies = _filtered_neg

    # v9.33.1: 老板 6/16 拍: "利空我只看 -7 到 -10 分的" → 只在 PDF 渲染时过滤
    # analyze.py 输出全档位 (-1 ~ -10), 不在这里动; PDF 渲染时 build_pdf._section_top5 自己过滤
    # Excel 拿全档位, 跟老板 "其余的所有内容都应该在 excel 中" 对齐
    strong_bad_count = sum(1 for e in neg_companies if e['best_score'] <= STRONG_BAD_DISPLAY_THRESHOLD)

    # neu_with_neg_score 按 |score| 降序排 (弱的在前, 强利空后)
    neu_with_neg_score.sort(key=lambda x: (x['best_score'], -x.get('reduce_pct', 0)))

    # 全量入榜 (Skill v2: 每日全部利好/利空, 不再 [:5] 截断)
    # rank 按 best_score 排序顺序 (利好 1→N / 利空 1→N)
    top_good, top_bad = [], []
    for i, c in enumerate(pos_companies, 1):
        c['rank'] = i
        c['conclusion'] = derive_conclusion(c)
        c['event'] = c['best_title']
        c['logic'] = derive_logic(c)
        top_good.append(c)
    for i, c in enumerate(neg_companies, 1):
        c['rank'] = i
        c['conclusion'] = derive_conclusion(c)
        c['event'] = c['best_title']
        c['logic'] = derive_logic(c)
        top_bad.append(c)

    good_count = sum(1 for x in processed_items if x['score'] > 0)
    bad_count = sum(1 for x in processed_items if x['score'] < 0)
    good_sectors = Counter(c['industry'] for c in pos_companies[:30])
    bad_sectors = Counter(c['industry'] for c in neg_companies[:30])

    if good_count > bad_count * 1.5:
        sentiment_summary = f"全市场偏多({good_count} 利好 vs {bad_count} 利空),资金风险偏好提升。"
    elif bad_count > good_count * 1.5:
        sentiment_summary = f"全市场偏空({good_count} 利好 vs {bad_count} 利空),避险情绪上升。"
    else:
        sentiment_summary = f"全市场多空均衡({good_count} 利好 vs {bad_count} 利空),无明确单边方向。"

    focus_targets, focus_logic_parts = [], []
    for c in top_good[:2]:
        sig_names = [s[0] for s in c['best_signals']]
        focus_targets.append(f"{c['company']}({c['code']}) - {','.join(sig_names[:2])}")
        focus_logic_parts.append(f"#{c['rank']} {c['company']}:{c['conclusion']},行业:{c['industry']}")

    # v9.33: 利空 风险回避 也只取 <= -7 (强利空), 跟老板 "利空我只看 -7 到 -10 分的" 对齐
    # 防止某天没强利空时, top_bad[:2] 取到弱/中利空 误进 PDF 风险回避段
    top_bad_strong = [c for c in top_bad if c.get("best_score", 0) <= -7]
    avoid_targets, avoid_logic_parts = [], []
    for c in top_bad_strong[:2]:
        sig_names = [s[0] for s in c['best_signals']]
        avoid_targets.append(f"{c['company']}({c['code']}) - {','.join(sig_names[:2])}")
        avoid_logic_parts.append(f"#{c['rank']} {c['company']}:{c['conclusion']},行业:{c['industry']}")

    sector_view = ""
    # 过滤掉"其他"行业 (分类失败的噪声), 选行业类别最多的作代表
    good_inds = [(k, v) for k, v in good_sectors.items() if k != "其他"]
    bad_inds = [(k, v) for k, v in bad_sectors.items() if k != "其他"]
    if good_inds and bad_inds:
        top_g = max(good_inds, key=lambda x: x[1])[0]
        top_b = max(bad_inds, key=lambda x: x[1])[0]
        sector_view = f"利好板块 {top_g},利空板块 {top_b};若两者重叠说明板块内部分化明显。"
    elif good_inds:
        sector_view = f"资金集中流入 {max(good_inds, key=lambda x: x[1])[0]} 板块。"
    elif bad_inds:
        sector_view = f"资金集中流出 {max(bad_inds, key=lambda x: x[1])[0]} 板块。"

    output = {
        'date': end_date,
        'start_date': start_date,
        'end_date': end_date,
        'fetch_meta': {
            'total': len(anns),
            'is_complete': raw_data.get('is_complete', True),
            'columns': fetch_meta,
        },
        'sentiment': {
            'good_count': good_count,
            'bad_count': bad_count,                                  # 全口径: -1~-10 全部利空
            'strong_bad_count': strong_bad_count,                   # v9.33: 强利空 (<= -7)
            'neutral_count': len(anns) - good_count - bad_count,
            'good_sectors': [s for s, _ in good_sectors.most_common(5)],
            'bad_sectors': [s for s, _ in bad_sectors.most_common(5)],  # v9.33: 已过滤 -7 以下
            'summary': sentiment_summary,
        },
        'excluded_summary': [r for r, _ in neutral_reasons.most_common()],
        'neutral_announcements': neutral_announcements,  # 中性公告明细 (公司/标题/原因)
        'coverage': {
            'start_date': start_date,
            'end_date': end_date,
            'range_label': (start_date if start_date == end_date else f'{start_date} ~ {end_date}'),
            'day_count': 1 if start_date == end_date else (
                (datetime.strptime(end_date, '%Y-%m-%d') - datetime.strptime(start_date, '%Y-%m-%d')).days + 1
            ),
            # v9.37: 实际数据日 (raw announcementTime 分日) + 周中/周末提示
            **_coverage_weekend_note(start_date, end_date, raw_data.get('announcements', [])),
        },
        'per_day': dict(Counter(it['ann_date'] for it in processed_items if it.get('ann_date'))),
        'top_good': top_good,
        'top_bad': top_bad,
        # 每日全部利好/利空 sheet 显示全量 (v9.8 放开 [:20] 截断, 让 限制性股票 +2 等弱利多也能入表)
        'all_good_companies': pos_companies,
        'all_bad_companies': neg_companies,
        'neu_with_neg_score': neu_with_neg_score,  # v9.30: -6~-1 弱/中利空 中性化段, 保持负分
        'short_term': {
            'focus_targets': focus_targets,
            'focus_logic': '; '.join(focus_logic_parts),
            'avoid_targets': avoid_targets,
            'avoid_logic': '; '.join(avoid_logic_parts),
            'sector_view': sector_view,
            'key_themes': ' / '.join([s for s, _ in good_sectors.most_common(3)] + [s for s, _ in bad_sectors.most_common(3)]),
        },
        'score_distribution': dict(Counter(
            '强利多 (≥+7)' if s >= 7 else
            '中利多 (+4~+6)' if s >= 4 else
            '弱利多 (+1~+3)' if s >= 1 else
            '弱利空 (-1~-3)' if s >= -3 else
            '中利空 (-4~-6)' if s >= -6 else
            '强利空 (≤-7)'
            for s in [x['score'] for x in processed_items]
        )),
    }

    if output_path:
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        print(f"OK Processed: {output_path}")
        print(f"   {start_date} ~ {end_date}  | 公告总数: {len(anns)}  | 利好: {good_count}  | 利空: {bad_count}  | 中性: {output['sentiment']['neutral_count']}")
        print(f"   TOP5 利好: {[(c['company'], c['best_score']) for c in top_good]}")
        print(f"   TOP5 利空: {[(c['company'], c['best_score']) for c in top_bad]}")

    return output


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python3 analyze.py <raw_announcements.json> <output_processed.json>")
        sys.exit(1)
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        raw = json.load(f)
    out_path = Path(sys.argv[2])
    process(raw, out_path)
