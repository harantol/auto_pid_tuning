// Loading of Betaflight blackbox logs into arrays.

import { DecodeError, decodeFlight, readHeader } from "./decoder.js";
import { clip, median } from "./numeric.js";

export const AXES = ["roll", "pitch", "yaw"];

// First bytes of every log: a file holds one per arming.
const LOG_START = Array.from("H Product:Blackbox", (c) => c.charCodeAt(0));

// Value of the `debug_mode` header for which debug[0..2] hold the unfiltered gyro.
const DEBUG_GYRO_SCALED = 6;

/** The log cannot be used for tuning. */
export class LogError extends Error {}

/** [major, minor] of the Betaflight firmware that wrote the log, [0, 0] if unknown. */
export function firmwareVersion(headers) {
  const match = /Betaflight\s+(\d+)\.(\d+)/.exec(String(headers["Firmware revision"] ?? ""));
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

/** Whether a [major, minor] version is at least `major.minor`. */
export function atLeast(version, major, minor) {
  return version[0] > major || (version[0] === major && version[1] >= minor);
}

function find(bytes, pattern, from) {
  const first = pattern[0];
  for (let i = bytes.indexOf(first, from); i !== -1 && i <= bytes.length - pattern.length;
    i = bytes.indexOf(first, i + 1)) {
    let j = 1;
    while (j < pattern.length && bytes[i + j] === pattern[j]) j++;
    if (j === pattern.length) return i;
  }
  return -1;
}

/** [start, end) byte offsets of every flight in the content of a blackbox file. */
function flightSpans(bytes, name) {
  const starts = [];
  for (let at = find(bytes, LOG_START, 0); at !== -1; at = find(bytes, LOG_START, at + LOG_START.length)) {
    starts.push(at);
  }
  if (!starts.length) throw new LogError(`${name} is not a blackbox log.`);
  return starts.map((start, i) => [start, i + 1 < starts.length ? starts[i + 1] : bytes.length]);
}

/**
 * Size in bytes of every flight stored in a blackbox file, in file order.
 *
 * A flash chip dump holds one log per arming, most of them a few kilobytes of bench tests,
 * sometimes after a stretch of erased flash. Nothing is decoded here: one truncated flight
 * must not make the whole file unreadable.
 */
export function flightSizes(bytes, name = "This file") {
  return flightSpans(bytes, name).map(([start, end]) => end - start);
}

/** Index (1-based) of the largest flight of a file: the one worth tuning from. */
export function longestFlight(bytes, name = "This file") {
  const sizes = flightSizes(bytes, name);
  return sizes.indexOf(Math.max(...sizes)) + 1;
}

// A header value as the Python version read it: a number when it looks like one, a list
// when it holds commas.
function headerValue(text) {
  const cast = (part) => {
    const s = part.trim();
    if (s.startsWith("0x")) return Number.parseInt(s, 16);
    if (/^[+-]?\d+$/.test(s)) return Number.parseInt(s, 10);
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number.parseFloat(s);
    return s;
  };
  return text.includes(",") ? text.split(",").map(cast) : cast(text);
}

/** Header lines as a dict, field definitions left out. */
function headerDict(lines) {
  const headers = {};
  for (const [name, value] of lines) {
    if (!name.includes("Field")) headers[name.trim()] = headerValue(value);
  }
  return headers;
}

function motorRange(headers) {
  const output = headers.motorOutput;
  if (Array.isArray(output) && output.length === 2) {
    const [low, high] = output.map(Number);
    if (high > low) return [low, high];
  }
  return [Number(headers.minthrottle ?? 1000), Number(headers.maxthrottle ?? 2000)];
}

/**
 * Decode flight `logIndex` (1-based) of a blackbox file.
 *
 * Returns one flight, sampled as logged (uniform rate assumed). Rates are in deg/s, PID terms
 * in Betaflight PID units (pidsum, 1000 = full authority), throttle and motors normalised to
 * 0..1. Per-axis signals are arrays of three Float64Array.
 */
export function loadLog(bytes, logIndex = 1, name = "This file") {
  const spans = flightSpans(bytes, name);
  if (!(logIndex >= 1 && logIndex <= spans.length)) {
    throw new LogError(`${name} holds ${spans.length} flight(s); there is no flight ${logIndex}.`);
  }
  const [start, end] = spans[logIndex - 1];

  const names = readHeaderFieldNames(bytes, start, end);
  if (!names.length) {
    // a header cut short, without any field definition
    throw new LogError(`Flight ${logIndex} of ${name} cannot be read, its header is truncated.`);
  }
  const motorNames = names.filter((field) => /^motor\[\d+\]$/.test(field));
  const series = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}[${i}]`);
  const wanted = {
    time: ["time"],
    setpoint: series("setpoint", 4),
    gyro: series("gyroADC", 3),
    pid_p: series("axisP", 3),
    pid_d: series("axisD", 3),
    motors: series("motor", motorNames.length),
    gyro_unfilt: series("gyroUnfilt", 3),
    debug: series("debug", 3),
  };
  for (const required of ["time", "setpoint", "gyro"]) {
    if (wanted[required].some((field) => !names.includes(field))) {
      throw new LogError(`Log is missing the '${required}' fields; enable them in the blackbox settings.`);
    }
  }

  let decoded;
  try {
    decoded = decodeFlight(bytes, start, end, Object.values(wanted).flat());
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    throw new LogError(`Flight ${logIndex} of ${name} cannot be read, its header is damaged (${error.message}).`);
  }
  const headers = headerDict(decoded.headerLines);
  const warnings = [];
  // A log without end marker (battery pulled) ends on a partial frame: that is a normal ending,
  // and corrupt frames are skipped. Both only show as missing frames, checked below.
  if (decoded.frames < 100) {
    throw new LogError(`Flight ${logIndex} of ${name} holds too few frames to analyse (bench test or truncated log).`);
  }
  const column = (field) => decoded.columns[field] ?? null;
  const take = (key) => wanted[key].map((field) => column(field) ?? new Float64Array(decoded.frames));

  // Drop frames that go backwards in time (corrupted or out of order).
  const raw = column("time");
  const keep = [0];
  for (let i = 1; i < raw.length; i++) if (raw[i] * 1e-6 - raw[i - 1] * 1e-6 > 0) keep.push(i);
  const n = keep.length;
  const pick = (values) => {
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) out[k] = values[keep[k]];
    return out;
  };
  const time = new Float64Array(n);
  const t0 = raw[keep[0]] * 1e-6;
  for (let k = 0; k < n; k++) time[k] = raw[keep[k]] * 1e-6 - t0;
  const steps = new Float64Array(n - 1);
  for (let k = 1; k < n; k++) steps[k - 1] = time[k] - time[k - 1];
  const dt = median(steps);
  let gaps = 0;
  for (const step of steps) if (step > 1.5 * dt) gaps++;
  if (gaps / steps.length > 0.02) {
    warnings.push("More than 2% of frames are missing; results may be less accurate.");
  }

  const setpoint = take("setpoint").map(pick);
  const [motorLow, motorHigh] = motorRange(headers);
  const motors = take("motors").map((values) => {
    const out = pick(values);
    for (let k = 0; k < n; k++) out[k] = clip((out[k] - motorLow) / (motorHigh - motorLow), 0, 1);
    return out;
  });

  let gyroUnfiltered = null;
  if (wanted.gyro_unfilt.every((field) => column(field))) {
    gyroUnfiltered = take("gyro_unfilt").map(pick);
  } else if (headers.debug_mode === DEBUG_GYRO_SCALED && atLeast(firmwareVersion(headers), 4, 3)
    && wanted.debug.every((field) => column(field))) {
    gyroUnfiltered = take("debug").map(pick);
  }

  const throttle = new Float64Array(n);
  for (let k = 0; k < n; k++) throttle[k] = clip(setpoint[3][k] / 1000, 0, 1);

  return {
    headers,
    time,
    sampleRate: 1 / dt,
    setpoint: setpoint.slice(0, 3),
    gyro: take("gyro").map(pick),
    throttle,
    pidP: take("pid_p").map(pick),
    pidD: take("pid_d").map(pick),
    motors,
    gyroUnfiltered,
    warnings,
    duration: time[n - 1] - time[0],
  };
}

function readHeaderFieldNames(bytes, start, end) {
  const { lines } = readHeader(bytes, start, end);
  const line = lines.find(([field]) => field === "Field I name");
  return line ? line[1].split(",").map((n) => n.replace(/^gyroData(.+)$/, "gyroADC$1")) : [];
}
