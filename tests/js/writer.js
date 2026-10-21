// Writer of blackbox logs, to test the decoder and the whole pipeline on known flights.
//
// It encodes like the firmware: I frames every 32 loops, P frames in between predicted from
// the previous frames, a few encodings (variable bytes, TAG8_4S16, TAG2_3S32), slow frames and
// events.

import { axisFlight, normal } from "./simulate.js";

// Headers of a stock Betaflight 4.3 quad on Actual rates (same as tests/conftest.py).
export const HEADERS_4_3 = {
  "Firmware revision": "Betaflight 4.3.0 (fc8318f54) STM32F405",
  rollPID: [45, 80, 40],
  pitchPID: [47, 84, 46],
  yawPID: [45, 80, 0],
  d_min: [30, 34, 0],
  ff_weight: [120, 125, 120],
  simplified_pids_mode: 2,
  simplified_gyro_filter: 1,
  simplified_dterm_filter: 1,
  gyro_lpf1_static_hz: 250,
  gyro_lpf1_dyn_hz: [250, 500],
  gyro_lpf2_static_hz: 500,
  dterm_lpf1_static_hz: 75,
  dterm_lpf1_dyn_hz: [75, 150],
  dterm_lpf2_static_hz: 150,
  dyn_notch_count: 1,
  dyn_notch_min_hz: 150,
  dyn_notch_max_hz: 600,
  dshot_bidir: 1,
  rates_type: 3,
  rc_rates: [15, 15, 13],
  rates: [80, 80, 65],
  rc_expo: [45, 45, 40],
  motorOutput: [158, 2047],
};

class Bytes {
  constructor() {
    this.parts = [];
  }

  byte(value) {
    this.parts.push(value & 0xff);
  }

  text(value) {
    for (const c of value) this.byte(c.charCodeAt(0));
  }

  unsignedVB(value) {
    let v = value >>> 0;
    while (v >= 0x80) {
      this.byte((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    this.byte(v);
  }

  signedVB(value) {
    this.unsignedVB((value << 1) ^ (value >> 31)); // zigzag
  }

  // Selector of 2 bits per value (0, 4, 8 or 16 bits), then the values as a stream of nibbles.
  tag8_4S16(values) {
    let selector = 0;
    const nibbles = [];
    values.forEach((v, i) => {
      if (v === 0) return;
      if (v >= -8 && v < 8) {
        selector |= 1 << (2 * i);
        nibbles.push(v & 0x0f);
      } else if (v >= -128 && v < 128) {
        selector |= 2 << (2 * i);
        nibbles.push((v >> 4) & 0x0f, v & 0x0f);
      } else {
        selector |= 3 << (2 * i);
        nibbles.push((v >> 12) & 0x0f, (v >> 8) & 0x0f, (v >> 4) & 0x0f, v & 0x0f);
      }
    });
    this.byte(selector);
    if (nibbles.length % 2) nibbles.push(0);
    for (let k = 0; k < nibbles.length; k += 2) this.byte((nibbles[k] << 4) | nibbles[k + 1]);
  }

  tag2_3S32(values) {
    const fits = (bits) => values.every((v) => v >= -(1 << (bits - 1)) && v < 1 << (bits - 1));
    if (fits(2)) {
      this.byte(((values[0] & 3) << 4) | ((values[1] & 3) << 2) | (values[2] & 3));
    } else if (fits(4)) {
      this.byte(0x40 | (values[0] & 0x0f));
      this.byte(((values[1] & 0x0f) << 4) | (values[2] & 0x0f));
    } else if (fits(6)) {
      this.byte(0x80 | (values[0] & 0x3f));
      this.byte(values[1] & 0x3f);
      this.byte(values[2] & 0x3f);
    } else {
      const sizes = values.map((v) => (v >= -128 && v < 128 ? 0 : v >= -32768 && v < 32768 ? 1 : v >= -(1 << 23) && v < 1 << 23 ? 2 : 3));
      this.byte(0xc0 | sizes[0] | (sizes[1] << 2) | (sizes[2] << 4));
      values.forEach((v, i) => {
        for (let b = 0; b <= sizes[i]; b++) this.byte(v >> (8 * b));
      });
    }
  }

  done() {
    return Uint8Array.from(this.parts);
  }
}

/** Field layout: [name, I predictor, I encoding, P predictor, P encoding]. */
function layout(motorCount, unfiltered, extraFields) {
  const fields = [
    ["loopIteration", 0, 1, 6, 9],
    ["time", 0, 1, 2, 0],
    ...[0, 1, 2].map((i) => [`axisP[${i}]`, 0, 0, 1, 0]),
    ...[0, 1].map((i) => [`axisD[${i}]`, 0, 0, 1, 0]), // no D on yaw, as on a real quad
    ...[0, 1, 2].map((i) => [`setpoint[${i}]`, 0, 0, 1, 8]),
    ["setpoint[3]", 0, 1, 1, 8],
    ...[0, 1, 2].map((i) => [`gyroADC[${i}]`, 0, 0, 3, 7]),
  ];
  if (unfiltered) fields.push(...[0, 1, 2].map((i) => [`gyroUnfilt[${i}]`, 0, 0, 1, 7]));
  for (let i = 0; i < motorCount; i++) fields.push([`motor[${i}]`, i ? 5 : 11, i ? 0 : 1, 1, 0]);
  for (const name of extraFields) fields.push([name, 0, 0, 1, 0]);
  return fields;
}

const headerValue = (value) => (Array.isArray(value) ? value.join(",") : String(value));

/**
 * One flight as a blackbox log. `signals` maps field names to integer series of the same
 * length (time excluded); `times` is in microseconds.
 */
export function encodeFlight({
  times, signals, headers, motorCount, unfiltered = false, extraFields = [], leadingEvent = false, endMarker = true,
}) {
  const fields = layout(motorCount, unfiltered, extraFields);
  const out = new Bytes();
  const line = (name, value) => out.text(`H ${name}:${headerValue(value)}\n`);
  line("Product", "Blackbox flight data recorder by Nicholas Sherlock");
  line("Data version", 2);
  line("I interval", 32);
  line("P interval", "1/1");
  line("Field I name", fields.map((f) => f[0]));
  line("Field I signed", fields.map((f) => (/motor|loopIteration|time|setpoint\[3\]/.test(f[0]) ? 0 : 1)));
  line("Field I predictor", fields.map((f) => f[1]));
  line("Field I encoding", fields.map((f) => f[2]));
  line("Field P predictor", fields.map((f) => f[3]));
  line("Field P encoding", fields.map((f) => f[4]));
  line("Field S name", ["flightModeFlags", "stateFlags", "failsafePhase", "rxSignalReceived", "rxFlightChannelsValid"]);
  line("Field S signed", [0, 0, 0, 0, 0]);
  line("Field S predictor", [0, 0, 0, 0, 0]);
  line("Field S encoding", [1, 1, 7, 7, 7]);
  line("Craft name", "Simulated");
  for (const [name, value] of Object.entries(headers)) line(name, value);
  const minMotor = headers.motorOutput[0];

  if (leadingEvent) {
    out.byte("E".charCodeAt(0));
    out.byte(0); // sync beep
    out.unsignedVB(times[0]);
  }

  const n = times.length;
  const frame = (k) => fields.map(([name]) => (name === "loopIteration" ? k : name === "time" ? times[k] : signals[name][k]));
  let previous = null;
  let previous2 = null;
  for (let k = 0; k < n; k++) {
    const current = frame(k);
    if (k % 32 === 0) {
      out.byte("I".charCodeAt(0));
      current.forEach((value, i) => {
        const [, predictor, encoding] = fields[i];
        let v = value;
        if (predictor === 11) v -= minMotor;
        if (predictor === 5) v -= current[fields.findIndex((f) => f[0] === "motor[0]")];
        if (encoding === 1) out.unsignedVB(v);
        else out.signedVB(v);
      });
      previous = current;
      previous2 = current;
    } else {
      out.byte("P".charCodeAt(0));
      const residual = current.map((value, i) => {
        const predictor = fields[i][3];
        if (predictor === 1) return value - previous[i];
        if (predictor === 2) return value - (2 * previous[i] - previous2[i]);
        if (predictor === 3) return value - Math.trunc((previous[i] + previous2[i]) / 2);
        return value;
      });
      for (let i = 0; i < fields.length;) {
        const encoding = fields[i][4];
        if (encoding === 9) {
          i++;
        } else if (encoding === 0) {
          out.signedVB(residual[i++]);
        } else if (encoding === 8) {
          out.tag8_4S16(residual.slice(i, i + 4));
          i += 4;
        } else if (encoding === 7) {
          out.tag2_3S32(residual.slice(i, i + 3));
          i += 3;
        } else {
          throw new Error(`encoding ${encoding} not written`);
        }
      }
      previous2 = previous;
      previous = current;
    }
    if (k % 500 === 250) {
      out.byte("S".charCodeAt(0));
      out.unsignedVB(1);
      out.unsignedVB(0);
      out.tag2_3S32([0, 1, 1]);
    }
  }
  if (endMarker) {
    out.byte("E".charCodeAt(0));
    out.byte(255);
    out.text("End of log\0");
  }
  return out.done();
}

/**
 * A simulated flight, as a blackbox log. The three axes share one closed-loop response;
 * `dtermNoise` is the RMS of the D-term, `motorLevel` the motors' share of their range.
 */
export function simulatedLog({
  fs = 1000, duration = 120, headers = HEADERS_4_3, dtermNoise = 6, motorLevel = 0.4,
  gyroToneHz = 0, gyroTone = 0, unfiltered = false, leadingEvent = false, endMarker = true,
  jitterUs = 0, seed = 0, ...axis
} = {}) {
  const axes = [0, 1, 2].map((k) => axisFlight({ fs, duration, seed: seed + k, ...axis }));
  const n = axes[0].setpoint.length;
  const gauss = normal(seed + 42);
  const round = (values) => Int32Array.from(values, Math.round);
  const signals = {};
  axes.forEach(({ setpoint, gyro }, i) => {
    const tone = Float64Array.from(gyro, (g, k) => g + gyroTone * Math.sin((2 * Math.PI * gyroToneHz * k) / fs));
    signals[`setpoint[${i}]`] = round(setpoint);
    signals[`gyroADC[${i}]`] = round(tone);
    signals[`axisP[${i}]`] = round(setpoint.map((s, k) => 0.3 * (s - gyro[k])));
    if (unfiltered) signals[`gyroUnfilt[${i}]`] = round(tone.map((g) => g + gauss(8)));
    if (i < 2) signals[`axisD[${i}]`] = round(Float64Array.from(setpoint, () => gauss(dtermNoise)));
  });
  signals["setpoint[3]"] = Int32Array.from({ length: n }, (_, k) => Math.round(400 + 100 * Math.sin(k / fs)));
  const [low, high] = headers.motorOutput;
  for (let m = 0; m < 4; m++) {
    signals[`motor[${m}]`] = Int32Array.from({ length: n }, () =>
      Math.round(Math.min(high, Math.max(low, low + motorLevel * (high - low) + gauss(10)))));
  }
  const step = 1e6 / fs;
  const times = Array.from({ length: n }, (_, k) => Math.round(5e6 + k * step + (jitterUs ? gauss(jitterUs) : 0)));
  return encodeFlight({ times, signals, headers, motorCount: 4, unfiltered, leadingEvent, endMarker });
}

/** Several flights in one file, as a flash dump holds them. */
export function concat(...logs) {
  const out = new Uint8Array(logs.reduce((total, log) => total + log.length, 0));
  let at = 0;
  for (const log of logs) {
    out.set(log, at);
    at += log.length;
  }
  return out;
}
