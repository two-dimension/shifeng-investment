from report_types import classify_report_title, is_target_report


def test_accepts_four_formal_report_types():
    assert classify_report_title("2025年年度报告")["报告期"] == "2025FY"
    assert classify_report_title("2026年半年度报告")["报告期"] == "2026H1"
    assert classify_report_title("2026年第一季度报告")["报告期"] == "2026Q1"
    assert classify_report_title("2026年第三季度报告")["报告期"] == "2026Q3"


def test_accepts_highlight_tags_and_fulltext_suffix():
    result = classify_report_title("<em>2025年年度报告</em>全文")
    assert result == {"报告类型": "年度报告", "报告期": "2025FY"}


def test_accepts_fulltext_variants():
    accepted = [
        "2025年年度报告（英文版）",
        "2025年年度报告(更正后)",
        "2025年年度报告修订稿",
        "2025年年度报告（修订版）（英文版）",
    ]
    assert all(is_target_report(title) for title in accepted)


def test_excludes_non_fulltext_derivative_documents():
    rejected = [
        "2025年年度报告摘要",
        "关于2025年年度报告的信息披露监管问询函回复",
        "关于2025年年度报告的更正公告",
        "会计师关于2025年年度报告的审计报告",
        "2025年度业绩快报",
        "2025年度业绩预告",
    ]
    assert all(not is_target_report(title) for title in rejected)


def test_rejects_extra_business_suffix():
    assert not is_target_report("2025年年度报告风险提示公告")
