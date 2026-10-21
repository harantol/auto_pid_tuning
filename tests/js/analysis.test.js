import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyze, bandRms, isValid, longestHold, noisePeak, sharpestMove, stepResponse, stickStats, typicalDterm,
} from "../../app/core/analysis.js";
import { loadLog } from "../../app/core/blackbox.js";
import { axisFlight, normal } from "./simulate.js";
import { simulatedLog } from "./writer.js";

const close = (actual, expected, tolerance, message = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} != ${expected} ± ${tolerance}`);

const maxOf = (values) => values.reduce((a, b) => Math.max(a, b), -Infinity);

for (const fs of [1000, 250]) {
  for (const damping of [0.35, 0.5, 0.7, 1.0]) {
    test(`step response recovers a known system (fs ${fs}, damping ${damping})`, () => {
      const { setpoint, gyro, truth } = axisFlight({ fs, damping });
      const response = stepResponse(setpoint, gyro, fs);
      assert.ok(isValid(response));
      close(response.peak, maxOf(truth), 0.06, "peak");
      close(response.steadyState, 1, 0.03, "steady state");
      const trueRise = truth.findIndex((v) => v >= 0.5) / fs;
      close(response.riseTime, trueRise, 0.006, "rise time");
    });
  }
}

test("step response orders tunes by overshoot", () => {
  const peaks = [1.0, 0.6, 0.3].map((damping) => {
    const { setpoint, gyro } = axisFlight({ damping });
    return stepResponse(setpoint, gyro, 1000).peak;
  });
  assert.deepEqual(peaks, [...peaks].sort((a, b) => a - b));
});

test("step response is invalid when sticks are too gentle", () => {
  // Slow, small stick moves buried in wind: the response cannot be read from the log.
  const { setpoint, gyro } = axisFlight({ damping: 0.35, disturbance: 150, amplitude: 80, stickHz: 3 });
  const response = stepResponse(setpoint, gyro, 1000);
  assert.ok(!isValid(response));
  assert.ok(response.bandwidth < 15);
});

test("no step response without stick input or on a short log", () => {
  const gauss = normal(0);
  assert.equal(stepResponse(new Float64Array(20000), Float64Array.from({ length: 20000 }, () => gauss()), 1000), null);
  assert.equal(stepResponse(new Float64Array(500).fill(1), new Float64Array(500).fill(1), 1000), null);
});

test("band RMS measures only the band", () => {
  const fs = 1000;
  const n = 20 * fs;
  const low = Float64Array.from({ length: n }, (_, k) => 50 * Math.sin((2 * Math.PI * 5 * k) / fs));
  const both = low.map((v, k) => v + 3 * Math.sin((2 * Math.PI * 220 * k) / fs));
  close(bandRms(both, fs, 100), 3 / Math.SQRT2, 0.05 * (3 / Math.SQRT2));
  assert.ok(bandRms(low, fs, 100) < 0.05);
});

test("noise peak finds a resonance", () => {
  const fs = 1000;
  const gauss = normal(0);
  const noise = Float64Array.from({ length: 20 * fs }, () => gauss());
  assert.equal(noisePeak(noise, fs), null);
  close(noisePeak(noise.map((v, k) => v + 5 * Math.sin((2 * Math.PI * 240 * k) / fs)), fs), 240, 3);
});

test("stick stats", () => {
  const setpoint = new Float64Array(1000);
  setpoint.fill(-600, 900);
  const stats = stickStats(setpoint);
  assert.equal(stats.maxRate, 600);
  assert.equal(stats.p50, 0);
  assert.equal(stats.p95, 600);
});

test("sharpest move frames the step and stays inside the log", () => {
  const setpoint = new Float64Array(2000);
  setpoint.fill(500, 1200); // one flick at 1.2 s
  const [start, end] = sharpestMove(setpoint, 1000);
  assert.equal(end - start, 500);
  assert.ok(start < 1200 && 1200 < start + 200); // the move near the start, the response after it
  assert.equal(sharpestMove(new Float64Array(2000), 1000), null);

  const late = new Float64Array(1000);
  late.fill(500, 960);
  assert.deepEqual(sharpestMove(late, 1000), [500, 1000]);
});

test("longest hold finds the held input", () => {
  const setpoint = new Float64Array(5000);
  setpoint.fill(600, 1000, 1300); // short and strong
  setpoint.fill(-300, 3000, 3900); // long enough to settle
  const [start, end] = longestHold(setpoint, 1000);
  assert.ok(start <= 3000 && end >= 3600);
  assert.equal(longestHold(new Float64Array(5000).fill(5), 1000), null);
});

test("typical D-term skips the extremes", () => {
  const gauss = normal(0);
  const columns = [0, 1].map(() => Float64Array.from({ length: 10000 }, () => gauss(5)));
  for (const column of columns) for (let k = 2000; k < 2500; k++) column[k] *= 10; // a burst of noise
  const flying = new Uint8Array(10000).fill(1);
  const [start, end] = typicalDterm(columns, flying, 1000);
  assert.equal(end - start, 250);
  assert.ok(!(start > 1750 && start < 2500));
  assert.equal(typicalDterm([new Float64Array(10000), new Float64Array(10000)], flying, 1000), null);
});

test("analyze a full flight", () => {
  const analysis = analyze(loadLog(simulatedLog({ damping: 0.5, dtermNoise: 6 })));
  close(analysis.duration, 120, 0.1);
  for (const axis of ["roll", "pitch", "yaw"]) assert.ok(isValid(analysis.step[axis]), axis);
  close(analysis.noise.roll.dtermRms, 6 * Math.sqrt(0.8), 0.1 * 6 * Math.sqrt(0.8));
  assert.equal(analysis.noise.yaw.dtermRms, 0);
  assert.equal(analysis.motorSaturation, 0);
  assert.deepEqual(analysis.warnings, []);

  for (const axis of ["roll", "pitch", "yaw"]) {
    const move = analysis.excerpts[`move_${axis}`];
    close(move.time.length, 500, 2); // 0.5 s, at the rate read from the log
    assert.equal(move.time[0], 0);
    assert.deepEqual(Object.keys(move.series).sort(), ["gyro", "setpoint"]);
    assert.ok(`hold_${axis}` in analysis.excerpts);
  }
  assert.deepEqual(Object.keys(analysis.excerpts.dterm.series).sort(), ["pitch", "roll"]);
});

test("analyze reports saturation and gentle sticks", () => {
  const log = loadLog(simulatedLog({ damping: 0.35, disturbance: 150, amplitude: 80, stickHz: 3, motorLevel: 1 }));
  const analysis = analyze(log);
  assert.equal(analysis.motorSaturation, 1);
  assert.equal(analysis.warnings.filter((w) => w.includes("too gentle")).length, 3);
});

test("a short flight is flagged", () => {
  const analysis = analyze(loadLog(simulatedLog({ duration: 10 })));
  assert.ok(analysis.warnings.some((w) => w.includes("shorter than 20 s")));
});
