# Betaflight PID auto-tuning    
Given a black box of a flight and a user-defined style of this flight (freestyle, cine, long-range...) I would like an auto tuning of both PID, filters and rates.

## Working on the project
- The app is plain JavaScript in `app/` (ES modules, no build step, no npm dependency), Node 22+ for the tools: `npm start` (local server, `bin/serve.js`), `node bin/auto-pid-tuning.js <log> --style freestyle` (CLI), `npm test` (tests in `tests/js/`).
- Pipeline in `app/core/`: `decoder.js` (blackbox format, after Betaflight's Blackbox Explorer parser) -> `blackbox.js` (flights, arrays) -> `analysis.js` (measure, with `numeric.js`) -> `styles.js` (targets) -> `tuner.js` (changes) -> `report.js`; `index.js` runs it all on a file.
- The core is UI-independent. The page (`app/app.js`, plain JS/SVG) runs it in a worker (`app/worker.js`) on the user's device: no server-side analysis.
- `src/auto_pid_tuning/` is the former Python version, kept as reference until removed: managed with **uv** (never pip): `uv sync`, `uv run pytest`, `uv run ruff check`. `tests/test_js_parity.py` checks both versions give the same result; keep them in step when changing the analysis, or remove the Python side.
- Real logs live in `samples/` (git-ignored); tests needing them are skipped when absent. JS tests write simulated logs (`tests/js/writer.js`).
- Version `MAJOR.MINOR`: major in `VERSION`, minor = merges into master since it changed (`src/auto_pid_tuning/version.py`, stdlib only); builds write it to `version.json`.
- GitHub (`harantol/auto_pid_tuning`) with PRs into `master`. A merge publishes the Docker image (nginx serving `app/`, port 7860) to GHCR (S13 = Debian server 192.168.1.15, not the Synology `s13.home`, picks it up via Watchtower, `deploy/s13`) and attaches the Android app (`android/`, a WebView carrying `app/` as assets, works offline) to a GitHub release, which the home F-Droid store on S13 (repo `magasin-fdroid` in Forgejo) picks up.
- `orangebox` (Python side only) comes from `vendor/` (PyPI wheel with broken entry points removed, see `vendor/README.md`).
