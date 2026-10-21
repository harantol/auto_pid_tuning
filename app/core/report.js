// JSON and text rendering of a flight and its tuning, as the page and the command line show it.

import { isValid } from "./analysis.js";
import { AXES } from "./blackbox.js";
import { pyFixed, pyPercent, pySigned } from "./numeric.js";
import { cliCommands } from "./tuner.js";

// Object.hasOwn needs a newer WebView than the Android app can count on.
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const GROUP_TITLES = [["pid", "PIDs"], ["filter", "Filters"], ["rates", "Rates"]];

const list = (values) => Array.from(values);
const header = (headers, name) => (has(headers, name) ? headers[name] : null);

/** JSON-serialisable measurements of a flight, independent of any style. */
export function flightToDict(headers, analysis) {
  const axes = {};
  for (const axis of AXES) {
    const step = analysis.step[axis];
    const noise = analysis.noise[axis];
    const sticks = analysis.sticks[axis];
    axes[axis] = {
      step_response: step === null ? null : {
        valid: isValid(step),
        windows: step.windows,
        bandwidth: step.bandwidth,
        peak: step.peak,
        peak_time: step.peakTime,
        rise_time: Number.isNaN(step.riseTime) ? null : step.riseTime,
        steady_state: step.steadyState,
        time: list(step.time),
        response: list(step.response),
      },
      noise: {
        gyro_rms: noise.gyroRms,
        dterm_rms: noise.dtermRms,
        peak_hz: noise.peakHz,
        gyro_unfiltered_rms: noise.gyroUnfilteredRms,
      },
      sticks: { max_rate: sticks.maxRate, p50: sticks.p50, p95: sticks.p95, p995: sticks.p995 },
    };
  }
  const excerpts = {};
  for (const [name, excerpt] of Object.entries(analysis.excerpts)) {
    excerpts[name] = {
      start: excerpt.start,
      time: list(excerpt.time),
      series: Object.fromEntries(Object.entries(excerpt.series).map(([key, values]) => [key, list(values)])),
    };
  }
  const spectrum = { hz: list(analysis.spectrumHz) };
  for (const [axis, values] of Object.entries(analysis.gyroSpectrum)) spectrum[axis] = list(values);
  return {
    firmware: header(headers, "Firmware revision"),
    craft: header(headers, "Craft name"),
    duration: analysis.duration,
    sample_rate: analysis.sampleRate,
    motor_saturation: analysis.motorSaturation,
    axes,
    excerpts,
    spectrum,
  };
}

/** JSON-serialisable suggestions for one style. */
export function tuningToDict(result) {
  const { style } = result;
  return {
    style: style.name,
    description: style.description,
    peak_min: style.peakMin,
    peak_max: style.peakMax,
    noise_low: style.noiseLow,
    noise_high: style.noiseHigh,
    changes: result.changes.map(({ group, param, current, suggested, reason, evidence }) =>
      ({ group, param, current, suggested, reason, evidence })),
    evidence: result.evidence,
    notes: result.notes,
    cli: cliCommands(result),
  };
}

/** JSON-serialisable summary of a flight and its suggestions for one style. */
export const toDict = (headers, analysis, result) => ({ ...flightToDict(headers, analysis), ...tuningToDict(result) });

const padStart = (text, width) => String(text).padStart(width);
const padEnd = (text, width) => String(text).padEnd(width);

export function toText(headers, analysis, result) {
  const { style } = result;
  const lines = [
    `Firmware : ${header(headers, "Firmware revision") ?? "unknown"}`,
    `Flight   : ${pyFixed(analysis.duration, 0)} s logged at ${pyFixed(analysis.sampleRate, 0)} Hz, `
      + `motors saturated ${pyPercent(analysis.motorSaturation, 1)} of the time`,
    `Style    : ${style.name} - ${style.description}`,
    "",
    "Measured",
    `  ${padEnd("axis", 6)}${padStart("overshoot", 10)}${padStart("rise", 9)}${padStart("settles", 9)}`
      + `${padStart("gyro noise", 12)}${padStart("D noise", 9)}${padStart("max stick", 11)}`,
  ];
  for (const axis of AXES) {
    const step = analysis.step[axis];
    const noise = analysis.noise[axis];
    const response = step !== null && isValid(step)
      ? `${padStart(pySigned((step.peak - 1) * 100, 0), 9)}%${padStart(pyFixed(step.riseTime * 1000, 0), 6)} ms`
        + padStart(pyPercent(step.steadyState), 9)
      : `${padStart("n/a", 10)}${padStart("n/a", 9)}${padStart("n/a", 9)}`;
    lines.push(
      `  ${padEnd(axis, 6)}${response}${padStart(pyFixed(noise.gyroRms, 1), 12)}${padStart(pyFixed(noise.dtermRms, 1), 9)}`
      + `${padStart(pyFixed(analysis.sticks[axis].maxRate, 0), 5)} deg/s`,
    );
  }

  if (!result.changes.length) {
    lines.push("", `Nothing to change: this tune already fits ${style.name} flying.`);
  }
  for (const [group, title] of GROUP_TITLES) {
    const changes = result.changes.filter((c) => c.group === group);
    if (!changes.length) continue;
    lines.push("", title);
    for (const c of changes) {
      const current = c.current === null ? "?" : c.current;
      lines.push(`  ${padEnd(c.param, 24)}${padStart(current, 6)} -> ${padEnd(c.suggested, 8)}${c.reason}`);
    }
  }

  if (result.notes.length) lines.push("", "Notes", ...result.notes.map((note) => `  - ${note}`));
  if (result.changes.length) lines.push("", "Betaflight CLI", ...cliCommands(result).map((command) => `  ${command}`));
  return lines.join("\n");
}
