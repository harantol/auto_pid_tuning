"""Flight styles: what a "good tune" means for each way of flying."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Style:
    name: str
    description: str

    # Step response targets (1.0 = setpoint reached, peak - 1 = overshoot).
    peak_min: float  # below this the quad is considered sluggish
    peak_max: float  # above this it overshoots too much for the style

    # D-term noise above 100 Hz, in PID units RMS.
    noise_low: float  # below this the filters can be relaxed (less delay)
    noise_high: float  # above this the filters must be tightened (cooler motors)

    # Rates, in Betaflight "Actual" rates (deg/s, expo 0..1).
    center_sensitivity: tuple[int, int, int]  # roll, pitch, yaw
    max_rate_range: tuple[int, int]  # allowed max rate on roll/pitch
    yaw_max_rate_range: tuple[int, int]
    expo: tuple[float, float, float]

    feedforward_range: tuple[int, int]  # feedforward gains outside this are pulled back in


STYLES: dict[str, Style] = {
    style.name: style
    for style in (
        Style(
            name="freestyle",
            description="Snappy and locked-in, tolerant of a slight overshoot.",
            peak_min=1.02,
            peak_max=1.15,
            noise_low=4.0,
            noise_high=14.0,
            center_sensitivity=(150, 150, 130),
            max_rate_range=(700, 1000),
            yaw_max_rate_range=(500, 800),
            expo=(0.45, 0.45, 0.40),
            feedforward_range=(90, 150),
        ),
        Style(
            name="racing",
            description="Fastest possible stick response, precise at moderate rates.",
            peak_min=1.03,
            peak_max=1.12,
            noise_low=5.0,
            noise_high=16.0,
            center_sensitivity=(200, 200, 180),
            max_rate_range=(550, 750),
            yaw_max_rate_range=(450, 650),
            expo=(0.30, 0.30, 0.25),
            feedforward_range=(120, 200),
        ),
        Style(
            name="cinematic",
            description="Smooth footage: no overshoot, soft sticks, quiet motors.",
            peak_min=0.97,
            peak_max=1.04,
            noise_low=3.0,
            noise_high=9.0,
            center_sensitivity=(90, 90, 80),
            max_rate_range=(360, 600),
            yaw_max_rate_range=(300, 450),
            expo=(0.55, 0.55, 0.50),
            feedforward_range=(40, 90),
        ),
        Style(
            name="long_range",
            description="Efficient cruising: cool motors and gentle, stable response.",
            peak_min=0.97,
            peak_max=1.06,
            noise_low=2.5,
            noise_high=8.0,
            center_sensitivity=(80, 80, 70),
            max_rate_range=(300, 500),
            yaw_max_rate_range=(250, 400),
            expo=(0.40, 0.40, 0.35),
            feedforward_range=(50, 100),
        ),
    )
}

_ALIASES = {"cine": "cinematic", "cinewhoop": "cinematic", "race": "racing", "lr": "long_range"}


def get_style(name: str) -> Style:
    key = name.strip().lower().replace("-", "_").replace(" ", "_")
    key = _ALIASES.get(key, key)
    if key not in STYLES:
        raise ValueError(f"Unknown flight style '{name}'. Choose one of: {', '.join(STYLES)}.")
    return STYLES[key]
