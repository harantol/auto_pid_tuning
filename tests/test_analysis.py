from __future__ import annotations

import numpy as np
import pytest

from auto_pid_tuning.analysis import (
    analyze,
    band_rms,
    noise_peak,
    step_response,
    stick_stats,
)
from simulate import flight


@pytest.mark.parametrize("damping", [0.35, 0.5, 0.7, 1.0])
@pytest.mark.parametrize("fs", [1000.0, 250.0])
def test_step_response_recovers_known_system(damping, fs):
    setpoint, gyro, true = flight(fs=fs, damping=damping)
    response = step_response(setpoint, gyro, fs)

    assert response.valid
    assert response.peak == pytest.approx(true.max(), abs=0.06)
    assert response.steady_state == pytest.approx(1.0, abs=0.03)
    true_rise = np.argmax(true >= 0.5) / fs
    assert response.rise_time == pytest.approx(true_rise, abs=0.006)


def test_step_response_orders_tunes_by_overshoot():
    peaks = [
        step_response(*flight(damping=damping)[:2], 1000.0).peak for damping in (1.0, 0.6, 0.3)
    ]
    assert peaks == sorted(peaks)


def test_step_response_invalid_when_sticks_are_too_gentle():
    # Slow, small stick moves buried in wind: the response cannot be read from the log.
    setpoint, gyro, _ = flight(damping=0.35, disturbance=150.0, amplitude=80.0, stick_hz=3.0)
    response = step_response(setpoint, gyro, 1000.0)
    assert not response.valid
    assert response.bandwidth < 15.0


def test_step_response_none_without_stick_input():
    rng = np.random.default_rng(0)
    assert step_response(np.zeros(20_000), rng.normal(0, 1, 20_000), 1000.0) is None


def test_step_response_none_for_short_log():
    assert step_response(np.ones(500), np.ones(500), 1000.0) is None


def test_band_rms_measures_only_the_band():
    fs = 1000.0
    t = np.arange(int(20 * fs)) / fs
    low = 50.0 * np.sin(2 * np.pi * 5 * t)
    high = 3.0 * np.sin(2 * np.pi * 220 * t)
    assert band_rms(low + high, fs, 100.0) == pytest.approx(3.0 / np.sqrt(2), rel=0.05)
    assert band_rms(low, fs, 100.0) < 0.05


def test_noise_peak_finds_a_resonance():
    fs = 1000.0
    t = np.arange(int(20 * fs)) / fs
    rng = np.random.default_rng(0)
    noise = rng.normal(0, 1, len(t))
    assert noise_peak(noise, fs) is None
    assert noise_peak(noise + 5 * np.sin(2 * np.pi * 240 * t), fs) == pytest.approx(240, abs=3)


def test_stick_stats():
    stats = stick_stats(np.concatenate((np.zeros(900), np.full(100, -600.0))))
    assert stats.max_rate == 600.0
    assert stats.p50 == 0.0
    assert stats.p95 == 600.0


def test_analyze_full_flight(log_factory):
    analysis = analyze(log_factory(damping=0.5, dterm_noise=6.0))

    assert analysis.duration == pytest.approx(120.0, abs=0.1)
    assert all(analysis.step[axis].valid for axis in ("roll", "pitch", "yaw"))
    assert analysis.noise["roll"].dterm_rms == pytest.approx(6.0 * np.sqrt(0.8), rel=0.1)
    assert analysis.noise["yaw"].dterm_rms == 0.0
    assert analysis.motor_saturation == 0.0
    assert analysis.warnings == []


def test_analyze_reports_saturation_and_gentle_sticks(log_factory):
    log = log_factory(
        damping=0.35, disturbance=150.0, amplitude=80.0, stick_hz=3.0, motor_level=1.0
    )
    analysis = analyze(log)

    assert analysis.motor_saturation == 1.0
    assert sum("too gentle" in warning for warning in analysis.warnings) == 3
