import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "macd screener" / "macd_screener.py"


def load_macd_module():
    spec = importlib.util.spec_from_file_location("macd_screener_under_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MacdPathTests(unittest.TestCase):
    def test_loads_and_deduplicates_platform_fund_positions(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            funds_path = tmp_path / "funds.json"
            output_dir = tmp_path / "output"
            funds_path.write_text(
                json.dumps(
                    {
                        "funds": [
                            {
                                "positions": [
                                    {"code": "603663", "name": "三祥新材", "currentPrice": 43.72},
                                    {"code": "000629", "name": "钒钛股份", "currentPrice": 3.08},
                                ]
                            },
                            {
                                "positions": [
                                    {"code": "603663", "name": "三祥新材", "currentPrice": 44.0}
                                ]
                            },
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with patch.dict(
                os.environ,
                {
                    "MACD_WATCHLIST_PATH": str(funds_path),
                    "MACD_OUTPUT_DIR": str(output_dir),
                },
            ):
                module = load_macd_module()
                codes, metadata = module.load_watchlist_meta()

            self.assertEqual(codes, ["sh603663", "sz000629"])
            self.assertEqual(metadata["sh603663"]["股票名称"], "三祥新材")
            self.assertEqual(metadata["sh603663"]["现价"], 44.0)
            self.assertEqual(module.OUTPUT_DIR, output_dir)


if __name__ == "__main__":
    unittest.main()
