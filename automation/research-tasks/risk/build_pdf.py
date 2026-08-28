#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""风险提示 PDF 输出。"""
from __future__ import annotations

import json
import os
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def _register_font() -> str:
    candidates = [
        os.environ.get("RESEARCH_CJK_FONT"),
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ]
    font_path = next((Path(value) for value in candidates if value and Path(value).is_file()), None)
    if font_path is None:
        raise FileNotFoundError(
            "未找到中文 PDF 字体；请安装 fonts-noto-cjk 或设置 RESEARCH_CJK_FONT"
        )
    pdfmetrics.registerFont(TTFont("ResearchCJK", str(font_path)))
    return "ResearchCJK"


FONT = _register_font()
STYLES = getSampleStyleSheet()
TITLE = ParagraphStyle("title_cn", parent=STYLES["Title"], fontName=FONT, fontSize=18, leading=24, textColor=colors.HexColor("#7A1E1E"))
H2 = ParagraphStyle("h2_cn", parent=STYLES["Heading2"], fontName=FONT, fontSize=13, leading=17, textColor=colors.HexColor("#7A1E1E"))
BODY = ParagraphStyle("body_cn", parent=STYLES["BodyText"], fontName=FONT, fontSize=9, leading=12)
SMALL = ParagraphStyle("small_cn", parent=BODY, fontSize=8, leading=10)


def _load(data_or_path):
    if isinstance(data_or_path, (str, Path)):
        return json.loads(Path(data_or_path).read_text(encoding="utf-8"))
    return data_or_path


def _p(text, style=BODY):
    text = "" if text is None else str(text)
    return Paragraph(text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), style)


def _risk_table(items, empty_text="本交易日无风险命中"):
    rows = [[_p("#", SMALL), _p("代码", SMALL), _p("公司", SMALL), _p("等级", SMALL), _p("分数", SMALL), _p("风险类型", SMALL), _p("一句话", SMALL)]]
    if not items:
        rows.append([_p(empty_text, SMALL), "", "", "", "", "", ""])
    for it in items:
        rows.append([
            _p(it.get("rank", ""), SMALL),
            _p(it.get("code", ""), SMALL),
            _p(it.get("company", ""), SMALL),
            _p(it.get("risk_level", ""), SMALL),
            _p(it.get("score", ""), SMALL),
            _p(it.get("primary_signal", ""), SMALL),
            _p(it.get("summary", ""), SMALL),
        ])
    table = Table(rows, colWidths=[10*mm, 18*mm, 24*mm, 22*mm, 14*mm, 34*mm, 130*mm], repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#7A1E1E")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#BFBFBF")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#FCE4D6")),
    ]
    if not items:
        style.append(("SPAN", (0, 1), (-1, 1)))
    table.setStyle(TableStyle(style))
    return table


def render(data_or_path, out_path: Path) -> Path:
    data = _load(data_or_path)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(str(out_path), pagesize=landscape(A4), leftMargin=12*mm, rightMargin=12*mm, topMargin=12*mm, bottomMargin=12*mm)
    story = []

    cov = data.get("coverage", {})
    sent = data.get("sentiment", {})
    story.append(Paragraph(f"风险提示-公告扫描-{data.get('date', '')}", TITLE))
    story.append(_p(f"扫描区间: {cov.get('range_label', '')}    生成时间: {data.get('generated_at', '')}", BODY))
    story.append(Spacer(1, 6))

    story.append(Paragraph("一、风险概览", H2))
    overview = [
        ["原始公告数", cov.get("raw_total", 0), "watchlist公告数", cov.get("watchlist_ann_count", 0)],
        ["风险条数", sent.get("risk_count", 0), "重大/高风险公司数", sent.get("major_risk_company_count", 0)],
        ["PDF展示阈值", "≤ -7", "观察项", sent.get("observation_count", 0)],
    ]
    table = Table([[_p(c, SMALL) for c in row] for row in overview], colWidths=[32*mm, 32*mm, 40*mm, 32*mm])
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#BFBFBF")),
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F7F7F7")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(table)
    story.append(Spacer(1, 8))

    story.append(Paragraph("二、重大风险判断", H2))
    major = data.get("major_risks", [])
    if major:
        story.append(_p(f"本交易日命中 {sent.get('major_risk_company_count', 0)} 家重大/高风险公司。", BODY))
    else:
        story.append(_p("本交易日无重大风险；以下列出全部风险清单供盘前逐项检查。", BODY))
    story.append(_risk_table(major, empty_text="本交易日无重大/高风险"))
    story.append(Spacer(1, 8))

    story.append(Paragraph("三、全部风险清单", H2))
    story.append(_p(f"本段列出全部 {sent.get('risk_count', 0)} 条风险命中，按分数从重到轻排序；重大风险判断见上一段。", BODY))
    story.append(_risk_table(data.get("risks", []), empty_text="本交易日无任何风险命中"))
    story.append(Spacer(1, 8))

    story.append(Paragraph("四、风险类型分布", H2))
    by_signal = sent.get("by_signal", {})
    if by_signal:
        signal_text = "；".join(f"{k}: {v}" for k, v in list(by_signal.items())[:8])
        story.append(_p(f"主要风险类型: {signal_text}", BODY))
    story.append(Spacer(1, 8))

    story.append(Paragraph("五、规则说明与免责声明", H2))
    story.append(_p("本报告基于公开公告自动生成, 严格按巨潮资讯 watchlist 过滤, 仅供内部研究使用, 不代表投资建议。", BODY))
    doc.build(story)
    return out_path


def render_recap_pdf(data_or_path, out_path: Path) -> Path:
    data = _load(data_or_path)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(str(out_path), pagesize=landscape(A4), leftMargin=12*mm, rightMargin=12*mm, topMargin=12*mm, bottomMargin=12*mm)
    recap = data.get("recap", {})
    avg_pct = recap.get("avg_pct")
    story = [
        Paragraph(f"风险提示-今日复盘-{recap.get('date', data.get('date', ''))}", TITLE),
        _p(f"风险报告日: {data.get('date', '')}    复盘交易日: {recap.get('date', '')}    样本数: {recap.get('count', 0)}", BODY),
        _p(f"平均涨跌幅: {avg_pct if avg_pct is not None else '-'}", BODY),
        Spacer(1, 8),
    ]
    rows = [[_p("代码", SMALL), _p("公司", SMALL), _p("等级", SMALL), _p("分数", SMALL), _p("风险类型", SMALL), _p("开盘", SMALL), _p("收盘", SMALL), _p("涨跌幅%", SMALL)]]
    for it in recap.get("items", []):
        rows.append([_p(it.get(k, ""), SMALL) for k in ["code", "company", "risk_level", "score", "primary_signal", "open", "close", "pct"]])
    if len(rows) == 1:
        rows.append([_p("无可复盘样本", SMALL), "", "", "", "", "", "", ""])
    table = Table(rows, colWidths=[20*mm, 28*mm, 26*mm, 16*mm, 44*mm, 22*mm, 22*mm, 24*mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#7A1E1E")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#BFBFBF")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(table)
    story.append(Spacer(1, 8))
    story.append(_p("复盘仅用于观察风险事件披露后当日 open→close 表现, 不代表投资建议。", BODY))
    doc.build(story)
    return out_path
