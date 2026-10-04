from __future__ import annotations

import pytest

from auto_pid_tuning.rates import actual_rate, betaflight_rate, current_rates


def test_actual_rates_are_read_directly():
    rates = current_rates(
        {"rates_type": 3, "rc_rates": [7, 15, 13], "rates": [67, 80, 65], "rc_expo": [0, 45, 40]}
    )
    assert rates[0].center_sensitivity == 70
    assert rates[0].max_rate == 670
    assert rates[1].expo == 0.45


def test_actual_rate_curve_endpoints():
    assert actual_rate(1.0, 150, 800, 0.5) == pytest.approx(800)
    assert actual_rate(-1.0, 150, 800, 0.5) == pytest.approx(-800)
    # Near the centre the slope is the centre sensitivity.
    assert actual_rate(0.01, 150, 800, 0.5) == pytest.approx(1.5, rel=0.05)


def test_betaflight_rates_max_and_centre():
    # The classic 1.00 / 0.70 / 0.00 Betaflight rates give 667 deg/s.
    assert betaflight_rate(1.0, 100, 70, 0.0) == pytest.approx(666.7, abs=0.1)
    rates = current_rates(
        {"rates_type": 0, "rc_rates": [100] * 3, "rates": [70] * 3, "rc_expo": [20] * 3}
    )
    assert rates[0].max_rate == pytest.approx(666.7, abs=0.1)
    assert rates[0].center_sensitivity == pytest.approx(160.0)


def test_unmodelled_or_missing_rates():
    assert current_rates({"rates_type": 2, "rc_rates": [1] * 3, "rates": [1] * 3,
                          "rc_expo": [0] * 3}) is None
    assert current_rates({"rates_type": 3}) is None
