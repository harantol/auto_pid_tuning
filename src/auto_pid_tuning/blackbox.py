"""Loading of Betaflight blackbox logs into numpy arrays."""

from __future__ import annotations

import logging
import os
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from orangebox import Parser

# orangebox logs every frame type it does not know (GPS, newer events) as a warning.
logging.getLogger("orangebox").setLevel(logging.ERROR)

AXES = ("roll", "pitch", "yaw")

# First bytes of every log: a file holds one per arming.
LOG_START = b"H Product:Blackbox"

# Value of the `debug_mode` header for which debug[0..2] hold the unfiltered gyro.
DEBUG_GYRO_SCALED = 6


class LogError(Exception):
    """The log cannot be used for tuning."""


@dataclass
class FlightLog:
    """One flight, resampled as logged (uniform rate assumed).

    Rates are in deg/s, PID terms in Betaflight PID units (pidsum, 1000 = full authority),
    throttle and motors normalised to 0..1.
    """

    headers: dict[str, Any]
    time: np.ndarray  # (n,) seconds, starting at 0
    sample_rate: float  # Hz
    setpoint: np.ndarray  # (n, 3)
    gyro: np.ndarray  # (n, 3) filtered gyro
    throttle: np.ndarray  # (n,)
    pid_p: np.ndarray  # (n, 3)
    pid_d: np.ndarray  # (n, 3), yaw column is zero when not logged
    motors: np.ndarray  # (n, n_motors)
    gyro_unfiltered: np.ndarray | None = None  # (n, 3) when logged
    warnings: list[str] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return float(self.time[-1] - self.time[0]) if len(self.time) else 0.0

    @property
    def firmware_version(self) -> tuple[int, int]:
        return firmware_version(self.headers)


def firmware_version(headers: dict[str, Any]) -> tuple[int, int]:
    """(major, minor) of the Betaflight firmware that wrote the log, (0, 0) if unknown."""
    match = re.search(r"Betaflight\s+(\d+)\.(\d+)", str(headers.get("Firmware revision", "")))
    return (int(match.group(1)), int(match.group(2))) if match else (0, 0)


def _flight_spans(content: bytes, name: str) -> list[tuple[int, int]]:
    """(start, end) byte offsets of every flight in the content of a blackbox file."""
    starts = []
    position = content.find(LOG_START)
    while position != -1:
        starts.append(position)
        position = content.find(LOG_START, position + len(LOG_START))
    if not starts:
        raise LogError(f"{name} is not a blackbox log.")
    return list(zip(starts, starts[1:] + [len(content)], strict=True))


def _read(path: str | Path) -> tuple[Path, bytes]:
    path = Path(path)
    if not path.is_file():
        raise LogError(f"Log file not found: {path}")
    return path, path.read_bytes()


def flight_sizes(path: str | Path) -> list[int]:
    """Size in bytes of every flight stored in a blackbox file, in file order.

    A flash chip dump holds one log per arming, most of them a few kilobytes of bench tests,
    sometimes after a stretch of erased flash. Nothing is decoded here: one truncated flight
    must not make the whole file unreadable.
    """
    path, content = _read(path)
    return [end - start for start, end in _flight_spans(content, path.name)]


def log_count(path: str | Path) -> int:
    """Number of flights stored in a blackbox file."""
    return len(flight_sizes(path))


def longest_flight(path: str | Path) -> int:
    """Index (1-based) of the largest flight of a file: the one worth tuning from."""
    sizes = flight_sizes(path)
    return sizes.index(max(sizes)) + 1


def load_log(path: str | Path, log_index: int = 1) -> FlightLog:
    """Decode flight `log_index` (1-based) of a blackbox file."""
    path, content = _read(path)
    spans = _flight_spans(content, path.name)
    if not 1 <= log_index <= len(spans):
        raise LogError(f"{path.name} holds {len(spans)} flight(s); there is no flight {log_index}.")
    start, end = spans[log_index - 1]

    # orangebox locates flights from the first line of the file, which fails on dumps that
    # start with erased flash or contain a truncated flight. It is given the one flight alone.
    handle, single = tempfile.mkstemp(suffix=".bbl")
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(content[start:end])
        try:
            parser = Parser.load(single)
        except Exception as exc:  # orangebox raises bare exceptions on malformed headers
            raise LogError(
                f"Flight {log_index} of {path.name} cannot be read, its header is damaged ({exc})."
            ) from exc
    finally:
        os.unlink(single)

    names = parser.field_names
    index = {name: i for i, name in enumerate(names)}

    def columns(prefix: str, count: int) -> list[int | None]:
        return [index.get(f"{prefix}[{i}]") for i in range(count)]

    n_motors = sum(1 for name in names if re.fullmatch(r"motor\[\d+\]", name))
    wanted: dict[str, list[int | None]] = {
        "time": [index.get("time")],
        "setpoint": columns("setpoint", 4),
        "gyro": columns("gyroADC", 3),
        "pid_p": columns("axisP", 3),
        "pid_d": columns("axisD", 3),
        "motors": columns("motor", n_motors),
        "gyro_unfilt": columns("gyroUnfilt", 3),
        "debug": columns("debug", 3),
    }
    for required in ("time", "setpoint", "gyro"):
        if any(col is None for col in wanted[required]):
            raise LogError(
                f"Log is missing the '{required}' fields; enable them in the blackbox settings."
            )

    flat = sorted({col for cols in wanted.values() for col in cols if col is not None})
    headers = dict(parser.headers)
    warnings: list[str] = []
    rows = []
    reader = parser.reader
    try:
        for frame in parser.frames():
            rows.append([frame.data[col] for col in flat])
    except Exception as exc:
        # A log without end marker (battery pulled) fails on its last, partial frame: that is
        # a normal ending. Failing earlier means the rest of the flight is lost.
        total = getattr(reader, "_frame_data_len", end - start)  # frame bytes, headers excluded
        unread = 1.0 - reader.tell() / max(1, total)
        if unread > 0.02:
            warnings.append(
                f"Log is corrupted {1 - unread:.0%} of the way through ({exc}); "
                "only the part before is analysed."
            )
    if len(rows) < 100:
        raise LogError(
            f"Flight {log_index} of {path.name} holds too few frames to analyse "
            "(bench test or truncated log)."
        )
    data = np.asarray(rows, dtype=float)
    position = {col: i for i, col in enumerate(flat)}

    def take(key: str) -> np.ndarray:
        out = np.zeros((len(data), len(wanted[key])))
        for j, col in enumerate(wanted[key]):
            if col is not None:
                out[:, j] = data[:, position[col]]
        return out

    time = take("time")[:, 0] * 1e-6
    # Drop frames that go backwards in time (corrupted or out of order).
    keep = np.concatenate(([True], np.diff(time) > 0))
    time = time[keep] - time[keep][0]
    dt = float(np.median(np.diff(time)))
    sample_rate = 1.0 / dt
    if np.mean(np.diff(time) > 1.5 * dt) > 0.02:
        warnings.append("More than 2% of frames are missing; results may be less accurate.")

    setpoint = take("setpoint")[keep]
    motor_low, motor_high = _motor_range(headers)
    motors = np.clip((take("motors")[keep] - motor_low) / (motor_high - motor_low), 0.0, 1.0)

    gyro_unfiltered = None
    if all(col is not None for col in wanted["gyro_unfilt"]):
        gyro_unfiltered = take("gyro_unfilt")[keep]
    elif headers.get("debug_mode") == DEBUG_GYRO_SCALED and firmware_version(headers) >= (4, 3):
        if all(col is not None for col in wanted["debug"]):
            gyro_unfiltered = take("debug")[keep]

    return FlightLog(
        headers=headers,
        time=time,
        sample_rate=sample_rate,
        setpoint=setpoint[:, :3],
        gyro=take("gyro")[keep],
        throttle=np.clip(setpoint[:, 3] / 1000.0, 0.0, 1.0),
        pid_p=take("pid_p")[keep],
        pid_d=take("pid_d")[keep],
        motors=motors,
        gyro_unfiltered=gyro_unfiltered,
        warnings=warnings,
    )


def _motor_range(headers: dict[str, Any]) -> tuple[float, float]:
    motor_output = headers.get("motorOutput")
    if isinstance(motor_output, (list, tuple)) and len(motor_output) == 2:
        low, high = float(motor_output[0]), float(motor_output[1])
        if high > low:
            return low, high
    return float(headers.get("minthrottle", 1000)), float(headers.get("maxthrottle", 2000))
