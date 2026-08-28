#!/usr/bin/env python3
"""定增预案情景分类。

该模块只处理“定增/非公开发行/向特定对象发行股票预案”主文，
不对只有标题、没有可靠正文的定增机械性扣分。函数无 I/O、无网络依赖，
方便 analyze.py 在取得 PDF 文本后调用。
"""

import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple


Signal = Tuple[str, int]


_PLAN_EXCLUSIONS = re.compile(
    r"提示性公告|论证分析报告|论证报告|可行性分析报告|"
    r"募集资金使用可行性|审核意见|审核问询|落实函|回复报告|"
    r"摊薄即期回报|摊薄回报|董事会决议|监事会决议|股东大会"
)

_PLACEMENT_WORDS = re.compile(r"向特定对象发行|非公开发行|定向增发|定增")

_HIGH_GROWTH_WORDS = re.compile(
    r"AI|人工智能|算力|数据中心|高速光通信|光通信|光互联|CPO|NPO|"
    r"半导体|芯片|集成电路|先进封装|机器人|新能源|储能|"
    r"创新药|新药|生物医药|高景气|战略性新兴产业"
)

_EXPANSION_WORDS = re.compile(
    r"扩产|扩建|新建产能|产能(?:建设|扩充|提升|增加|爬坡)|"
    r"产业化(?:项目|能力建设|建设)|新建.{0,16}(?:生产线|工厂|基地)|"
    r"生产基地|制造基地|生产线|设备购置"
)

_CORE_BUSINESS_WORDS = re.compile(
    r"主营业务|主业|围绕.{0,20}(?:主营|核心业务|核心产品)|"
    r"现有业务|现有产品|核心器件|核心产品"
)

_FLOW_PURPOSE = r"补充流动资金|补流"
_DEBT_PURPOSE = r"偿还(?:银行)?(?:贷款|借款|债务|有息负债)|归还(?:银行)?(?:贷款|借款)"
_MONEY_RE = re.compile(r"([0-9][0-9,.]*)\s*(亿元|万元|元)")


def _normalise(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    value = value.replace("\u00a0", " ").replace("\u3000", " ")
    return re.sub(r"[ \t\r\n]+", " ", value).strip()


def is_canonical_placement_plan(title: str) -> bool:
    """仅识别定增预案主文，避免一套预案附件重复计分。"""
    compact = re.sub(r"\s+", "", _normalise(title))
    if not compact or "预案" not in compact:
        return False
    if _PLAN_EXCLUSIONS.search(compact):
        return False
    return bool(_PLACEMENT_WORDS.search(compact))


def _money_to_wan(number: str, unit: str) -> Optional[float]:
    try:
        value = float(number.replace(",", ""))
    except (TypeError, ValueError):
        return None
    if unit == "亿元":
        return value * 10000.0
    if unit == "万元":
        return value
    if unit == "元":
        return value / 10000.0
    return None


def _extract_total_raise(text: str) -> Optional[float]:
    values: List[float] = []
    pattern = re.compile(
        r"募集资金(?:总额)?\s*(?:预计)?\s*(?:不超过|不高于|上限(?:为)?|为)?\s*"
        r"(?:人民币)?\s*([0-9][0-9,.]*)\s*(亿元|万元|元)"
    )
    for match in pattern.finditer(text):
        # “拟使用/拟投入募集资金”是单个项目额，不是总额。
        prefix = text[max(0, match.start() - 14):match.start()]
        if re.search(r"使用|投入|用于", prefix):
            continue
        value = _money_to_wan(match.group(1), match.group(2))
        if value is not None and value > 0:
            values.append(value)
    return max(values) if values else None


def _extract_near_purpose_amount(text: str, purpose_pattern: str) -> Optional[float]:
    """抽取某用途对应金额，支持“3亿元补流”与“补流3亿元”两种语序。"""
    money = r"([0-9][0-9,.]*)\s*(亿元|万元|元)"
    patterns = (
        re.compile(money + r"[^,，;；。]{0,45}?(?:" + purpose_pattern + r")"),
        re.compile(r"(?:" + purpose_pattern + r")[^,，;；。]{0,55}?" + money),
    )
    values: List[float] = []
    for pattern in patterns:
        for match in pattern.finditer(text):
            value = _money_to_wan(match.group(1), match.group(2))
            if value is not None and value > 0:
                values.append(value)
    return max(values) if values else None


def _extract_industrial_amount(text: str, total_raise_wan: Optional[float]) -> Optional[float]:
    """优先汇总各产业项目的“拟使用募集资金”，同一金额在预案重复出现时去重。"""
    pattern = re.compile(
        r"拟(?:使用|投入)(?:本次)?募集资金(?:金额|额)?\s*"
        r"([0-9][0-9,.]*)\s*(亿元|万元|元)"
    )
    values = set()
    for match in pattern.finditer(text):
        # 用途词必须紧邻金额才排除。预案常在同一段连续列出多个
        # 产业项目后再列“补充流动资金”，窗口过大会把相邻项目误排除。
        context = text[max(0, match.start() - 28):min(len(text), match.end() + 28)]
        if re.search(_FLOW_PURPOSE + "|" + _DEBT_PURPOSE, context):
            continue
        value = _money_to_wan(match.group(1), match.group(2))
        if value is not None and value > 0:
            values.add(round(value, 4))
    if not values:
        return None
    candidates = set(values)
    if total_raise_wan is not None and len(candidates) > 1:
        candidates = {v for v in candidates if abs(v - total_raise_wan) > max(1.0, total_raise_wan * 0.001)}
        if not candidates:
            return None
    total = sum(candidates)
    if total_raise_wan is not None and total > total_raise_wan * 1.01:
        return None
    return total


_CN_DIGITS = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}


def _chinese_number(value: str) -> Optional[float]:
    value = (value or "").strip()
    if not value:
        return None
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value):
        return float(value)
    if "点" in value:
        integer, fraction = value.split("点", 1)
        base = _chinese_number(integer)
        if base is None or any(ch not in _CN_DIGITS for ch in fraction):
            return None
        return float(str(int(base)) + "." + "".join(str(_CN_DIGITS[ch]) for ch in fraction))
    if "百" in value:
        left, right = value.split("百", 1)
        hundreds = _CN_DIGITS.get(left, 1)
        rest = _chinese_number(right) if right else 0
        return float(hundreds * 100 + (rest or 0))
    if "十" in value:
        left, right = value.split("十", 1)
        tens = _CN_DIGITS.get(left, 1) if left else 1
        ones = _CN_DIGITS.get(right, 0) if right else 0
        return float(tens * 10 + ones)
    if all(ch in _CN_DIGITS for ch in value):
        return float("".join(str(_CN_DIGITS[ch]) for ch in value))
    return None


def _extract_issue_ratio_pct(text: str) -> Optional[float]:
    patterns = (
        re.compile(
            r"(?:不超过|不高于|上限(?:为)?|占)?[^。；]{0,35}?"
            r"发行前[^。；]{0,25}?总股本(?:的)?\s*百分之"
            r"([零〇一二两三四五六七八九十百点0-9.]+)"
        ),
        re.compile(
            r"(?:不超过|不高于|上限(?:为)?|占)?[^。；]{0,35}?"
            r"发行前[^。；]{0,25}?总股本(?:的)?\s*([0-9]+(?:\.[0-9]+)?)\s*%"
        ),
    )
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            return _chinese_number(match.group(1))

    # 少数预案只披露股数，没有直接披露百分比。
    issue_match = re.search(
        r"发行(?:股票)?数量[^。；]{0,40}?(?:不超过|上限为)\s*"
        r"([0-9][0-9,.]*)\s*(万股|股)", text
    )
    capital_match = re.search(
        r"发行前[^。；]{0,30}?总股本(?:为)?\s*([0-9][0-9,.]*)\s*(万股|股)", text
    )
    if issue_match and capital_match:
        issue = float(issue_match.group(1).replace(",", ""))
        capital = float(capital_match.group(1).replace(",", ""))
        if issue_match.group(2) == "万股":
            issue *= 10000
        if capital_match.group(2) == "万股":
            capital *= 10000
        if capital > 0:
            return issue / capital * 100.0
    return None


def _extract_lockup_months(text: str) -> Optional[int]:
    patterns = (
        re.compile(r"锁定期(?:为)?\s*([0-9]+|[一二两三四五六七八九十]+)\s*个月"),
        re.compile(r"限售期(?:为)?\s*([0-9]+|[一二两三四五六七八九十]+)\s*个月"),
        re.compile(r"发行结束之日起\s*([0-9]+|[一二两三四五六七八九十]+)\s*个月内不得转让"),
    )
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            value = _chinese_number(match.group(1))
            return int(value) if value is not None else None
    return None


def _extract_pricing(text: str, current_price: Optional[float]) -> Dict[str, Optional[float]]:
    result: Dict[str, Optional[float]] = {
        "fixed_issue_price": None,
        "pricing_floor_ratio": None,
        "issue_price_ratio_vs_current": None,
    }
    fixed_match = re.search(
        r"(?:本次)?发行价格(?:确定)?\s*(?:为|:) *\s*(?:人民币)?\s*"
        r"([0-9][0-9,.]*)\s*元(?:/股|每股)?", text
    )
    if fixed_match:
        result["fixed_issue_price"] = float(fixed_match.group(1).replace(",", ""))

    floor_match = re.search(
        r"发行价格不低于[^。]{0,180}?(?:交易均价|股票均价|均价)"
        r"[^。]{0,60}?(?:百分之([零〇一二两三四五六七八九十百点0-9.]+)|"
        r"([0-9]+(?:\.[0-9]+)?)\s*%)", text
    )
    if floor_match:
        pct = _chinese_number(floor_match.group(1) or floor_match.group(2))
        if pct is not None:
            result["pricing_floor_ratio"] = pct / 100.0

    fixed = result["fixed_issue_price"]
    if fixed is not None and current_price is not None and current_price > 0:
        result["issue_price_ratio_vs_current"] = fixed / float(current_price)
    return result


def _detect_investors(text: str) -> Dict[str, Optional[bool]]:
    unknown = bool(re.search(
        r"尚未确定(?:本次)?(?:具体)?(?:发行的)?发行对象|"
        r"发行对象不超过\s*[0-9一二三四五六七八九十两]+\s*名[^。]{0,180}?最终发行对象[^。]{0,80}?确定",
        text,
    ))

    role = r"控股股东|实际控制人|实控人|董事|高级管理人员|高管|管理层"
    magnitude = r"全额|全部|大额|全数|不低于[^。]{0,16}(?:亿元|万元)"
    internal = bool(
        re.search(r"(?:" + role + r")[^。]{0,80}?(?:" + magnitude + r")[^。]{0,35}?认购", text)
        or re.search(r"(?:" + role + r")[^。]{0,45}?认购[^。]{0,35}?(?:" + magnitude + r")", text)
        or re.search(r"发行对象(?:仅)?为[^。]{0,30}?(?:" + role + r")", text)
    )
    strategic = bool(
        re.search(r"(?:战略投资者|战略投资方|产业资本|产业投资者|头部产业资本|产业方)"
                  r"[^。]{0,80}?(?:认购|参与认购|引入)", text)
        or re.search(r"(?:认购|引入)[^。]{0,80}?(?:战略投资者|产业资本|产业投资者)", text)
    )
    pure_financial = bool(re.search(
        r"纯财务投资者|发行对象[^。]{0,80}?均为财务(?:性)?投资者|"
        r"财务(?:性)?投资者[^。]{0,50}?认购",
        text,
    ))
    known = None  # type: Optional[bool]
    if unknown:
        known = False
    elif internal or strategic or pure_financial or re.search(r"发行对象(?:仅)?为[^。]{1,100}", text):
        known = True
    return {
        "investors_known": known,
        "internal_subscription": internal,
        "strategic_subscription": strategic,
        "pure_financial_investors": pure_financial,
    }


def extract_placement_metrics(
    pdf_text: str,
    current_price: Optional[float] = None,
) -> Dict[str, Any]:
    """从预案 PDF 文本抽取可用于分类的量化与情景要素。"""
    text = _normalise(pdf_text)
    total = _extract_total_raise(text)
    flow = _extract_near_purpose_amount(text, _FLOW_PURPOSE)
    debt = _extract_near_purpose_amount(text, _DEBT_PURPOSE)

    combined = _extract_near_purpose_amount(
        text,
        r"(?:补充流动资金|补流)(?:及|与|和)(?:" + _DEBT_PURPOSE + r")",
    )
    high_interest = bool(
        re.search(_DEBT_PURPOSE, text)
        and re.search(r"高息债务|高利率债务|高成本有息负债", text)
        and re.search(r"降低财务费用|减少利息支出|降低利息费用", text)
    )

    flow_value = flow or 0.0
    debt_value = debt or 0.0
    ordinary_debt = 0.0 if high_interest else debt_value
    if combined is not None:
        liquidity_ordinary = combined
    else:
        liquidity_ordinary = flow_value + ordinary_debt

    industrial_amount = _extract_industrial_amount(text, total)
    if industrial_amount is None and total is not None and liquidity_ordinary > 0 and _EXPANSION_WORDS.search(text):
        industrial_amount = max(0.0, total - liquidity_ordinary)

    direct_industrial_pct = None
    ratio_match = re.search(
        r"(?:产业项目|产业化项目|扩产项目|项目建设)"
        r"[^。]{0,60}?(?:占募集资金(?:总额)?|比例为)\s*([0-9]+(?:\.[0-9]+)?)\s*%", text
    )
    if ratio_match:
        direct_industrial_pct = float(ratio_match.group(1))

    industrial_ratio = None
    if direct_industrial_pct is not None:
        industrial_ratio = direct_industrial_pct / 100.0
        if industrial_amount is None and total is not None:
            industrial_amount = total * industrial_ratio
    elif total is not None and industrial_amount is not None and total > 0:
        industrial_ratio = max(0.0, min(1.0, industrial_amount / total))

    liquidity_ratio = None
    if total is not None and total > 0 and liquidity_ordinary > 0:
        liquidity_ratio = max(0.0, min(1.0, liquidity_ordinary / total))
    elif total is not None and total > 0 and re.search(_FLOW_PURPOSE + "|" + _DEBT_PURPOSE, text):
        liquidity_ratio = 0.0

    issue_ratio_pct = _extract_issue_ratio_pct(text)
    pricing = _extract_pricing(text, current_price)
    investors = _detect_investors(text)

    metrics: Dict[str, Any] = {
        "has_reliable_text": bool(text),
        "total_raise_wan": total,
        "liquidity_amount_wan": flow,
        "ordinary_debt_amount_wan": ordinary_debt if debt is not None and not high_interest else None,
        "high_interest_debt_amount_wan": debt if high_interest else None,
        "liquidity_and_ordinary_debt_wan": liquidity_ordinary if (flow is not None or debt is not None or combined is not None) else None,
        "liquidity_and_ordinary_debt_ratio": liquidity_ratio,
        "liquidity_and_ordinary_debt_pct": liquidity_ratio * 100.0 if liquidity_ratio is not None else None,
        "industrial_project_amount_wan": industrial_amount,
        "industrial_project_ratio": industrial_ratio,
        "industrial_project_pct": industrial_ratio * 100.0 if industrial_ratio is not None else None,
        "issue_ratio_pre_capital": issue_ratio_pct / 100.0 if issue_ratio_pct is not None else None,
        "issue_ratio_pre_capital_pct": issue_ratio_pct,
        "lockup_months": _extract_lockup_months(text),
        "pricing_type": (
            "fixed" if pricing["fixed_issue_price"] is not None
            else "auction_floor" if pricing["pricing_floor_ratio"] is not None
            else "unknown"
        ),
        "fixed_issue_price": pricing["fixed_issue_price"],
        "pricing_floor_ratio": pricing["pricing_floor_ratio"],
        "issue_price_ratio_vs_current": pricing["issue_price_ratio_vs_current"],
        "high_growth_sector": bool(_HIGH_GROWTH_WORDS.search(text)),
        "specific_expansion": bool(_EXPANSION_WORDS.search(text)),
        "core_business_fit": bool(_CORE_BUSINESS_WORDS.search(text)),
        "high_interest_debt_repayment": high_interest,
    }
    metrics.update(investors)
    return metrics


def _format_yi(wan: float) -> str:
    return "{:.2f}亿元".format(wan / 10000.0)


def analyze_placement_plan(
    title: str,
    pdf_text: str,
    current_price: Optional[float] = None,
    price_position: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    对一份定增预案评分。

    返回的 ``signals`` 沿用 analyze.py 的 ``(label, score)`` 形式；
    未知发行价格/对象不计分，正文不可用时返回 0 分。
    """
    if not is_canonical_placement_plan(title):
        return {
            "is_placement_plan": False,
            "score": 0,
            "signals": [],
            "facts": [],
            "metrics": {},
            "reasons": ["非定增预案主文，不进入情景评分"],
        }

    metrics = extract_placement_metrics(pdf_text, current_price=current_price)
    signals: List[Signal] = []
    reasons: List[str] = []

    industrial_ratio = metrics.get("industrial_project_ratio")
    qualified_expansion = bool(
        industrial_ratio is not None and industrial_ratio >= 0.50
        and metrics.get("specific_expansion")
        and metrics.get("high_growth_sector")
        and metrics.get("core_business_fit")
    )
    liquidity_ratio = metrics.get("liquidity_and_ordinary_debt_ratio")

    # 募资用途只取一个主分类，避免“合格扩产 + 部分补流”对同一资金结构重复计分。
    if qualified_expansion:
        signals.append(("定增投向主业扩产", 7))
        reasons.append(
            "产业项目占募资{:.2f}%，投向高景气主业的具体扩产/产业化项目".format(
                industrial_ratio * 100.0
            )
        )
        if liquidity_ratio is not None and liquidity_ratio >= 0.20:
            reasons.append(
                "补流/普通还贷占募资{:.2f}%，作为资金结构风险提示，不重复扣减扩产分".format(
                    liquidity_ratio * 100.0
                )
            )
    elif liquidity_ratio is not None and liquidity_ratio >= 0.50:
        signals.append(("定增补流/还贷为主", -2))
        reasons.append("补流/普通还贷占募资{:.2f}%，缺少主导性新增盈利项目".format(liquidity_ratio * 100.0))
    elif liquidity_ratio is not None and liquidity_ratio >= 0.20:
        signals.append(("定增补流占比较高", -1))
        reasons.append("补流/普通还贷占募资{:.2f}%，且未构成合格主业扩产".format(liquidity_ratio * 100.0))

    issue_ratio_pct = metrics.get("issue_ratio_pre_capital_pct")
    if issue_ratio_pct is not None and issue_ratio_pct >= 30.0:
        signals.append(("定增严重稀释", -5))
        reasons.append("发行上限占发行前总股本{:.2f}%，达到严重稀释阈值".format(issue_ratio_pct))

    if metrics.get("internal_subscription"):
        signals.append(("定增内部人认购", 3))
        reasons.append("实控人/大股东/高管明确全额或大额认购，利益绑定")

    if metrics.get("strategic_subscription"):
        signals.append(("定增产业资本认购", 2))
        reasons.append("明确引入产业资本/战略投资者，可能带来客户、供应链或技术资源")

    if metrics.get("high_interest_debt_repayment"):
        signals.append(("定增偿还高息债", 2))
        reasons.append("明确偿还高息/高成本债务并降低财务费用")

    price_ratio = metrics.get("issue_price_ratio_vs_current")
    if price_ratio is not None and price_ratio >= 0.95:
        signals.append(("定增高价发行", 3))
        reasons.append("固定发行价为当前股价的{:.2f}%，折价很小或溢价".format(price_ratio * 100.0))
    elif price_ratio is not None and price_ratio <= 0.80:
        signals.append(("定增大幅折价", -3))
        reasons.append("固定发行价不高于当前股价的80%，存在明显套利空间")
    elif metrics.get("pricing_type") == "auction_floor":
        reasons.append("仅披露询价底价，实际发行折价未知，暂不计分")

    price_position = price_position or {}
    ratio_vs_avg = price_position.get("ratio_vs_avg")
    pos_60d = price_position.get("pos_60d")
    high_position = (
        (isinstance(ratio_vs_avg, (int, float)) and ratio_vs_avg > 1.10)
        or (isinstance(pos_60d, (int, float)) and pos_60d > 0.70)
    )
    if high_position:
        signals.append(("定增高位发行", -2))
        reasons.append("预案公告时股价处于近60日高位，后续折价定价及解禁压力风险较高")

    if (
        metrics.get("pure_financial_investors")
        and not metrics.get("internal_subscription")
        and not metrics.get("strategic_subscription")
    ):
        signals.append(("定增纯财务投资", -1))
        reasons.append("已明确为纯财务投资者，且无内部人或产业资本认购")

    if metrics.get("investors_known") is False:
        reasons.append("发行对象尚未确定，内部人/产业资本背书暂不计分")

    if not signals and not metrics.get("has_reliable_text"):
        reasons.append("无可靠预案正文要素，不按“定增”标题机械扣分")

    facts: List[str] = []
    total = metrics.get("total_raise_wan")
    if total is not None:
        facts.append("募资总额: " + _format_yi(total))
    if industrial_ratio is not None:
        facts.append("产业项目占比: {:.2f}%".format(industrial_ratio * 100.0))
    if liquidity_ratio is not None:
        facts.append("补流/普通还贷占比: {:.2f}%".format(liquidity_ratio * 100.0))
    if issue_ratio_pct is not None:
        facts.append("发行上限占发行前股本: {:.2f}%".format(issue_ratio_pct))
    if metrics.get("lockup_months") is not None:
        facts.append("锁定期: {}个月".format(metrics["lockup_months"]))
    if metrics.get("pricing_type") == "auction_floor":
        floor = metrics.get("pricing_floor_ratio")
        facts.append("定价: 询价发行，底价为基准均价{:.0f}%".format((floor or 0) * 100.0))
    elif metrics.get("fixed_issue_price") is not None:
        facts.append("固定发行价: {:.2f}元/股".format(metrics["fixed_issue_price"]))
    if metrics.get("investors_known") is False:
        facts.append("发行对象: 尚未确定")
    elif metrics.get("investors_known") is True:
        facts.append("发行对象: 已确定")

    return {
        "is_placement_plan": True,
        "score": sum(weight for _, weight in signals),
        "signals": signals,
        "facts": facts,
        "metrics": metrics,
        "reasons": reasons,
    }


# 语义更直观的别名，便于调用方按项目风格选择。
classify_placement_plan = analyze_placement_plan


__all__ = [
    "analyze_placement_plan",
    "classify_placement_plan",
    "extract_placement_metrics",
    "is_canonical_placement_plan",
]
