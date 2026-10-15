# Betaflight PID auto-tuning    
Given a black box of a flight and a user-defined style of this flight (freestyle, cine, long-range...) I would like an auto tuning of both PID, filters and rates.

## Working on the project
- Python package in `src/auto_pid_tuning`, managed with **uv** (never pip): `uv sync`, `uv add <pkg>`.
- Run: `uv run auto-pid-tuning-web` (web app) or `uv run auto-pid-tuning <log> --style freestyle` (CLI)
- Tests and lint: `uv run pytest`, `uv run ruff check`
- Pipeline: `blackbox.py` (load log) -> `analysis.py` (measure) -> `styles.py` (targets) -> `tuner.py` (changes) -> `report.py` / `cli.py`.
- The core is UI-independent. The web app (`web/app.py`, FastAPI) only calls `load_log` / `analyze` / `tune` and returns `report.flight_to_dict` + `tuning_to_dict`; the page is plain JS/SVG in `web/static`, no Node build.
- Real logs live in `samples/` (git-ignored); tests needing them are skipped when absent.
- Version `MAJOR.MINOR`: major in `VERSION`, minor = merges into master since it changed (`version.py`).
- GitHub (`harantol/auto_pid_tuning`) with PRs into `master`. A merge publishes the Docker image to GHCR (S13 picks it up via Watchtower, `deploy/s13`) and updates the Hugging Face Space (`deploy/hf_space.py`).
- `orangebox` comes from `vendor/` (PyPI wheel with broken entry points removed, see `vendor/README.md`).
