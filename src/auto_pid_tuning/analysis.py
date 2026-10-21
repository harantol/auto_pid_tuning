"""Signal analysis of a flight: step response, noise, motor and stick usage."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage, signal

from .blackbox import AXES, FlightLog

# Step response estimation
WINDOW_S = 2.0  # length of the analysis windows
RESPONSE_S = 0.5  # length of the estimated step response
PRE_ROLL_S = 0.2  # part of the impulse response kept before t=0, see step_response()
MIN_INPUT_DPS = 20.0  # windows with less stick input than this are ignored
MIN_WINDOWS = 5  # below this the step response is not trusted
MIN_COHERENCE = 0.5  # gyro must follow the setpoint at least this well to use a frequency
MIN_BANDWIDTH_HZ = 15.0  # overshoot lives around 10-30 Hz: less than this cannot show it
MAX_BANDWIDTH_HZ = 100.0

# Noise analysis
NOISE_BAND_HZ = 100.0  # content above this is considered noise, not flight dynamics
MIN_THROTTLE = 0.05  # samples below this are treated as "on the ground"
MOTOR_SATURATION = 0.98

# Excerpts: short stretches of the log shown next to the changes they justify
MOVE_SPAN_S = 0.05  # a stick move is the setpoint change over this span
MOVE_BEFORE_S, MOVE_AFTER_S = 0.1, 0.4
HOLD_S = 0.6  # a hold is the setpoint staying on one side of zero for this long
HOLD_MARGIN_S = 0.2
DTERM_WINDOW_S = 0.25


@dataclass
class StepResponse:
    """Closed-loop response of one axis to a unit step on the setpoint."""

    time: np.ndarray  # seconds
    response: np.ndarray  # 1.0 = setpoint reached
    windows: int  # number of windows averaged
    bandwidth: float  # Hz up to which the sticks excited the quad enough to measure it
    peak: float  # maximum of the response (overshoot = peak - 1)
    peak_time: float  # seconds
    rise_time: float  # seconds to first reach 50% of the setpoint
    steady_state: float  # mean of the response over its last 40%

    @property
    def valid(self) -> bool:
        return self.windows >= MIN_WINDOWS and self.bandwidth >= MIN_BANDWIDTH_HZ


@dataclass
class NoiseStats:
    """High-frequency content of one axis."""

    gyro_rms: float  # deg/s, filtered gyro above NOISE_BAND_HZ
    dterm_rms: float  # PID units, D-term above NOISE_BAND_HZ
    peak_hz: float | None  # noise frequency left in the filtered gyro, if any stands out
    gyro_unfiltered_rms: float | None = None


@dataclass
class StickStats:
    """How the pilot used one axis, in deg/s of commanded rate."""

    max_rate: float
    p50: float
    p95: float
    p995: float


@dataclass
class Excerpt:
    """A short stretch of the log that shows what a measurement is about."""

    start: float  # seconds from the start of the log
    time: np.ndarray  # seconds from the start of the excerpt
    series: dict[str, np.ndarray]


@dataclass
class FlightAnalysis:
    duration: float
    sample_rate: float
    step: dict[str, StepResponse | None]
    noise: dict[str, NoiseStats]
    sticks: dict[str, StickStats]
    motor_saturation: float  # fraction of airborne time with a motor at its limit
    throttle_mean: float
    spectrum_hz: np.ndarray = field(default_factory=lambda: np.zeros(0))
    gyro_spectrum: dict[str, np.ndarray] = field(default_factory=dict)  # deg/s per sqrt(Hz)
    warnings: list[str] = field(default_factory=list)
    # "move_<axis>", "hold_<axis>" and "dterm", when the flight holds one
    excerpts: dict[str, Excerpt] = field(default_factory=dict)


def analyze(log: FlightLog) -> FlightAnalysis:
    """Run every analysis on a flight."""
    fs = log.sample_rate
    warnings = list(log.warnings)
    flying = log.throttle > MIN_THROTTLE
    if flying.mean() < 0.2:
        # Throttle not logged or mostly idle: fall back to using everything.
        flying = np.ones_like(flying, dtype=bool)

    step: dict[str, StepResponse | None] = {}
    noise: dict[str, NoiseStats] = {}
    sticks: dict[str, StickStats] = {}
    spectra: dict[str, np.ndarray] = {}
    excerpts: dict[str, Excerpt] = {}
    freqs = np.zeros(0)
    for i, axis in enumerate(AXES):
        response = step_response(log.setpoint[:, i], log.gyro[:, i], fs)
        step[axis] = response
        if response is None or not response.valid:
            reach = "" if response is None else f" (usable up to {response.bandwidth:.0f} Hz)"
            warnings.append(
                f"Stick inputs on {axis} are too gentle to measure its step response{reach}; "
                "its PIDs are left untouched. Add a few sharp, snappy moves to the flight."
            )
        unfiltered = None if log.gyro_unfiltered is None else log.gyro_unfiltered[flying, i]
        noise[axis] = noise_stats(log.gyro[flying, i], log.pid_d[flying, i], fs, unfiltered)
        freqs, spectra[axis] = spectrum(log.gyro[flying, i], fs)
        sticks[axis] = stick_stats(log.setpoint[:, i])
        for name, excerpt in (("move", sharpest_move), ("hold", longest_hold)):
            span = excerpt(log.setpoint[:, i], fs)
            if span is not None:
                excerpts[f"{name}_{axis}"] = _cut(
                    log, span, setpoint=log.setpoint[:, i], gyro=log.gyro[:, i]
                )
    span = typical_dterm(log.pid_d[:, :2], flying, fs)
    if span is not None:
        excerpts["dterm"] = _cut(log, span, roll=log.pid_d[:, 0], pitch=log.pid_d[:, 1])

    saturation = 0.0
    if log.motors.shape[1]:
        saturation = float(np.mean(log.motors[flying].max(axis=1) >= MOTOR_SATURATION))

    if log.duration < 20:
        warnings.append("Flight is shorter than 20 s; fly longer for reliable recommendations.")

    return FlightAnalysis(
        duration=log.duration,
        sample_rate=fs,
        step=step,
        noise=noise,
        sticks=sticks,
        motor_saturation=saturation,
        throttle_mean=float(log.throttle[flying].mean()),
        spectrum_hz=freqs,
        gyro_spectrum=spectra,
        warnings=warnings,
        excerpts=excerpts,
    )


def step_response(setpoint: np.ndarray, gyro: np.ndarray, fs: float) -> StepResponse | None:
    """Estimate the closed-loop step response from setpoint to gyro.

    The transfer function is the cross-spectrum of setpoint and gyro over the spectrum of the
    setpoint, averaged over all windows with stick activity. Its inverse FFT is the impulse
    response, whose running sum is the step response.

    Sticks only excite the quad up to some frequency; above it the gyro shows wind and
    propwash rather than tracking, and the transfer function is noise. That limit is read
    from the coherence, and the transfer function is tapered there. The taper is zero-phase,
    so it spreads part of the impulse response before t=0: that part is included in the
    running sum (PRE_ROLL_S) to keep the steady state unbiased.
    """
    window = int(WINDOW_S * fs)
    length = int(RESPONSE_S * fs)
    pre_roll = int(PRE_ROLL_S * fs)
    if len(setpoint) < window or length < 8:
        return None

    taper = np.hanning(window)
    input_power = output_power = cross = 0.0
    windows = 0
    for start in range(0, len(setpoint) - window + 1, window // 4):
        sp = setpoint[start : start + window]
        if np.max(np.abs(sp)) < MIN_INPUT_DPS:
            continue
        sp_f = np.fft.rfft(sp * taper)
        gyro_f = np.fft.rfft(gyro[start : start + window] * taper)
        input_power = input_power + np.abs(sp_f) ** 2
        output_power = output_power + np.abs(gyro_f) ** 2
        cross = cross + gyro_f * np.conj(sp_f)
        windows += 1
    if windows == 0:
        return None

    freqs = np.fft.rfftfreq(window, 1.0 / fs)
    tiny = 1e-12 * input_power.max()
    coherence = np.abs(cross) ** 2 / (input_power * output_power + tiny**2)
    bandwidth = _usable_bandwidth(freqs, coherence)
    transfer = cross / (input_power + tiny) * np.exp(-0.5 * (freqs / bandwidth) ** 2)
    impulse = np.roll(np.fft.irfft(transfer, n=window), pre_roll)
    response = np.cumsum(impulse)[pre_roll : pre_roll + length]

    time = np.arange(length) / fs
    peak_index = int(np.argmax(response))
    above = np.nonzero(response >= 0.5)[0]
    rise_time = float(time[above[0]]) if len(above) else float("nan")
    return StepResponse(
        time=time,
        response=response,
        windows=windows,
        bandwidth=bandwidth,
        peak=float(response[peak_index]),
        peak_time=float(time[peak_index]),
        rise_time=rise_time,
        steady_state=float(response[int(0.6 * length) :].mean()),
    )


def _usable_bandwidth(freqs: np.ndarray, coherence: np.ndarray) -> float:
    """Frequency up to which the gyro is coherent with the setpoint."""
    span = max(1, int(round(2.5 / (freqs[1] - freqs[0]))))  # smooth over 2.5 Hz
    smoothed = np.convolve(coherence, np.ones(span) / span, mode="same")
    start = int(np.searchsorted(freqs, 1.0))
    below = np.nonzero(smoothed[start:] < MIN_COHERENCE)[0]
    limit = freqs[start + below[0]] if len(below) else freqs[-1]
    return float(np.clip(limit, 1.0, MAX_BANDWIDTH_HZ))


def spectrum(values: np.ndarray, fs: float) -> tuple[np.ndarray, np.ndarray]:
    """Amplitude spectral density (units per sqrt(Hz)) by Welch's method."""
    nperseg = int(min(len(values), max(256, fs // 2)))
    freqs, psd = signal.welch(values, fs=fs, nperseg=nperseg, detrend="linear")
    return freqs, np.sqrt(psd)


def band_rms(values: np.ndarray, fs: float, low_hz: float) -> float:
    """RMS of the content of `values` above `low_hz`."""
    freqs, density = spectrum(values, fs)
    band = freqs >= low_hz
    if band.sum() < 2:
        return 0.0
    return float(np.sqrt(np.trapezoid(density[band] ** 2, freqs[band])))


def noise_stats(
    gyro: np.ndarray, dterm: np.ndarray, fs: float, gyro_unfiltered: np.ndarray | None = None
) -> NoiseStats:
    return NoiseStats(
        gyro_rms=band_rms(gyro, fs, NOISE_BAND_HZ),
        dterm_rms=band_rms(dterm, fs, NOISE_BAND_HZ),
        peak_hz=noise_peak(gyro, fs),
        gyro_unfiltered_rms=(
            None if gyro_unfiltered is None else band_rms(gyro_unfiltered, fs, NOISE_BAND_HZ)
        ),
    )


def noise_peak(values: np.ndarray, fs: float) -> float | None:
    """Frequency of the dominant noise peak, or None when the noise floor is flat."""
    freqs, density = spectrum(values, fs)
    band = freqs >= NOISE_BAND_HZ
    if band.sum() < 8:
        return None
    density = density[band]
    peak = int(np.argmax(density))
    if density[peak] < 4.0 * np.median(density):
        return None
    return float(freqs[band][peak])


def stick_stats(setpoint: np.ndarray) -> StickStats:
    magnitude = np.abs(setpoint)
    p50, p95, p995 = np.percentile(magnitude, [50, 95, 99.5])
    return StickStats(float(magnitude.max()), float(p50), float(p95), float(p995))


def sharpest_move(setpoint: np.ndarray, fs: float) -> tuple[int, int] | None:
    """(start, end) samples around the fastest stick move: where overshoot shows."""
    span = max(1, int(MOVE_SPAN_S * fs))
    if len(setpoint) <= span:
        return None
    change = np.abs(setpoint[span:] - setpoint[:-span])
    at = int(np.argmax(change))
    if change[at] < MIN_INPUT_DPS:
        return None
    return _window(at - int(MOVE_BEFORE_S * fs), at + int(MOVE_AFTER_S * fs), len(setpoint))


def longest_hold(setpoint: np.ndarray, fs: float) -> tuple[int, int] | None:
    """(start, end) samples around the strongest held stick input: where I shows.

    The hold is the stretch of HOLD_S whose weakest setpoint, on one side of zero, is the
    largest: the gyro should settle on it.
    """
    length = int(HOLD_S * fs)
    if len(setpoint) <= length:
        return None
    best, at = 0.0, 0
    for side in (setpoint, -setpoint):
        weakest = ndimage.minimum_filter1d(side, length, origin=-(length // 2))[: -length + 1]
        index = int(np.argmax(weakest))
        if weakest[index] > best:
            best, at = float(weakest[index]), index
    if best < MIN_INPUT_DPS:
        return None
    margin = int(HOLD_MARGIN_S * fs)
    return _window(at - margin, at + length + margin, len(setpoint))


def typical_dterm(dterm: np.ndarray, flying: np.ndarray, fs: float) -> tuple[int, int] | None:
    """(start, end) samples of an airborne stretch whose D-term noise is the flight's typical.

    Noise is the D-term content above NOISE_BAND_HZ, as in noise_stats(); the stretch shown
    is the one whose level is closest to the median, not a cherry-picked worst case.
    """
    length = int(DTERM_WINDOW_S * fs)
    if fs <= 2.5 * NOISE_BAND_HZ or len(dterm) < 4 * length or not np.any(dterm):
        return None
    sos = signal.butter(4, NOISE_BAND_HZ, "highpass", fs=fs, output="sos")
    power = (signal.sosfiltfilt(sos, dterm, axis=0) ** 2).sum(axis=1)
    level = ndimage.uniform_filter1d(power, length, origin=-(length // 2))[: -length + 1]
    airborne = ndimage.minimum_filter1d(flying.astype(float), length, origin=-(length // 2))
    candidates = np.nonzero(airborne[: -length + 1] > 0)[0]
    if not len(candidates):
        return None
    distance = np.abs(level[candidates] - np.median(level[candidates]))
    # With an even count the two middle stretches are equally close to the median, up to
    # rounding: the earliest of the closest ones is taken.
    at = int(candidates[np.argmax(distance <= distance.min() * (1 + 1e-9) + 1e-12)])
    return at, at + length


def _window(start: int, end: int, size: int) -> tuple[int, int]:
    """Shift [start, end) inside [0, size) without changing its length when possible."""
    shift = max(0, -start) - max(0, end - size)
    return max(0, start + shift), min(size, end + shift)


def _cut(log: FlightLog, span: tuple[int, int], **series: np.ndarray) -> Excerpt:
    start, end = span
    return Excerpt(
        start=float(log.time[start]),
        time=log.time[start:end] - log.time[start],
        series={name: values[start:end].copy() for name, values in series.items()},
    )
