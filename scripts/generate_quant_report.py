#!/usr/bin/env python3
import html
import json
import os
import sys
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


FONT_REG = "Helvetica"
FONT_BOLD = "Helvetica-Bold"


def register_fonts():
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


def esc(value):
    if value is None:
        return "-"
    return html.escape(str(value), quote=False)


def pct(value, digits=1):
    if isinstance(value, (int, float)):
        return f"{value * 100:.{digits}f}%"
    return "-"


def num(value, digits=2):
    if isinstance(value, (int, float)):
        return f"{value:.{digits}f}"
    return "-"


def bool_text(value):
    return "通过" if value else "未通过"


def join_labels(values):
    if not values:
        return "无"
    return "、".join(str(item) for item in values)


def paragraph(value, style):
    return Paragraph(esc(value), style)


def make_table(rows, col_widths, body_style, header=False):
    data = []
    header_style = ParagraphStyle(
        f"{body_style.name}_Header",
        parent=body_style,
        fontName=FONT_BOLD,
        textColor=colors.white,
        alignment=TA_CENTER,
    )
    for ridx, row in enumerate(rows):
        style = header_style if header and ridx == 0 else body_style
        data.append([cell if hasattr(cell, "wrap") else paragraph(cell, style) for cell in row])
    table = Table(data, colWidths=col_widths, hAlign="LEFT")
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
            ("FONTNAME", (0, 0), (-1, 0), FONT_BOLD),
        ])
    else:
        commands.extend([
            ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#F5F7FA")),
            ("FONTNAME", (0, 0), (0, -1), FONT_BOLD),
        ])
    table.setStyle(TableStyle(commands))
    return table


def format_datetime(value):
    if not value:
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S %Z")
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    except Exception:
        return str(value)


def build_report(payload, output_path):
    register_fonts()
    result = payload.get("result", {})
    context = payload.get("context", {})
    strategy = result.get("strategy", {})
    metrics = result.get("metrics", {})
    data_status = result.get("dataStatus", {})
    params = strategy.get("params", {})
    stage = context.get("stage") or {}
    gates = metrics.get("gateResults", {})

    doc = SimpleDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=1.45 * cm,
        rightMargin=1.45 * cm,
        topMargin=1.35 * cm,
        bottomMargin=1.2 * cm,
        title="量化选股 Loop 回测报告",
    )

    styles = getSampleStyleSheet()
    title = ParagraphStyle("TitleCN", parent=styles["Title"], fontName=FONT_BOLD, fontSize=18, leading=24, alignment=TA_CENTER, textColor=colors.HexColor("#1F2933"))
    sub = ParagraphStyle("SubCN", parent=styles["BodyText"], fontName=FONT_REG, fontSize=8.5, leading=12, alignment=TA_CENTER, textColor=colors.HexColor("#6B7280"))
    h2 = ParagraphStyle("H2CN", parent=styles["Heading2"], fontName=FONT_BOLD, fontSize=12.5, leading=17, textColor=colors.HexColor("#1F2933"), spaceBefore=10, spaceAfter=6)
    body = ParagraphStyle("BodyCN", parent=styles["BodyText"], fontName=FONT_REG, fontSize=8.5, leading=12, textColor=colors.HexColor("#263238"))
    note = ParagraphStyle("NoteCN", parent=body, fontSize=7.5, leading=10.5, textColor=colors.HexColor("#6B7280"))

    story = [
        Paragraph("量化选股 Loop 回测报告", title),
        Paragraph(f"生成时间: {esc(format_datetime(payload.get('generatedAt')))}", sub),
        Spacer(1, 10),
    ]

    basic_rows = [
        ["策略版本", strategy.get("version", "-")],
        ["本轮", f"第 {context.get('round', '-')} 轮 - {stage.get('label', '-')}"],
        ["当前启用指标", join_labels(strategy.get("activeIndicatorLabels"))],
        ["回测区间", f"{metrics.get('startDate', '-')} 至 {metrics.get('endDate', '-')}"],
        ["基准", data_status.get("benchmark", "沪深300")],
        ["数据覆盖", f"{data_status.get('cachedStockCount', 0)} / {data_status.get('eligibleUniverseCount', data_status.get('universeCount', 0))} ({pct(data_status.get('coverage'))})"],
        ["已剔除新股", str(data_status.get("shortHistoryStockCount", 0))],
    ]
    story.append(Paragraph("一、本轮内容", h2))
    story.append(make_table(basic_rows, [3.6 * cm, 13.8 * cm], body))

    change_rows = [
        ["本轮新增指标", join_labels(context.get("addedIndicators"))],
        ["本轮删除指标", join_labels(context.get("removedIndicators"))],
        ["本轮改动", context.get("change", "-")],
        ["调整原因", context.get("why", "-")],
        ["是否通过硬约束", bool_text(metrics.get("passed"))],
        ["下一步动作", context.get("nextAction", "-")],
    ]
    story.append(Paragraph("二、指标变更", h2))
    story.append(make_table(change_rows, [3.6 * cm, 13.8 * cm], body))

    metric_rows = [
        ["指标", "本轮结果", "硬约束/说明"],
        ["Sharpe", num(metrics.get("sharpe")), ">= 1"],
        ["Calmar", num(metrics.get("calmar")), ">= 2"],
        ["最大回撤", pct(metrics.get("maxDrawdown")), "<= 20%"],
        ["年化收益率", pct(metrics.get("annualReturn")), "策略组合"],
        ["沪深300年化", pct(metrics.get("benchmarkAnnualReturn")), "基准收益"],
        ["超额年化", pct(metrics.get("excessAnnualReturn")), "策略 - 沪深300"],
        ["开仓/周", num(metrics.get("rolling13WeekAvgOpenings", metrics.get("minRolling13WeekOpenings")), 1), "完整13周滚动窗口平均 >= 8"],
        ["最低开仓/周", num(metrics.get("minRolling13WeekOpenings"), 1), "诊断项"],
        ["最近13周开仓/周", num(metrics.get("latestRolling13WeekOpenings"), 1), "诊断项"],
        ["交易笔数", str(metrics.get("tradeCount", 0)), "已闭合交易"],
        ["胜率", pct(metrics.get("winRate")), "已闭合交易"],
    ]
    story.append(Paragraph("三、回测结果", h2))
    story.append(make_table(metric_rows, [4.2 * cm, 4.4 * cm, 8.8 * cm], body, header=True))

    gate_rows = [["约束", "状态"]]
    gate_labels = {
        "sharpe": "Sharpe >= 1",
        "calmar": "Calmar >= 2",
        "maxDrawdown": "最大回撤 <= 20%",
        "rolling13WeekAvgOpenings": "开仓/周 >= 8",
        "dataCoverage": "全A历史数据覆盖 = 100%",
    }
    for key, label in gate_labels.items():
        gate_rows.append([label, bool_text(gates.get(key))])
    story.append(Paragraph("四、硬约束检查", h2))
    story.append(make_table(gate_rows, [10 * cm, 7.4 * cm], body, header=True))

    param_rows = [
        ["红柱放大窗口", str((params.get("redFrontDown") or 0) + (params.get("redBackUp") or 0))],
        ["前段递减/后段递增", f"{params.get('redFrontDown', '-') } + {params.get('redBackUp', '-')}"],
        ["绿柱衰减窗口", params.get("greenDecayWindow", "-")],
        ["红转绿观察窗口", params.get("redToGreenLookback", "-")],
        ["趋势均线模式", params.get("trendMode", "-")],
        ["成交量均线", f"{params.get('volumeMa', '-')} 日"],
        ["最大同时持仓", params.get("maxPositions", "-")],
        ["单边成本", pct(params.get("tradeCost"), 2)],
    ]
    story.append(Paragraph("五、参数", h2))
    story.append(make_table(param_rows, [4.2 * cm, 13.2 * cm], body))

    signals = result.get("latestSignals") or []
    if signals:
        story.append(PageBreak())
        story.append(Paragraph("六、最新信号样本", h2))
        rows = [["代码", "名称", "日期", "收盘价", "得分", "原因"]]
        for item in signals[:15]:
            rows.append([
                item.get("code", "-"),
                item.get("name", "-"),
                item.get("date", "-"),
                num(item.get("close"), 2),
                num(item.get("score"), 1),
                join_labels(item.get("reasons")),
            ])
        story.append(make_table(rows, [2.0 * cm, 3.0 * cm, 2.3 * cm, 2.2 * cm, 1.8 * cm, 6.1 * cm], body, header=True))

    failed = metrics.get("failedReasons") or []
    story.append(Spacer(1, 10))
    story.append(Paragraph(f"失败项: {join_labels(failed)}", note))
    story.append(Paragraph("说明: 本报告仅用于策略研究和回测记录，不构成交易建议。", note))

    doc.build(story)


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: generate_quant_report.py input.json output.pdf")
    input_path, output_path = sys.argv[1], sys.argv[2]
    with open(input_path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    build_report(payload, output_path)
    print(output_path)


if __name__ == "__main__":
    main()
