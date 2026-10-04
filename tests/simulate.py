"""Synthetic flights with a known closed-loop response, to test the analysis against."""

from __future__ import annotations

import numpy as np
from scipy import signal


def second_order(fs: float, natural_hz: float, damping: float, delay_s: float = 0.008):
    """Discrete closed-loop model (b, a, delay in samples) of a quad axis."""
    wn = 2 * np.pi * natural_hz
    b, a, _ = signal.cont2discrete(([wn**2], [1, 2 * damping * wn, wn**2]), 1 / fs)
    return b.ravel(), a, int(round(delay_s * fs))


def respond(model, values: np.ndarray) -> np.ndarray:
    b, a, delay = model
    out = signal.lfilter(b, a, values)
    return np.concatenate((np.zeros(delay), out[: len(out) - delay]))


def sticks(
    fs: float, duration: float, amplitude: float = 400.0, stick_hz: float = 8.0, seed: int = 0
) -> np.ndarray:
    """Setpoint of a pilot alternating between holds and moves, smoothed like RC input."""
    rng = np.random.default_rng(seed)
    n = int(duration * fs)
    setpoint = np.zeros(n)
    i = 0
    while i < n:
        hold = int(rng.uniform(0.15, 1.2) * fs)
        setpoint[i : i + hold] = rng.choice([0.0, 0.0, 1.0]) * rng.uniform(-amplitude, amplitude)
        i += hold
    return signal.sosfilt(signal.butter(2, stick_hz, fs=fs, output="sos"), setpoint)


def flight(
    fs: float = 1000.0,
    duration: float = 120.0,
    natural_hz: float = 12.0,
    damping: float = 0.7,
    noise: float = 1.5,
    disturbance: float = 0.0,
    stick_hz: float = 8.0,
    amplitude: float = 400.0,
    seed: int = 0,
):
    """Return (setpoint, gyro, true step response over 0.5 s)."""
    rng = np.random.default_rng(seed + 1)
    model = second_order(fs, natural_hz, damping)
    setpoint = sticks(fs, duration, amplitude, stick_hz, seed)
    gyro = respond(model, setpoint) + rng.normal(0.0, noise, len(setpoint))
    if disturbance:
        # Wind and propwash: motion in the 3-40 Hz band that the sticks did not ask for.
        band = signal.butter(2, (3.0, 40.0), btype="bandpass", fs=fs, output="sos")
        gyro = gyro + signal.sosfilt(band, rng.normal(0.0, 1.0, len(setpoint))) * disturbance
    true = respond(model, np.ones(int(0.5 * fs)))
    return setpoint, gyro, true
