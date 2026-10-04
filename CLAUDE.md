# Betaflight PID auto-tuning    
Given a black box of a flight and a user-defined style of this flight (freestyle, cine, long-range...) I would like an auto tuning of both PID, filters and rates.

## Working on the project
- Python package in `src/auto_pid_tuning`, managed with **uv** (never pip): `uv sync`, `uv add <pkg>`.
- Run: `uv run auto-pid-tuning <log> --style freestyle`
- Tests and lint: `uv run pytest`, `uv run ruff check`
- Pipeline: `blackbox.py` (load log) -> `analysis.py` (measure) -> `styles.py` (targets) -> `tuner.py` (changes) -> `report.py` / `cli.py`.
- The core is UI-independent: a web app should only call `load_log` / `analyze` / `tune` and render `report.to_dict`.
- Real logs live in `samples/` (git-ignored); tests needing them are skipped when absent.
