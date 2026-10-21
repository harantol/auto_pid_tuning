// Flight styles: what a "good tune" means for each way of flying.
//
// peakMin / peakMax: step response targets (1.0 = setpoint reached, peak - 1 = overshoot);
//   below peakMin the quad is sluggish, above peakMax it overshoots too much for the style.
// noiseLow / noiseHigh: D-term noise above 100 Hz, in PID units RMS; below noiseLow the
//   filters can be relaxed (less delay), above noiseHigh they must be tightened (cooler motors).
// centerSensitivity, maxRateRange, yawMaxRateRange, expo: rates, in Betaflight "Actual" rates
//   (deg/s, expo 0..1), roll / pitch / yaw.
// feedforwardRange: feedforward gains outside this are pulled back in.

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const style = (fields) => Object.freeze(fields);

export const STYLES = Object.freeze({
  freestyle: style({
    name: "freestyle",
    description: "Snappy and locked-in, tolerant of a slight overshoot.",
    peakMin: 1.02,
    peakMax: 1.15,
    noiseLow: 4.0,
    noiseHigh: 14.0,
    centerSensitivity: [150, 150, 130],
    maxRateRange: [700, 1000],
    yawMaxRateRange: [500, 800],
    expo: [0.45, 0.45, 0.40],
    feedforwardRange: [90, 150],
  }),
  racing: style({
    name: "racing",
    description: "Fastest possible stick response, precise at moderate rates.",
    peakMin: 1.03,
    peakMax: 1.12,
    noiseLow: 5.0,
    noiseHigh: 16.0,
    centerSensitivity: [200, 200, 180],
    maxRateRange: [550, 750],
    yawMaxRateRange: [450, 650],
    expo: [0.30, 0.30, 0.25],
    feedforwardRange: [120, 200],
  }),
  cinematic: style({
    name: "cinematic",
    description: "Smooth footage: no overshoot, soft sticks, quiet motors.",
    peakMin: 0.97,
    peakMax: 1.04,
    noiseLow: 3.0,
    noiseHigh: 9.0,
    centerSensitivity: [90, 90, 80],
    maxRateRange: [360, 600],
    yawMaxRateRange: [300, 450],
    expo: [0.55, 0.55, 0.50],
    feedforwardRange: [40, 90],
  }),
  long_range: style({
    name: "long_range",
    description: "Efficient cruising: cool motors and gentle, stable response.",
    peakMin: 0.97,
    peakMax: 1.06,
    noiseLow: 2.5,
    noiseHigh: 8.0,
    centerSensitivity: [80, 80, 70],
    maxRateRange: [300, 500],
    yawMaxRateRange: [250, 400],
    expo: [0.40, 0.40, 0.35],
    feedforwardRange: [50, 100],
  }),
});

const ALIASES = { cine: "cinematic", cinewhoop: "cinematic", race: "racing", lr: "long_range" };

export function getStyle(name) {
  let key = name.trim().toLowerCase().replace(/[- ]/g, "_");
  key = ALIASES[key] ?? key;
  if (!has(STYLES, key)) {
    throw new Error(`Unknown flight style '${name}'. Choose one of: ${Object.keys(STYLES).join(", ")}.`);
  }
  return STYLES[key];
}
