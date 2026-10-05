"""End-to-end tests: report rendering on simulated flights, CLI on real logs when present."""

from __future__ import annotations

import json

import pytest

from auto_pid_tuning import (
    analyze,
    flight_sizes,
    get_style,
    load_log,
    log_count,
    longest_flight,
    tune,
)
from auto_pid_tuning.blackbox import LogError, firmware_version
from auto_pid_tuning.cli import main
from auto_pid_tuning.report import to_dict, to_text
from conftest import SAMPLES

SAMPLE_4_3 = SAMPLES / "gg_LOG00001.BFL"
SAMPLE_MULTI = SAMPLES / "gg_btfl_001.bbl"
needs_sample = pytest.mark.skipif(not SAMPLE_4_3.is_file(), reason="sample logs not downloaded")


def test_report_on_simulated_overshooting_quad(log_factory):
    log = log_factory(damping=0.3)
    analysis = analyze(log)
    result = tune(log.headers, analysis, get_style("freestyle"))

    text = to_text(log.headers, analysis, result)
    assert "d_roll" in text
    assert "Betaflight CLI" in text
    assert text.rstrip().endswith("save")

    payload = json.loads(json.dumps(to_dict(log.headers, analysis, result)))
    assert payload["style"] == "freestyle"
    assert payload["axes"]["roll"]["step_response"]["valid"] is True
    assert len(payload["axes"]["roll"]["step_response"]["response"]) == 500
    assert payload["cli"][-1] == "save"


def test_report_when_nothing_changes(log_factory):
    log = log_factory(damping=0.55, dterm_noise=9.0)
    analysis = analyze(log)
    result = tune(log.headers, analysis, get_style("freestyle"))
    assert "Nothing to change" in to_text(log.headers, analysis, result)


def test_firmware_version():
    assert firmware_version({"Firmware revision": "Betaflight 4.3.0 (fc8318f54) STM32F405"}) == (
        4,
        3,
    )
    assert firmware_version({"Firmware revision": "INAV 6.0"}) == (0, 0)
    assert firmware_version({}) == (0, 0)


def test_missing_file(tmp_path, capsys):
    with pytest.raises(LogError, match="not found"):
        load_log(tmp_path / "nope.bbl")
    assert main([str(tmp_path / "nope.bbl")]) == 1
    assert "not found" in capsys.readouterr().err


def test_unknown_style_is_an_error(tmp_path, capsys):
    assert main([str(tmp_path / "nope.bbl"), "--style", "ballet"]) == 1
    assert "Unknown flight style" in capsys.readouterr().err


@needs_sample
def test_load_real_log():
    log = load_log(SAMPLE_4_3)
    assert log.firmware_version == (4, 3)
    assert log.sample_rate == pytest.approx(1000, rel=0.05)
    assert log.duration > 200
    assert log.gyro.shape == log.setpoint.shape == (len(log.time), 3)
    assert log.motors.shape[1] == 4
    assert 0.0 <= log.motors.min() and log.motors.max() <= 1.0
    assert log.gyro_unfiltered is not None  # logged with debug_mode = GYRO_SCALED


@needs_sample
def test_cli_on_real_log(tmp_path, capsys):
    output = tmp_path / "tune.txt"
    assert main([str(SAMPLE_4_3), "--style", "cinematic", "--output", str(output)]) == 0

    out = capsys.readouterr().out
    assert "Betaflight 4.3.0" in out
    assert "cinematic" in out
    assert output.read_text(encoding="utf-8").rstrip().endswith("save")


@needs_sample
def test_cli_json_and_log_index(capsys):
    assert log_count(SAMPLE_MULTI) == 3
    assert main([str(SAMPLE_MULTI), "--json", "--log-index", "3"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["style"] == "freestyle"
    assert set(payload["axes"]) == {"roll", "pitch", "yaw"}

    assert main([str(SAMPLE_MULTI), "--log-index", "9"]) == 1


def test_flight_sizes_survives_a_truncated_flight(tmp_path):
    # A flash dump: a bench-test log cut in the middle of its header, then a real flight.
    marker = b"H Product:Blackbox flight data recorder by Nicholas Sherlock\n"
    dump = tmp_path / "btfl_all.bbl"
    dump.write_bytes(marker + b"H Data ver" + marker + b"H Data version:2\n" + b"x" * 500)

    assert flight_sizes(dump) == [len(marker) + 10, len(marker) + 17 + 500]
    assert log_count(dump) == 2
    assert longest_flight(dump) == 2
    with pytest.raises(LogError, match="Flight 1 of btfl_all.bbl"):
        load_log(dump, 1)
    with pytest.raises(LogError, match="no flight 3"):
        load_log(dump, 3)


def test_flight_sizes_skips_erased_flash(tmp_path):
    marker = b"H Product:Blackbox flight data recorder by Nicholas Sherlock\n"
    dump = tmp_path / "dump.bbl"
    dump.write_bytes(b"\xff" * 4096 + marker + b"H Data version:2\n")
    assert flight_sizes(dump) == [len(marker) + 17]


def test_flight_sizes_rejects_other_files(tmp_path):
    other = tmp_path / "notes.txt"
    other.write_bytes(b"not a blackbox log\n")
    with pytest.raises(LogError, match="not a blackbox log"):
        flight_sizes(other)
