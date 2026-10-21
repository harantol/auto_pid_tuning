"""The JavaScript version (app/core, what the page runs) against this Python version.

Each simulated flight is written as a blackbox log by tests/js/make_log.js, then analysed by
both. Everything the page shows must match: measurements, curves, changes, reasons and notes.

Real logs are not compared: Betaflight starts each log with an event, which orangebox (the
Python decoder) reads as part of the header, losing the first frames and decoding a few
garbage ones in their place. The JavaScript decoder reads them as Blackbox Explorer does.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

from auto_pid_tuning.analysis import analyze
from auto_pid_tuning.blackbox import flight_sizes, load_log
from auto_pid_tuning.report import flight_to_dict, tuning_to_dict
from auto_pid_tuning.styles import STYLES
from auto_pid_tuning.tuner import tune

JS = Path(__file__).parent / "js"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(NODE is None, reason="Node.js is not installed")

FLIGHTS = {
    "overshoot": {"damping": 0.5},
    "soft_and_saturated": {"damping": 1.0, "motorLevel": 1.0, "seed": 3},
    "gentle_sticks": {"damping": 0.35, "disturbance": 150, "amplitude": 80, "stickHz": 3},
    "noisy_dterm": {"dtermNoise": 40, "gyroToneHz": 120, "gyroTone": 6, "jitterUs": 3},
    "quiet_2k_unfiltered": {"fs": 2000, "duration": 40, "dtermNoise": 1, "unfiltered": True},
    "short_250hz": {"fs": 250, "duration": 15},
    "betaflight_rates_4_2": {
        "headers": {
            "Firmware revision": "Betaflight 4.2.9 (b6a4f9d) STM32F7X2",
            "rates_type": 0,
            "rc_rates": [100, 100, 100],
            "rates": [70, 70, 70],
            "rc_expo": [0, 0, 0],
        }
    },
    "legacy_4_1": {
        "headers": {
            "Firmware revision": "Betaflight 4.1.1 (a1b2c3d) STM32F405",
            "dterm_lowpass_hz": 100,
            "dterm_lowpass_dyn_hz": [70, 170],
            "gyro_lowpass_hz": 200,
            "gyro_lowpass2_hz": 250,
            "dshot_bidir": 0,
        },
        "dtermNoise": 30,
    },
}


def python_report(path: Path) -> dict:
    sizes = flight_sizes(path)
    index = sizes.index(max(sizes)) + 1
    log = load_log(path, index)
    analysis = analyze(log)
    return {
        "log_index": index,
        "log_count": len(sizes),
        "flight_bytes": sizes,
        **flight_to_dict(log.headers, analysis),
        "tunes": {
            style.name: tuning_to_dict(tune(log.headers, analysis, style))
            for style in STYLES.values()
        },
    }


def js_report(path: Path) -> dict:
    out = subprocess.run(
        [NODE, str(JS / "report.js"), str(path)], capture_output=True, text=True, check=True
    )
    report = json.loads(out.stdout)
    del report["filename"]
    return report


def differences(python, js, where="") -> list[str]:
    """Where the two reports differ; floats only need to agree to 1e-6."""
    if isinstance(python, dict) and isinstance(js, dict):
        found = [f"{where}: keys {sorted(set(python) ^ set(js))}"] if set(python) != set(js) else []
        for key in python.keys() & js.keys():
            found += differences(python[key], js[key], f"{where}.{key}")
        return found
    if isinstance(python, (list, tuple)) and isinstance(js, list):
        if len(python) != len(js):
            return [f"{where}: {len(python)} items in Python, {len(js)} in JS"]
        found = []
        for i, (a, b) in enumerate(zip(python, js, strict=True)):
            found += differences(a, b, f"{where}[{i}]")
            if len(found) > 5:
                break
        return found
    if isinstance(python, (int, float)) and isinstance(js, (int, float)):
        if isinstance(python, bool) or isinstance(js, bool):
            return [] if python == js else [f"{where}: {python!r} != {js!r}"]
        if math.isclose(python, js, rel_tol=1e-6, abs_tol=1e-9):
            return []
        return [f"{where}: {python!r} != {js!r}"]
    return [] if python == js else [f"{where}: {python!r} != {js!r}"]


def compare(path: Path) -> None:
    python = json.loads(json.dumps(python_report(path)))  # tuples become lists, as in JS
    found = differences(python, js_report(path))
    assert not found, "\n".join(found[:20])


@pytest.mark.parametrize("name", FLIGHTS)
def test_simulated_flight(name, tmp_path):
    path = tmp_path / f"{name}.bbl"
    subprocess.run(
        [NODE, str(JS / "make_log.js"), str(path), json.dumps(FLIGHTS[name])], check=True
    )
    compare(path)
