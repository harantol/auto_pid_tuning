// Turn a flight analysis and a flight style into Betaflight setting changes.
//
// The rules are deliberately conservative: gains and filter cutoffs move by at most 15% per
// flight, so tuning is an iteration of fly, log, apply, repeat.

import { isValid } from "./analysis.js";
import { AXES, atLeast, firmwareVersion } from "./blackbox.js";
import { clip, pyFixed, pyPercent, pyRound, pySigned } from "./numeric.js";
import { RATES_ACTUAL, actualRate, currentRates, rateCurve } from "./rates.js";

// Object.hasOwn needs a newer WebView than the Android app can count on.
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const MAX_STEP = 0.15; // largest relative change of a gain or cutoff in one pass
const MIN_STEP = 0.03; // smaller corrections are not worth a flight
const SATURATION_LIMIT = 0.03; // share of flight time with a motor at its limit

const P_LIMITS = [10, 150];
const I_LIMITS = [10, 200];
const D_LIMITS = [0, 100];
const GYRO_LPF_LIMITS = [50, 1000];
const DTERM_LPF_LIMITS = [40, 300];
const RATE_CURVE_POINTS = 41;

// [CLI name, log header, index in the header value or null] per firmware generation.
const FILTERS_4_3 = {
  gyro: [
    ["gyro_lpf1_static_hz", "gyro_lpf1_static_hz", null],
    ["gyro_lpf1_dyn_min_hz", "gyro_lpf1_dyn_hz", 0],
    ["gyro_lpf1_dyn_max_hz", "gyro_lpf1_dyn_hz", 1],
    ["gyro_lpf2_static_hz", "gyro_lpf2_static_hz", null],
  ],
  dterm: [
    ["dterm_lpf1_static_hz", "dterm_lpf1_static_hz", null],
    ["dterm_lpf1_dyn_min_hz", "dterm_lpf1_dyn_hz", 0],
    ["dterm_lpf1_dyn_max_hz", "dterm_lpf1_dyn_hz", 1],
    ["dterm_lpf2_static_hz", "dterm_lpf2_static_hz", null],
  ],
};
const FILTERS_LEGACY = {
  gyro: [
    ["gyro_lowpass_hz", "gyro_lowpass_hz", null],
    ["dyn_lpf_gyro_min_hz", "gyro_lowpass_dyn_hz", 0],
    ["dyn_lpf_gyro_max_hz", "gyro_lowpass_dyn_hz", 1],
    ["gyro_lowpass2_hz", "gyro_lowpass2_hz", null],
  ],
  dterm: [
    ["dterm_lowpass_hz", "dterm_lowpass_hz", null],
    ["dyn_lpf_dterm_min_hz", "dterm_lowpass_dyn_hz", 0],
    ["dyn_lpf_dterm_max_hz", "dterm_lowpass_dyn_hz", 1],
    ["dterm_lowpass2_hz", "dterm_lowpass2_hz", null],
  ],
};

/** Python truthiness of a header value. */
const truthy = (value) =>
  value !== undefined && value !== null && value !== 0 && value !== "" && value !== false
  && !(Array.isArray(value) && value.length === 0);

const header = (headers, name) => (has(headers, name) ? headers[name] : null);

const indexed = (value, index) => (Array.isArray(value) && value.length > index ? value[index] : null);

const toInt = (value) => Math.trunc(Number(value));

/**
 * A setting change. `group` is "pid", "filter" or "rates", `param` the Betaflight CLI name.
 * `evidence` is the id of the chart that shows why: an analysis excerpt ("move_roll",
 * "hold_roll", "dterm") or an entry of the result's evidence ("notch", "rates_roll"); null for
 * switches that only make other changes possible.
 */
const change = (group, param, current, suggested, reason, evidence = null) =>
  ({ group, param, current, suggested, reason, evidence });

/** Commands to paste in the Betaflight CLI; empty when nothing changes. */
export function cliCommands(result) {
  if (!result.changes.length) return [];
  return [...result.changes.map((c) => `set ${c.param} = ${c.suggested}`), "save"];
}

export function tune(headers, analysis, style) {
  const result = { style, changes: [], notes: [...analysis.warnings], evidence: {} };
  let version = firmwareVersion(headers);
  if (version[0] === 0 && version[1] === 0) {
    result.notes.push("Firmware version not recognised; assuming Betaflight 4.3 or newer.");
    version = [4, 3];
  }
  const modern = atLeast(version, 4, 3);

  const saturated = analysis.motorSaturation > SATURATION_LIMIT;
  if (saturated) {
    result.notes.push(
      `Motors are at their limit ${pyPercent(analysis.motorSaturation)} of the time: `
      + "gains are not raised. Consider a lighter build or lower-pitch props.",
    );
  }

  const pidChanges = [];
  AXES.forEach((axis, index) => {
    const noisy = analysis.noise[axis].dtermRms > style.noiseHigh;
    pidChanges.push(...tunePid(headers, index, axis, analysis.step[axis], style, noisy, saturated, analysis.excerpts));
  });
  const simplified = has(headers, "simplified_pids_mode") ? headers.simplified_pids_mode : 0;
  if (pidChanges.length && modern && truthy(simplified)) {
    pidChanges.unshift(change(
      "pid", "simplified_pids_mode", headers.simplified_pids_mode, "OFF",
      "Sliders must be off, otherwise they overwrite the individual gains.",
    ));
  }
  result.changes.push(...pidChanges);
  result.changes.push(...tuneFilters(headers, analysis, style, modern, result.notes));
  if (result.changes.some((c) => c.evidence === "notch")) {
    result.evidence.notch = { range: [header(headers, "dyn_notch_min_hz"), header(headers, "dyn_notch_max_hz")] };
  }
  if (atLeast(version, 4, 2)) {
    result.changes.push(...tuneRates(headers, analysis, style, result.notes, result.evidence));
  } else {
    result.notes.push("Rates are left untouched: Actual rates need Betaflight 4.2 or newer.");
  }

  if (result.changes.length) {
    result.notes.push(
      "Changes are limited to 15% per pass: apply them, fly the same way, "
      + "log again and repeat until nothing is suggested.",
    );
  }
  return result;
}

const stepSize = (deviation) => clip(Math.abs(deviation), MIN_STEP, MAX_STEP);

const scaled = (value, scale, [low, high]) => clip(pyRound(value * scale), low, high);

function tunePid(headers, index, axis, step, style, noisy, saturated, excerpts) {
  const gains = header(headers, `${axis}PID`);
  if (step === null || !isValid(step) || !Array.isArray(gains) || gains.length < 3) return [];
  const [p, i, d] = gains.slice(0, 3).map(toInt);
  const dMinValue = indexed(header(headers, "d_min"), index);
  const dMin = toInt(truthy(dMinValue) ? dMinValue : 0);
  const changes = [];

  const add = (name, current, suggested, reason) => {
    // I shows on a held stick, everything else on the sharpest move.
    const evidence = `${name === "i" ? "hold" : "move"}_${axis}`;
    if (suggested !== current) {
      changes.push(change("pid", `${name}_${axis}`, current, suggested, reason, evidence in excerpts ? evidence : null));
    }
  };

  const ffWeight = has(headers, "ff_weight") ? headers.ff_weight : header(headers, "feedforward_weight");
  const feedforward = indexed(ffWeight, index);
  const [ffLow, ffHigh] = style.feedforwardRange;
  const overshoot = `${pySigned((step.peak - 1) * 100, 0)}%`;
  // Too much feedforward alone can cause overshoot: lower it first, P and D wait a flight.
  const excessFeedforward = truthy(feedforward) && feedforward > ffHigh;
  if (step.peak > style.peakMax && excessFeedforward) {
    // feedforward is pulled back below
  } else if (step.peak > style.peakMax) {
    const amount = stepSize(step.peak - style.peakMax);
    if (axis !== "yaw" && d > 0 && !noisy) {
      const reason = `Overshoot of ${overshoot} exceeds the ${style.name} target; more damping.`;
      add("d", d, scaled(d, 1 + amount, D_LIMITS), reason);
      if (dMin) add("d_min", dMin, scaled(dMin, 1 + amount, D_LIMITS), reason);
    } else {
      const why = noisy && axis !== "yaw" ? "the D-term is already noisy" : "no D on this axis";
      add("p", p, scaled(p, 1 - amount, P_LIMITS),
        `Overshoot of ${overshoot} exceeds the ${style.name} target and ${why}; less P.`);
    }
  } else if (step.peak < style.peakMin && !saturated) {
    const amount = stepSize(style.peakMin - step.peak);
    add("p", p, scaled(p, 1 + amount, P_LIMITS),
      `Response peaks at ${overshoot}, soft for ${style.name}; more P for a sharper response.`);
  }

  if (step.steadyState < 0.94 && !saturated) {
    add("i", i, scaled(i, 1 + stepSize(1 - step.steadyState), I_LIMITS),
      `Response settles at ${pyPercent(step.steadyState)} of the setpoint; more I to hold it.`);
  }

  if (truthy(feedforward)) {
    add("f", toInt(feedforward), toInt(clip(feedforward, ffLow, ffHigh)),
      `Feedforward for ${style.name} flying is kept between ${ffLow} and ${ffHigh}.`);
  }
  return changes;
}

function tuneFilters(headers, analysis, style, modern, notes) {
  if (!truthy(header(headers, "dshot_bidir"))) {
    notes.push(
      "RPM filtering is off: enabling bidirectional DShot is the single biggest "
      + "noise improvement and allows much lighter filtering.",
    );
  }

  const changes = [];
  const noise = Math.max(analysis.noise.roll.dtermRms, analysis.noise.pitch.dtermRms);
  if (noise <= 0) {
    notes.push("D-term is not in the log; lowpass filters are left untouched.");
  } else {
    let scale = 1;
    let reason = "";
    if (noise > 2 * style.noiseHigh) [scale, reason] = [1 - MAX_STEP, "D-term noise is very high"];
    else if (noise > style.noiseHigh) [scale, reason] = [0.9, "D-term noise is high"];
    else if (noise < style.noiseLow) [scale, reason] = [1.1, "D-term noise is low"];
    if (scale !== 1) {
      const action = scale < 1 ? "lower cutoffs, cooler motors" : "higher cutoffs, less delay";
      reason = `${reason} (${pyFixed(noise, 1)} RMS) for ${style.name}; ${action}.`;
      const table = modern ? FILTERS_4_3 : FILTERS_LEGACY;
      const evidence = "dterm" in analysis.excerpts ? "dterm" : null;
      for (const [kind, [low, high]] of [["gyro", GYRO_LPF_LIMITS], ["dterm", DTERM_LPF_LIMITS]]) {
        const kindChanges = [];
        for (const [param, name, position] of table[kind]) {
          const value = header(headers, name);
          const current = position === null ? value : indexed(value, position);
          if (!truthy(current)) continue; // absent, or 0 = filter disabled
          const suggested = clip(5 * pyRound((current * scale) / 5), low, high);
          if (suggested !== current) {
            kindChanges.push(change("filter", param, toInt(current), suggested, reason, evidence));
          }
        }
        const slider = `simplified_${kind}_filter`;
        if (kindChanges.length && modern && truthy(header(headers, slider))) {
          kindChanges.unshift(change(
            "filter", slider, headers[slider], "OFF",
            "Slider must be off, otherwise it overwrites the cutoffs.", evidence,
          ));
        }
        changes.push(...kindChanges);
      }
    }
  }

  changes.push(...tuneDynamicNotch(headers, analysis, modern));
  return changes;
}

function tuneDynamicNotch(headers, analysis, modern) {
  const low = header(headers, "dyn_notch_min_hz");
  const high = header(headers, "dyn_notch_max_hz");
  if (!truthy(low) || !truthy(high) || (modern && !truthy(header(headers, "dyn_notch_count")))) return [];
  const peaks = ["roll", "pitch"].map((axis) => analysis.noise[axis].peakHz).filter((peak) => peak !== null);
  if (!peaks.length) return [];
  const lowest = Math.min(...peaks);
  const highest = Math.max(...peaks);
  const changes = [];
  if (lowest < low) {
    const suggested = Math.max(60, Math.floor((lowest * 0.8) / 10) * 10);
    if (suggested < low) {
      changes.push(change("filter", "dyn_notch_min_hz", toInt(low), suggested,
        `A noise peak at ${pyFixed(lowest, 0)} Hz sits below the dynamic notch range.`, "notch"));
    }
  }
  if (highest > high) {
    const suggested = Math.min(1000, Math.ceil((highest * 1.2) / 10) * 10);
    if (suggested > high) {
      changes.push(change("filter", "dyn_notch_max_hz", toInt(high), suggested,
        `A noise peak at ${pyFixed(highest, 0)} Hz sits above the dynamic notch range.`, "notch"));
    }
  }
  return changes;
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();

function tuneRates(headers, analysis, style, notes, evidence) {
  const current = currentRates(headers);
  const isActual = header(headers, "rates_type") === RATES_ACTUAL;
  const targets = [];
  let suitable = current !== null;
  AXES.forEach((axis, index) => {
    const [low, high] = axis === "yaw" ? style.yawMaxRateRange : style.maxRateRange;
    let center = style.centerSensitivity[index];
    let expo = style.expo[index];
    let wanted;
    if (current !== null) {
      const flown = current[index];
      wanted = flown.maxRate;
      const maxOk = low <= flown.maxRate && flown.maxRate <= high;
      const centerOk = 0.7 * center <= flown.centerSensitivity && flown.centerSensitivity <= 1.3 * center;
      suitable = suitable && maxOk && centerOk;
      // Keep what already fits the style: sticks are muscle memory.
      if (isActual && centerOk) center = flown.centerSensitivity;
      if (isActual && flown.expo !== null && Math.abs(flown.expo - expo) <= 0.2) expo = flown.expo;
    } else {
      wanted = 1.2 * analysis.sticks[axis].p995;
    }
    const maxRate = clip(10 * pyRound(wanted / 10), low, high);
    targets.push([pyRound(center), maxRate, expo]);
  });

  if (suitable) return [];
  if (current === null) {
    notes.push(
      "The rate type of this log is not modelled; max rates are derived from "
      + "the fastest moves of the flight.",
    );
  }

  const changes = [];
  if (!isActual) {
    changes.push(change("rates", "rates_type", header(headers, "rates_type"), "ACTUAL",
      "Actual rates set centre sensitivity and max rate directly in deg/s."));
  }
  // The same three settings exist for every rate type, only their meaning differs.
  const raw = [header(headers, "rc_rates"), header(headers, "rates"), header(headers, "rc_expo")];
  AXES.forEach((axis, index) => {
    const [center, maxRate, expo] = targets[index];
    const [low, high] = axis === "yaw" ? style.yawMaxRateRange : style.maxRateRange;
    const settings = [
      ["rc_rate", pyRound(center / 10), `centre sensitivity of ${center} deg/s`],
      ["srate", pyRound(maxRate / 10), `max rate of ${maxRate} deg/s (${low}-${high})`],
      ["expo", pyRound(expo * 100), `expo of ${pyFixed(expo, 2)}`],
    ];
    settings.forEach(([name, suggested, text], position) => {
      const value = indexed(raw[position], index);
      const before = value === null ? null : toInt(value);
      if (before !== suggested) {
        changes.push(change("rates", `${axis}_${name}`, before, suggested,
          `${capitalize(style.name)} ${axis}: ${text}.`, `rates_${axis}`));
      }
    });
    if (changes.some((c) => c.evidence === `rates_${axis}`)) {
      const sticks = Array.from({ length: RATE_CURVE_POINTS }, (_, k) => k / (RATE_CURVE_POINTS - 1));
      evidence[`rates_${axis}`] = {
        stick: sticks,
        current: rateCurve(headers, index, sticks),
        suggested: sticks.map((x) => actualRate(x, center, maxRate, expo)),
      };
    }
  });
  return changes;
}
