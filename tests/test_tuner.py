from __future__ import annotations

import numpy as np
import pytest

from auto_pid_tuning.analysis import FlightAnalysis, NoiseStats, StepResponse, StickStats
from auto_pid_tuning.styles import get_style
from auto_pid_tuning.tuner import MAX_STEP, tune

AXES = ("roll", "pitch", "yaw")


def make_step(peak: float = 1.08, steady: float = 1.0, bandwidth: float = 30.0) -> StepResponse:
    return StepResponse(
        time=np.zeros(1),
        response=np.zeros(1),
        windows=50,
        bandwidth=bandwidth,
        peak=peak,
        peak_time=0.04,
        rise_time=0.02,
        steady_state=steady,
    )


def make_analysis(
    peak: float = 1.08,
    steady: float = 1.0,
    dterm_rms: float = 8.0,
    saturation: float = 0.0,
    peak_hz: float | None = None,
    bandwidth: float = 30.0,
    max_stick: float = 800.0,
) -> FlightAnalysis:
    return FlightAnalysis(
        duration=120.0,
        sample_rate=1000.0,
        step={axis: make_step(peak, steady, bandwidth) for axis in AXES},
        noise={
            axis: NoiseStats(1.0, 0.0 if axis == "yaw" else dterm_rms, peak_hz) for axis in AXES
        },
        sticks={axis: StickStats(max_stick, 20.0, 300.0, max_stick) for axis in AXES},
        motor_saturation=saturation,
        throttle_mean=0.4,
    )


def by_param(result) -> dict:
    return {change.param: change for change in result.changes}


def test_good_tune_is_left_alone(headers):
    result = tune(headers, make_analysis(), get_style("freestyle"))
    assert result.changes == []
    assert result.cli_commands() == []


def test_overshoot_adds_damping(headers):
    changes = by_param(tune(headers, make_analysis(peak=1.25), get_style("freestyle")))

    assert changes["d_roll"].suggested == 44  # 40 * 1.10
    assert changes["d_min_roll"].suggested == 33
    assert changes["d_pitch"].suggested > 46
    assert "p_roll" not in changes
    # Yaw has no D: its overshoot is fixed with P.
    assert changes["p_yaw"].suggested < 45
    assert changes["simplified_pids_mode"].suggested == "OFF"


def test_overshoot_with_noisy_dterm_lowers_p_instead(headers):
    analysis = make_analysis(peak=1.25, dterm_rms=20.0)
    changes = by_param(tune(headers, analysis, get_style("freestyle")))

    assert "d_roll" not in changes
    assert changes["p_roll"].suggested < 45


def test_soft_response_raises_p(headers):
    changes = by_param(tune(headers, make_analysis(peak=0.96), get_style("freestyle")))
    assert changes["p_roll"].suggested > 45
    assert "d_roll" not in changes


def test_gains_are_not_raised_when_motors_saturate(headers):
    result = tune(
        headers, make_analysis(peak=0.96, steady=0.85, saturation=0.2), get_style("freestyle")
    )
    assert not [change for change in result.changes if change.group == "pid"]
    assert any("at their limit" in note for note in result.notes)


def test_low_steady_state_raises_i(headers):
    changes = by_param(tune(headers, make_analysis(steady=0.88), get_style("freestyle")))
    assert changes["i_roll"].suggested == 90  # 80 * 1.12


def test_changes_are_capped(headers):
    changes = by_param(tune(headers, make_analysis(peak=2.0), get_style("freestyle")))
    assert changes["d_roll"].suggested == round(40 * (1 + MAX_STEP))


def test_style_changes_the_verdict(headers):
    headers["ff_weight"] = [80, 80, 80]  # inside every style range, so only overshoot matters
    analysis = make_analysis(peak=1.10)
    assert "d_roll" not in by_param(tune(headers, analysis, get_style("freestyle")))
    assert "d_roll" in by_param(tune(headers, analysis, get_style("cinematic")))


def test_excess_feedforward_is_fixed_before_p_and_d(headers):
    headers["ff_weight"] = [180, 180, 180]
    changes = by_param(tune(headers, make_analysis(peak=1.25), get_style("freestyle")))

    assert changes["f_roll"].suggested == 150
    assert "d_roll" not in changes
    assert "p_yaw" not in changes


def test_unmeasured_step_response_leaves_pids_alone(headers):
    result = tune(headers, make_analysis(peak=1.4, bandwidth=5.0), get_style("freestyle"))
    assert not [change for change in result.changes if change.group == "pid"]


def test_noisy_dterm_tightens_filters(headers):
    changes = by_param(tune(headers, make_analysis(dterm_rms=20.0), get_style("freestyle")))

    assert changes["dterm_lpf1_dyn_min_hz"].suggested < 75
    assert changes["gyro_lpf1_static_hz"].suggested < 250
    assert changes["simplified_dterm_filter"].suggested == "OFF"
    assert changes["simplified_gyro_filter"].suggested == "OFF"


def test_clean_dterm_relaxes_filters(headers):
    changes = by_param(tune(headers, make_analysis(dterm_rms=1.0), get_style("freestyle")))
    assert changes["dterm_lpf1_dyn_min_hz"].suggested > 75
    assert changes["gyro_lpf2_static_hz"].suggested > 500


def test_disabled_filters_stay_disabled(headers):
    headers["gyro_lpf2_static_hz"] = 0
    changes = by_param(tune(headers, make_analysis(dterm_rms=1.0), get_style("freestyle")))
    assert "gyro_lpf2_static_hz" not in changes


def test_legacy_firmware_uses_legacy_names(headers):
    headers.update(
        {
            "Firmware revision": "Betaflight 4.2.8 (101738d8e) STM32F7X2",
            "gyro_lowpass_hz": 300,
            "gyro_lowpass_dyn_hz": [0, 400],
            "dterm_lowpass_hz": 100,
            "dterm_lowpass_dyn_hz": [0, 350],
            "feedforward_weight": [120, 120, 120],
        }
    )
    result = tune(headers, make_analysis(peak=1.25, dterm_rms=20.0), get_style("freestyle"))
    changes = by_param(result)

    assert changes["gyro_lowpass_hz"].suggested == 270
    assert changes["dyn_lpf_gyro_max_hz"].suggested == 360
    assert "dyn_lpf_gyro_min_hz" not in changes  # 0 = disabled
    assert not any(param.startswith("simplified") for param in changes)


def test_dynamic_notch_follows_noise_peak(headers):
    low = by_param(tune(headers, make_analysis(peak_hz=110.0), get_style("freestyle")))
    assert low["dyn_notch_min_hz"].suggested == 80

    inside = by_param(tune(headers, make_analysis(peak_hz=300.0), get_style("freestyle")))
    assert "dyn_notch_min_hz" not in inside
    assert "dyn_notch_max_hz" not in inside


def test_missing_rpm_filter_is_noted(headers):
    headers["dshot_bidir"] = 0
    result = tune(headers, make_analysis(), get_style("freestyle"))
    assert any("RPM filtering is off" in note for note in result.notes)


def test_suitable_rates_are_kept(headers):
    result = tune(headers, make_analysis(), get_style("freestyle"))
    assert not [change for change in result.changes if change.group == "rates"]


def test_rates_are_pulled_into_the_style_range(headers):
    changes = by_param(tune(headers, make_analysis(), get_style("cinematic")))

    assert changes["roll_srate"].suggested == 60  # 800 deg/s -> 600, top of the cine range
    assert changes["yaw_srate"].suggested == 45
    assert changes["roll_rc_rate"].suggested == 9
    assert "roll_expo" not in changes  # 0.45 is close enough to 0.55: keep muscle memory
    assert "rates_type" not in changes


def test_betaflight_rates_are_converted_to_actual(headers):
    headers.update(
        {"rates_type": 0, "rc_rates": [100, 100, 100], "rates": [70, 70, 70], "rc_expo": [0, 0, 0]}
    )
    changes = by_param(tune(headers, make_analysis(), get_style("freestyle")))

    assert changes["rates_type"].suggested == "ACTUAL"
    assert changes["roll_rc_rate"].suggested == 15
    # 667 deg/s flown, raised to the 700 minimum: srate is already 70, nothing to set.
    assert "roll_srate" not in changes
    assert changes["roll_expo"].suggested == 45


def test_unknown_rate_type_uses_stick_usage(headers):
    headers["rates_type"] = 2  # KISS, not modelled
    result = tune(headers, make_analysis(max_stick=500.0), get_style("cinematic"))
    changes = by_param(result)

    assert changes["rates_type"].suggested == "ACTUAL"
    assert changes["roll_srate"].suggested == 60  # 1.2 * 500 = 600
    assert any("not modelled" in note for note in result.notes)


def test_cli_commands_end_with_save(headers):
    commands = tune(headers, make_analysis(peak=1.25), get_style("freestyle")).cli_commands()
    assert commands[0] == "set simplified_pids_mode = OFF"
    assert "set d_roll = 44" in commands
    assert commands[-1] == "save"


def test_unknown_style():
    with pytest.raises(ValueError, match="Unknown flight style"):
        get_style("acro-ballet")
    assert get_style("Cine").name == "cinematic"
    assert get_style("long-range").name == "long_range"
