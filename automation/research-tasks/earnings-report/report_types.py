#!/usr/bin/env python3
"""正式定期报告标题识别规则。"""
from __future__ import annotations

import re
from typing import Optional


EXCLUDE_PATTERNS = (
    r"摘要",
    r"补充公告|补充说明",
    r"问询|回复|监管工作函|审核意见",
    r"审计报告|审阅报告|鉴证报告|专项说明|核查意见|法律意见",
    r"董事会|监事会|独立董事|内部控制|社会责任|ESG|环境、社会",
    r"业绩说明会|投资者关系|延期披露|取消披露|提示性公告",
    r"业绩预告|业绩快报",
)

FULLTEXT_VARIANT = r"(?:全文|英文版|外文版|英文译本|更正(?:后|稿|版)?|修订(?:后|稿|版)?|更新后)"

REPORT_PATTERNS = (
    ("第一季度报告", re.compile(r"(?P<year>20\d{2})\s*年\s*第?一\s*季度报告")),
    ("第三季度报告", re.compile(r"(?P<year>20\d{2})\s*年\s*第?三\s*季度报告")),
    ("半年度报告", re.compile(r"(?P<year>20\d{2})\s*年\s*半年度报告")),
    ("年度报告", re.compile(r"(?P<year>20\d{2})\s*年\s*(?:年度报告|年报)")),
)


def clean_title(title: str) -> str:
    value = re.sub(r"</?em>", "", title or "", flags=re.I)
    value = value.replace("：", ":").replace("（", "(").replace("）", ")")
    return re.sub(r"\s+", "", value).strip()


def classify_report_title(title: str) -> Optional[dict]:
    """返回报告类型/报告期；非正式全文返回 None。"""
    normalized = clean_title(title)
    if not normalized or any(re.search(pat, normalized, re.I) for pat in EXCLUDE_PATTERNS):
        return None

    for report_type, pattern in REPORT_PATTERNS:
        match = pattern.search(normalized)
        if not match:
            continue
        # 报告全文的英文版、更正稿和修订稿也纳入；单独更正公告等业务性后缀仍排除。
        suffix = normalized[match.end():]
        suffix = suffix.strip("-—_·:：.。")
        if suffix and not re.fullmatch(
            rf"(?:(?:{FULLTEXT_VARIANT})|\((?:{FULLTEXT_VARIANT})\))*",
            suffix,
            re.I,
        ):
            return None
        year = match.group("year")
        period = {
            "第一季度报告": f"{year}Q1",
            "第三季度报告": f"{year}Q3",
            "半年度报告": f"{year}H1",
            "年度报告": f"{year}FY",
        }[report_type]
        return {"报告类型": report_type, "报告期": period}
    return None


def is_target_report(title: str) -> bool:
    return classify_report_title(title) is not None
