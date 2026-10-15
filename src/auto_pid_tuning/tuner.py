"""Turn a flight analysis and a flight style into Betaflight setting changes.

The rules are deliberately conservative: gains and filter cutoffs move by at most 15% per
flight, so tuning is an iteration of fly, log, apply, repeat.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .analysis import FlightAnalysis, StepResponse
from .blackbox import AXES, firmware_version
from .rates import RATES_ACTUAL, actual_rate, current_rates, rate_curve
from .styles import Style

MAX_STEP = 0.15  # largest relative change of a gain or cutoff in one pass
MIN_STEP = 0.03  # smaller corrections are not worth a flight
SATURATION_LIMIT = 0.03  # share of flight time with a motor at its limit

P_LIMITS = (10, 150)
I_LIMITS = (10, 200)
D_LIMITS = (0, 100)
GYRO_LPF_LIMITS = (50, 1000)
DTERM_LPF_LIMITS = (40, 300)
RATE_CURVE_POINTS = 41

# (CLI name, log header, index in the header value or None) per firmware generation.
_FILTERS_4_3 = {
    "gyro": [
        ("gyro_lpf1_static_hz", "gyro_lpf1_static_hz", None),
        ("gyro_lpf1_dyn_min_hz", "gyro_lpf1_dyn_hz", 0),
        ("gyro_lpf1_dyn_max_hz", "gyro_lpf1_dyn_hz", 1),
        ("gyro_lpf2_static_hz", "gyro_lpf2_static_hz", None),
    ],
    "dterm": [
        ("dterm_lpf1_static_hz", "dterm_lpf1_static_hz", None),
        ("dterm_lpf1_dyn_min_hz", "dterm_lpf1_dyn_hz", 0),
        ("dterm_lpf1_dyn_max_hz", "dterm_lpf1_dyn_hz", 1),
        ("dterm_lpf2_static_hz", "dterm_lpf2_static_hz", None),
    ],
}
_FILTERS_LEGACY = {
    "gyro": [
        ("gyro_lowpass_hz", "gyro_lowpass_hz", None),
        ("dyn_lpf_gyro_min_hz", "gyro_lowpass_dyn_hz", 0),
        ("dyn_lpf_gyro_max_hz", "gyro_lowpass_dyn_hz", 1),
        ("gyro_lowpass2_hz", "gyro_lowpass2_hz", None),
    ],
    "dterm": [
        ("dterm_lowpass_hz", "dterm_lowpass_hz", None),
        ("dyn_lpf_dterm_min_hz", "dterm_lowpass_dyn_hz", 0),
        ("dyn_lpf_dterm_max_hz", "dterm_lowpass_dyn_hz", 1),
        ("dterm_lowpass2_hz", "dterm_lowpass2_hz", None),
    ],
}


@dataclass
class Change:
    group: str  # "pid", "filter" or "rates"
    param: str  # Betaflight CLI name
    current: int | str | None
    suggested: int | str
    reason: str
    # Id of the chart that shows why: an analysis excerpt ("move_roll", "hold_roll", "dterm")
    # or an entry of TuningResult.evidence ("notch", "rates_roll"). None for switches that
    # only make other changes possible.
    evidence: str | None = None

    @property
    def cli(self) -> str:
        return f"set {self.param} = {self.suggested}"


@dataclass
class TuningResult:
    style: Style
    changes: list[Change] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    evidence: dict[str, dict[str, Any]] = field(default_factory=dict)  # style-dependent charts

    def cli_commands(self) -> list[str]:
        """Commands to paste in the Betaflight CLI; empty when nothing changes."""
        if not self.changes:
            return []
        return [change.cli for change in self.changes] + ["save"]


def tune(headers: dict[str, Any], analysis: FlightAnalysis, style: Style) -> TuningResult:
    result = TuningResult(style=style, notes=list(analysis.warnings))
    version = firmware_version(headers)
    if version == (0, 0):
        result.notes.append("Firmware version not recognised; assuming Betaflight 4.3 or newer.")
        version = (4, 3)
    modern = version >= (4, 3)

    saturated = analysis.motor_saturation > SATURATION_LIMIT
    if saturated:
        result.notes.append(
            f"Motors are at their limit {analysis.motor_saturation:.0%} of the time: "
            "gains are not raised. Consider a lighter build or lower-pitch props."
        )

    pid_changes: list[Change] = []
    for index, axis in enumerate(AXES):
        noisy = analysis.noise[axis].dterm_rms > style.noise_high
        pid_changes += _tune_pid(
            headers, index, axis, analysis.step[axis], style, noisy, saturated, analysis.excerpts
        )
    if pid_changes and modern and headers.get("simplified_pids_mode", 0):
        pid_changes.insert(
            0,
            Change(
                "pid",
                "simplified_pids_mode",
                headers["simplified_pids_mode"],
                "OFF",
                "Sliders must be off, otherwise they overwrite the individual gains.",
            ),
        )
    result.changes += pid_changes
    result.changes += _tune_filters(headers, analysis, style, modern, result.notes)
    if any(change.evidence == "notch" for change in result.changes):
        result.evidence["notch"] = {
            "range": [headers.get("dyn_notch_min_hz"), headers.get("dyn_notch_max_hz")]
        }
    if version >= (4, 2):
        result.changes += _tune_rates(headers, analysis, style, result.notes, result.evidence)
    else:
        result.notes.append("Rates are left untouched: Actual rates need Betaflight 4.2 or newer.")

    if result.changes:
        result.notes.append(
            "Changes are limited to 15% per pass: apply them, fly the same way, "
            "log again and repeat until nothing is suggested."
        )
    return result


def _step(deviation: float) -> float:
    return float(np.clip(abs(deviation), MIN_STEP, MAX_STEP))


def _scaled(value: float, scale: float, limits: tuple[int, int]) -> int:
    return int(np.clip(round(value * scale), *limits))


def _tune_pid(
    headers: dict[str, Any],
    index: int,
    axis: str,
    step: StepResponse | None,
    style: Style,
    noisy: bool,
    saturated: bool,
    excerpts: dict[str, Any],
) -> list[Change]:
    gains = headers.get(f"{axis}PID")
    if step is None or not step.valid or not isinstance(gains, (list, tuple)) or len(gains) < 3:
        return []
    p, i, d = (int(v) for v in gains[:3])
    d_min = int(_indexed(headers.get("d_min"), index) or 0)
    changes: list[Change] = []

    def change(name: str, current: int, suggested: int, reason: str) -> None:
        # I shows on a held stick, everything else on the sharpest move.
        evidence = f"{'hold' if name == 'i' else 'move'}_{axis}"
        if suggested != current:
            changes.append(
                Change(
                    "pid",
                    f"{name}_{axis}",
                    current,
                    suggested,
                    reason,
                    evidence if evidence in excerpts else None,
                )
            )

    feedforward = _indexed(headers.get("ff_weight", headers.get("feedforward_weight")), index)
    ff_low, ff_high = style.feedforward_range
    overshoot = f"{(step.peak - 1) * 100:+.0f}%"
    # Too much feedforward alone can cause overshoot: lower it first, P and D wait a flight.
    excess_feedforward = bool(feedforward and feedforward > ff_high)
    if step.peak > style.peak_max and excess_feedforward:
        pass
    elif step.peak > style.peak_max:
        amount = _step(step.peak - style.peak_max)
        if axis != "yaw" and d > 0 and not noisy:
            reason = (
                f"Overshoot of {overshoot} exceeds the {style.name} target; more damping."
            )
            change("d", d, _scaled(d, 1 + amount, D_LIMITS), reason)
            if d_min:
                change("d_min", d_min, _scaled(d_min, 1 + amount, D_LIMITS), reason)
        else:
            why = "the D-term is already noisy" if noisy and axis != "yaw" else "no D on this axis"
            change(
                "p",
                p,
                _scaled(p, 1 - amount, P_LIMITS),
                f"Overshoot of {overshoot} exceeds the {style.name} target and {why}; less P.",
            )
    elif step.peak < style.peak_min and not saturated:
        amount = _step(style.peak_min - step.peak)
        change(
            "p",
            p,
            _scaled(p, 1 + amount, P_LIMITS),
            f"Response peaks at {overshoot}, soft for {style.name}; more P for a sharper response.",
        )

    if step.steady_state < 0.94 and not saturated:
        change(
            "i",
            i,
            _scaled(i, 1 + _step(1 - step.steady_state), I_LIMITS),
            f"Response settles at {step.steady_state:.0%} of the setpoint; more I to hold it.",
        )

    if feedforward:
        change(
            "f",
            int(feedforward),
            int(np.clip(feedforward, ff_low, ff_high)),
            f"Feedforward for {style.name} flying is kept between {ff_low} and {ff_high}.",
        )
    return changes


def _tune_filters(
    headers: dict[str, Any],
    analysis: FlightAnalysis,
    style: Style,
    modern: bool,
    notes: list[str],
) -> list[Change]:
    if not headers.get("dshot_bidir"):
        notes.append(
            "RPM filtering is off: enabling bidirectional DShot is the single biggest "
            "noise improvement and allows much lighter filtering."
        )

    changes: list[Change] = []
    noise = max(analysis.noise[axis].dterm_rms for axis in ("roll", "pitch"))
    if noise <= 0:
        notes.append("D-term is not in the log; lowpass filters are left untouched.")
    else:
        if noise > 2 * style.noise_high:
            scale, reason = 1 - MAX_STEP, "D-term noise is very high"
        elif noise > style.noise_high:
            scale, reason = 0.9, "D-term noise is high"
        elif noise < style.noise_low:
            scale, reason = 1.1, "D-term noise is low"
        else:
            scale, reason = 1.0, ""
        if scale != 1.0:
            action = "lower cutoffs, cooler motors" if scale < 1 else "higher cutoffs, less delay"
            reason = f"{reason} ({noise:.1f} RMS) for {style.name}; {action}."
            table = _FILTERS_4_3 if modern else _FILTERS_LEGACY
            evidence = "dterm" if "dterm" in analysis.excerpts else None
            for kind, limits in (("gyro", GYRO_LPF_LIMITS), ("dterm", DTERM_LPF_LIMITS)):
                scaled = []
                for param, header, position in table[kind]:
                    value = headers.get(header)
                    current = value if position is None else _indexed(value, position)
                    if not current:  # absent, or 0 = filter disabled
                        continue
                    suggested = int(np.clip(5 * round(current * scale / 5), *limits))
                    if suggested != current:
                        scaled.append(
                            Change("filter", param, int(current), suggested, reason, evidence)
                        )
                slider = f"simplified_{kind}_filter"
                if scaled and modern and headers.get(slider):
                    scaled.insert(
                        0,
                        Change(
                            "filter",
                            slider,
                            headers[slider],
                            "OFF",
                            "Slider must be off, otherwise it overwrites the cutoffs.",
                            evidence,
                        ),
                    )
                changes += scaled

    changes += _tune_dynamic_notch(headers, analysis, modern)
    return changes


def _tune_dynamic_notch(
    headers: dict[str, Any], analysis: FlightAnalysis, modern: bool
) -> list[Change]:
    low, high = headers.get("dyn_notch_min_hz"), headers.get("dyn_notch_max_hz")
    if not low or not high or (modern and not headers.get("dyn_notch_count")):
        return []
    peaks = [analysis.noise[axis].peak_hz for axis in ("roll", "pitch")]
    peaks = [peak for peak in peaks if peak is not None]
    if not peaks:
        return []
    changes = []
    if min(peaks) < low:
        suggested = max(60, int(min(peaks) * 0.8 // 10 * 10))
        if suggested < low:
            changes.append(
                Change(
                    "filter",
                    "dyn_notch_min_hz",
                    int(low),
                    suggested,
                    f"A noise peak at {min(peaks):.0f} Hz sits below the dynamic notch range.",
                    "notch",
                )
            )
    if max(peaks) > high:
        suggested = min(1000, int(-(-max(peaks) * 1.2 // 10) * 10))
        if suggested > high:
            changes.append(
                Change(
                    "filter",
                    "dyn_notch_max_hz",
                    int(high),
                    suggested,
                    f"A noise peak at {max(peaks):.0f} Hz sits above the dynamic notch range.",
                    "notch",
                )
            )
    return changes


def _tune_rates(
    headers: dict[str, Any],
    analysis: FlightAnalysis,
    style: Style,
    notes: list[str],
    evidence: dict[str, dict[str, Any]],
) -> list[Change]:
    current = current_rates(headers)
    is_actual = headers.get("rates_type") == RATES_ACTUAL
    targets = []
    suitable = current is not None
    for index, axis in enumerate(AXES):
        low, high = style.yaw_max_rate_range if axis == "yaw" else style.max_rate_range
        center = style.center_sensitivity[index]
        expo = style.expo[index]
        if current is not None:
            flown = current[index]
            wanted = flown.max_rate
            max_ok = low <= flown.max_rate <= high
            center_ok = 0.7 * center <= flown.center_sensitivity <= 1.3 * center
            suitable = suitable and max_ok and center_ok
            # Keep what already fits the style: sticks are muscle memory.
            if is_actual and center_ok:
                center = flown.center_sensitivity
            if is_actual and flown.expo is not None and abs(flown.expo - expo) <= 0.2:
                expo = flown.expo
        else:
            wanted = 1.2 * analysis.sticks[axis].p995
        max_rate = int(np.clip(10 * round(wanted / 10), low, high))
        targets.append((int(round(center)), max_rate, expo))

    if suitable:
        return []
    if current is None:
        notes.append(
            "The rate type of this log is not modelled; max rates are derived from "
            "the fastest moves of the flight."
        )

    changes: list[Change] = []
    if not is_actual:
        changes.append(
            Change(
                "rates",
                "rates_type",
                headers.get("rates_type"),
                "ACTUAL",
                "Actual rates set centre sensitivity and max rate directly in deg/s.",
            )
        )
    # The same three settings exist for every rate type, only their meaning differs.
    raw = [headers.get("rc_rates"), headers.get("rates"), headers.get("rc_expo")]
    for index, axis in enumerate(AXES):
        center, max_rate, expo = targets[index]
        low, high = style.yaw_max_rate_range if axis == "yaw" else style.max_rate_range
        settings = (
            ("rc_rate", round(center / 10), f"centre sensitivity of {center} deg/s"),
            ("srate", round(max_rate / 10), f"max rate of {max_rate} deg/s ({low}-{high})"),
            ("expo", round(expo * 100), f"expo of {expo:.2f}"),
        )
        for position, (name, suggested, text) in enumerate(settings):
            before = _indexed(raw[position], index)
            before = None if before is None else int(before)
            if before != suggested:
                changes.append(
                    Change(
                        "rates",
                        f"{axis}_{name}",
                        before,
                        int(suggested),
                        f"{style.name.capitalize()} {axis}: {text}.",
                        f"rates_{axis}",
                    )
                )
        if any(change.evidence == f"rates_{axis}" for change in changes):
            sticks = [step / (RATE_CURVE_POINTS - 1) for step in range(RATE_CURVE_POINTS)]
            evidence[f"rates_{axis}"] = {
                "stick": sticks,
                "current": rate_curve(headers, index, sticks),
                "suggested": [actual_rate(x, center, max_rate, expo) for x in sticks],
            }
    return changes


def _indexed(value: Any, index: int) -> float | None:
    if isinstance(value, (list, tuple)) and len(value) > index:
        return value[index]
    return None
