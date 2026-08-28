#!/usr/bin/env python3
"""
A 股业绩预告日报 - cninfo 数据拉取器
入参: <data_date YYYY-MM-DD> <output_dir>
逻辑: 双 column (sse+szse) 拉取 -> 公告 PDF 解析 -> 写 input.json
失败: 写空 input.json,标记降级原因
"""
import sys
import json
import re
import time
from pathlib import Path
from datetime import datetime
from io import BytesIO
import requests
import pypdf
from industry_map import lookup_subset

CNINFO_QUERY = "http://www.cninfo.com.cn/new/hisAnnouncement/query"
CNINFO_PDF_PREFIX = "http://static.cninfo.com.cn/"
HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Origin": "http://www.cninfo.com.cn",
    "Referer": "http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice",
}

# 已知 AI 大模型主题 A 股标的
AI_STOCK_CODES = {
    "688041", "688256", "688981", "300474", "300223", "002371",
    "688008", "688012", "688396", "603501", "688536", "688521",
    "002049", "300782", "300661", "688126", "688220",
    "300308", "300502", "300570", "002463", "002281", "300394",
    "000988", "002179", "300620", "002446",
    "300408", "300476", "300739", "600584", "002916", "603803",
    "002384", "002475", "300433", "300628", "002241",
    "300033", "002230", "300364", "300077", "300458", "300674",
    "300339", "300378", "300454", "002405", "300348", "300253",
    "300133", "300017", "300212", "300383", "002335",
    "600050", "601728", "300604", "300316", "300083", "002129",
    "002056", "000063", "000938", "300782", "300661",
}

AI_KEYWORDS = [
    "GPU", "CPU", "NPU", "TPU", "FPGA", "ASIC", "算力", "智算", "超算",
    "AI 芯片", "人工智能芯片", "AI 算力",
    "大模型", "大语言模型", "LLM", "通用人工智能", "AGI", "AIGC",
    "生成式 AI", "GPT", "文心", "通义", "盘古", "混元", "星火", "豆包",
    "AI 应用", "AI 技术", "AI 产品", "人工智能应用", "智能驾驶", "智能座舱", "智能机器人",
    "智能客服", "智能语音", "智能视觉",
    "机器学习", "深度学习", "神经网络",
    "数据中心", "IDC", "云计算", "云服务", "云算力",
    "服务器", "AI 服务器", "存储芯片", "HBM", "DDR5",
    "光模块", "光通信", "CPO", "LPO", "800G", "1.6T",
    "PCB", "IC 载板", "封装测试", "封测",
    "半导体", "集成电路", "IC 设计", "晶圆", "代工",
    "探针台", "分选机", "测试机",
    "AI 手机", "AI PC", "AI 眼镜", "AR", "VR", "MR",
    "智能穿戴", "智能音箱", "智能家居",
    "算力中心", "智算中心",
]

TITLE_KEYWORDS = ["业绩预告", "业绩预增", "业绩预减", "业绩预亏", "业绩预告修正", "业绩预盈"]
SEARCH_KEYS = ["业绩预告", "业绩预增", "业绩预减", "业绩预亏", "业绩预盈", "业绩预告修正"]


def fetch_cninfo(date_str, column, searchkey="业绩预告", retries=3):
    payload = {
        "pageNum": "1", "pageSize": "50", "column": column,
        "tabName": "fulltext", "plate": "", "stock": "",
        "searchkey": searchkey, "secid": "", "category": "",
        "trade": "", "seDate": f"{date_str}~{date_str}",
        "sortName": "", "sortType": "", "isHLtitle": "true",
    }
    for attempt in range(retries):
        try:
            r = requests.post(CNINFO_QUERY, data=payload, headers=HTTP_HEADERS, timeout=20)
            r.raise_for_status()
            return r.json().get("announcements", []) or []
        except Exception as e:
            print(f"[fetch_cninfo] {column} {searchkey} {date_str} attempt {attempt+1} failed: {e}", file=sys.stderr)
            time.sleep(2)
    return []


def fetch_all_cninfo(date_str, column):
    out = []
    for searchkey in SEARCH_KEYS:
        out.extend(fetch_cninfo(date_str, column, searchkey=searchkey))
        time.sleep(0.2)
    return out


def filter_titles(items):
    out = []
    for it in items:
        title = (it.get("announcementTitle") or "").replace("<em>", "").replace("</em>", "")
        if any(k in title for k in TITLE_KEYWORDS):
            out.append(it)
    return out


def dedup(items):
    seen, out = set(), []
    for it in items:
        aid = it.get("announcementId")
        if aid and aid not in seen:
            seen.add(aid)
            out.append(it)
    return out


def parse_pdf_text(pdf_bytes, max_pages=6):
    try:
        reader = pypdf.PdfReader(BytesIO(pdf_bytes))
        texts = []
        for i, page in enumerate(reader.pages[:max_pages]):
            try:
                texts.append(page.extract_text() or "")
            except Exception:
                continue
        return "\n".join(texts)
    except Exception as e:
        print(f"[parse_pdf_text] failed: {e}", file=sys.stderr)
        return ""


def download_pdf(pdf_url, name, retries=3):
    for attempt in range(retries):
        try:
            r = requests.get(pdf_url, headers=HTTP_HEADERS, timeout=30)
            r.raise_for_status()
            return r.content
        except Exception as e:
            print(f"[fetch_cninfo] pdf dl fail {name} attempt {attempt+1}/{retries}: {e}", file=sys.stderr)
            time.sleep(2)
    return b""


def extract_company_code(sec_code):
    return sec_code.split(",")[0].strip()


def classify_ai(sec_code, name, pdf_text):
    code = extract_company_code(sec_code)
    if code in AI_STOCK_CODES:
        return 1, f"代码 {code} 在 AI 主题标的清单"
    hits = [k for k in AI_KEYWORDS if k.lower() in pdf_text.lower()]
    if hits:
        return 1, f"主营产品命中 AI 关键词: {', '.join(hits[:3])}"
    return 0, ""


def extract_yjyg_fields(pdf_text):
    result = {
        "预告类型": "", "下限万元": None, "上限万元": None,
        "上年同期万元": None, "同比下限%": None, "同比上限%": None,
        "同比变动说明": "", "口径": "归母净利润",
    }
    def normalize_grouped_numbers(raw):
        return re.sub(r"(?<=\d)[,，]\s+(?=\d{3}(?:\D|$))", ",", raw or "")

    text = normalize_grouped_numbers(pdf_text)
    flat_text = normalize_grouped_numbers(re.sub(r"\s+", " ", text or "").strip())

    def parse_amount(raw, unit="万元", negative=False):
        val = float(raw.replace(",", "").replace("，", "").replace("－", "-"))
        if unit == "亿元":
            val *= 10000
        if negative and val > 0:
            val = -val
        return val

    def parse_percent(raw, negative=False):
        val = float(raw.replace(",", "").replace("，", "").replace("－", "-"))
        if negative and val > 0:
            val = -val
        return val

    def is_loss_label(raw):
        return "亏损" in str(raw or "")

    def calc_yoy_pct(current, previous):
        if current is None or previous in (None, "", 0):
            return None
        try:
            return (float(current) - float(previous)) / abs(float(previous)) * 100
        except (TypeError, ValueError, ZeroDivisionError):
            return None

    def apply_percent_from_context(context):
        if result["同比下限%"] is not None and result["同比上限%"] is not None:
            return
        patterns = [
            r"(?:同比|比\s*上\s*年\s*同\s*期)[^。；;]{0,80}?(下降|减少|增长|增加|上升|减亏|增亏)?\s*([+\-]?[0-9,，.]+)\s*%\s*[至~到～\-–—]\s*([+\-]?[0-9,，.]+)\s*%",
            r"(下降|减少|增长|增加|上升|减亏|增亏)\s*([+\-]?[0-9,，.]+)\s*%\s*[至~到～\-–—]\s*([+\-]?[0-9,，.]+)\s*%",
        ]
        for pattern in patterns:
            m = re.search(pattern, context or "")
            if not m:
                continue
            try:
                direction = re.sub(r"\s+", "", m.group(1) or "")
                pct_negative = direction in ("下降", "减少", "增亏")
                result["同比下限%"] = parse_percent(m.group(2), negative=pct_negative)
                result["同比上限%"] = parse_percent(m.group(3), negative=pct_negative)
                return
            except (TypeError, ValueError):
                continue

    def parse_previous_from_segment(prev_part):
        part = prev_part or ""
        if not re.search(r"上\s*年\s*同\s*期|亏\s*损|盈\s*利|净\s*利\s*润", part):
            return None
        if re.search(r"与?\s*上\s*年\s*同\s*期.*?(?:增\s*加|减\s*少|增\s*长|下\s*降|上\s*升|减\s*亏|增\s*亏)", part):
            return None
        previous_numbers = re.findall(r"(亏损|盈利)?[:：]?\s*([+\-－]?[0-9,，.]+)", part)
        for previous_label, previous_raw in reversed(previous_numbers):
            if not previous_label and not re.search(r"上\s*年\s*同\s*期|净\s*利\s*润", part):
                continue
            try:
                return parse_amount(previous_raw, negative=is_loss_label(previous_label))
            except (TypeError, ValueError):
                continue
        return None

    profit_label_pat = (
        r"归\s*属\s*于(?:上\s*市\s*公\s*司\s*股\s*东|母\s*公\s*司\s*股\s*东|母\s*公\s*司\s*所\s*有\s*者)"
        r"\s*的?\s*净\s*利\s*润"
    )

    selected_type = re.search(r"[☑√■●]\s*(亏损|扭亏为盈|同向上升|同向下降)", text)
    if selected_type:
        result["预告类型"] = {
            "亏损": "续亏",
            "扭亏为盈": "扭亏",
            "同向上升": "预增",
            "同向下降": "预减",
        }.get(selected_type.group(1), "")

    if not result["预告类型"] and ("扭亏为盈" in text or "实现扭亏" in text or "同比扭亏" in text):
        result["预告类型"] = "扭亏"

    if "增亏" in text or "同比增亏" in text or "减亏" in text:
        result["预告类型"] = result["预告类型"] or "续亏"
    for k, v in [("预增", "预增"), ("预减", "预减"), ("续亏", "续亏"),
                 ("首亏", "首亏"), ("续盈", "续盈"), ("略增", "略增"),
                 ("略减", "略减"), ("扭亏", "扭亏")]:
        if result["预告类型"]:
            break
        if k in text:
            result["预告类型"] = v
            break
    if not result["预告类型"]:
        if "同向上升" in text or "比上年同期增长" in text:
            result["预告类型"] = "预增"
        elif "同向下降" in text or "比上年同期下降" in text:
            result["预告类型"] = "预减"

    if not result["预告类型"]:
        for k, v in [("盈利", "续盈"), ("亏损", "续亏"), ("不确定", "不确定")]:
            if k in text:
                result["预告类型"] = v
                break

    pat_table = (
        r"归属于上市公\s*司\s*股\s*东?的?净利\s*润?\s*"
        r"(亏损[:：]?\s*)?([+\-－]?[0-9,，.]+)\s*(?:万\s*元?)?\s*[～~至到\-–—]\s*"
        r"([+\-－]?[0-9,，.]+)\s*(?:万\s*元?)?\s*"
        r"(亏损[:：]?\s*)?([+\-－]?[0-9,，.]+)?\s*"
        r"比上年同\s*期\s*(?:增\s*长|下\s*降|减亏)"
    )
    m = re.search(pat_table, flat_text)
    if m:
        try:
            negative_current = bool(m.group(1))
            negative_last = bool(m.group(4))
            low = parse_amount(m.group(2), negative=negative_current)
            high = parse_amount(m.group(3), negative=negative_current)
            result["下限万元"] = min(low, high)
            result["上限万元"] = max(low, high)
            if m.group(5):
                result["上年同期万元"] = parse_amount(m.group(5), negative=negative_last)
        except (TypeError, ValueError):
            pass

    if result["下限万元"] is None:
        m = re.search(rf"{profit_label_pat}(.{{0,320}}?)(?=扣除非经常性|基本每股|二、|一、|三、|$)", flat_text)
        if m:
            segment = m.group(1)
            range_match = re.search(
                r"(亏损|盈利)?[:：]?\s*(?:为|约|人民币)?\s*([+\-－]?[0-9,，.]+)\s*(亿|万)?\s*元?(?:左右)?\s*[～~至到\-–—]\s*(?:人民币)?\s*([+\-－]?[0-9,，.]+)\s*(亿|万)?\s*元?(?:左右)?",
                segment,
            )
            if range_match:
                try:
                    current_negative = is_loss_label(range_match.group(1))
                    unit = "亿元" if "亿" in (range_match.group(3) or range_match.group(5) or "") else "万元"
                    low = parse_amount(range_match.group(2), unit=unit, negative=current_negative)
                    high = parse_amount(range_match.group(4), unit=unit, negative=current_negative)
                    result["下限万元"] = min(low, high)
                    result["上限万元"] = max(low, high)

                    prev_part = re.split(r"比\s*上\s*年\s*同\s*期|同\s*比|扣除非", segment[range_match.end():], maxsplit=1)[0]
                    previous = parse_previous_from_segment(prev_part)
                    if previous is not None:
                        result["上年同期万元"] = previous
                    apply_percent_from_context(segment[range_match.end():range_match.end() + 260])
                except (TypeError, ValueError):
                    pass
            else:
                single_match = re.search(
                    r"(亏损|盈利)?[:：]?\s*(?:为|约|人民币)?\s*([+\-－]?[0-9,，.]+)\s*(亿|万)?\s*元?(?:左右)?",
                    segment,
                )
                if single_match:
                    try:
                        current_negative = is_loss_label(single_match.group(1))
                        unit = "亿元" if single_match.group(3) == "亿" else "万元"
                        val = parse_amount(single_match.group(2), unit=unit, negative=current_negative)
                        result["下限万元"] = val
                        result["上限万元"] = val

                        prev_part = re.split(r"比\s*上\s*年\s*同\s*期|同\s*比|扣除非", segment[single_match.end():], maxsplit=1)[0]
                        previous = parse_previous_from_segment(prev_part)
                        if previous is not None:
                            result["上年同期万元"] = previous
                        apply_percent_from_context(segment[single_match.end():single_match.end() + 260])
                    except (TypeError, ValueError):
                        pass

    if result["下限万元"] is None:
        pat_profit_table = (
            r"归属于上市公司\s*股东的净利润\s*"
            r"(亏损[:：]?\s*)?([+\-－]?[0-9,，.]+)\s*万\s*元?\s*[～~至到\-–—]\s*"
            r"([+\-－]?[0-9,，.]+)\s*万\s*元?\s*"
            r"(亏损[:：]?\s*)?([+\-－]?[0-9,，.]+)\s*万\s*元?"
        )
        m = re.search(pat_profit_table, flat_text)
        if m:
            try:
                negative_current = bool(m.group(1))
                negative_last = bool(m.group(4))
                low = parse_amount(m.group(2), negative=negative_current)
                high = parse_amount(m.group(3), negative=negative_current)
                result["下限万元"] = min(low, high)
                result["上限万元"] = max(low, high)
                result["上年同期万元"] = parse_amount(m.group(5), negative=negative_last)
            except (TypeError, ValueError):
                pass

    if result["下限万元"] is None:
        pat_profit_range_with_last = (
            r"归属于上市公司\s*股东的\s*净利润\s*"
            r"(亏损|盈利)?[:：]?\s*约?\s*([+\-－]?[0-9,，.]+)\s*(?:万\s*元?)?\s*[～~至到\-–—]\s*"
            r"([+\-－]?[0-9,，.]+)\s*(?:万\s*元?)?\s*"
            r"(亏损|盈利)?[:：]?\s*([+\-－]?[0-9,，.]+)\s*(?:万\s*元?)?"
            r"(?:\s*(亏损|盈利)?[:：]?\s*([+\-－]?[0-9,，.]+)\s*(?:万\s*元?)?)?"
        )
        m = re.search(pat_profit_range_with_last, flat_text)
        if m:
            try:
                current_negative = is_loss_label(m.group(1))
                previous_label = m.group(6) or m.group(4)
                previous_raw = m.group(7) or m.group(5)
                low = parse_amount(m.group(2), negative=current_negative)
                high = parse_amount(m.group(3), negative=current_negative)
                result["下限万元"] = min(low, high)
                result["上限万元"] = max(low, high)
                result["上年同期万元"] = parse_amount(previous_raw, negative=is_loss_label(previous_label))
            except (TypeError, ValueError):
                pass

    if result["下限万元"] is None:
        pat_profit_range_plain = (
            r"归属于上市公司股东的净利润\s*([+\-－]?[0-9,，.]+)\s*[～~至到\-–—]\s*"
            r"([+\-－]?[0-9,，.]+)\s+([+\-－]?[0-9,，.]+)"
        )
        m = re.search(pat_profit_range_plain, flat_text)
        if m:
            try:
                low = parse_amount(m.group(1))
                high = parse_amount(m.group(2))
                result["下限万元"] = min(low, high)
                result["上限万元"] = max(low, high)
                result["上年同期万元"] = parse_amount(m.group(3))
            except (TypeError, ValueError):
                pass

    if result["下限万元"] is None:
        pat_profit_single_with_last = (
            r"归属于上市公司\s*股东的\s*净利润\s*"
            r"(亏损|盈利)?[:：]?\s*约?\s*([+\-－]?[0-9,，.]+)\s*万\s*元?\s*"
            r"(亏损|盈利)?[:：]?\s*([+\-－]?[0-9,，.]+)\s*万\s*元?"
        )
        m = re.search(pat_profit_single_with_last, flat_text)
        if m:
            try:
                val = parse_amount(m.group(2), negative=is_loss_label(m.group(1)))
                result["下限万元"] = val
                result["上限万元"] = val
                result["上年同期万元"] = parse_amount(m.group(4), negative=is_loss_label(m.group(3)))
            except (TypeError, ValueError):
                pass

    if result["下限万元"] is None:
        pat_profit_single_plain = r"归属于上市公司股东\s*([+\-－]?[0-9,，.]+)\s+([+\-－]?[0-9,，.]+)\s*的净利润"
        m = re.search(pat_profit_single_plain, flat_text)
        if m:
            try:
                val = parse_amount(m.group(1))
                result["下限万元"] = val
                result["上限万元"] = val
                result["上年同期万元"] = parse_amount(m.group(2))
            except (TypeError, ValueError):
                pass

    if result["下限万元"] is None:
        pat_profit_single_plain_after_label = r"归属于上市公司股东\s*的净利润\s*([+\-－]?[0-9,，.]+)\s+([+\-－]?[0-9,，.]+)"
        m = re.search(pat_profit_single_plain_after_label, flat_text)
        if m:
            try:
                val = parse_amount(m.group(1))
                result["下限万元"] = val
                result["上限万元"] = val
                result["上年同期万元"] = parse_amount(m.group(2))
            except (TypeError, ValueError):
                pass

    if result["下限万元"] is None:
        pat_loss_range = r"净利润\s*(?:为)?\s*负值.*?亏损[:：]?\s*([0-9,，.]+)\s*万\s*元?\s*[至~到～\-–—]\s*([0-9,，.]+)\s*万\s*元?"
        m = re.search(pat_loss_range, flat_text)
        if m:
            try:
                low = parse_amount(m.group(1), negative=True)
                high = parse_amount(m.group(2), negative=True)
                result["下限万元"] = min(low, high)
                result["上限万元"] = max(low, high)
            except (TypeError, ValueError):
                pass

    pat_range = r"([+\-－]?[0-9,，.]+(?:\.[0-9]+)?)\s*万\s*元?\s*[至~到～\-–—]\s*([+\-－]?[0-9,，.]+(?:\.[0-9]+)?)\s*万\s*元?"
    m = re.search(pat_range, text)
    if result["下限万元"] is None and m:
        try:
            low = parse_amount(m.group(1))
            high = parse_amount(m.group(2))
            result["下限万元"] = min(low, high)
            result["上限万元"] = max(low, high)
        except (TypeError, ValueError):
            pass

    if result["下限万元"] is None:
        pat_single_yi = r"归属于(?:上市公司股东|母公司所有者)的净\s*利润\s*(?:为)?\s*([+\-－]?[0-9,，.]+)\s*亿\s*元"
        m = re.search(pat_single_yi, text)
        if m:
            try:
                val = parse_amount(m.group(1), unit="亿元")
                result["下限万元"] = val
                result["上限万元"] = val
            except (TypeError, ValueError):
                pass

    if result["下限万元"] is None:
        pat_single_wan = r"归属于(?:上市公司股东|母公司所有者)的净\s*利润(?:在|为)?\s*([+\-－]?[0-9,，.]+)\s*万\s*元(?:左右)?"
        m = re.search(pat_single_wan, text)
        if m:
            try:
                val = parse_amount(m.group(1))
                result["下限万元"] = val
                result["上限万元"] = val
            except (TypeError, ValueError):
                pass

    if result["下限万元"] is None:
        pat_yi = r"([+\-－]?[0-9,，.]+)\s*亿\s*元?\s*[至~到～\-–—]\s*([+\-－]?[0-9,，.]+)\s*亿\s*元?"
        m = re.search(pat_yi, text)
        if m:
            try:
                low = parse_amount(m.group(1), unit="亿元")
                high = parse_amount(m.group(2), unit="亿元")
                result["下限万元"] = min(low, high)
                result["上限万元"] = max(low, high)
            except (TypeError, ValueError):
                pass

    if result["下限万元"] is None:
        pat_yuan = r"([0-9,，.]+)\s*元\s*[至~到～\-–—]\s*([0-9,，.]+)\s*元"
        m = re.search(pat_yuan, text)
        if m:
            try:
                result["下限万元"] = float(m.group(1).replace(",", "").replace("，", "")) / 10000
                result["上限万元"] = float(m.group(2).replace(",", "").replace("，", "")) / 10000
            except (TypeError, ValueError):
                pass

    if result["上年同期万元"] is None:
        pat_profit_table_last = (
            rf"{profit_label_pat}\s*"
            r"(?:亏损|盈利)?[:：]?\s*([+\-－]?[0-9,，.]+)\s*(?:万\s*元?)?\s*[～~至到\-–—]\s*"
            r"([+\-－]?[0-9,，.]+)\s*(?:万\s*元?)?\s+"
            r"(亏损|盈利)?[:：]?\s*([+\-－]?[0-9,，.]+)\s*(?:万\s*元?)?"
        )
        m = re.search(pat_profit_table_last, flat_text)
        if m:
            try:
                result["上年同期万元"] = parse_amount(m.group(4), negative=is_loss_label(m.group(3)))
            except (TypeError, ValueError):
                pass

    if result["上年同期万元"] is None:
        pat_last_yi = r"(?:二、\s*)?上年同期(?:业绩情况|经营业绩|经营业绩和财务状况|业绩和财务状况).*?(?:实现)?归属于(?:上市公司股东|母公司股东|母公司所有者)的净\s*利润(?:[：:]|为)\s*(?:人民币)?\s*([+\-－]?[0-9,，.]+)\s*亿\s*元"
        m = re.search(pat_last_yi, flat_text)
        if m:
            try:
                result["上年同期万元"] = parse_amount(m.group(1), unit="亿元")
            except (TypeError, ValueError):
                pass

    if result["上年同期万元"] is None:
        pat_last_wan = r"(?:二、\s*)?上年同期(?:业绩情况|经营业绩|经营业绩和财务状况|业绩和财务状况).*?(?:实现)?归属于(?:上市公司股东|母公司股东|母公司所有者)的净\s*利润(?:[：:]|为)\s*([+\-－]?[0-9,，.]+)\s*万\s*元"
        m = re.search(pat_last_wan, flat_text)
        if m:
            try:
                result["上年同期万元"] = parse_amount(m.group(1))
            except (TypeError, ValueError):
                pass

    if result["上年同期万元"] is None:
        pat_last_yuan = r"(?:上年同期|2025\s*上半年).*?归属于(?:上市公司股东|母公司股东|母公司所有者)的净\s*利润(?:[：:]|为)?\s*([+\-－]?[0-9,，.]+)\s*元"
        m = re.search(pat_last_yuan, flat_text)
        if m:
            try:
                result["上年同期万元"] = parse_amount(m.group(1)) / 10000
            except (TypeError, ValueError):
                pass

    if result["上年同期万元"] is None and result["下限万元"] is not None and result["上限万元"] is not None:
        pat_change_range = (
            r"与\s*上\s*年\s*同\s*期.*?相比，?\s*(?:预计)?(?:将)?\s*(增加|减少)\s*(?:人民币)?\s*"
            r"([0-9,，.]+)\s*(亿|万)\s*元?\s*[至~到～\-–—]\s*(?:人民币)?\s*([0-9,，.]+)\s*(亿|万)\s*元?"
        )
        m = re.search(pat_change_range, flat_text)
        if m:
            try:
                low_change = parse_amount(m.group(2), unit="亿元" if m.group(3) == "亿" else "万元")
                high_change = parse_amount(m.group(4), unit="亿元" if m.group(5) == "亿" else "万元")
                if m.group(1) == "增加":
                    previous_low = result["下限万元"] - low_change
                    previous_high = result["上限万元"] - high_change
                else:
                    previous_low = result["下限万元"] + low_change
                    previous_high = result["上限万元"] + high_change
                if abs(previous_low - previous_high) <= max(1, abs(previous_low), abs(previous_high)) * 0.02:
                    result["上年同期万元"] = (previous_low + previous_high) / 2
            except (TypeError, ValueError):
                pass

    if result["上年同期万元"] is None and result["下限万元"] is not None and result["上限万元"] is not None:
        pat_change_single = r"与\s*上\s*年\s*同\s*期.*?相比，?\s*(?:预计)?(?:将)?\s*(增加|减少)\s*(?:人民币)?\s*([0-9,，.]+)\s*(亿|万)\s*元?(?:左右)?"
        m = re.search(pat_change_single, flat_text)
        if m:
            try:
                change = parse_amount(m.group(2), unit="亿元" if m.group(3) == "亿" else "万元")
                current = (result["下限万元"] + result["上限万元"]) / 2
                result["上年同期万元"] = current - change if m.group(1) == "增加" else current + change
            except (TypeError, ValueError):
                pass

    pat_change_yi = r"与上年同期相比，?\s*预计?(增亏|减亏|增加|减少)\s*([0-9,，.]+)\s*亿\s*元"
    m = re.search(pat_change_yi, flat_text)
    if m:
        try:
            change = float(m.group(2).replace(",", "").replace("，", ""))
            result["同比变动说明"] = f"同比{m.group(1)} {change:g} 亿元"
        except (TypeError, ValueError):
            result["同比变动说明"] = f"同比{m.group(1)} {m.group(2)} 亿元"

    if result["同比下限%"] is None or result["同比上限%"] is None:
        pat_pct = r"(下降|减少|增长|增加|上升|减亏|增亏)?[：:]?\s*([+\-]?[0-9,，.]+)\s*%\s*[至~到～\-–—]\s*([+\-]?[0-9,，.]+)\s*%"
        m = re.search(pat_pct, text)
        if m:
            try:
                pct_negative = re.sub(r"\s+", "", m.group(1) or "") in ("下降", "减少", "增亏")
                result["同比下限%"] = parse_percent(m.group(2), negative=pct_negative)
                result["同比上限%"] = parse_percent(m.group(3), negative=pct_negative)
            except (TypeError, ValueError):
                pass
        else:
            pat_pct2 = r"(?:同比|比上年同期)\s*(增\s*加|增\s*长|上\s*升|下\s*降|减\s*少|减\s*亏|增\s*亏)\s*约?[：:]?\s*([+\-]?[0-9,，.]+)\s*%"
            m = re.search(pat_pct2, text)
            if m:
                try:
                    pct_negative = re.sub(r"\s+", "", m.group(1)) in ("下降", "减少", "增亏")
                    val = parse_percent(m.group(2), negative=pct_negative)
                    result["同比下限%"] = val
                    result["同比上限%"] = val
                except (TypeError, ValueError):
                    pass

    low_pct = calc_yoy_pct(result["下限万元"], result["上年同期万元"])
    high_pct = calc_yoy_pct(result["上限万元"], result["上年同期万元"])
    if low_pct is not None and high_pct is not None:
        if result["同比下限%"] is None or result["同比上限%"] is None or (
            result["同比下限%"] == 0 and result["同比上限%"] == 0
        ):
            result["同比下限%"] = min(low_pct, high_pct)
            result["同比上限%"] = max(low_pct, high_pct)

    if result["下限万元"] is not None and result["上限万元"] is not None:
        current_mid = (result["下限万元"] + result["上限万元"]) / 2
        previous = result["上年同期万元"]
        if previous not in (None, ""):
            try:
                previous = float(previous)
            except (TypeError, ValueError):
                previous = None
        else:
            previous = None

        if current_mid < 0:
            if previous is not None and previous >= 0:
                result["预告类型"] = "首亏"
            elif previous is not None and previous < 0:
                result["预告类型"] = "续亏"
            elif result["预告类型"] in ("", "预增", "续盈", "预减"):
                result["预告类型"] = "续亏"
        elif current_mid > 0 and previous is not None and previous < 0:
            result["预告类型"] = "扭亏"

    return result


def extract_reason_summary(pdf_text):
    text = re.sub(r"\s+", " ", pdf_text or "").strip()
    if not text:
        return "公告未披露具体原因"

    chapter_patterns = [
        r"(?:[一二三四五六七八九十]、)?(?:本期)?业绩(?:预增|预减|变动|变化|增长|下降)?(?:的)?(?:主要)?原因(?:说明)?[:：]?\s*(.+?)(?=(?:[一二三四五六七八九十]、)?(?:风险提示|其他说明|其他相关说明|备查文件|上年同期|本次业绩预告|董事会|特此公告)|$)",
        r"(?:[一二三四五六七八九十]、)?(?:本期)?业绩变动原因(?:说明)?[:：]?\s*(.+?)(?=(?:[一二三四五六七八九十]、)?(?:风险提示|其他说明|其他相关说明|备查文件|上年同期|本次业绩预告|董事会|特此公告)|$)",
    ]
    for pat in chapter_patterns:
        m = re.search(pat, text)
        if not m:
            continue
        reason = m.group(1).strip()
        reason = re.sub(r"^[。；;：:\s]+", "", reason).strip()
        if reason:
            return reason[:220]

    patterns = [
        r"(?:业绩变动原因|变动原因说明|业绩预告原因|主要原因|原因说明)[:：]?\s*(.{20,240})",
        r"(?:报告期内|本报告期内)(.{20,220})",
    ]
    for pat in patterns:
        m = re.search(pat, text)
        if not m:
            continue
        reason = m.group(1).strip()
        reason = re.split(r"(?:三、|四、|五、|其他相关说明|风险提示|备查文件)", reason)[0]
        reason = re.sub(r"^[。；;：:\s]+", "", reason).strip()
        if reason:
            return reason[:200]

    return "公告未披露具体原因"


def main():
    if len(sys.argv) < 3:
        print("Usage: fetch_cninfo.py <YYYY-MM-DD> <output_dir>", file=sys.stderr)
        sys.exit(2)

    date_str = sys.argv[1]
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    input_path = out_dir / "input.json"

    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        wd_names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
        wd = wd_names[dt.weekday()]
    except ValueError as e:
        print(f"[fetch_cninfo] bad date: {date_str}: {e}", file=sys.stderr)
        sys.exit(2)

    print(f"[fetch_cninfo] start {date_str} ({wd})", file=sys.stderr)
    items_sse = fetch_all_cninfo(date_str, "sse")
    items_szse = fetch_all_cninfo(date_str, "szse")
    print(f"[fetch_cninfo] sse={len(items_sse)} szse={len(items_szse)}", file=sys.stderr)

    merged = dedup(filter_titles(items_sse + items_szse))
    print(f"[fetch_cninfo] merged (filtered+deduped) = {len(merged)}", file=sys.stderr)

    if not merged:
        payload = {
            "date": date_str, "weekday": wd,
            "data_source": f"巨潮资讯 cninfo（sse+szse 双列去重，命中 0 条；日期 {date_str} 实际无披露或非交易日）",
            "items": [], "_note": f"cninfo {date_str} 无业绩预告披露",
        }
        input_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[fetch_cninfo] empty result, wrote {input_path}", file=sys.stderr)
        sys.exit(0)

    out_items = []
    for it in merged:
        sec_code = it.get("secCode", "")
        name = (it.get("secName") or "").strip() or "?"
        title = (it.get("announcementTitle") or "").replace("<em>", "").replace("</em>", "")
        adjunct = it.get("adjunctUrl", "")
        pdf_url = CNINFO_PDF_PREFIX + adjunct if adjunct else ""
        ann_time = it.get("announcementTime", 0)
        ann_date = datetime.fromtimestamp(ann_time / 1000).strftime("%Y-%m-%d") if ann_time else date_str

        pdf_bytes = download_pdf(pdf_url, name) if adjunct else b""

        pdf_text = parse_pdf_text(pdf_bytes) if pdf_bytes else ""
        yj = extract_yjyg_fields(pdf_text)
        ai_flag, ai_note = classify_ai(sec_code, name, pdf_text)
        subset = lookup_subset(sec_code)

        period = ""
        m = re.search(r"(20\d{2})[年\-](0?[1-9]|1[0-2])[月\-](3[01]|[12]\d|0?[1-9])日?\s*[至~到\-–—]\s*(20\d{2})[年\-](0?[1-9]|1[0-2])[月\-](3[01]|[12]\d|0?[1-9])日?", pdf_text)
        if m:
            period = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}~{m.group(4)}-{int(m.group(5)):02d}-{int(m.group(6)):02d}"
        else:
            period = f"{dt.year}-01-01~{dt.year}-06-30"

        reason = extract_reason_summary(pdf_text)

        out_items.append({
            "公告日期": ann_date,
            "公告标题": title,
            "公告ID": it.get("announcementId", ""),
            "公告链接": pdf_url,
            "证券代码": extract_company_code(sec_code),
            "证券简称": name,
            "所属子集": subset,
            "行业": subset,
            "预告类型": yj["预告类型"] or "不确定",
            "预告期间": period,
            "口径": yj["口径"],
            "下限万元": yj["下限万元"] if yj["下限万元"] is not None else 0.0,
            "上限万元": yj["上限万元"] if yj["上限万元"] is not None else 0.0,
            "上年同期万元": yj["上年同期万元"] if yj["上年同期万元"] is not None else "",
            "同比下限%": yj["同比下限%"] if yj["同比下限%"] is not None else 0.0,
            "同比上限%": yj["同比上限%"] if yj["同比上限%"] is not None else 0.0,
            "同比变动说明": yj["同比变动说明"],
            "原因摘要": reason,
            "AI主题相关": ai_flag,
            "AI说明": ai_note,
        })
        time.sleep(0.3)

    payload = {
        "date": date_str, "weekday": wd,
        "data_source": f"巨潮资讯 cninfo（sse+szse 双列去重，关键词 {', '.join(SEARCH_KEYS)}）+ PDF (pypdf) 解析；AI 主题判定为关键词启发式，准确率约 80%",
        "items": out_items,
        "_note": f"共拉取 {len(merged)} 条, 解析 {len(out_items)} 条",
    }
    input_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[fetch_cninfo] done: {len(out_items)} items, wrote {input_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
