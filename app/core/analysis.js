// Signal analysis of a flight: step response, noise, motor and stick usage.

import { AXES } from "./blackbox.js";
import {
  argmax, butterHighpass, min, clip, forwardMean, forwardMin, hanning, irfft, max, mean, median,
  movingAverageSame, percentiles, pyFixed, pyRound, rfft, rfftfreq, sosFiltFilt, trapezoid, welch,
} from "./numeric.js";

// Step response estimation
const WINDOW_S = 2.0; // length of the analysis windows
const RESPONSE_S = 0.5; // length of the estimated step response
const PRE_ROLL_S = 0.2; // part of the impulse response kept before t=0, see stepResponse()
export const MIN_INPUT_DPS = 20.0; // windows with less stick input than this are ignored
const MIN_WINDOWS = 5; // below this the step response is not trusted
const MIN_COHERENCE = 0.5; // gyro must follow the setpoint at least this well to use a frequency
export const MIN_BANDWIDTH_HZ = 15.0; // overshoot lives around 10-30 Hz: less than this cannot show it
const MAX_BANDWIDTH_HZ = 100.0;

// Noise analysis
export const NOISE_BAND_HZ = 100.0; // content above this is considered noise, not flight dynamics
const MIN_THROTTLE = 0.05; // samples below this are treated as "on the ground"
const MOTOR_SATURATION = 0.98;

// Excerpts: short stretches of the log shown next to the changes they justify
const MOVE_SPAN_S = 0.05; // a stick move is the setpoint change over this span
const MOVE_BEFORE_S = 0.1;
const MOVE_AFTER_S = 0.4;
const HOLD_S = 0.6; // a hold is the setpoint staying on one side of zero for this long
const HOLD_MARGIN_S = 0.2;
const DTERM_WINDOW_S = 0.25;

const int = Math.trunc; // Python's int() on a float

/** Whether a step response can be trusted. */
export const isValid = (step) => step.windows >= MIN_WINDOWS && step.bandwidth >= MIN_BANDWIDTH_HZ;

const masked = (values, mask) => values.filter((_, i) => mask[i]);

/** Run every analysis on a flight. */
export function analyze(log) {
  const fs = log.sampleRate;
  const warnings = [...log.warnings];
  let flying = Uint8Array.from(log.throttle, (t) => (t > MIN_THROTTLE ? 1 : 0));
  if (mean(flying) < 0.2) {
    // Throttle not logged or mostly idle: fall back to using everything.
    flying = new Uint8Array(flying.length).fill(1);
  }

  const step = {};
  const noise = {};
  const sticks = {};
  const spectra = {};
  const excerpts = {};
  let freqs = new Float64Array(0);
  AXES.forEach((axis, i) => {
    const response = stepResponse(log.setpoint[i], log.gyro[i], fs);
    step[axis] = response;
    if (response === null || !isValid(response)) {
      const reach = response === null ? "" : ` (usable up to ${pyFixed(response.bandwidth, 0)} Hz)`;
      warnings.push(
        `Stick inputs on ${axis} are too gentle to measure its step response${reach}; `
        + "its PIDs are left untouched. Add a few sharp, snappy moves to the flight.",
      );
    }
    const gyro = masked(log.gyro[i], flying);
    const unfiltered = log.gyroUnfiltered === null ? null : masked(log.gyroUnfiltered[i], flying);
    const gyroSpectrum = spectrum(gyro, fs);
    noise[axis] = noiseStats(gyroSpectrum, masked(log.pidD[i], flying), fs, unfiltered);
    freqs = gyroSpectrum[0];
    spectra[axis] = gyroSpectrum[1];
    sticks[axis] = stickStats(log.setpoint[i]);
    for (const [name, finder] of [["move", sharpestMove], ["hold", longestHold]]) {
      const span = finder(log.setpoint[i], fs);
      if (span !== null) {
        excerpts[`${name}_${axis}`] = cut(log, span, { setpoint: log.setpoint[i], gyro: log.gyro[i] });
      }
    }
  });
  const span = typicalDterm(log.pidD.slice(0, 2), flying, fs);
  if (span !== null) excerpts.dterm = cut(log, span, { roll: log.pidD[0], pitch: log.pidD[1] });

  let saturation = 0;
  if (log.motors.length) {
    let saturated = 0;
    let airborne = 0;
    for (let k = 0; k < flying.length; k++) {
      if (!flying[k]) continue;
      airborne++;
      let top = -Infinity;
      for (const motor of log.motors) top = Math.max(top, motor[k]);
      if (top >= MOTOR_SATURATION) saturated++;
    }
    saturation = saturated / airborne;
  }

  if (log.duration < 20) {
    warnings.push("Flight is shorter than 20 s; fly longer for reliable recommendations.");
  }

  return {
    duration: log.duration,
    sampleRate: fs,
    step,
    noise,
    sticks,
    motorSaturation: saturation,
    throttleMean: mean(masked(log.throttle, flying)),
    spectrumHz: freqs,
    gyroSpectrum: spectra,
    warnings,
    excerpts, // "move_<axis>", "hold_<axis>" and "dterm", when the flight holds one
  };
}

/**
 * Estimate the closed-loop step response from setpoint to gyro.
 *
 * The transfer function is the cross-spectrum of setpoint and gyro over the spectrum of the
 * setpoint, averaged over all windows with stick activity. Its inverse FFT is the impulse
 * response, whose running sum is the step response.
 *
 * Sticks only excite the quad up to some frequency; above it the gyro shows wind and
 * propwash rather than tracking, and the transfer function is noise. That limit is read
 * from the coherence, and the transfer function is tapered there. The taper is zero-phase,
 * so it spreads part of the impulse response before t=0: that part is included in the
 * running sum (PRE_ROLL_S) to keep the steady state unbiased.
 */
export function stepResponse(setpoint, gyro, fs) {
  const window = int(WINDOW_S * fs);
  const length = int(RESPONSE_S * fs);
  const preRoll = int(PRE_ROLL_S * fs);
  if (setpoint.length < window || length < 8) return null;

  const taper = hanning(window);
  const bins = Math.floor(window / 2) + 1;
  const inputPower = new Float64Array(bins);
  const outputPower = new Float64Array(bins);
  const crossRe = new Float64Array(bins);
  const crossIm = new Float64Array(bins);
  const sp = new Float64Array(window);
  const gy = new Float64Array(window);
  let windows = 0;
  for (let start = 0; start + window <= setpoint.length; start += Math.floor(window / 4)) {
    let peak = 0;
    for (let k = 0; k < window; k++) peak = Math.max(peak, Math.abs(setpoint[start + k]));
    if (peak < MIN_INPUT_DPS) continue;
    for (let k = 0; k < window; k++) {
      sp[k] = setpoint[start + k] * taper[k];
      gy[k] = gyro[start + k] * taper[k];
    }
    const [spRe, spIm] = rfft(sp);
    const [gyRe, gyIm] = rfft(gy);
    for (let k = 0; k < bins; k++) {
      inputPower[k] += spRe[k] * spRe[k] + spIm[k] * spIm[k];
      outputPower[k] += gyRe[k] * gyRe[k] + gyIm[k] * gyIm[k];
      // gyro * conj(setpoint)
      crossRe[k] += gyRe[k] * spRe[k] + gyIm[k] * spIm[k];
      crossIm[k] += gyIm[k] * spRe[k] - gyRe[k] * spIm[k];
    }
    windows++;
  }
  if (windows === 0) return null;

  const freqs = rfftfreq(window, 1 / fs);
  const tiny = 1e-12 * max(inputPower);
  const coherence = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const cross2 = crossRe[k] * crossRe[k] + crossIm[k] * crossIm[k];
    coherence[k] = cross2 / (inputPower[k] * outputPower[k] + tiny * tiny);
  }
  const bandwidth = usableBandwidth(freqs, coherence);
  const transferRe = new Float64Array(bins);
  const transferIm = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const taperK = Math.exp(-0.5 * (freqs[k] / bandwidth) ** 2);
    transferRe[k] = (crossRe[k] / (inputPower[k] + tiny)) * taperK;
    transferIm[k] = (crossIm[k] / (inputPower[k] + tiny)) * taperK;
  }
  const impulse = irfft(transferRe, transferIm, window);
  // np.roll(impulse, preRoll), then the running sum from preRoll on
  const response = new Float64Array(length);
  let total = 0;
  for (let k = 0; k < preRoll + length; k++) {
    total += impulse[(k - preRoll + window) % window];
    if (k >= preRoll) response[k - preRoll] = total;
  }

  const time = Float64Array.from({ length }, (_, k) => k / fs);
  const peakIndex = argmax(response);
  const above = response.findIndex((value) => value >= 0.5);
  return {
    time,
    response, // 1.0 = setpoint reached
    windows, // number of windows averaged
    bandwidth, // Hz up to which the sticks excited the quad enough to measure it
    peak: response[peakIndex], // overshoot = peak - 1
    peakTime: time[peakIndex],
    riseTime: above >= 0 ? time[above] : NaN, // to first reach 50% of the setpoint
    steadyState: mean(response.subarray(int(0.6 * length))), // mean over its last 40%
  };
}

/** Frequency up to which the gyro is coherent with the setpoint. */
function usableBandwidth(freqs, coherence) {
  const span = Math.max(1, pyRound(2.5 / (freqs[1] - freqs[0]))); // smooth over 2.5 Hz
  const smoothed = movingAverageSame(coherence, span);
  let start = freqs.findIndex((f) => f >= 1.0);
  if (start < 0) start = freqs.length;
  let limit = freqs[freqs.length - 1];
  for (let k = start; k < smoothed.length; k++) {
    if (smoothed[k] < MIN_COHERENCE) {
      limit = freqs[k];
      break;
    }
  }
  return clip(limit, 1.0, MAX_BANDWIDTH_HZ);
}

/** Amplitude spectral density (units per sqrt(Hz)) by Welch's method: [freqs, density]. */
export function spectrum(values, fs) {
  const nperseg = int(Math.min(values.length, Math.max(256, Math.floor(fs / 2))));
  const [freqs, psd] = welch(values, fs, nperseg);
  return [freqs, psd.map(Math.sqrt)];
}

/** RMS of the content above `lowHz`, from a spectrum. */
function bandRmsOf([freqs, density], lowHz) {
  const first = freqs.findIndex((f) => f >= lowHz);
  if (first < 0 || freqs.length - first < 2) return 0;
  const power = density.subarray(first).map((d) => d * d);
  return Math.sqrt(trapezoid(power, freqs.subarray(first)));
}

/** RMS of the content of `values` above `lowHz`. */
export const bandRms = (values, fs, lowHz) => bandRmsOf(spectrum(values, fs), lowHz);

function noiseStats(gyroSpectrum, dterm, fs, gyroUnfiltered) {
  return {
    gyroRms: bandRmsOf(gyroSpectrum, NOISE_BAND_HZ), // deg/s, filtered gyro above NOISE_BAND_HZ
    dtermRms: bandRms(dterm, fs, NOISE_BAND_HZ), // PID units, D-term above NOISE_BAND_HZ
    peakHz: noisePeakOf(gyroSpectrum), // noise frequency left in the filtered gyro, if any stands out
    gyroUnfilteredRms: gyroUnfiltered === null ? null : bandRms(gyroUnfiltered, fs, NOISE_BAND_HZ),
  };
}

function noisePeakOf([freqs, density]) {
  const first = freqs.findIndex((f) => f >= NOISE_BAND_HZ);
  if (first < 0 || freqs.length - first < 8) return null;
  const band = density.subarray(first);
  const peak = argmax(band);
  if (band[peak] < 4.0 * median(band)) return null;
  return freqs[first + peak];
}

/** Frequency of the dominant noise peak, or null when the noise floor is flat. */
export const noisePeak = (values, fs) => noisePeakOf(spectrum(values, fs));

/** How the pilot used one axis, in deg/s of commanded rate. */
export function stickStats(setpoint) {
  const magnitude = setpoint.map(Math.abs);
  const [p50, p95, p995] = percentiles(magnitude, [50, 95, 99.5]);
  return { maxRate: max(magnitude), p50, p95, p995 };
}

/** [start, end) samples around the fastest stick move: where overshoot shows. */
export function sharpestMove(setpoint, fs) {
  const span = Math.max(1, int(MOVE_SPAN_S * fs));
  if (setpoint.length <= span) return null;
  let at = 0;
  let best = -Infinity;
  for (let k = 0; k + span < setpoint.length; k++) {
    const change = Math.abs(setpoint[k + span] - setpoint[k]);
    if (change > best) {
      best = change;
      at = k;
    }
  }
  if (best < MIN_INPUT_DPS) return null;
  return fitWindow(at - int(MOVE_BEFORE_S * fs), at + int(MOVE_AFTER_S * fs), setpoint.length);
}

/**
 * [start, end) samples around the strongest held stick input: where I shows.
 *
 * The hold is the stretch of HOLD_S whose weakest setpoint, on one side of zero, is the
 * largest: the gyro should settle on it.
 */
export function longestHold(setpoint, fs) {
  const length = int(HOLD_S * fs);
  if (setpoint.length <= length) return null;
  let best = 0;
  let at = 0;
  for (const side of [setpoint, setpoint.map((v) => -v)]) {
    const weakest = forwardMin(side, length);
    const index = argmax(weakest);
    if (weakest[index] > best) {
      best = weakest[index];
      at = index;
    }
  }
  if (best < MIN_INPUT_DPS) return null;
  const margin = int(HOLD_MARGIN_S * fs);
  return fitWindow(at - margin, at + length + margin, setpoint.length);
}

/**
 * [start, end) samples of an airborne stretch whose D-term noise is the flight's typical.
 *
 * Noise is the D-term content above NOISE_BAND_HZ, as in noiseStats(); the stretch shown
 * is the one whose level is closest to the median, not a cherry-picked worst case.
 * `dterm` holds the roll and pitch columns.
 */
export function typicalDterm(dterm, flying, fs) {
  const length = int(DTERM_WINDOW_S * fs);
  const n = dterm[0].length;
  if (fs <= 2.5 * NOISE_BAND_HZ || n < 4 * length || dterm.every((column) => column.every((v) => v === 0))) {
    return null;
  }
  const sos = butterHighpass(4, NOISE_BAND_HZ, fs);
  const power = new Float64Array(n);
  for (const column of dterm) {
    const high = sosFiltFilt(sos, column);
    for (let k = 0; k < n; k++) power[k] += high[k] * high[k];
  }
  const level = forwardMean(power, length);
  const airborne = forwardMin(Float64Array.from(flying), length);
  const candidates = [];
  for (let k = 0; k < airborne.length; k++) if (airborne[k] > 0) candidates.push(k);
  if (!candidates.length) return null;
  const middle = median(candidates.map((k) => level[k]));
  const distance = candidates.map((k) => Math.abs(level[k] - middle));
  // With an even count the two middle stretches are equally close to the median, up to
  // rounding: the earliest of the closest ones is taken.
  const closest = min(distance);
  const at = candidates[distance.findIndex((d) => d <= closest * (1 + 1e-9) + 1e-12)];
  return [at, at + length];
}

/** Shift [start, end) inside [0, size) without changing its length when possible. */
function fitWindow(start, end, size) {
  const shift = Math.max(0, -start) - Math.max(0, end - size);
  return [Math.max(0, start + shift), Math.min(size, end + shift)];
}

/** A short stretch of the log that shows what a measurement is about. */
function cut(log, [start, end], series) {
  const t0 = log.time[start];
  return {
    start: t0, // seconds from the start of the log
    time: log.time.slice(start, end).map((t) => t - t0), // seconds from the start of the excerpt
    series: Object.fromEntries(Object.entries(series).map(([name, values]) => [name, values.slice(start, end)])),
  };
}
