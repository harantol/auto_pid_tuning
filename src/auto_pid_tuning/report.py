"""Human-readable and JSON rendering of a tuning result."""

from __future__ import annotations

from typing import Any

from .analysis import FlightAnalysis
from .blackbox import AXES
from .tuner import TuningResult

_GROUP_TITLES = {"pid": "PIDs", "filter": "Filters", "rates": "Rates"}


def to_dict(headers: dict[str, Any], analysis: FlightAnalysis, result: TuningResult) -> dict:
    """JSON-serialisable summary, the payload a UI would consume."""
    axes = {}
    for axis in AXES:
        step = analysis.step[axis]
        noise = analysis.noise[axis]
        sticks = analysis.sticks[axis]
        axes[axis] = {
            "step_response": None
            if step is None
            else {
                "valid": step.valid,
                "windows": step.windows,
                "peak": step.peak,
                "peak_time": step.peak_time,
                "rise_time": step.rise_time,
                "steady_state": step.steady_state,
                "time": step.time.tolist(),
                "response": step.response.tolist(),
            },
            "noise": {
                "gyro_rms": noise.gyro_rms,
                "dterm_rms": noise.dterm_rms,
                "peak_hz": noise.peak_hz,
                "gyro_unfiltered_rms": noise.gyro_unfiltered_rms,
            },
            "sticks": {
                "max_rate": sticks.max_rate,
                "p50": sticks.p50,
                "p95": sticks.p95,
                "p995": sticks.p995,
            },
        }
    return {
        "firmware": headers.get("Firmware revision"),
        "craft": headers.get("Craft name"),
        "style": result.style.name,
        "duration": analysis.duration,
        "sample_rate": analysis.sample_rate,
        "motor_saturation": analysis.motor_saturation,
        "axes": axes,
        "changes": [
            {
                "group": change.group,
                "param": change.param,
                "current": change.current,
                "suggested": change.suggested,
                "reason": change.reason,
            }
            for change in result.changes
        ],
        "notes": result.notes,
        "cli": result.cli_commands(),
    }


def to_text(headers: dict[str, Any], analysis: FlightAnalysis, result: TuningResult) -> str:
    lines = [
        f"Firmware : {headers.get('Firmware revision', 'unknown')}",
        f"Flight   : {analysis.duration:.0f} s logged at {analysis.sample_rate:.0f} Hz, "
        f"motors saturated {analysis.motor_saturation:.1%} of the time",
        f"Style    : {result.style.name} - {result.style.description}",
        "",
        "Measured",
        f"  {'axis':<6}{'overshoot':>10}{'rise':>9}{'settles':>9}"
        f"{'gyro noise':>12}{'D noise':>9}{'max stick':>11}",
    ]
    for axis in AXES:
        step = analysis.step[axis]
        noise = analysis.noise[axis]
        if step is not None and step.valid:
            response = (
                f"{(step.peak - 1) * 100:>+9.0f}%{step.rise_time * 1000:>6.0f} ms"
                f"{step.steady_state:>9.0%}"
            )
        else:
            response = f"{'n/a':>10}{'n/a':>9}{'n/a':>9}"
        lines.append(
            f"  {axis:<6}{response}{noise.gyro_rms:>12.1f}{noise.dterm_rms:>9.1f}"
            f"{analysis.sticks[axis].max_rate:>5.0f} deg/s"
        )

    if not result.changes:
        lines += ["", f"Nothing to change: this tune already fits {result.style.name} flying."]
    for group, title in _GROUP_TITLES.items():
        changes = [change for change in result.changes if change.group == group]
        if not changes:
            continue
        lines += ["", title]
        for change in changes:
            current = "?" if change.current is None else change.current
            values = f"{current!s:>6} -> {change.suggested!s:<8}"
            lines.append(f"  {change.param:<24}{values}{change.reason}")

    if result.notes:
        lines += ["", "Notes"] + [f"  - {note}" for note in result.notes]
    if result.changes:
        lines += ["", "Betaflight CLI"] + [f"  {command}" for command in result.cli_commands()]
    return "\n".join(lines)
