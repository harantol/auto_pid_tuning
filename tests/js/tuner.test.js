import assert from "node:assert/strict";
import { test } from "node:test";

import { actualRate, betaflightRate, currentRates } from "../../app/core/rates.js";
import { getStyle } from "../../app/core/styles.js";
import { cliCommands, tune } from "../../app/core/tuner.js";
import { HEADERS_4_3 } from "./writer.js";

const AXES = ["roll", "pitch", "yaw"];
const close = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

const headers = (changes = {}) => ({ ...structuredClone(HEADERS_4_3), ...changes });

function makeAnalysis({
  peak = 1.08, steady = 1.0, dtermRms = 8.0, saturation = 0, peakHz = null, bandwidth = 30, maxStick = 800,
} = {}) {
  const step = () => ({ time: [0], response: [0], windows: 50, bandwidth, peak, peakTime: 0.04, riseTime: 0.02, steadyState: steady });
  return {
    duration: 120,
    sampleRate: 1000,
    step: Object.fromEntries(AXES.map((axis) => [axis, step()])),
    noise: Object.fromEntries(AXES.map((axis) => [axis, {
      gyroRms: 1, dtermRms: axis === "yaw" ? 0 : dtermRms, peakHz, gyroUnfilteredRms: null,
    }])),
    sticks: Object.fromEntries(AXES.map((axis) => [axis, { maxRate: maxStick, p50: 20, p95: 300, p995: maxStick }])),
    motorSaturation: saturation,
    throttleMean: 0.4,
    spectrumHz: [],
    gyroSpectrum: {},
    warnings: [],
    excerpts: {},
  };
}

const freestyle = getStyle("freestyle");
const byParam = (result) => Object.fromEntries(result.changes.map((change) => [change.param, change]));
const pids = (result) => result.changes.filter((change) => change.group === "pid");

test("a good tune is left alone", () => {
  const result = tune(headers(), makeAnalysis(), freestyle);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(cliCommands(result), []);
});

test("overshoot adds damping", () => {
  const changes = byParam(tune(headers(), makeAnalysis({ peak: 1.25 }), freestyle));
  assert.equal(changes.d_roll.suggested, 44); // 40 * 1.10
  assert.equal(changes.d_min_roll.suggested, 33);
  assert.ok(changes.d_pitch.suggested > 46);
  assert.ok(!("p_roll" in changes));
  assert.ok(changes.p_yaw.suggested < 45); // yaw has no D: its overshoot is fixed with P
  assert.equal(changes.simplified_pids_mode.suggested, "OFF");
});

test("overshoot with a noisy D-term lowers P instead", () => {
  const changes = byParam(tune(headers(), makeAnalysis({ peak: 1.25, dtermRms: 20 }), freestyle));
  assert.ok(!("d_roll" in changes));
  assert.ok(changes.p_roll.suggested < 45);
});

test("a soft response raises P", () => {
  const changes = byParam(tune(headers(), makeAnalysis({ peak: 0.96 }), freestyle));
  assert.ok(changes.p_roll.suggested > 45);
  assert.ok(!("d_roll" in changes));
});

test("gains are not raised when motors saturate", () => {
  const result = tune(headers(), makeAnalysis({ peak: 0.96, steady: 0.85, saturation: 0.2 }), freestyle);
  assert.deepEqual(pids(result), []);
  assert.ok(result.notes.some((note) => note.includes("at their limit 20%")));
});

test("a low steady state raises I", () => {
  assert.equal(byParam(tune(headers(), makeAnalysis({ steady: 0.88 }), freestyle)).i_roll.suggested, 90);
});

test("changes are capped", () => {
  assert.equal(byParam(tune(headers(), makeAnalysis({ peak: 2 }), freestyle)).d_roll.suggested, 46);
});

test("the style changes the verdict", () => {
  const h = headers({ ff_weight: [80, 80, 80] }); // inside every style range
  const analysis = makeAnalysis({ peak: 1.1 });
  assert.ok(!("d_roll" in byParam(tune(h, analysis, freestyle))));
  assert.ok("d_roll" in byParam(tune(h, analysis, getStyle("cinematic"))));
});

test("excess feedforward is fixed before P and D", () => {
  const changes = byParam(tune(headers({ ff_weight: [180, 180, 180] }), makeAnalysis({ peak: 1.25 }), freestyle));
  assert.equal(changes.f_roll.suggested, 150);
  assert.ok(!("d_roll" in changes));
  assert.ok(!("p_yaw" in changes));
});

test("an unmeasured step response leaves PIDs alone", () => {
  assert.deepEqual(pids(tune(headers(), makeAnalysis({ peak: 1.4, bandwidth: 5 }), freestyle)), []);
});

test("a noisy D-term tightens the filters", () => {
  const changes = byParam(tune(headers(), makeAnalysis({ dtermRms: 20 }), freestyle));
  assert.ok(changes.dterm_lpf1_dyn_min_hz.suggested < 75);
  assert.ok(changes.gyro_lpf1_static_hz.suggested < 250);
  assert.equal(changes.simplified_dterm_filter.suggested, "OFF");
  assert.equal(changes.simplified_gyro_filter.suggested, "OFF");
});

test("a clean D-term relaxes the filters, disabled ones stay disabled", () => {
  const changes = byParam(tune(headers(), makeAnalysis({ dtermRms: 1 }), freestyle));
  assert.ok(changes.dterm_lpf1_dyn_min_hz.suggested > 75);
  assert.ok(changes.gyro_lpf2_static_hz.suggested > 500);
  const disabled = byParam(tune(headers({ gyro_lpf2_static_hz: 0 }), makeAnalysis({ dtermRms: 1 }), freestyle));
  assert.ok(!("gyro_lpf2_static_hz" in disabled));
});

test("legacy firmware uses legacy names", () => {
  const h = headers({
    "Firmware revision": "Betaflight 4.2.8 (101738d8e) STM32F7X2",
    gyro_lowpass_hz: 300,
    gyro_lowpass_dyn_hz: [0, 400],
    dterm_lowpass_hz: 100,
    dterm_lowpass_dyn_hz: [0, 350],
    feedforward_weight: [120, 120, 120],
  });
  const changes = byParam(tune(h, makeAnalysis({ peak: 1.25, dtermRms: 20 }), freestyle));
  assert.equal(changes.gyro_lowpass_hz.suggested, 270);
  assert.equal(changes.dyn_lpf_gyro_max_hz.suggested, 360);
  assert.ok(!("dyn_lpf_gyro_min_hz" in changes)); // 0 = disabled
  assert.ok(!Object.keys(changes).some((param) => param.startsWith("simplified")));
});

test("the dynamic notch follows the noise peak", () => {
  assert.equal(byParam(tune(headers(), makeAnalysis({ peakHz: 110 }), freestyle)).dyn_notch_min_hz.suggested, 80);
  const inside = byParam(tune(headers(), makeAnalysis({ peakHz: 300 }), freestyle));
  assert.ok(!("dyn_notch_min_hz" in inside) && !("dyn_notch_max_hz" in inside));
  assert.equal(byParam(tune(headers(), makeAnalysis({ peakHz: 700 }), freestyle)).dyn_notch_max_hz.suggested, 840);
});

test("a missing RPM filter is noted", () => {
  const result = tune(headers({ dshot_bidir: 0 }), makeAnalysis(), freestyle);
  assert.ok(result.notes.some((note) => note.includes("RPM filtering is off")));
});

test("an unrecognised firmware is assumed modern", () => {
  const result = tune(headers({ "Firmware revision": "INAV 6.0" }), makeAnalysis(), freestyle);
  assert.ok(result.notes[0].includes("not recognised"));
});

test("suitable rates are kept", () => {
  assert.deepEqual(tune(headers(), makeAnalysis(), freestyle).changes.filter((c) => c.group === "rates"), []);
});

test("rates are pulled into the style range", () => {
  const changes = byParam(tune(headers(), makeAnalysis(), getStyle("cinematic")));
  assert.equal(changes.roll_srate.suggested, 60); // 800 deg/s -> 600, top of the cine range
  assert.equal(changes.yaw_srate.suggested, 45);
  assert.equal(changes.roll_rc_rate.suggested, 9);
  assert.ok(!("roll_expo" in changes)); // 0.45 is close enough to 0.55: keep muscle memory
  assert.ok(!("rates_type" in changes));
});

test("Betaflight rates are converted to Actual", () => {
  const h = headers({ rates_type: 0, rc_rates: [100, 100, 100], rates: [70, 70, 70], rc_expo: [0, 0, 0] });
  const changes = byParam(tune(h, makeAnalysis(), freestyle));
  assert.equal(changes.rates_type.suggested, "ACTUAL");
  assert.equal(changes.roll_rc_rate.suggested, 15);
  assert.ok(!("roll_srate" in changes)); // 667 deg/s flown, raised to 700: srate is already 70
  assert.equal(changes.roll_expo.suggested, 45);
});

test("an unknown rate type uses stick usage", () => {
  const result = tune(headers({ rates_type: 2 }), makeAnalysis({ maxStick: 500 }), getStyle("cinematic"));
  const changes = byParam(result);
  assert.equal(changes.rates_type.suggested, "ACTUAL");
  assert.equal(changes.roll_srate.suggested, 60); // 1.2 * 500 = 600
  assert.ok(result.notes.some((note) => note.includes("not modelled")));
});

test("CLI commands end with save", () => {
  const commands = cliCommands(tune(headers(), makeAnalysis({ peak: 1.25 }), freestyle));
  assert.equal(commands[0], "set simplified_pids_mode = OFF");
  assert.ok(commands.includes("set d_roll = 44"));
  assert.equal(commands.at(-1), "save");
});

test("unknown style and aliases", () => {
  assert.throws(() => getStyle("acro-ballet"), /Unknown flight style/);
  assert.equal(getStyle("Cine").name, "cinematic");
  assert.equal(getStyle("long-range").name, "long_range");
});

test("changes point to their evidence", () => {
  const analysis = makeAnalysis({ peak: 1.25, steady: 0.85, dtermRms: 40 });
  const blank = { start: 0, time: [0], series: {} };
  analysis.excerpts = { move_roll: blank, hold_roll: blank, dterm: blank };
  const changes = byParam(tune(headers(), analysis, freestyle));
  assert.equal(changes.p_roll.evidence, "move_roll"); // noisy D-term: overshoot lowers P
  assert.equal(changes.i_roll.evidence, "hold_roll");
  assert.equal(changes.p_pitch.evidence, null); // no excerpt for pitch: no chart
  assert.equal(changes.gyro_lpf1_static_hz.evidence, "dterm");
  assert.equal(changes.simplified_pids_mode.evidence, null);
});

test("rate and notch evidence", () => {
  const h = headers();
  const result = tune(h, makeAnalysis({ peakHz: 110 }), getStyle("cinematic"));
  const changes = byParam(result);
  assert.equal(changes.dyn_notch_min_hz.evidence, "notch");
  assert.deepEqual(result.evidence.notch.range, [h.dyn_notch_min_hz, h.dyn_notch_max_hz]);
  assert.equal(changes.roll_srate.evidence, "rates_roll");
  const curves = result.evidence.rates_roll;
  assert.equal(curves.stick[0], 0);
  assert.equal(curves.stick.at(-1), 1);
  close(curves.current.at(-1), 800, 1e-9); // flown max rate
  close(curves.suggested.at(-1), 600, 1e-9);
});

test("Actual rates are read directly", () => {
  const rates = currentRates({ rates_type: 3, rc_rates: [7, 15, 13], rates: [67, 80, 65], rc_expo: [0, 45, 40] });
  assert.equal(rates[0].centerSensitivity, 70);
  assert.equal(rates[0].maxRate, 670);
  assert.equal(rates[1].expo, 0.45);
});

test("Actual rate curve endpoints", () => {
  close(actualRate(1, 150, 800, 0.5), 800, 1e-9);
  close(actualRate(-1, 150, 800, 0.5), -800, 1e-9);
  close(actualRate(0.01, 150, 800, 0.5), 1.5, 0.075); // near the centre the slope is the centre sensitivity
});

test("Betaflight rates: max and centre", () => {
  close(betaflightRate(1, 100, 70, 0), 666.7, 0.1); // the classic 1.00 / 0.70 / 0.00 rates
  const rates = currentRates({ rates_type: 0, rc_rates: [100, 100, 100], rates: [70, 70, 70], rc_expo: [20, 20, 20] });
  close(rates[0].maxRate, 666.7, 0.1);
  close(rates[0].centerSensitivity, 160, 1e-9);
});

test("unmodelled or missing rates", () => {
  assert.equal(currentRates({ rates_type: 2, rc_rates: [1, 1, 1], rates: [1, 1, 1], rc_expo: [0, 0, 0] }), null);
  assert.equal(currentRates({ rates_type: 3 }), null);
});
