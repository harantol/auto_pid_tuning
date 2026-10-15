"""Betaflight rate curves: what the logged rate settings mean in deg/s."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

RATES_BETAFLIGHT = 0
RATES_ACTUAL = 3


@dataclass(frozen=True)
class AxisRates:
    center_sensitivity: float  # deg/s per full stick, slope around the centre
    max_rate: float  # deg/s at full stick
    expo: float | None  # 0..1, only meaningful for Actual rates


def current_rates(headers: dict[str, Any]) -> list[AxisRates] | None:
    """Rates of the three axes as flown, or None for rate types that are not modelled."""
    rates_type = headers.get("rates_type", RATES_BETAFLIGHT)
    try:
        rc_rates = [float(v) for v in headers["rc_rates"]]
        rates = [float(v) for v in headers["rates"]]
        expos = [float(v) / 100.0 for v in headers["rc_expo"]]
    except (KeyError, TypeError, ValueError):
        return None
    if not (len(rc_rates) == len(rates) == len(expos) == 3):
        return None

    if rates_type == RATES_ACTUAL:
        return [
            AxisRates(center * 10.0, max(top, center) * 10.0, expo)
            for center, top, expo in zip(rc_rates, rates, expos, strict=True)
        ]
    if rates_type == RATES_BETAFLIGHT:
        return [
            AxisRates(
                center_sensitivity=200.0 * _betaflight_rc_rate(rc_rate) * (1.0 - expo),
                max_rate=betaflight_rate(1.0, rc_rate, super_rate, expo),
                expo=None,
            )
            for rc_rate, super_rate, expo in zip(rc_rates, rates, expos, strict=True)
        ]
    return None


def rate_curve(headers: dict[str, Any], index: int, sticks: list[float]) -> list[float] | None:
    """Commanded deg/s of axis `index` at each stick deflection, with the rates as flown."""
    if current_rates(headers) is None:
        return None
    rc_rate = float(headers["rc_rates"][index])
    top = float(headers["rates"][index])
    expo = float(headers["rc_expo"][index]) / 100.0
    if headers.get("rates_type", RATES_BETAFLIGHT) == RATES_ACTUAL:
        return [actual_rate(x, rc_rate * 10.0, max(top, rc_rate) * 10.0, expo) for x in sticks]
    return [betaflight_rate(x, rc_rate, top, expo) for x in sticks]


def _betaflight_rc_rate(rc_rate: float) -> float:
    rc_rate /= 100.0
    if rc_rate > 2.0:
        rc_rate += 14.54 * (rc_rate - 2.0)
    return rc_rate


def betaflight_rate(stick: float, rc_rate: float, super_rate: float, expo: float) -> float:
    """Commanded deg/s for a stick deflection (-1..1) with Betaflight-type rates."""
    magnitude = abs(stick)
    if expo:
        stick = stick * magnitude**3 * expo + stick * (1.0 - expo)
    rate = 200.0 * _betaflight_rc_rate(rc_rate) * stick
    if super_rate:
        rate /= min(max(1.0 - magnitude * super_rate / 100.0, 0.01), 1.0)
    return rate


def actual_rate(stick: float, center_sensitivity: float, max_rate: float, expo: float) -> float:
    """Commanded deg/s for a stick deflection (-1..1) with Actual-type rates."""
    magnitude = abs(stick)
    curve = magnitude * (stick**5 * expo + stick * (1.0 - expo))
    return stick * center_sensitivity + max(0.0, max_rate - center_sensitivity) * curve
