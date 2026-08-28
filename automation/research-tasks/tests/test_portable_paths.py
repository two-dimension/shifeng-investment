from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


TASKS_ROOT = Path(__file__).resolve().parents[1]
TASK_NAMES = ("cninfo", "earnings", "earnings-report", "risk")
FORBIDDEN = (
    "/Users/" + "rayw",
    "/Users/" + "ray_wang",
    "Library/" + "LaunchAgents",
)


def _executable_sources():
    for task_name in TASK_NAMES:
        task_dir = TASKS_ROOT / task_name
        yield from task_dir.rglob("*.py")
        yield from task_dir.rglob("*.mjs")


def _run_import(task_dir: Path, source: str) -> None:
    result = subprocess.run(
        [sys.executable, "-c", source],
        cwd=task_dir,
        env={**os.environ, "PYTHONPATH": str(task_dir)},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_executable_sources_have_no_old_computer_paths_or_local_publishers():
    for source_path in _executable_sources():
        source = source_path.read_text(encoding="utf-8")
        for forbidden in FORBIDDEN:
            assert forbidden not in source, f"{source_path}: contains {forbidden}"
        assert "publish_shifeng.py" not in source, f"{source_path}: local publisher remains"
    earnings_report_run = (TASKS_ROOT / "earnings-report" / "run.py").read_text(encoding="utf-8")
    assert "from send_mail" not in earnings_report_run


def test_task_roots_stay_inside_a_temporary_checkout(tmp_path: Path):
    checkout = tmp_path / "research-tasks"
    shutil.copytree(
        TASKS_ROOT,
        checkout,
        ignore=shutil.ignore_patterns(".venv", "__pycache__", ".pytest_cache", "output", "state"),
    )

    _run_import(
        checkout / "cninfo",
        "from pathlib import Path; import run; "
        "root=Path.cwd().resolve(); out=run._date_dir('2026-08-28').resolve(); "
        "assert out.is_relative_to(root)",
    )
    _run_import(
        checkout / "earnings",
        "from pathlib import Path; import industry_map; "
        "root=Path.cwd().resolve(); assert industry_map.WATCHLIST_CSV.resolve().is_relative_to(root.parent)",
    )
    _run_import(
        checkout / "earnings-report",
        "from pathlib import Path; import run, industry_map; "
        "root=Path.cwd().resolve(); out=(run.HERE/'output'/'2026-08-28').resolve(); "
        "assert out.is_relative_to(root); assert run.STATE_DIR.resolve().is_relative_to(root); "
        "assert industry_map.DEFAULT_WATCHLIST.resolve().is_relative_to(root.parent)",
    )
    _run_import(
        checkout / "risk",
        "from pathlib import Path; import run, analyze; "
        "root=Path.cwd().resolve(); out=run._date_dir('2026-08-28').resolve(); "
        "assert out.is_relative_to(root); assert run.CNINFO_DIR.resolve().is_relative_to(root.parent); "
        "assert analyze.CNINFO_DIR.resolve().is_relative_to(root.parent)",
    )
