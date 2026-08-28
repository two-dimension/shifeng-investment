import unittest

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from placement_analysis import (
    analyze_placement_plan,
    is_canonical_placement_plan,
)


class PlacementAnalysisTests(unittest.TestCase):
    def test_only_canonical_plan_is_eligible(self):
        cases = [
            ("2026年度向特定对象发行A股股票预案", True),
            ("非公开发行股票预案(修订稿)", True),
            ("定增预案", True),
            ("关于向特定对象发行股票预案披露的提示性公告", False),
            ("向特定对象发行股票方案论证分析报告", False),
            ("向特定对象发行股票审核意见", False),
            ("向特定对象发行股票摊薄即期回报的公告", False),
        ]
        for title, expected in cases:
            with self.subTest(title=title):
                self.assertEqual(is_canonical_placement_plan(title), expected)

    def test_juguang_is_expansion_plus_seven(self):
        title = "西安炬光科技2026年度向特定对象发行A股股票预案"
        text = """
        本次向特定对象发行募集资金总额不超过人民币102,114.95万元。
        高端光互联核心光学元器件研发及产业化能力建设项目，
        拟使用募集资金额39,126.15万元。
        面向高速光通信激光器高性能衬底材料产业化项目，
        拟使用募集资金额30,297.70万元。
        面向光互联核心器件的高端装备产业化项目，
        拟使用募集资金2,691.10万元。
        公司拟使用本次募集资金30,000.00万元补充流动资金。
        募集资金投资项目均紧密围绕公司主营业务开展，
        有助于公司把握AI算力基础设施和高速光互联快速发展机遇。
        发行数量不超过本次发行前公司总股本的百分之五。
        发行价格不低于定价基准日前二十个交易日公司股票交易均价的百分之八十。
        截至本预案公告日，公司尚未确定本次发行的发行对象。
        认购股份自本次发行结束之日起6个月内不得转让。
        """
        result = analyze_placement_plan(title, text)
        self.assertEqual(result["score"], 7)
        self.assertEqual(
            result["signals"],
            [("定增投向主业扩产", 7)],
        )
        self.assertTrue(any("不重复扣减扩产分" in reason for reason in result["reasons"]))
        metrics = result["metrics"]
        self.assertAlmostEqual(metrics["industrial_project_pct"], 70.6213, places=3)
        self.assertAlmostEqual(metrics["liquidity_and_ordinary_debt_pct"], 29.3787, places=3)
        self.assertAlmostEqual(metrics["issue_ratio_pre_capital_pct"], 5.0, places=3)
        self.assertEqual(metrics["lockup_months"], 6)
        self.assertEqual(metrics["pricing_type"], "auction_floor")
        self.assertFalse(metrics["investors_known"])

    def test_pure_working_capital_is_negative_two(self):
        result = analyze_placement_plan(
            "2026年度非公开发行股票预案",
            "本次募集资金总额不超过10亿元。公司拟使用本次募集资金10亿元补充流动资金。",
        )
        self.assertEqual(result["score"], -2)
        self.assertIn(("定增补流/还贷为主", -2), result["signals"])

    def test_partial_working_capital_without_qualified_expansion_is_negative_one(self):
        result = analyze_placement_plan(
            "2026年度非公开发行股票预案",
            "本次募集资金总额不超过10亿元，其中3亿元补充流动资金，其余用于一般研发投入。",
        )
        self.assertEqual(result["score"], -1)
        self.assertEqual(result["signals"], [("定增补流占比较高", -1)])

    def test_fifty_fifty_qualified_expansion_takes_expansion_class(self):
        result = analyze_placement_plan(
            "2026年度向特定对象发行A股股票预案",
            """
            本次募集资金总额不超过10亿元。
            其中5亿元用于AI高速光通信器件产业化扩产项目，项目紧密围绕公司主营业务；
            5亿元用于补充流动资金。
            """,
        )
        self.assertEqual(result["score"], 7)
        self.assertEqual(result["signals"], [("定增投向主业扩产", 7)])

    def test_thirty_percent_dilution(self):
        result = analyze_placement_plan(
            "向特定对象发行A股股票预案",
            "本次募集资金总额为5亿元。发行数量不超过本次发行前总股本的30%。",
        )
        self.assertEqual(result["score"], -5)
        self.assertIn(("定增严重稀释", -5), result["signals"])

    def test_expansion_keeps_independent_severe_dilution_penalty(self):
        result = analyze_placement_plan(
            "向特定对象发行A股股票预案",
            """
            本次募集资金总额不超过10亿元。
            AI高速光通信器件产业化扩产项目拟使用募集资金10亿元，
            募投项目紧密围绕公司主营业务。发行数量不超过发行前总股本的30%。
            """,
        )
        self.assertEqual(result["score"], 2)
        self.assertEqual(
            result["signals"],
            [("定增投向主业扩产", 7), ("定增严重稀释", -5)],
        )

    def test_internal_subscription(self):
        result = analyze_placement_plan(
            "定增预案",
            "本次发行对象仅为公司控股股东及实际控制人，将以现金全额认购本次发行股票。",
        )
        self.assertEqual(result["score"], 3)
        self.assertIn(("定增内部人认购", 3), result["signals"])

    def test_fixed_price_thresholds(self):
        cases = [
            (95.0, 3, "定增高价发行"),
            (80.0, -3, "定增大幅折价"),
        ]
        for issue_price, expected_score, expected_label in cases:
            with self.subTest(issue_price=issue_price):
                result = analyze_placement_plan(
                    "非公开发行股票预案",
                    "本次发行价格为{:.2f}元/股。".format(issue_price),
                    current_price=100.0,
                )
                self.assertEqual(result["score"], expected_score)
                self.assertIn((expected_label, expected_score), result["signals"])

    def test_no_text_does_not_mechanically_deduct(self):
        result = analyze_placement_plan("向特定对象发行股票预案", "")
        self.assertEqual(result["score"], 0)
        self.assertEqual(result["signals"], [])


if __name__ == "__main__":
    unittest.main()
