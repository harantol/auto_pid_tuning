from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from auto_pid_tuning.blackbox import FlightLog
from simulate import flight

SAMPLES = Path(__file__).parent.parent / "samples"

# Headers of a stock Betaflight 4.3 quad on Actual rates.
HEADERS_4_3 = {
    "Firmware revision": "Betaflight 4.3.0 (fc8318f54) STM32F405",
    "rollPID": [45, 80, 40],
    "pitchPID": [47, 84, 46],
    "yawPID": [45, 80, 0],
    "d_min": [30, 34, 0],
    "ff_weight": [120, 125, 120],
    "simplified_pids_mode": 2,
    "simplified_gyro_filter": 1,
    "simplified_dterm_filter": 1,
    "gyro_lpf1_static_hz": 250,
    "gyro_lpf1_dyn_hz": [250, 500],
    "gyro_lpf2_static_hz": 500,
    "dterm_lpf1_static_hz": 75,
    "dterm_lpf1_dyn_hz": [75, 150],
    "dterm_lpf2_static_hz": 150,
    "dyn_notch_count": 1,
    "dyn_notch_min_hz": 150,
    "dyn_notch_max_hz": 600,
    "dshot_bidir": 1,
    "rates_type": 3,
    "rc_rates": [15, 15, 13],
    "rates": [80, 80, 65],
    "rc_expo": [45, 45, 40],
    "motorOutput": [158, 2047],
}


@pytest.fixture
def headers() -> dict:
    return {key: list(v) if isinstance(v, list) else v for key, v in HEADERS_4_3.items()}


def make_log(headers: dict, dterm_noise: float = 6.0, motor_level: float = 0.4, **kwargs):
    """A FlightLog whose three axes share one simulated closed-loop response."""
    fs = kwargs.setdefault("fs", 1000.0)
    setpoint, gyro = [], []
    for seed in range(3):
        sp, gy, _ = flight(seed=seed, **kwargs)
        setpoint.append(sp)
        gyro.append(gy)
    n = len(setpoint[0])
    rng = np.random.default_rng(42)
    return FlightLog(
        headers=headers,
        time=np.arange(n) / fs,
        sample_rate=fs,
        setpoint=np.column_stack(setpoint),
        gyro=np.column_stack(gyro),
        throttle=np.full(n, 0.4),
        pid_p=np.zeros((n, 3)),
        pid_d=np.column_stack(
            [rng.normal(0, dterm_noise, n), rng.normal(0, dterm_noise, n), np.zeros(n)]
        ),
        motors=np.full((n, 4), motor_level),
    )


@pytest.fixture
def log_factory(headers):
    def factory(**kwargs):
        return make_log(headers, **kwargs)

    return factory
