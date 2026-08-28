#!/usr/bin/env python3
"""
processed_<date>.json → PDF 报告
- 4 段:总结(扫描区间/板块/多空对比) / 利好一览表(红) / 利空一览表(绿) / 短线参考 + 附录
- 字体:Heiti SC(黑体-简, 跨平台)
- 颜色:利好 #C00000 红 / 利空 #2E7D32 绿(Skill 规范)
"""
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


# ===== 字体 =====
def _register_fonts() -> tuple:
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
    return "ResearchCJK", "ResearchCJK"


FONT_REG, FONT_BOLD = _register_fonts()


# ===== 颜色 (Skill 规范:利好红 / 利空绿) =====
# 注意:reportlab `HexColor` 接收 24-bit hex,但内部取 16-bit 时低位会被截断,
# 实际 PDF 内显示色为:
#   RED   (#C00000) -> 0xBF0000 (视觉 ≈ 深红,可接受)
#   GREEN (#2E7D32) -> 0x2D7C31 (视觉 ≈ 深绿,可接受)
# 这是 reportlab 已知行为;**不要为了"对齐视觉"而改 hex 值** — 改色统一改这两个常量。
# 详见 AGENTS.md SKILL 块 §PDF 配色规范。
RED = colors.HexColor("#C00000")
GREEN = colors.HexColor("#2E7D32")
GRAY = colors.HexColor("#666666")
DARK = colors.HexColor("#1A1A1A")
RED_BG = colors.HexColor("#FFEBEE")
GREEN_BG = colors.HexColor("#E8F5E9")


# ===== 样式 =====
_styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=_styles["Title"], fontName=FONT_BOLD, fontSize=18, leading=24, textColor=DARK, spaceAfter=10, alignment=TA_CENTER)
H2 = ParagraphStyle("H2", parent=_styles["Heading1"], fontName=FONT_BOLD, fontSize=14, leading=20, textColor=DARK, spaceBefore=14, spaceAfter=8, alignment=TA_LEFT)
H3 = ParagraphStyle("H3", parent=_styles["Heading2"], fontName=FONT_BOLD, fontSize=12, leading=18, textColor=DARK, spaceBefore=8, spaceAfter=4)
BODY = ParagraphStyle("Body", parent=_styles["BodyText"], fontName=FONT_REG, fontSize=9.5, leading=14, textColor=DARK, spaceAfter=4)
BODY_GRAY = ParagraphStyle("BodyGray", parent=BODY, textColor=GRAY, fontSize=8.5, leading=12)
GOOD = ParagraphStyle("Good", parent=BODY, textColor=RED, fontName=FONT_BOLD)
BAD = ParagraphStyle("Bad", parent=BODY, textColor=GREEN, fontName=FONT_BOLD)
GOOD_BODY = ParagraphStyle("GoodBody", parent=BODY, textColor=RED)
BAD_BODY = ParagraphStyle("BadBody", parent=BODY, textColor=GREEN)
SMALL = ParagraphStyle("Small", parent=BODY, fontSize=8, leading=11, textColor=GRAY)
HEADER_META = ParagraphStyle("HeaderMeta", parent=SMALL, fontSize=5.2, leading=7.0, textColor=DARK, alignment=TA_CENTER, spaceAfter=1)


def _top_industries(top_entries: list, fallback_entries: list) -> list:
    """
    列出 TOP5 标的所在的"行业", 去重保序。
    退化策略:
      1) 优先用 industry 字段(已分类)
      2) 行业不可推断时, 返回空列表 (调用方据此决定是否渲染)
         — 不再退化到公司名 (trader 已经在 TOP5 列表里看到标的, 板块段不要重复)
    """
    seen, out = set(), []
    for src in (top_entries, fallback_entries):
        for e in src:
            ind = (e.get("industry") or "").strip()
            if not ind or ind in {"其他", "未知", ""}:
                continue
            if ind not in seen:
                seen.add(ind)
                out.append(ind)
        if len(out) >= 3:
            break
    return out[:3]


def _load_watchlist_codes() -> set:
    path = Path(__file__).with_name("watchlist.json")
    if not path.exists():
        return set()
    try:
        watchlist = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return set()

    codes = set()
    for code in watchlist.get("all_codes", []) or []:
        code = str(code).strip()
        if code:
            codes.add(code.zfill(6))
    for group_key in ("concept_groups", "ytd_top_15"):
        for group in watchlist.get(group_key, []) or []:
            for stock in (group.get("components", []) or []) + (group.get("stocks", []) or []):
                code = str(stock.get("code") or stock.get("stock_code") or "").strip()
                if code:
                    codes.add(code.zfill(6))
    return codes


def _iter_report_codes(data: Dict) -> set:
    codes = set()
    for key in ("top_good", "top_bad", "neutral_announcements", "neu_with_neg_score"):
        for item in data.get(key, []) or []:
            code = str(item.get("code") or item.get("secCode") or "").strip()
            if code:
                codes.add(code.zfill(6))
    return codes


def _forecast_bypass_count(data: Dict) -> int:
    watchlist_codes = _load_watchlist_codes()
    if not watchlist_codes:
        return 0
    bypass = set()
    for key in ("top_good", "top_bad"):
        for item in data.get(key, []) or []:
            code = str(item.get("code") or "").strip().zfill(6)
            if not code or code in watchlist_codes:
                continue
            labels = [str(sig[0]) for sig in item.get("best_signals", []) or [] if sig]
            if any("业绩预告" in label for label in labels) and abs(item.get("best_score", 0)) >= 7:
                bypass.add(code)
    return len(bypass)


def _header_summary_text(data: Dict) -> str:
    coverage = data.get("coverage", {}) or {}
    raw_total = coverage.get("pre_watchlist_total") or data.get("fetch_meta", {}).get("columns", {}).get("sse", {}).get("total", 0)
    sentiment = data.get("sentiment", {}) or {}
    good_count = sentiment.get("good_count", 0)
    all_bad_count = sentiment.get("bad_count", 0)
    neutral_count = sentiment.get("neutral_count", 0)
    good_companies = len(data.get("all_good_companies", []) or data.get("top_good", []) or [])
    strong_bad_items = [
        item for item in (data.get("top_bad", []) or [])
        if (item.get("best_score") or 0) <= -7
    ]
    strong_bad_count = sum(max(int(item.get("ann_count") or 1), 1) for item in strong_bad_items)
    strong_bad_companies = len(strong_bad_items)
    watchlist_hit_n = len(_iter_report_codes(data))
    filtered_total = data.get("fetch_meta", {}).get("total", good_count + all_bad_count + neutral_count)
    return (
        f"巨潮资讯官网公告 {raw_total} 篇,命中经筛选Wind热门概念指数的成份股 {watchlist_hit_n} 支,"
        f"涉及公告 {filtered_total} 篇,"
        f"{good_count} 篇利好 {good_companies} 个公司,"
        f"{strong_bad_count} 篇强利空 {strong_bad_companies} 个公司,"
        f"{neutral_count} 篇中性已过滤,详情请看Excel底稿。"
    )


def _section_overview(story: list, data: Dict) -> None:
    """一、概览 (v10 表格版): 利好 / 利空 双栏并列对比, 每栏 4 子列 (代码/公司/公告分类/得分)

    设计目标:
      - trader 一眼横比多空两侧的核心标的, 不需要再点开 Excel
      - 跟 _编辑版.docx v1 一、概览的 2x4 表格结构对齐
      - 老板铁律 (6/24): "表格内容应该是利好一列, 利空一列, 利好的一列分出代码、
        公司、公告的分类、得分, 利空的一列分出代码、公司、公告的分类、得分"
    """
    date = data.get("date", "?")
    sentiment = data.get("sentiment", {})
    excluded = data.get("excluded_summary", [])
    coverage = data.get('coverage', {})
    range_label = coverage.get('range_label', date)
    day_count = coverage.get('day_count', 1)

    story.append(Paragraph("一、概览", H2))

    # ---- 利好 / 利空 双栏并列表格 (8 子列 = 4 + 4) ----
    # v10.1 (老板铁律 6/24): 删顶部 3 段文字 (样本状态/扫描区间/多空对比/过滤清单)
    # 数据 → 顶部 report header 已经展示, 这里直接进表格
    # v10.1 (老板铁律 6/24): 利空侧只列 ≤-7 强利空, -3/-2/-1 弱/中利空不在概览表展示
    good_items = data.get("top_good", []) or []
    bad_items_all = data.get("top_bad", []) or []
    bad_items = [b for b in bad_items_all if (b.get("best_score") or 0) <= -7]

    def _classify_label(item: Dict) -> str:
        """公告分类字段: 优先 best_signals[0][0] 主信号 label, 兜底 event"""
        sigs = item.get("best_signals") or []
        if sigs and isinstance(sigs[0], (list, tuple)) and sigs[0]:
            return str(sigs[0][0])
        ev = item.get("event") or ""
        if ev:
            return ev[:16]
        return "-"

    # 每个 "侧" 4 列宽: 代码 1.4 | 公司 2.2 | 公告分类 3.0 | 得分 1.0
    col_w = [1.4*cm, 2.2*cm, 3.0*cm, 1.0*cm]
    col_widths = col_w + col_w  # 利好 4 + 利空 4

    header_style = ParagraphStyle(
        "OvHeader", fontName=FONT_BOLD, fontSize=10, textColor=colors.white,
        alignment=TA_CENTER, leading=12)
    sub_header_style = ParagraphStyle(
        "OvSubHeader", fontName=FONT_BOLD, fontSize=8.5, textColor=DARK,
        alignment=TA_CENTER, leading=10)
    cell_center = ParagraphStyle(
        "OvCenter", fontName=FONT_REG, fontSize=8.5, textColor=DARK,
        alignment=TA_CENTER, leading=10.5)
    cell_body = ParagraphStyle(
        "OvBody", fontName=FONT_REG, fontSize=8.5, textColor=DARK,
        alignment=TA_LEFT, leading=10.5)
    cell_red = ParagraphStyle(
        "OvRed", fontName=FONT_BOLD, fontSize=10.5, textColor=RED,
        alignment=TA_CENTER, leading=12)
    cell_green = ParagraphStyle(
        "OvGreen", fontName=FONT_BOLD, fontSize=10.5, textColor=GREEN,
        alignment=TA_CENTER, leading=12)

    rows = []
    styles = [
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#BFBFBF")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]

    # Row 0: 大表头 (利好 / 利空 各横跨 4 列)
    rows.append([Paragraph("利好", header_style), "", "", "",
                 Paragraph("利空", header_style), "", "", ""])
    styles.extend([
        ("SPAN", (0, 0), (3, 0)),       # 利好横跨 col 0-3
        ("SPAN", (4, 0), (7, 0)),       # 利空横跨 col 4-7
        ("BACKGROUND", (0, 0), (3, 0), RED),
        ("BACKGROUND", (4, 0), (7, 0), GREEN),
        ("ALIGN", (0, 0), (3, 0), "CENTER"),
        ("ALIGN", (4, 0), (7, 0), "CENTER"),
        ("TOPPADDING", (0, 0), (7, 0), 6),
        ("BOTTOMPADDING", (0, 0), (7, 0), 6),
    ])

    # Row 1: 子表头 (代码 / 公司 / 公告分类 / 得分) x 2
    sub_header_text = ["代码", "公司", "公告分类", "得分"]
    rows.append([Paragraph(t, sub_header_style) for t in (sub_header_text + sub_header_text)])
    styles.extend([
        ("BACKGROUND", (0, 1), (3, 1), colors.HexColor("#FCE4E4")),  # 利好侧子表头浅红底
        ("BACKGROUND", (4, 1), (7, 1), colors.HexColor("#E8F5E9")),  # 利空侧子表头浅绿底
        ("ALIGN", (0, 1), (7, 1), "CENTER"),
    ])

    # 数据行: 利好 / 利空 按 max(len) 对齐, 短侧留空
    n_rows = max(len(good_items), len(bad_items))
    for i in range(n_rows):
        row = []
        g = good_items[i] if i < len(good_items) else None
        b = bad_items[i] if i < len(bad_items) else None
        if g:
            row.extend([
                Paragraph(str(g.get("code", "-")), cell_center),
                Paragraph(str(g.get("company", "-")), cell_body),
                Paragraph(_classify_label(g), cell_body),
                Paragraph(f"{g.get('best_score', 0):+d}", cell_red),
            ])
        else:
            row.extend(["", "", "", ""])
        if b:
            row.extend([
                Paragraph(str(b.get("code", "-")), cell_center),
                Paragraph(str(b.get("company", "-")), cell_body),
                Paragraph(_classify_label(b), cell_body),
                Paragraph(f"{b.get('best_score', 0):+d}", cell_green),
            ])
        else:
            row.extend(["", "", "", ""])
        rows.append(row)

    # 数据行隔行底色 (利好侧浅红, 利空侧浅绿)
    if n_rows > 0:
        styles.append(("ROWBACKGROUNDS",
                       (0, 2), (3, 1 + n_rows),
                       [colors.white, colors.HexColor("#FFF5F5")]))
        styles.append(("ROWBACKGROUNDS",
                       (4, 2), (7, 1 + n_rows),
                       [colors.white, colors.HexColor("#F1F8F2")]))

    tbl = Table(rows, colWidths=col_widths, repeatRows=2)
    tbl.setStyle(TableStyle(styles))
    story.append(tbl)

    # 表后说明 (v10.1: 用表格实际行数, 不引用已删除的统计变量)
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        f"<i>注: 本表利好 {len(good_items)} 家、利空 {len(bad_items)} 家 (≤-7 强利空) 并列对照; "
        f"空单元格表示该侧已无更多标的。-6 ~ -1 弱/中利空仅保留在 Excel 底稿。</i>",
        BODY_GRAY))

    story.append(Spacer(1, 6))
    story.append(HRFlowable(width="100%", color=GRAY, thickness=0.5))


def _section_detail(story: list, data: Dict) -> None:
    """二、明细: 利好全量 + ≤-7 强利空；弱/中利空只保留在 Excel。"""
    good_items = data.get("top_good", []) or []
    bad_items_all = data.get("top_bad", []) or []
    bad_items = [
        item for item in bad_items_all
        if (item.get("best_score") or 0) <= -7
    ]

    story.append(Paragraph("二、明细", H2))
    if not good_items and not bad_items:
        story.append(Paragraph("本交易日无利好或利空公告。", BODY_GRAY))
        story.append(Spacer(1, 6))
        return

    col_widths = [0.8*cm, 1.5*cm, 2.1*cm, 1.3*cm, 8.6*cm, 1.7*cm, 1.4*cm]
    header_style = ParagraphStyle("DetailHeader", fontName=FONT_BOLD, fontSize=8.2, textColor=colors.white, alignment=TA_CENTER, leading=10)
    band_style = ParagraphStyle("DetailBand", fontName=FONT_BOLD, fontSize=9, textColor=colors.black, alignment=TA_CENTER, leading=11)
    cell_center = ParagraphStyle("DetailCenter", fontName=FONT_REG, fontSize=7.4, textColor=DARK, leading=9.2, alignment=TA_CENTER)
    cell_body = ParagraphStyle("DetailBody", fontName=FONT_REG, fontSize=7.4, textColor=DARK, leading=9.2)
    cell_red = ParagraphStyle("DetailRed", parent=cell_center, textColor=RED, fontName=FONT_BOLD)
    cell_green = ParagraphStyle("DetailGreen", parent=cell_center, textColor=GREEN, fontName=FONT_BOLD)
    cell_link = ParagraphStyle("DetailLink", parent=cell_center, textColor=colors.HexColor("#0563C1"))

    rows = []
    styles = [
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#BFBFBF")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]

    def add_band(label: str, bg_color) -> None:
        idx = len(rows)
        rows.append([Paragraph(label, band_style), "", "", "", "", "", ""])
        styles.extend([
            ("SPAN", (0, idx), (-1, idx)),
            ("BACKGROUND", (0, idx), (-1, idx), bg_color),
            ("ALIGN", (0, idx), (-1, idx), "CENTER"),
            ("VALIGN", (0, idx), (-1, idx), "MIDDLE"),
            ("TOPPADDING", (0, idx), (-1, idx), 4),
            ("BOTTOMPADDING", (0, idx), (-1, idx), 4),
        ])

    def add_header() -> None:
        idx = len(rows)
        rows.append([Paragraph(h, header_style) for h in ["#", "代码", "公司", "分数", "一句话概括", "公告日", "原文"]])
        styles.append(("BACKGROUND", (0, idx), (-1, idx), colors.HexColor("#4F4F4F")))
        styles.append(("ALIGN", (0, idx), (-1, idx), "CENTER"))

    def add_items(items: list, side: str) -> None:
        score_style = cell_red if side == "good" else cell_green
        start_idx = len(rows)
        for i, item in enumerate(items, 1):
            code = str(item.get("code", ""))
            company = item.get("company", "")
            score = item.get("best_score", 0)
            summary = item.get("best_summary") or item.get("event") or item.get("best_title") or "-"
            ann_date = item.get("best_date", "")
            url = item.get("best_url", "")
            link_para = f'<link href="{url}"><u>原文</u></link>' if url else "-"
            rows.append([
                Paragraph(str(i), cell_center),
                Paragraph(code, cell_center),
                Paragraph(company, cell_body),
                Paragraph(f"{score:+d}", score_style),
                Paragraph(summary, cell_body),
                Paragraph(ann_date, cell_center),
                Paragraph(link_para, cell_link),
            ])
        if len(rows) > start_idx:
            bg = colors.HexColor("#FFF5F5") if side == "good" else colors.HexColor("#F1F8F2")
            styles.append(("ROWBACKGROUNDS", (0, start_idx), (-1, len(rows)-1), [colors.white, bg]))

    add_band("利好", colors.HexColor("#FF0000"))
    add_header()
    add_items(good_items, "good")
    add_band("强利空（≤-7）", colors.HexColor("#92D050"))
    add_header()
    add_items(bad_items, "bad")

    tbl = Table(rows, colWidths=col_widths, repeatRows=0)
    tbl.setStyle(TableStyle(styles))
    story.append(tbl)
    story.append(Spacer(1, 8))
    story.append(HRFlowable(width="100%", color=GRAY, thickness=0.5))


def _section_top5(story: list, data: Dict, side: str, section_title: str, section_emoji: str) -> None:
    """
    Skill v3 输出形式: 表格化 (一张表展示每日全部利好/利空)
    列: # | 代码 | 公司 | 行业 | 分数 | 一句话概括 | 公告日 | 原文链接
    """
    key = "top_good" if side == "good" else "top_bad"
    items = data.get(key, [])
    if side == "bad":
        items = [
            item for item in items
            if (item.get("best_score") or 0) <= -7
        ]
    story.append(Paragraph(f"{section_emoji} {section_title} ({len(items)} 条)", H2))

    if not items:
        # 提取侧别 (good/bad -> 利好/利空), 不依赖 section_title 里有空格
        suffix = "利好" if side == "good" else "利空"
        story.append(Paragraph(f"本交易日无{suffix}公告。", BODY_GRAY))
        story.append(Spacer(1, 6))
        return

    # === 表格列定义 ===
    header = ['#', '代码', '公司', '行业', '分数', '一句话概括', '公告日', '原文']
    col_widths = [0.8*cm, 1.6*cm, 2.4*cm, 2.4*cm, 1.2*cm, 7.0*cm, 1.6*cm, 1.2*cm]
    # 头部样式
    header_style = ParagraphStyle("TblH", fontName=FONT_BOLD, fontSize=9, textColor=colors.white, alignment=TA_CENTER)
    # 单元格样式 (内嵌 Paragraph 实现自动换行)
    cell_red = ParagraphStyle("TblRed", fontName=FONT_REG, fontSize=8, textColor=RED, leading=10)
    cell_grn = ParagraphStyle("TblGrn", fontName=FONT_REG, fontSize=8, textColor=GREEN, leading=10)
    cell_body = ParagraphStyle("TblBody", fontName=FONT_REG, fontSize=8, textColor=DARK, leading=10)
    cell_gray = ParagraphStyle("TblGray", fontName=FONT_REG, fontSize=8, textColor=GRAY, leading=10)
    cell_link = ParagraphStyle("TblLink", fontName=FONT_REG, fontSize=8, textColor=colors.HexColor("#0563C1"), leading=10, alignment=TA_CENTER)

    score_style = cell_red if side == "good" else cell_grn

    # 头部 row (背景色)
    header_row = [Paragraph(h, header_style) for h in header]
    table_data = [header_row]

    for i, item in enumerate(items, 1):
        rank = item.get("rank", i)
        code = item.get("code", "?")
        company = item.get("company", "?")
        industry = item.get("industry", "其他")
        score = item.get("best_score", 0)
        summary = item.get("best_summary", "-")[:60]  # 截断
        ann_date = item.get("best_date", "")
        url = item.get("best_url", "")
        link_para = f'<link href="{url}"><u>📄 原文</u></link>' if url else "-"

        table_data.append([
            Paragraph(str(rank), ParagraphStyle("cn", fontName=FONT_REG, fontSize=8, alignment=TA_CENTER)),
            Paragraph(code, cell_body),
            Paragraph(company, cell_body),
            Paragraph(industry, cell_gray),
            Paragraph(f"{score:+d}", score_style),
            Paragraph(summary, cell_body),
            Paragraph(ann_date, cell_gray),
            Paragraph(link_para, cell_link),
        ])

    tbl = Table(table_data, colWidths=col_widths, repeatRows=1)
    bg_color = colors.HexColor("#FFF5F5") if side == "good" else colors.HexColor("#F1F8F2")
    tbl.setStyle(TableStyle([
        # 头部背景
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1A4D8F")),
        ("ALIGN", (0, 0), (-1, 0), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        # 数据行背景 (隔行)
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, bg_color]),
        # 网格
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#D0D0D0")),
        # 边距
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 8))
    story.append(HRFlowable(width="100%", color=GRAY, thickness=0.5))


def _section_short_term(story: list, data: Dict) -> None:
    story.append(Paragraph("三、提示", H2))
    short_term = data.get("short_term", {})

    # v9.30 (老板铁律): 删"行业多空判断"/"资金偏好" 段
    # 老板原话: "关于行业的多空判断就不要了, 短线交易提醒要去仔细看公告到底多利好"
    # 新版: 强调逐条看公告, 不被行业标签迷惑
    if short_term.get("focus_targets"):
        targets = "；".join(short_term["focus_targets"])
        story.append(Paragraph(f"<b>重点跟踪标的</b>: {targets}", GOOD_BODY))
        if short_term.get("focus_logic"):
            story.append(Paragraph(f"<b>催化持续性</b>: {short_term['focus_logic']}", BODY))

    if short_term.get("avoid_targets"):
        targets = "；".join(short_term["avoid_targets"])
        story.append(Paragraph(f"<b>风险回避标的</b>: {targets}", BAD_BODY))
        if short_term.get("avoid_logic"):
            story.append(Paragraph(f"<b>流动性/估值压制</b>: {short_term['avoid_logic']}", BODY))

    # v9.30: 短线交易提醒 — 仔细看公告到底多利好 (替换原"行业多空判断"/"资金偏好" 段)
    story.append(Paragraph(
        "<b>短线交易提醒</b>: 仔细看公告到底多利好, 不要被板块或行业标签迷惑。同一行业可能利好利空参半, "
        "关键是单个公告的具体内容和催化强度。利好需具体到金额、比例、对手方、期限；"
        "利空需具体到减持比例、立案主体、减值规模。",
        BODY))



def _section_neutral_neg(story: list, data: Dict) -> None:
    """v9.30: 中性公告 (含弱/中利空, 保持负分) — 老板铁律

    老板原话: "如果是 -6 到 -1 的利空可以直接过滤为中性, 但是依旧保持负分状态, 只是放在中性中"
    数据源: data['neu_with_neg_score'] = analyze.py by_company 阶段分桶结果
    渲染: 表格化 (与 _section_top5 一致), 浅灰底色, 负分用 GREEN 渲染
    """
    neu_neg = data.get("neu_with_neg_score", [])
    if not neu_neg:
        return

    story.append(Paragraph("五、中性公告 (含弱/中利空, 保持负分)", H2))
    story.append(Paragraph(
        f"本段为 <b>-6 ~ -1 弱/中利空</b>, 已过滤出利空段但保留负分, 供 trader 参考 ({len(neu_neg)} 条). "
        f"原因: 弱/中利空 (董监高离职/小额减持/问询函/题材澄清 等) 多为噪音, 不应污染强利空段。",
        BODY_GRAY))
    story.append(Spacer(1, 4))

    # 表格列定义 (与 _section_top5 一致)
    header = ['#', '代码', '公司', '行业', '分数', '一句话概括', '公告日', '原文']
    col_widths = [0.8*cm, 1.6*cm, 2.4*cm, 2.4*cm, 1.2*cm, 7.0*cm, 1.6*cm, 1.2*cm]
    header_style = ParagraphStyle("TblH", fontName=FONT_BOLD, fontSize=9, textColor=colors.white, alignment=TA_CENTER)
    cell_body = ParagraphStyle("TblBody", fontName=FONT_REG, fontSize=8, textColor=DARK, leading=10)
    cell_gray = ParagraphStyle("TblGray", fontName=FONT_REG, fontSize=8, textColor=GRAY, leading=10)
    cell_grn = ParagraphStyle("TblGrnNeuNeg", fontName=FONT_REG, fontSize=8, textColor=GREEN, leading=10)
    cell_link = ParagraphStyle("TblLink", fontName=FONT_REG, fontSize=8, textColor=colors.HexColor("#0563C1"), leading=10, alignment=TA_CENTER)

    header_row = [Paragraph(h, header_style) for h in header]
    table_data = [header_row]

    for i, item in enumerate(neu_neg, 1):
        rank = item.get("rank", i)
        code = item.get("code", "?")
        company = item.get("company", "?")
        industry = item.get("industry", "其他")
        score = item.get("best_score", 0)
        summary = item.get("best_summary", "-")[:60]
        ann_date = item.get("best_date", "")
        url = item.get("best_url", "")
        link_para = f'<link href="{url}"><u>📄 原文</u></link>' if url else "-"

        table_data.append([
            Paragraph(str(rank), ParagraphStyle("cn", fontName=FONT_REG, fontSize=8, alignment=TA_CENTER)),
            Paragraph(code, cell_body),
            Paragraph(company, cell_body),
            Paragraph(industry, cell_gray),
            Paragraph(f"{score:+d}", cell_grn),
            Paragraph(summary, cell_body),
            Paragraph(ann_date, cell_gray),
            Paragraph(link_para, cell_link),
        ])

    tbl = Table(table_data, colWidths=col_widths, repeatRows=1)
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#6B6B6B")),  # 灰色头, 区别利好(深蓝)/利空(深蓝)
        ("ALIGN", (0, 0), (-1, 0), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F4F4F4")]),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#D0D0D0")),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 8))
    story.append(HRFlowable(width="100%", color=GRAY, thickness=0.5))




def _section_recap(story: list, data: Dict) -> None:
    """今日复盘段: T 日 16:01 收盘后跑, 复盘 T 日报告在 T 日的市场反应
    (涨跌幅 = T 日前一交易日收盘 → T 日收盘 跨日, A 股涨跌幅习惯)

    数据契约: data['recap'] = {
      'prev_date', 'kline_avail',
      'good_items', 'bad_items', 'good_stats', 'bad_stats'
    }
    """
    recap = data.get("recap")
    if not recap:
        return
    prev_date = recap.get("prev_date", "?")
    source_entry_date = recap.get("source_entry_date") or prev_date
    target_trade_date = recap.get("target_trade_date") or prev_date
    kline_avail = recap.get("kline_avail", False)
    good_items = recap.get("good_items", []) or []
    bad_items = recap.get("bad_items", []) or []
    good_stats = recap.get("good_stats", {}).get("buckets", [])
    bad_stats = recap.get("bad_stats", {}).get("buckets", [])

    # v9.2: 删 PageBreak, 复盘独立 PDF 首页就把 5.1 强度分档表放上, 不再空余
    # v9.3: 段号 5.1/5.2/5.3/5.4 → 1.1/1.2/1.3/1.4 (复盘独立 PDF 重新编号)
    story.append(Paragraph("一、当日入榜标的收盘验证", H2))
    kline_tag = "已收盘" if kline_avail else "数据缺失 (T 日 K 线未生成)"
    story.append(Paragraph(
        f"<b>入榜日</b>: {source_entry_date} &nbsp;·&nbsp; "
        f"<b>验证日</b>: {target_trade_date} &nbsp;·&nbsp; "
        f"<b>涨跌幅口径</b>: T 日前收 → T 日收盘; 利好收红算命中, 利空收绿算命中 &nbsp;·&nbsp; "
        f"<b>K 线状态</b>: {kline_tag}",
        SMALL,
    ))

    # v9.31: 市场背景 (从 K 线 cache 反推 T-1 -> T 全市场均值, trader 一眼看出单日噪音)
    # 用 market_ctx 自己的 t_minus_1/prev_date, 不依赖外层 prev_date (避免陈旧 JSON 不一致)
    market_ctx = recap.get("market_ctx") or {}
    if market_ctx and market_ctx.get("avg_pct") is not None:
        avg = market_ctx["avg_pct"]
        n = market_ctx.get("sample_n", 0)
        label = market_ctx.get("label", "")
        note = market_ctx.get("note", "")
        t_minus_1 = market_ctx.get("t_minus_1", "?")
        t_day = market_ctx.get("prev_date", "?")
        sign_hex = "C00000" if avg > 0.5 else ("2E7D32" if avg < -0.5 else "333333")
        story.append(Paragraph(
            f"<b>入榜样本背景</b>: {t_minus_1} → {t_day} 样本均值 "
            f"<font color='#{sign_hex}'>{avg:+.2f}%</font> "
            f"(n={n}) &nbsp;·&nbsp; <b>{label}</b> &nbsp;·&nbsp; {note}",
            SMALL,
        ))

    story.append(Paragraph("1.1 强度分档命中统计 (按涨跌幅方向)", H3))
    header_style = ParagraphStyle("TblH", fontName=FONT_BOLD, fontSize=9, textColor=colors.white, alignment=TA_CENTER)
    cell_body = ParagraphStyle("TblBody", fontName=FONT_REG, fontSize=8.5, textColor=DARK, leading=11)
    cell_red = ParagraphStyle("TblRed", fontName=FONT_REG, fontSize=8.5, textColor=RED, leading=11, alignment=TA_CENTER)
    cell_grn = ParagraphStyle("TblGrn", fontName=FONT_REG, fontSize=8.5, textColor=GREEN, leading=11, alignment=TA_CENTER)
    cell_gray_c = ParagraphStyle("TblGray", fontName=FONT_REG, fontSize=8.5, textColor=GRAY, leading=11, alignment=TA_CENTER)

    def _row(b, side):
        rate_str = f"{b['hit_rate']:.1f}%" if b.get("count") else "-"
        avg_str = f"{b['avg_pct']:+.2f}%" if b.get("count") else "-"
        score_color = cell_red if side == "good" else cell_grn
        # v9.31-C: 噪音日反向档位 FAIL 加角标 [普涨压制] / [普跌压制]
        # 让 trader 一眼看出"这次 miss 50% 是单日噪音导致, 不是信号问题"
        strength_label = f"<b>{b['strength']}</b>"
        if b.get("count", 0) > 0 and b.get("hit_rate", 0) < 50:
            mlabel = market_ctx.get("label", "") if market_ctx else ""
            if "普涨" in mlabel and side == "bad":
                strength_label += " <font color='#888888' size='8'>[普涨压制]</font>"
            elif "普跌" in mlabel and side == "good":
                strength_label += " <font color='#888888' size='8'>[普跌压制]</font>"
        return [
            Paragraph(strength_label, score_color),
            Paragraph(str(b.get("count", 0)), cell_body),
            Paragraph(str(b.get("hit", 0)), cell_body),
            Paragraph(rate_str, cell_body),
            Paragraph(avg_str, cell_body),
        ]

    rows = [[Paragraph(h, header_style) for h in ["强度档", "数量", "命中数", "命中率", "平均涨跌幅"]]]
    if good_stats:
        for b in good_stats:
            rows.append(_row(b, "good"))
    else:
        rows.append([Paragraph("(无利好命中)", cell_gray_c), "", "", "", ""])
    if bad_stats:
        for b in bad_stats:
            rows.append(_row(b, "bad"))
    else:
        rows.append([Paragraph("(无利空命中)", cell_gray_c), "", "", "", ""])

    tbl = Table(rows, colWidths=[2.6*cm, 1.6*cm, 1.8*cm, 2.0*cm, 2.6*cm], repeatRows=1)
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1A4D8F")),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F9FC")]),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#D0D0D0")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 6))

    def _summary_line(side, stats):
        total = sum(b.get("count", 0) for b in stats)
        hit = sum(b.get("hit", 0) for b in stats)
        if total == 0:
            return None
        rate = round(hit / total * 100, 1)
        label = "利好" if side == "good" else "利空"
        return f"<b>{label}综合命中率</b>: {hit}/{total} = {rate}%"

    def _render_reflection(story, good_items, bad_items, good_stats, bad_stats):
        """v9.9 1.4 误判样本清单 (A/B 强 + C/D 全量) + 1.5 根因 + 1.6 actionable
        结构:
          1.4 A 强误判样本清单 (score≥4, pct≤-2%, 最多 10) - KEEP
          1.4 B 强反向样本清单 (score≤-4, pct≥+2%, 最多 10) - KEEP
          1.4 C 全部利好误判 (pct≤0, 全量) - NEW
          1.4 D 全部利空误判 (pct≥0, 全量) - NEW
          1.5 误判原因分析 (根因 4 类) - NEW
          1.6 改进方向 (actionable 5 条) - NEW
        """
        from collections import Counter
        story.append(Paragraph("1.4 误判样本清单", H3))
        if not good_stats and not bad_stats:
            story.append(Paragraph("数据不足, 暂不生成反思 (K 线缺失或 T 日报告无入榜标的)", BODY_GRAY))
            return

        # ============= A1. 强误判样本清单 (利好反跌) =============
        # 阈值: score≥4 AND pct≤-2% 才是真正意义上的"signal 说利好, 实际打脸"
        misjudged = [it for it in (good_items or []) if it.get("score", 0) >= 4 and (it.get("pct") or 0) <= -2.0]
        misjudged.sort(key=lambda x: x.get("pct") or 0)
        story.append(Paragraph(f"A. 强误判样本清单 (推荐利好但实际跌, score≥4 且涨跌幅≤-2%, {len(misjudged)} 只)", H4))
        if not misjudged:
            story.append(Paragraph("● 本交易日无强误判样本, 强利多方向判断准确", BODY_GREEN))
        else:
            _render_misjudged_table(story, misjudged, header_style, "red", "green", "F1F8F2", "FFF5F5")
        story.append(Spacer(1, 4))

        # ============= A2. 强反向样本清单 (利空反涨) =============
        # v9.5 对称补全: 阈值: score≤-4 AND pct≥+2% (signal 说利空, 实际反向)
        reverse_strong = [it for it in (bad_items or []) if it.get("score", 0) <= -4 and (it.get("pct") or 0) >= 2.0]
        reverse_strong.sort(key=lambda x: -x.get("pct") or 0)
        story.append(Paragraph(f"B. 强反向样本清单 (推荐利空但实际涨, score≤-4 且涨跌幅≥+2%, {len(reverse_strong)} 只)", H4))
        if not reverse_strong:
            story.append(Paragraph("● 本交易日无强反向样本, 强利空方向判断准确", BODY_GREEN))
        else:
            _render_misjudged_table(story, reverse_strong, header_style, "green", "red", "FFF5F5", "F1F8F2", reverse=True)
        story.append(Spacer(1, 4))

        # ============= 1.4 C. 全部利好误判 (NEW 全量) =============
        all_good_miss = [it for it in (good_items or []) if (it.get("pct") or 0) <= 0]
        all_good_miss.sort(key=lambda x: (-x.get("score", 0), x.get("pct") or 0))
        sg = sum(1 for it in all_good_miss if it.get("strength") == "强利多")
        mg = sum(1 for it in all_good_miss if it.get("strength") == "中利多")
        wg = sum(1 for it in all_good_miss if it.get("strength") == "弱利多")
        story.append(Paragraph(f"C. 全部利好误判 (推荐利好但实际跌/平, 共 {len(all_good_miss)} 只, 强利多 {sg} / 中利多 {mg} / 弱利多 {wg})", H4))
        if not all_good_miss:
            story.append(Paragraph("● 本交易日无利好误判, 利好方向判断准确", BODY_GREEN))
        else:
            _render_misjudged_table(story, all_good_miss, header_style, "red", "green", "F1F8F2", "FFF5F5", max_items=None)
        story.append(Spacer(1, 4))

        # ============= 1.4 D. 全部利空误判 (NEW 全量) =============
        all_bad_miss = [it for it in (bad_items or []) if (it.get("pct") or 0) >= 0]
        all_bad_miss.sort(key=lambda x: (x.get("score", 0), -(x.get("pct") or 0)))
        sb = sum(1 for it in all_bad_miss if it.get("strength") == "强利空")
        wb = sum(1 for it in all_bad_miss if it.get("strength") == "弱利空")
        story.append(Paragraph(f"D. 全部利空误判 (推荐利空但实际涨/平, 共 {len(all_bad_miss)} 只, 强利空 {sb} / 弱利空 {wb})", H4))
        if not all_bad_miss:
            story.append(Paragraph("● 本交易日无利空反向, 利空方向判断准确", BODY_GREEN))
        else:
            _render_misjudged_table(story, all_bad_miss, header_style, "green", "red", "FFF5F5", "F1F8F2", max_items=None, reverse=True)
        story.append(Spacer(1, 4))

        # ============= 1.5 误判原因分析 (根因 4 类) =============
        story.append(Paragraph("1.5 误判原因分析 (根因)", H3))
        for ln in _build_root_causes_pdf(good_items, bad_items, good_stats, bad_stats, all_good_miss, all_bad_miss):
            story.append(Paragraph(ln, BODY))
        story.append(Spacer(1, 4))

        # ============= 1.6 改进方向 (actionable 5 条) =============
        story.append(Paragraph("1.6 改进方向 (actionable)", H3))
        for ln in _build_action_items_pdf(good_items, bad_items, good_stats, bad_stats, all_good_miss, all_bad_miss):
            story.append(Paragraph(ln, BODY))

    def _render_misjudged_table(story, items, header_style, sig_color_name, pct_color_name, row_bg_hex, ev_bg_hex, reverse=False, max_items=10):
        """v9.5 强误判 / 强反向 通用表格 (8 列同 A 段)
        sig_color_name / pct_color_name: 'red' (利好方向) 或 'green' (利空方向)
        row_bg_hex: 行交替底色 hex
        reverse=True 利空方向, max_items=None 全量
        """
        from reportlab.lib import colors
        sig_color = RED if sig_color_name == "red" else GREEN
        pct_color = GREEN if pct_color_name == "green" else RED
        cell_code = ParagraphStyle("ac", fontName=FONT_REG, fontSize=7.5, textColor=DARK, leading=9, alignment=TA_CENTER)
        cell_co = ParagraphStyle("aco", fontName=FONT_REG, fontSize=7.5, textColor=DARK, leading=9)
        cell_ind = ParagraphStyle("ain", fontName=FONT_REG, fontSize=7, textColor=GRAY, leading=8.5)
        cell_sig = ParagraphStyle("asg", fontName=FONT_REG, fontSize=7, textColor=sig_color, leading=8.5, alignment=TA_CENTER)
        cell_score = ParagraphStyle("asc", fontName=FONT_BOLD, fontSize=8, textColor=sig_color, leading=9.5, alignment=TA_CENTER)
        cell_pct = ParagraphStyle("apc", fontName=FONT_BOLD, fontSize=8, textColor=pct_color, leading=9.5, alignment=TA_CENTER)
        cell_ev = ParagraphStyle("aev", fontName=FONT_REG, fontSize=6.5, textColor=DARK, leading=8)
        hdr = [Paragraph(h, header_style) for h in ["#", "代码", "公司", "行业", "主信号", "分数", "涨跌幅", "事件"]]
        tbl_rows = [hdr]
        row_iter = items if max_items is None else items[:max_items]
        for i, it in enumerate(row_iter, 1):
            pct = it.get("pct")
            pct_str = f"{pct:+.2f}%" if pct is not None else "-"
            sig = it.get("primary_signal") or "-"
            tbl_rows.append([
                Paragraph(str(i), cell_code),
                Paragraph(it.get("code", ""), cell_code),
                Paragraph(it.get("company", ""), cell_co),
                Paragraph(it.get("industry", "") or "-", cell_ind),
                Paragraph(sig, cell_sig),
                Paragraph(f"{it.get('score', 0):+d}", cell_score),
                Paragraph(pct_str, cell_pct),
                Paragraph((it.get("event") or "")[:30], cell_ev),
            ])
        t = Table(tbl_rows, colWidths=[0.6*cm, 1.4*cm, 2.6*cm, 2.0*cm, 2.4*cm, 0.9*cm, 1.6*cm, 4.4*cm], repeatRows=1)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1A4D8F")),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#" + row_bg_hex)]),
            ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#D0D0D0")),
            ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        story.append(t)


    def _render_items(title, items, side, color, header_style):
        if not items:
            story.append(Paragraph(f"{title}: 无标的", BODY_GRAY))
            return
        story.append(Paragraph(f"{title} ({len(items)} 只)", H3))
        cell_score = ParagraphStyle("cs", fontName=FONT_BOLD, fontSize=8.5, textColor=color, leading=11, alignment=TA_CENTER)
        cell_company = ParagraphStyle("cc", fontName=FONT_REG, fontSize=8, textColor=DARK, leading=10)
        cell_lim = ParagraphStyle("cl", fontName=FONT_BOLD, fontSize=8, textColor=color, leading=10, alignment=TA_CENTER)
        hdr = [Paragraph(h, header_style) for h in ["#", "代码", "公司", "行业", "强度", "分数", "涨跌幅", "状态"]]
        body_rows = [hdr]
        for i, it in enumerate(items, 1):
            pct = it.get("pct")
            if pct is None:
                pct_str = "-"
                pct_color = GRAY
            else:
                pct_str = f"{pct:+.2f}%"
                # v9.2: 涨跌颜色按方向 (A 股习惯), 不用 side 颜色: pct>0 涨=红, pct<0 跌=绿, 涨停跌停也用同样规则
                if pct > 0:
                    pct_color = RED
                elif pct < 0:
                    pct_color = GREEN
                else:
                    pct_color = color
            tag = it.get("tag", "")
            cell_pct_colored = ParagraphStyle("cpc", fontName=FONT_REG, fontSize=8.5, textColor=pct_color, leading=11, alignment=TA_CENTER)
            tag_pstyle = cell_lim if tag in ("涨停", "跌停") else cell_gray_c
            body_rows.append([
                Paragraph(str(i), cell_gray_c),
                Paragraph(it.get("code", ""), cell_gray_c),
                Paragraph(it.get("company", ""), cell_company),
                Paragraph(it.get("industry", ""), cell_gray_c),
                Paragraph(f"<b>{it.get('strength','')}</b>", cell_score),
                Paragraph(f"{it.get('score',0):+d}", cell_gray_c),
                Paragraph(pct_str, cell_pct_colored),
                Paragraph(tag, tag_pstyle),
            ])
        t = Table(body_rows, colWidths=[0.7*cm, 1.5*cm, 3.4*cm, 2.0*cm, 1.7*cm, 1.2*cm, 1.8*cm, 1.6*cm], repeatRows=1)
        bg = colors.HexColor("#FFF5F5") if side == "good" else colors.HexColor("#F1F8F2")
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1A4D8F")),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, bg]),
            ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#D0D0D0")),
            ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(t)
        story.append(Spacer(1, 6))

    bad_line = _summary_line("bad", bad_stats)
    good_line = _summary_line("good", good_stats)
    lines = [x for x in [good_line, bad_line] if x]
    if lines:
        story.append(Paragraph("&nbsp;&nbsp;<b>综合命中率</b> (按方向): " + " &nbsp;|&nbsp; ".join(lines), BODY))
    else:
        story.append(Paragraph("&nbsp;&nbsp;<b>综合命中率</b>: 数据不足, 待 K 线生成后回填", BODY_GRAY))
    story.append(Spacer(1, 6))

    _render_items("1.2 利好全量明细", good_items, "good", RED, header_style)
    _render_items("1.3 利空全量明细", bad_items, "bad", GREEN, header_style)

    # v9.3: 1.4 复盘反思和改进方向 (从数据自动生成, 不写死)
    _render_reflection(story, good_items, bad_items, good_stats, bad_stats)


def _build_root_causes_pdf(good_items, bad_items, good_stats, bad_stats, all_good_miss, all_bad_miss):
    """v9.9 1.5 误判原因分析: 4 大类根因 (分类边界 / 阈值 / 强信号边界 / 环境)"""
    from collections import Counter
    lines = []
    # 1. 分类边界 (信号层) — 利好 / 利空各自看主导信号
    if all_good_miss:
        sigs = Counter(it.get("primary_signal") or "(未知)" for it in all_good_miss)
        top_sig, top_n = sigs.most_common(1)[0]
        if top_n / len(all_good_miss) >= 0.3:
            pct = round(top_n / len(all_good_miss) * 100, 1)
            lines.append(f"● <b>分类边界问题 (信号层)</b>: 利好误判中 {top_sig} 占 {pct}% ({top_n}/{len(all_good_miss)}), 此类公告多为程序性事件 (草案/解锁/归属/作废), 实际不构成增量利好, 不应作为方向性信号入榜")
    if all_bad_miss:
        sigs = Counter(it.get("primary_signal") or "(未知)" for it in all_bad_miss)
        top_sig, top_n = sigs.most_common(1)[0]
        if top_n / len(all_bad_miss) >= 0.2:
            pct = round(top_n / len(all_bad_miss) * 100, 1)
            # 6/30: 异动拆档, 普通 -2 / 严重 -4 / 严重+风险提示 -5
        if top_sig in {"异常波动公告", "严重异常波动公告", "严重异常波动风险提示"}:
            lines.append(f"● <b>分类边界问题 (利空方向)</b>: 利空反向中 {top_sig} 占 {pct}% ({top_n}/{len(all_bad_miss)}), 异动类按普通/严重/严重且风险提示拆档, 保留弱到中利空权重")
        else:
            lines.append(f"● <b>分类边界问题 (利空方向)</b>: 利空反向中 {top_sig} 占 {pct}% ({top_n}/{len(all_bad_miss)}), 此类公告需复盘具体公告内容, 校准信号方向")
    # 2. 阈值问题 (权重层)
    weak_good = next((b for b in good_stats if b["strength"] == "弱利多"), None)
    if weak_good and weak_good.get("hit_rate", 100) < 50:
        lines.append(f"● <b>阈值问题 (权重层)</b>: 弱利多命中率仅 {weak_good['hit_rate']}%, 信号分太低 (|2~3|) 噪音大于信号, 需上调阈值或合并到中档")
    weak_bad = next((b for b in bad_stats if b["strength"] == "弱利空"), None)
    if weak_bad and weak_bad.get("hit_rate", 100) < 50:
        lines.append(f"● <b>阈值问题 (利空)</b>: 弱利空命中率 {weak_bad['hit_rate']}%, 同样存在噪音问题")
    # 3. 强信号边界不对等
    strong_good = next((b for b in good_stats if b["strength"] == "强利多"), None)
    strong_bad = next((b for b in bad_stats if b["strength"] == "强利空"), None)
    if strong_good and strong_bad:
        sg_hit = strong_good.get("hit_rate", 0)
        sb_hit = strong_bad.get("hit_rate", 0)
        if abs(sg_hit - sb_hit) >= 20:
            lines.append(f"● <b>强信号边界不对等</b>: 强利多命中率 {sg_hit}% vs 强利空命中率 {sb_hit}%, 差 {abs(sg_hit - sb_hit)}%, 利空端虚假信号更多 (减持完成后市场已消化, 处罚决定书已公告过)")
    # 4. 环境问题
    if bad_items and len(all_bad_miss) / len(bad_items) >= 0.4:
        pct = round(len(all_bad_miss) / len(bad_items) * 100, 1)
        lines.append(f"● <b>环境问题</b>: 利空反向占比 {pct}% 偏高, 弱信号在当前市场环境下失真严重, 需配合大盘情绪/板块轮动过滤")
    if not lines:
        lines.append("● 本次复盘数据未发现明显根因, 建议持续观察 7 日滚动数据")
    return lines


def _build_action_items_pdf(good_items, bad_items, good_stats, bad_stats, all_good_miss, all_bad_miss):
    """v9.9 1.6 改进方向: 5 条 actionable 建议 (跟数据强绑定)"""
    from collections import Counter
    lines = []
    good_miss_sigs = Counter(it.get("primary_signal") or "(未知)" for it in all_good_miss) if all_good_miss else Counter()
    bad_miss_sigs = Counter(it.get("primary_signal") or "(未知)" for it in all_bad_miss) if all_bad_miss else Counter()
    # 1. 限制性股票激励计划 → 6/10 老板明确: 草案/授予/登记/核查/归属条件成就 保留 +2,
    # 解锁/归属结果/解除限售/作废/失效/注销 由中性过滤覆盖 (已写进 spec + 规则层)
    # 此处不再自动建议降权, 但仍记录数量供复盘
    n_total = good_miss_sigs.get("限制性股票激励计划", 0)
    if n_total >= 3:
        lines.append(f"● <b>限制性股票激励计划</b>: 误判 {n_total} 只, 规则层已将 解锁/归属结果/解除限售/作废/失效/注销 改为中性过滤, 草案/授予/登记/核查/归属条件成就 仍保留弱利多 (|2|)")
    # 2. 异常波动公告 → 6/30 拆档: 普通 -2 / 严重 -4 / 严重+风险提示 -5
    # 3. 监管问询函 → 减弱分数
    n = bad_miss_sigs.get("监管问询函", 0)
    if n >= 3:
        lines.append(f"● <b>监管问询函 (年报回复类)</b>: 反向 {n} 只, 建议减弱分数 -3 → -2, 或加 concurrent 过滤 (需无 concurrent 监管处罚)")
    # 4. 董监高小额减持 / 离职 → 减弱
    n = bad_miss_sigs.get("董监高小额减持", 0) + bad_miss_sigs.get("董监高离职", 0)
    if n >= 3:
        lines.append(f"● <b>董监高小额减持 / 离职</b>: 反向 {n} 只, 建议从弱利空 (-2) 减弱为 (-1) 或降为中性 (频繁发生, 已 priced in)")
    # 5. 大股东减持 → 拆分控股股东 vs 普通股东
    n = bad_miss_sigs.get("大股东减持", 0) + bad_miss_sigs.get("≥2% 大股东减持", 0)
    if n >= 1:
        lines.append(f"● <b>大股东减持</b>: 需拆分 控股股东/大股东减持 vs 普通股东减持, 后者力度弱, 建议从 (-5/-7) 减弱为 (-2/-3)")
    if not lines:
        lines.append("● 本次复盘数据未触发具体改进建议, 建议持续观察 7 日滚动数据")
    return lines


# v9.30 (老板铁律): 删 _section_signals_spec 整个附录函数 — "PDF 最后一部份的附录也可以删掉了"
# def _section_signals_spec(story: list) -> None: ...  # 整段删除 (约 200 行)
    story.append(Paragraph(
        '本附录为打分系统的 single source of truth (<b>references/signals_spec.md</b>)。'
        '加新信号 / 改判断文字, 只动这个 md 文件, 无需改 Python。',
        BODY_GRAY))
    story.append(Spacer(1, 6))

    # 解析 spec md
    text = spec_path.read_text(encoding='utf-8')
    rows = []
    in_table = False
    for line in text.splitlines():
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
        # 把 md 里的 ; 还原为 |, ;; 拆为多段
        pattern = pattern.replace(';', ' | ')
        judge_chunks = [c.strip() for c in judge.split(';;') if c.strip()]
        rows.append((label, score, pattern, judge_chunks))
    if not rows:
        return

    # 按 |score| 降序排
    rows.sort(key=lambda x: -abs(x[1]))

    # 风格: 利好行绿底边框, 利空行红底边框
    for i, (label, score, pattern, judge_chunks) in enumerate(rows, 1):
        is_pos = score > 0
        is_neg = score < 0
        if is_pos:
            bg = colors.HexColor("#E8F5E9")
            accent = colors.HexColor("#2E7D32")
        elif is_neg:
            bg = colors.HexColor("#FFEBEE")
            accent = colors.HexColor("#C00000")
        else:
            bg = colors.HexColor("#F4F4F4")
            accent = colors.HexColor("#666666")

        # 标题行: 序号 + 标签 + 分数徽章(右)
        title_para = Paragraph(
            f'<font color="#888888" size="8">#{i:02d}</font> &nbsp;&nbsp; '
            f'<b>{label}</b> &nbsp;&nbsp; '
            f'<font color="{accent.hexval()}" size="11"><b>{score:+d}</b></font>',
            ParagraphStyle("CardTitle", parent=BODY, fontName=FONT_BOLD, fontSize=11, leading=16, spaceAfter=2, textColor=DARK),
        )

        # 正则段(灰色小字, reportlab 对内嵌 <font> + 含特殊字符的 pattern 易 parse error, 用 Paragraph 转义)
        # 用 xml.sax.saxutils.escape 转义 < > & 防止误解析
        from xml.sax.saxutils import escape as _xml_escape
        pattern_para = Paragraph(
            f'<font color="#555555" size="8">正则:</font> '
            f'<font color="#1A1A1A" size="8">{_xml_escape(pattern)}</font>',
            ParagraphStyle("CardPattern", parent=BODY, fontSize=8, leading=11, spaceAfter=2),
        )

        # 判断逻辑(多段保留)
        judge_paras = []
        for j, chunk in enumerate(judge_chunks):
            if j == 0:
                judge_paras.append(Paragraph(
                    f'<font color="#555555" size="8">判断:</font> {chunk}',
                    ParagraphStyle("CardJudge", parent=BODY, fontSize=9, leading=12, spaceAfter=1, textColor=DARK),
                ))
            else:
                judge_paras.append(Paragraph(
                    f'<font color="#777777" size="8">附注:</font> {chunk}',
                    ParagraphStyle("CardJudgeNote", parent=BODY, fontSize=8.5, leading=11, spaceAfter=1, textColor=colors.HexColor("#444444")),
                ))

        # 把 4 个段落塞进一个 1 列 Table, 设置背景色模拟"卡片"
        card = Table(
            [[title_para], [pattern_para], *[[p] for p in judge_paras]],
            colWidths=[17.4 * cm],
        )
        card.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), bg),
            ('LEFTPADDING', (0, 0), (-1, -1), 8),
            ('RIGHTPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            # 左边一条色带
            ('LINEBEFORE', (0, 0), (0, -1), 3, accent),
        ]))
        story.append(card)
        story.append(Spacer(1, 4))

    # 排除分支说明
    story.append(Spacer(1, 8))
    story.append(Paragraph("排除分支(必读, 代码内固定)", H3))
    story.append(Paragraph(
        '1) 标题含"自愿不减持 / 承诺锁定 / 不减持承诺"时, 即使匹配 5% / 2% 减持类 pattern, '
        '也按"自愿不减持 +3" 计入, 不算利空。',
        BODY))
    story.append(Paragraph(
        '2) 标题含"股权激励 / 限制性股票 / 股票期权 / 员工持股计划"时, '
        '"股份回购" 信号中性化(分 = 0), 避免误算。',
        BODY))


def render(processed_json_path: Path, output_pdf_path: Path) -> Path:
    with open(processed_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    doc = SimpleDocTemplate(
        str(output_pdf_path),
        pagesize=A4,
        leftMargin=1.8 * cm,
        rightMargin=1.8 * cm,
        topMargin=1.5 * cm,
        bottomMargin=1.5 * cm,
        title=f"A 股盘前公告研判 ({data.get('date', '?')})",
        author="cninfo-premarket skill",
    )

    coverage = data.get('coverage', {})
    range_label = coverage.get('range_label', data.get('date', '?'))
    day_count = coverage.get('day_count', 1)
    actual_dates = coverage.get("actual_dates") or [data.get("date", "?")]

    story = []
    story.append(Paragraph("A 股盘前公告研判报告", H1))
    story.append(Paragraph(
        f"扫描覆盖区间: {range_label}｜实际数据日: {'、'.join(actual_dates)}｜生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        HEADER_META))
    story.append(Paragraph(_header_summary_text(data), HEADER_META))
    story.append(Spacer(1, 3))
    story.append(HRFlowable(width="100%", color=DARK, thickness=0.8))
    story.append(Spacer(1, 4))

    _section_overview(story, data)
    _section_detail(story, data)
    # v10 (老板铁律 6/24): 删 _section_short_term → 「三、提示」段全部删掉, 不用做了暂时
    # v9.30 (老板铁律): 删 PDF 最后一部份的附录, 不再调 _section_signals_spec
    # _section_signals_spec(story)   # 已删 (老板原话: "PDF 最后一部份的附录也可以删掉了")

    story.append(Spacer(1, 10))
    story.append(HRFlowable(width="100%", color=GRAY, thickness=0.5))
    story.append(Paragraph(
        "<b>免责声明</b>: 本报告基于公开公告数据自动生成,仅供内部研究使用,不代表投资建议。市场有风险,投资需谨慎。",
        SMALL))

    doc.build(story)
    print(f"OK PDF: {output_pdf_path}")
    return output_pdf_path


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 build_pdf.py <processed.json> <output.pdf>")
        sys.exit(1)
    render(Path(sys.argv[1]), Path(sys.argv[2]))


def render_recap_pdf(processed_json_path: Path, output_pdf_path: Path) -> Path:
    """v9.1 复盘独立 PDF: 只渲染 data['recap'] 段, 不含一二三四主报告

    数据契约: processed.json 含 'recap' 字段 (run.py Step 2.5 写入)
    复盘内容: T 日推荐全量入榜标的 在 T 日的市场反应 (T 日 16:01 收盘后跑, 涨跌幅 = T 日前一交易日收盘 → T 日收盘 跨日)
    """
    with open(processed_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    recap = data.get("recap") or {}
    if not recap:
        print(f"[WARN] {processed_json_path} 不含 recap 段, 复盘 PDF 跳过")
        return output_pdf_path

    doc = SimpleDocTemplate(
        str(output_pdf_path),
        pagesize=A4,
        leftMargin=1.8 * cm,
        rightMargin=1.8 * cm,
        topMargin=1.5 * cm,
        bottomMargin=1.5 * cm,
        title=f"巨潮资讯 今日复盘 ({recap.get('prev_date', '?')})",
        author="cninfo-premarket skill",
    )

    story = []
    story.append(Paragraph(f"巨潮资讯 今日复盘报告 (T 日={recap.get('prev_date', '?')})", H1))
    prev = recap.get("prev_date", "?")
    source_entry_date = recap.get("source_entry_date") or prev
    target_trade_date = recap.get("target_trade_date") or prev
    kline = recap.get("kline_avail", False)
    kline_tag = "已收盘" if kline else "数据缺失"
    story.append(Paragraph(
        f"<b>涨跌幅口径</b>: T 日前一交易日收盘 → T 日收盘; 利好收红算命中, 利空收绿算命中 &nbsp;·&nbsp; "
        f"<b>复盘对象</b>: {source_entry_date} 入榜的全量标的 &nbsp;·&nbsp; "
        f"<b>验证日</b>: {target_trade_date} &nbsp;·&nbsp; "
        f"<b>K 线状态</b>: {kline_tag} &nbsp;·&nbsp; "
        f"<b>生成时间</b>: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        SMALL))
    # v9.31: 复盘独立 PDF 头部补市场背景
    market_ctx = recap.get("market_ctx") or {}
    if market_ctx and market_ctx.get("avg_pct") is not None:
        avg = market_ctx["avg_pct"]
        n = market_ctx.get("sample_n", 0)
        label = market_ctx.get("label", "")
        note = market_ctx.get("note", "")
        t_minus_1 = market_ctx.get("t_minus_1", "?")
        t_day = market_ctx.get("prev_date", "?")
        sign_hex = "C00000" if avg > 0.5 else ("2E7D32" if avg < -0.5 else "333333")
        story.append(Paragraph(
            f"<b>入榜样本背景</b>: {t_minus_1} → {t_day} 样本均值 "
            f"<font color='#{sign_hex}'>{avg:+.2f}%</font> "
            f"(n={n}) &nbsp;·&nbsp; <b>{label}</b> &nbsp;·&nbsp; {note}",
            SMALL,
        ))
    story.append(HRFlowable(width="100%", color=DARK, thickness=1.2))
    story.append(Spacer(1, 4))

    _section_recap(story, data)

    story.append(Spacer(1, 10))
    story.append(HRFlowable(width="100%", color=GRAY, thickness=0.5))
    story.append(Paragraph(
        "<b>免责声明</b>: 复盘数据基于公开公告 + 新浪 K 线计算, 仅供内部研究使用, 不代表投资建议。市场有风险, 投资需谨慎。",
        SMALL))

    doc.build(story)
    print(f"OK 复盘 PDF: {output_pdf_path}")
    return output_pdf_path
    story.append(Paragraph("1.1 强度分档命中统计 (按涨跌幅方向)", H3))
    story.append(Paragraph("1.1 强度分档命中统计 (按涨跌幅方向)", H3))
H4 = ParagraphStyle("H4", parent=_styles["Heading3"], fontName=FONT_BOLD, fontSize=10.5, leading=15, textColor=DARK, spaceBefore=6, spaceAfter=3)
BODY_GREEN = ParagraphStyle("BodyGreen", parent=BODY, textColor=GREEN, fontSize=8.5, leading=12)


def render_weekly_pdf(weekly_data: Dict, output_pdf_path: Path) -> Path:
    """周报 PDF: 多日聚合 6 档命中率 + 趋势分析 + 铁律提示 (Sunday 20:00 自动跑)

    数据契约: weekly_data = {
      'days': ['2026-06-09', '2026-06-10', '2026-06-11'],
      'agg': {'good': [{strength, count, hit, hit_rate, avg_pct}, ...],
              'bad':  [...]},
      'summary': {'good_hit':N, 'good_total':N, 'good_rate':N,
                  'bad_hit':N, 'bad_total':N, 'bad_rate':N},
      'trend': [str, str, ...],
      'abnormal_locked': str|None
    }
    """
    doc = SimpleDocTemplate(
        str(output_pdf_path),
        pagesize=A4,
        leftMargin=1.8 * cm,
        rightMargin=1.8 * cm,
        topMargin=1.5 * cm,
        bottomMargin=1.5 * cm,
        title=f"巨潮资讯 周报 ({weekly_data['days'][0]} ~ {weekly_data['days'][-1]})",
        author="cninfo-premarket skill",
    )

    story = []
    days = weekly_data["days"]
    story.append(Paragraph(f"巨潮资讯 周报 — {days[0]} ~ {days[-1]}", H1))
    story.append(Paragraph(
        f"<b>覆盖区间</b>: {days[0]} ~ {days[-1]} ({len(days)} 个交易日) &nbsp;·&nbsp; "
        f"<b>口径</b>: 多日 6 档滚动命中率 (强/中/弱 × 利好/利空) &nbsp;·&nbsp; "
        f"<b>生成时间</b>: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        SMALL))
    story.append(HRFlowable(width="100%", color=DARK, thickness=1.2))
    story.append(Spacer(1, 6))

    s = weekly_data["summary"]
    story.append(Paragraph("一、综合命中率 (跨 3 档)", H2))
    header_style = ParagraphStyle("TblH", fontName=FONT_BOLD, fontSize=9, textColor=colors.white, alignment=TA_CENTER)
    cell_body = ParagraphStyle("TblBody", fontName=FONT_REG, fontSize=9, textColor=DARK, leading=12, alignment=TA_CENTER)
    cell_red = ParagraphStyle("TblRed", fontName=FONT_REG, fontSize=9, textColor=RED, leading=12, alignment=TA_CENTER)
    cell_grn = ParagraphStyle("TblGrn", fontName=FONT_REG, fontSize=9, textColor=GREEN, leading=12, alignment=TA_CENTER)

    def _summary_row(label, hit, total, rate, color_style):
        return [
            Paragraph(f"<b>{label}</b>", cell_body),
            Paragraph(str(hit), cell_body),
            Paragraph(str(total), cell_body),
            Paragraph(f"<b>{rate:.1f}%</b>", color_style),
        ]

    summary_rows = [[Paragraph(h, header_style) for h in ["方向", "命中", "样本", "命中率"]]]
    summary_rows.append(_summary_row("利好 (跨 3 档)", s["good_hit"], s["good_total"], s["good_rate"], cell_red))
    summary_rows.append(_summary_row("利空 (跨 3 档)", s["bad_hit"], s["bad_total"], s["bad_rate"], cell_grn))

    tbl = Table(summary_rows, colWidths=[5*cm, 3*cm, 3*cm, 4*cm], repeatRows=1)
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1A4D8F")),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F9FC")]),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#D0D0D0")),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 10))

    story.append(Paragraph("二、6 档分档滚动命中率", H2))
    header_cells = [Paragraph(h, header_style) for h in ["档位", "命中", "样本", "命中率", "平均涨跌幅", "判定"]]
    rows = [header_cells]
    cell_gray = ParagraphStyle("TblGray", fontName=FONT_REG, fontSize=8.5, textColor=GRAY, leading=11, alignment=TA_CENTER)
    cell_judge_g = ParagraphStyle("JG", fontName=FONT_BOLD, fontSize=8.5, textColor=GREEN, leading=11, alignment=TA_CENTER)
    cell_judge_r = ParagraphStyle("JR", fontName=FONT_BOLD, fontSize=8.5, textColor=RED, leading=11, alignment=TA_CENTER)

    for side, label in [("good", "利好"), ("bad", "利空")]:
        for b in weekly_data["agg"][side]:
            if b["count"] == 0:
                judge = "N/A (0 样本)"
                judge_style = cell_gray
            elif b["hit_rate"] >= 50:
                judge = "达标"
                judge_style = cell_judge_g
            else:
                judge = f"miss ({b['hit_rate']:.1f}%)"
                judge_style = cell_judge_r
            rate_str = f"{b['hit_rate']:.1f}%" if b.get("count") else "-"
            avg_str = f"{b['avg_pct']:+.2f}%" if b.get("count") else "-"
            rows.append([
                Paragraph(f"<b>{b['strength']}</b>({label})", cell_body),
                Paragraph(str(b["hit"]), cell_body),
                Paragraph(str(b["count"]), cell_body),
                Paragraph(rate_str, cell_body),
                Paragraph(avg_str, cell_body),
                Paragraph(judge, judge_style),
            ])

    tbl2 = Table(rows, colWidths=[3.6*cm, 1.6*cm, 1.6*cm, 2.0*cm, 2.6*cm, 4.0*cm], repeatRows=1)
    tbl2.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1A4D8F")),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F9FC")]),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#D0D0D0")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(tbl2)
    story.append(Spacer(1, 10))

    story.append(Paragraph("三、趋势分析 (7 日滚动)", H2))
    trend = weekly_data.get("trend", [])
    if not trend:
        story.append(Paragraph("样本不足, 暂不生成", BODY_GRAY))
    else:
        for line in trend:
            story.append(Paragraph(line, BODY))
    story.append(Spacer(1, 6))

    story.append(Paragraph("四、铁律提示", H2))
    iron_rules = [
        "<b>铁律 #1</b>: 异动类拆档: 普通异常波动 -2 / 严重异常波动 -4 / 严重异常波动+风险提示 -5",
        "<b>铁律 #2</b>: 单日噪音不改分, 复盘报告加说明",
        "<b>铁律 #3</b>: 0 样本 N/A, 不要求 50%",
        "<b>铁律 #4</b>: 档位 1-3 弱 / 4-6 中 / 7-10 强",
        "<b>铁律 #5</b>: 多公告全显示, 不取舍不遗漏",
        "<b>铁律 #6</b>: 用户说 '请停止' 立即停",
    ]
    for rr in iron_rules:
        story.append(Paragraph(f"● {rr}", BODY))
    if weekly_data.get("abnormal_locked"):
        story.append(Spacer(1, 4))
        story.append(Paragraph(f"! {weekly_data['abnormal_locked']}", BAD_BODY))
    story.append(Spacer(1, 6))

    story.append(Paragraph("五、覆盖日期", H2))
    story.append(Paragraph("、".join(days), BODY))

    doc.build(story)
    print(f"OK weekly PDF: {output_pdf_path}")
    return output_pdf_path
