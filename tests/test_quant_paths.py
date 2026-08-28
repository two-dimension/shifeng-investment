import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
MODULE_FILE = ROOT / "scripts" / "quant_paths.py"


class QuantPathTests(unittest.TestCase):
    def load_module(self):
        spec = importlib.util.spec_from_file_location("quant_paths", MODULE_FILE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_parquet_dir_uses_environment_override(self):
        module = self.load_module()
        with patch.dict(os.environ, {"QUANT_PARQUET_DIR": "/tmp/shifeng-parquet"}):
            self.assertEqual(module.resolve_parquet_dir(), Path("/tmp/shifeng-parquet"))

    def test_parquet_dir_default_follows_current_user_home(self):
        module = self.load_module()
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(module.resolve_parquet_dir(), Path.home() / "Downloads" / "parquet")


if __name__ == "__main__":
    unittest.main()
