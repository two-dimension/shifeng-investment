from __future__ import annotations

import os
from pathlib import Path


def resolve_parquet_dir() -> Path:
    configured = os.environ.get("QUANT_PARQUET_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / "Downloads" / "parquet"
