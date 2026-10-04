# Betaflight auto-tuning

Suggests PIDs, filters and rates for a Betaflight quad from a blackbox log and the way you
want it to fly (`freestyle`, `racing`, `cinematic`, `long_range`).

## Usage

```
uv sync
uv run auto-pid-tuning path/to/LOG00001.BFL --style freestyle
```

Options: `--log-index N` picks a flight when the file holds several (default: the last one),
`--json` prints the full analysis (step responses included), `--output tune.txt` writes the
CLI commands to a file. Paste the commands in the Betaflight CLI tab.

## How it works

1. `blackbox.py` decodes the log (via `orangebox`) into numpy arrays.
2. `analysis.py` measures the flight:
   - closed-loop **step response** of each axis by Wiener deconvolution of gyro by setpoint
     (overshoot, rise time, steady state);
   - **noise** above 100 Hz on the filtered gyro and on the D-term, and any standing peak;
   - **motor saturation** and **stick usage**.
3. `styles.py` defines the targets of each flight style.
4. `tuner.py` compares the measurements to the targets and emits setting changes.
5. `report.py` / `cli.py` render the result.

Changes are capped at 15% per pass: apply, fly the same way, log again, repeat.

## Limits

- The targets and noise thresholds in `styles.py` are heuristics, not measured on a fleet of
  quads. Treat suggestions as a starting point and check motor temperature after each change.
- Step responses need real stick inputs: a hover-only log leaves the PIDs untouched.
- Supports Betaflight 4.2+ logs; Actual and Betaflight rate types are modelled.

## Development

```
uv run pytest
uv run ruff check
```

Sample logs go in `samples/` (git-ignored); tests that need them are skipped when absent.
