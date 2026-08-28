#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""风险提示公告筛选与评分。

第一版严格沿用巨潮资讯 watchlist, 只输出负向风险项。
"""
from __future__ import annotations

import csv
import io
import os
import re
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

import pdfplumber

HERE = Path(__file__).parent.resolve()
CNINFO_DIR = Path(os.environ.get("RESEARCH_CNINFO_DIR", str(HERE.parent / "cninfo")))
WATCHLIST_PATH = CNINFO_DIR / "watchlist.csv"
STRONG_RISK_THRESHOLD = -7
PDF_HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}


RISK_SIGNALS: List[Tuple[str, int, str, str]] = [
    ("退市/ST风险", -10, r"(?<!撤销)退市风险警示|实施退市|暂停上市|终止上市|退市整理期|重大违法退市", "强制退市或退市风险信号, 流动性与估值风险最高。"),
    ("立案调查", -10, r"立案调查|被立案|证监会.*立案|中国证券监督管理委员会.*立案|立案告知书", "监管立案意味着合规风险显著抬升。"),
    ("监管处罚", -10, r"证监会.*处罚|证监会.*行政处罚|信披违规.*处罚|市场禁入", "证监会级处罚确认违规事实, 估值折价风险高。"),
    ("业绩预减/预亏", -10, r"业绩预减|净利润预减|预计净利润.*下降|业绩预亏|预计亏损|净利润为负|首亏", "盈利预期下修或亏损暴露, 属核心经营风险。"),
    ("ST板块重整", -10, r"ST.*重整|ST.*预重整|公开招募重整投资人|重整计划(?!.*批准)", "ST公司重整通常对应经营恶化与退市压力。"),
    ("控股股东破产重整", -10, r"控股股东.*被申请破产重整|控股股东.*破产重整|预重整.*第一次债权人会议", "实控端债务风险暴露, 股权稳定性下降。"),
    ("≥2%大股东减持", -7, r"(?<!不)(?:5%以上股东|持股5%以上|控股股东|大股东).*减持.*?([0-9]+(?:\.[0-9]+)?)[ ]*%", "大股东较大比例减持, 短期供给与信心冲击强。"),
    ("大额资产减值", -7, r"商誉减值.*亿元|大额资产减值|计提减值.*亿元|计提.*减值准备.*亿元", "资产质量恶化, 可能压制利润与估值。"),
    ("重大诉讼/担保代偿", -7, r"重大诉讼.*亿元|重大仲裁.*亿元|担保.*代偿|债务逾期|连带担保", "诉讼、担保或债务风险可能形成实际现金流压力。"),
    ("控股股东股份司法处置", -7, r"控股股东.*股份.*司法拍卖|控股股东.*股份.*司法强制执行|控股股东.*股份.*司法变卖|控股股东.*股份.*流拍|大股东.*股份.*司法拍卖", "控股股东股份被司法处置, 实控端风险升高。"),
    ("ST风险警示", -7, r"其他风险警示|实施.*ST|被实施.*ST|实施ST|被ST", "ST或其他风险警示触发, 融资与流动性风险上升。"),
    ("终止资产重组", -7, r"终止.*发行股份.*购买资产|终止.*重大资产购买|终止.*重大资产出售|终止.*重大资产重组", "重组预期落空, 事件驱动逻辑中断。"),
    ("控股股东股份轮候冻结", -5, r"控股股东.*股份.*轮候冻结|实际控制人.*股份.*轮候冻结|控股股东.*轮候冻结", "实控端股份被轮候冻结, 流动性压力较高。"),
    ("大股东减持", -5, r"5%以上股东.*减持|持股5%以上.*减持|大额减持.*亿元|控股股东.*减持", "重要股东减持, 供给压力与信心冲击中高。"),
    ("严重异常波动风险提示", -8, r"股票交易严重异常波动.*风险提示.*公告|严重异常波动.*风险提示.*公告|严重异常波动.*交易风险提示.*公告", "严重异动叠加风险提示, 短线炒作降温风险较高。"),
    ("严重异常波动公告", -6, r"股票交易严重异常波动(?!.*风险提示).*公告|股票交易严重异常(?!.*风险提示).*公告", "严重异动接近监管关注, 情绪退潮风险上升。"),
    ("异常波动风险提示", -4, r"股票交易(?!严重异常).*异常波动.*(?:风险提示|交易风险提示).*公告|股票交易异常波动暨风险提示公告|股票交易异常波动暨交易风险提示公告", "普通异动叠加风险提示, 公司主动提示交易风险, 强于普通异动。"),
    ("监管问询函", -3, r"关注函|问询函|监管工作函|监管关注|警示函|监管警示函", "监管发函通常涉及信披或经营疑点。"),
    ("题材澄清/证伪", -3, r"题材.*澄清|业务.*澄清|不涉及.*热点|不涉及.*概念|营收占比.*极低", "市场炒作预期被证伪, 短线情绪承压。"),
    ("募投项目变更", -3, r"募投项目.*变更|募投项目.*调整|募集资金.*变更|部分募投项目.*延期|部分募投项目.*终止", "募投项目变更或延期, 资金使用效率存疑。"),
    ("可转债强赎提示", -3, r"转债.*强赎|转债.*提前赎回|提前赎回.*转债|转债.*停止转股", "强赎可能带来转股稀释压力。"),
    ("可转债回售提示", -3, r"转债.*回售|转债.*回售期", "回售意味着公司存在现金兑付压力。"),
    ("重大诉讼/仲裁(无金额)", -3, r"重大诉讼(?!.*亿元)|重大仲裁(?!.*亿元)|累计诉讼.*仲裁.*进展|担保.*诉讼|担保.*涉诉", "存在赔付或减值风险, 需跟踪金额。"),
    ("监管处罚(行业/环保/安监)", -3, r"行政处罚(?!.*证监会)|行政处罚决定书(?!.*证监会)|收到.*罚单(?!.*证监会)", "行业级处罚影响弱于证监会处罚, 但仍需关注。"),
    ("股东减持(含比例)", -3, r"股东.*减持.*?([0-9]+(?:\.[0-9]+)?)[ ]*%", "一般股东减持, 短期供给压力。"),
    ("转股价格下修", -2, r"转股价格.*下修|转股价.*向下修正|向下修正转股价", "下修转股价可能稀释老股东权益。"),
    ("董监高小额减持", -2, r"董事.*减持|监事.*减持|高管.*减持(?!.*5%以上)", "董监高减持规模通常较小, 但仍是弱风险。"),
    ("董监高离职", -2, r"高管.*离职|高级管理人员.*离职|核心技术人员.*离职|董事.*辞职|监事.*辞职", "核心人员变动需关注连续性。"),
    ("定增/可转债/配股", -2, r"定增.*预案|非公开发行.*预案|配股.*预案|可转债.*预案|发行可转债", "潜在股权稀释。"),
    ("转股价格上修", -2, r"转股价格.*上修|转股价格.*向上修正|转股价格.*调整|转股价.*除权", "转股意愿下降, 后续现金兑付压力可能上升。"),
    ("停牌", -2, r"停牌.*公告|重大事项.*停牌|筹划.*停牌", "停牌原因不明时先作为弱风险观察。"),
    ("异常波动公告", -2, r"股票交易(?!严重异常).*异常波动.*公告|股票交易异常波动的公告|股票交易异常波动公告", "普通股价异动披露, 更多作为观察项。"),
    ("股东减持(无比例)", -2, r"股东减持.*计划|股东减持.*结果|股东减持.*预披露", "减持公告未披露比例时按弱风险观察。"),
]


NEUTRAL_FILTERS: List[Tuple[str, str]] = [
    (r"撤销.*风险警示|撤销.*ST|撤销退市风险警示|撤销其他风险警示", "撤销风险警示/摘帽, 不算新风险"),
    (r"5%以上股东.*减持计划.*?(?:实施完成|完成|期限届满|届满)|持股5%以上.*减持计划.*?(?:实施完成|完成|期限届满|届满)|大股东.*?减持(?:计划|股份|公司股份).*?(?:实施完成|完成|期限届满|届满|减持结果|实施完毕)", "减持完成或届满, 不算新增减持风险"),
    (r"问询函的回复$", "问询函回复属程序性文件"),
    (r"并购重组.*问询函|重组.*问询函|年报.*问询函|年报事后审核.*问询函|年度报告.*问询函|向特定对象发行.*问询函|向不特定对象发行.*问询函", "审核/年报类问询按中性过滤"),
    (r".*股票交易风险提示.*公告$|.*不存在.*影响.*股价.*异常|.*股价异动.*公告$", "常规风险提示, 不构成强风险"),
    (r"(?:重组|并购重组|发行股份购买资产|收购股权).*?停牌|可转债.*停牌|转债.*停牌|停牌.*?(?:重组|并购重组|发行股份购买资产|收购股权|可转债|转债)", "重组/转债技术性停牌"),
    (r"解除质押(?!.*控股股东)(?!.*大股东)(?!.*股份冻结)(?!.*司法)|股份.*解除限售(?!.*控股股东)(?!.*大股东)(?!.*股份冻结)(?!.*司法)", "常规解除质押/限售"),
    (r"股份.*质押.*公告$(?!.*控股股东)(?!.*大股东)(?!.*股份冻结)(?!.*司法)(?!.*延期)", "常规股份质押"),
    (r"高管.*?(?:换届|改选|补选|退休|到期)|董事.*?(?:换届|改选|补选|退休|到期|到龄)|监事.*?(?:换届|改选|补选|退休|到期)", "董监高换届程序性事项"),
    (r"^.*离职.*?(?:管理制度|管理办法|实施细则|管理细则)(?!.*实际生效)", "离职制度文件"),
]


def _strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", "", s or "")
    return re.sub(r"\s+", "", s)


def _load_watchlist() -> Tuple[set, Dict[str, List[str]]]:
    codes = set()
    concepts: Dict[str, List[str]] = defaultdict(list)
    with WATCHLIST_PATH.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            code = str(row.get("stock_code", "")).zfill(6)
            if not code:
                continue
            codes.add(code)
            concept = row.get("concept_name", "")
            if concept and concept not in concepts[code]:
                concepts[code].append(concept)
    return codes, concepts


WATCHLIST_CODES, WATCHLIST_CONCEPTS = _load_watchlist()


def risk_level(score: int) -> str:
    if score <= -10:
        return "重大风险"
    if score <= -7:
        return "高风险"
    if score <= -5:
        return "中高风险"
    return "观察项"


def _neutral_reason(title: str) -> str:
    for pattern, reason in NEUTRAL_FILTERS:
        if re.search(pattern, title):
            return reason
    return ""


def _score_title(title: str) -> Tuple[int, List[Dict[str, object]]]:
    hits = []
    for label, score, pattern, judge in RISK_SIGNALS:
        if re.search(pattern, title):
            hits.append({"label": label, "score": score, "judge": judge})
    if not hits:
        return 0, []
    hits.sort(key=lambda x: int(x["score"]))
    return int(hits[0]["score"]), hits


def _one_liner(company: str, title: str, score: int, hits: List[Dict[str, object]]) -> str:
    if not hits:
        return f"{company}公告存在风险事项, 需进一步核查公告正文。"
    label = hits[0]["label"]
    judge = hits[0]["judge"]
    return f"{company}公告「{label}」, {judge}"


def _ann_url(ann: dict) -> str:
    adjunct = ann.get("adjunctUrl") or ""
    if adjunct.startswith("http"):
        return adjunct
    return f"http://static.cninfo.com.cn/{adjunct}" if adjunct else ""


def _stock_code(ann: dict) -> str:
    return str(ann.get("secCode") or ann.get("code") or "").zfill(6)


def _is_performance_forecast(title: str) -> bool:
    return bool(re.search(r"业绩预告|业绩预增|业绩预减|业绩预亏|业绩快报", title or ""))


def _pdf_text_cache_path(report_date: str, announcement_id: str) -> Path:
    return HERE / "output" / report_date / "raw" / f"pdf_text_{announcement_id}.txt"


def _download_pdf_text(url: str, report_date: str, announcement_id: str) -> Tuple[str, str]:
    if not url or not announcement_id:
        return "", "missing_url_or_id"
    cache = _pdf_text_cache_path(report_date, str(announcement_id))
    if cache.exists():
        return cache.read_text(encoding="utf-8"), "cache"
    try:
        req = urllib.request.Request(url, headers=PDF_HEADERS)
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = r.read()
        with pdfplumber.open(io.BytesIO(payload)) as pdf:
            text = "\n".join((page.extract_text() or "") for page in pdf.pages)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(text, encoding="utf-8")
        return text, "downloaded"
    except Exception as exc:
        return "", f"pdf_text_error:{type(exc).__name__}:{exc}"


def _to_float_wan(s: str) -> float | None:
    try:
        return float((s or "").replace(",", "").replace("，", ""))
    except ValueError:
        return None


def _format_wan(v: float | None) -> str:
    if v is None:
        return ""
    return str(int(v)) if float(v).is_integer() else f"{v:.2f}".rstrip("0").rstrip(".")


def _extract_net_profit_forecast(text: str) -> Dict[str, object]:
    if not text:
        return {}
    compact = re.sub(r"[ \t\r]+", " ", text)
    compact = re.sub(r"\s*\n\s*", "\n", compact)
    num = r"(-?\d[\d,，]*(?:\.\d+)?)"
    range_sep = r"(?:~|～|－|—|-{1,2}|至|到)"
    label = r"归属于上市公司股东的净利润"

    patterns = [
        rf"{label}[^\n。；;]*?(?:为人民币|为|预计为|：|:)?\s*{num}\s*{range_sep}\s*{num}\s*万元",
        rf"预计[^\n。；;]*?{label}[^\n。；;]*?{num}\s*{range_sep}\s*{num}\s*万元",
    ]
    for pattern in patterns:
        m = re.search(pattern, compact)
        if not m:
            continue
        low, high = _to_float_wan(m.group(1)), _to_float_wan(m.group(2))
        if low is None or high is None:
            continue
        if low > high:
            low, high = high, low
        return {
            "net_profit_min_wan": low,
            "net_profit_max_wan": high,
            "net_profit_text": f"{_format_wan(low)}~{_format_wan(high)}",
            "net_profit_source": "pdf_text_range",
        }

    exact_patterns = [
        rf"{num}\s*\n?{label}\s+\d[\d,，]*(?:\.\d+)?\s*\n?比上年同期",
        rf"{label}[^\n。；;]*?(?:为人民币|为|预计为|：|:)?\s*{num}\s*万元",
    ]
    for pattern in exact_patterns:
        m = re.search(pattern, compact)
        if not m:
            continue
        val = _to_float_wan(m.group(1))
        if val is None:
            continue
        return {
            "net_profit_min_wan": val,
            "net_profit_max_wan": val,
            "net_profit_text": _format_wan(val),
            "net_profit_source": "pdf_text_exact",
        }
    return {"net_profit_source": "pdf_text_no_match"}


def process(raw: dict) -> dict:
    anns = raw.get("announcements", []) if isinstance(raw, dict) else []
    risks: List[dict] = []
    watchlist_anns: List[dict] = []
    neutral_hits: List[dict] = []
    performance_forecasts: List[dict] = []

    report_date = raw.get("end_date") or raw.get("date") or datetime.now().strftime("%Y-%m-%d")

    for ann in anns:
        code = _stock_code(ann)
        title = _strip_html(ann.get("announcementTitle", ""))
        company = ann.get("secName") or ann.get("company") or ""
        concepts = WATCHLIST_CONCEPTS.get(code, [])
        base = {
            "code": code,
            "company": company,
            "title": title,
            "url": _ann_url(ann),
            "announcement_id": ann.get("announcementId", ""),
            "announcement_time": ann.get("announcementTime", ""),
            "concepts": concepts,
            "concept": " / ".join(concepts[:3]),
        }
        if _is_performance_forecast(title):
            text, status = _download_pdf_text(base["url"], report_date, str(base["announcement_id"]))
            base["profit_extract_status"] = status
            base.update(_extract_net_profit_forecast(text))
            performance_forecasts.append(base.copy())

        if code not in WATCHLIST_CODES:
            continue
        watchlist_anns.append(base)

        reason = _neutral_reason(title)
        if reason:
            neutral_hits.append({**base, "neutral_reason": reason})
            continue

        score, hits = _score_title(title)
        if score >= 0:
            continue
        risks.append({
            **base,
            "score": score,
            "risk_level": risk_level(score),
            "primary_signal": hits[0]["label"] if hits else "",
            "signals": hits,
            "summary": _one_liner(company, title, score, hits),
        })

    risks.sort(key=lambda x: (x["score"], x["code"], x["title"]))
    for i, item in enumerate(risks, 1):
        item["rank"] = i

    major = [x for x in risks if x["score"] <= STRONG_RISK_THRESHOLD]
    observations = [x for x in risks if x["score"] > STRONG_RISK_THRESHOLD]
    by_signal = Counter(x["primary_signal"] for x in risks)
    by_level = Counter(x["risk_level"] for x in risks)
    by_concept = Counter(c for x in risks for c in x.get("concepts", [])[:3])
    return {
        "project": "风险提示",
        "date": report_date,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "coverage": {
            "start_date": raw.get("start_date", report_date),
            "end_date": raw.get("end_date", report_date),
            "range_label": raw.get("se_date") or report_date,
            "raw_total": raw.get("total", len(anns)),
            "watchlist_ann_count": len(watchlist_anns),
            "performance_forecast_count": len(performance_forecasts),
            "watchlist_size": len(WATCHLIST_CODES),
        },
        "sentiment": {
            "risk_count": len(risks),
            "major_risk_count": len(major),
            "observation_count": len(observations),
            "risk_company_count": len({x["code"] for x in risks}),
            "major_risk_company_count": len({x["code"] for x in major}),
            "by_level": dict(by_level),
            "by_signal": dict(by_signal),
            "by_concept": dict(by_concept.most_common(10)),
        },
        "major_risks": major,
        "observations": observations,
        "risks": risks,
        "performance_forecasts": performance_forecasts,
        "watchlist_announcements": watchlist_anns,
        "neutral_hits": neutral_hits,
        "rules": {
            "pdf_threshold": STRONG_RISK_THRESHOLD,
            "watchlist_path": str(WATCHLIST_PATH),
            "risk_signal_count": len(RISK_SIGNALS),
            "neutral_filter_count": len(NEUTRAL_FILTERS),
        },
    }
