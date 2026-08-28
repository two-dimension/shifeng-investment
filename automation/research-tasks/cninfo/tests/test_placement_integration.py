import unittest
from unittest.mock import patch

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import analyze


JUGUANG_TITLE = "西安炬光科技股份有限公司2026年度向特定对象发行A股股票预案"
JUGUANG_TEXT = """
本次向特定对象发行募集资金总额不超过人民币102,114.95万元。
高端光互联核心光学元器件研发及产业化能力建设项目，拟使用募集资金额39,126.15万元。
面向高速光通信激光器高性能衬底材料产业化项目，拟使用募集资金额30,297.70万元。
面向光互联核心器件的高端装备产业化项目，拟使用募集资金2,691.10万元。
公司拟使用本次募集资金30,000.00万元补充流动资金。
募集资金投资项目均紧密围绕公司主营业务开展，有助于把握AI算力基础设施和高速光互联机遇。
发行数量不超过本次发行前公司总股本的百分之五。
发行价格不低于定价基准日前二十个交易日公司股票交易均价的百分之八十。
截至本预案公告日，公司尚未确定本次发行的发行对象。
认购股份自本次发行结束之日6个月内不得转让。
"""


def _ann(announcement_id, title):
    return {
        "announcementId": announcement_id,
        "announcementTitle": title,
        "announcementTime": 1786118400000,
        "secCode": "688167",
        "secName": "炬光科技",
        "adjunctUrl": f"finalpage/2026-08-08/{announcement_id}.PDF",
    }


class PlacementIntegrationTests(unittest.TestCase):
    @patch.object(analyze, "_get_price_position", return_value=None)
    @patch.object(analyze, "_read_pdf_text", return_value=JUGUANG_TEXT)
    def test_main_plan_enters_good_once_and_companion_stays_neutral(self, _read, _price):
        raw = {
            "start_date": "2026-08-08",
            "end_date": "2026-08-08",
            "announcements": [
                _ann("1225464376", JUGUANG_TITLE),
                _ann(
                    "1225464346",
                    "西安炬光科技股份有限公司关于2026年度向特定对象发行A股股票预案披露的提示性公告",
                ),
            ],
        }

        result = analyze.process(raw)
        matches = [entry for entry in result["top_good"] if entry["code"] == "688167"]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["best_score"], 7)
        self.assertEqual(matches[0]["ann_count"], 1)
        self.assertEqual(
            matches[0]["best_signals"],
            [("定增投向主业扩产", 7)],
        )
        self.assertTrue(any("提示性公告" in item["title"] for item in result["neutral_announcements"]))

    @patch.object(analyze, "_read_pdf_text", return_value="")
    def test_pdf_failure_keeps_negative_two_fallback(self, _read):
        raw = {
            "start_date": "2026-08-08",
            "end_date": "2026-08-08",
            "announcements": [_ann("1225464376", JUGUANG_TITLE)],
        }
        result = analyze.process(raw)
        matches = [entry for entry in result["top_bad"] if entry["code"] == "688167"]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["best_score"], -2)


if __name__ == "__main__":
    unittest.main()
