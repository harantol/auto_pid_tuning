"""App version, MAJOR.MINOR.

MAJOR is the number in the VERSION file at the repository root. MINOR counts the commits
on master since VERSION last changed: every merged PR adds one, and bumping MAJOR resets
it to 0. Docker images get the version baked in through AUTO_PID_TUNING_VERSION, since
they ship without the git history.

Stdlib only, so CI can run it as a plain script: `python src/auto_pid_tuning/version.py`.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

ENV_VAR = "AUTO_PID_TUNING_VERSION"
ROOT = Path(__file__).resolve().parents[2]
VERSION_FILE = ROOT / "VERSION"


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()


def get_version() -> str:
    if version := os.environ.get(ENV_VAR):
        return version
    try:
        major = int(VERSION_FILE.read_text().strip())
    except (OSError, ValueError):
        return "dev"
    try:
        # --first-parent: a PR that bumps VERSION counts as its merge commit, so it gets .0
        base = _git("log", "--first-parent", "-1", "--format=%H", "--", VERSION_FILE.name)
        minor = int(_git("rev-list", "--count", "--first-parent", f"{base}..HEAD"))
    except (OSError, ValueError, subprocess.CalledProcessError):
        return f"{major}.dev"
    return f"{major}.{minor}"


if __name__ == "__main__":
    print(get_version())
