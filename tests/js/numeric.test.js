import assert from "node:assert/strict";
import { test } from "node:test";

import {
  butterHighpass, fft, forwardMean, forwardMin, irfft, median, movingAverageSame, percentiles,
  pyFixed, pyPercent, pyRound, pySigned, rfft, sosFiltFilt, welch,
} from "../../app/core/numeric.js";
import { normal } from "./simulate.js";

const close = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ""} ${actual} != ${expected}`);

function naiveDft(re, im) {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      outRe[k] += re[t] * Math.cos(angle) - im[t] * Math.sin(angle);
      outIm[k] += re[t] * Math.sin(angle) + im[t] * Math.cos(angle);
    }
  }
  return [outRe, outIm];
}

test("fft matches the DFT for power-of-two and other lengths", () => {
  const gauss = normal(1);
  for (const n of [1, 2, 8, 64, 3, 5, 12, 100, 250]) {
    const re = Float64Array.from({ length: n }, () => gauss());
    const im = Float64Array.from({ length: n }, () => gauss());
    const [fr, fi] = fft(re, im);
    const [dr, di] = naiveDft(re, im);
    for (let k = 0; k < n; k++) {
      close(fr[k], dr[k], 1e-9 * n, `n=${n} re[${k}]`);
      close(fi[k], di[k], 1e-9 * n, `n=${n} im[${k}]`);
    }
  }
});

test("irfft undoes rfft, for even and odd lengths", () => {
  const gauss = normal(2);
  for (const n of [16, 2000, 999, 7]) {
    const x = Float64Array.from({ length: n }, () => gauss());
    const [re, im] = rfft(x);
    assert.equal(re.length, Math.floor(n / 2) + 1);
    const back = irfft(re, im, n);
    for (let i = 0; i < n; i++) close(back[i], x[i], 1e-9);
  }
});

test("Python rounding and formatting", () => {
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, -1.5, 2.4, 2.6].map(pyRound), [0, 2, 2, -0, -2, 2, 3]);
  assert.equal(pyFixed(0.125, 2), "0.12"); // exact tie: to even, where toFixed gives 0.13
  assert.equal(pyFixed(0.375, 2), "0.38");
  assert.equal(pyFixed(2.5, 0), "2");
  assert.equal(pyFixed(3.5, 0), "4");
  assert.equal(pyFixed(1.005, 2), "1.00"); // 1.005 is really 1.00499..., not a tie
  assert.equal(pyFixed(-2.5, 0), "-2");
  assert.equal(pySigned(15.2, 0), "+15");
  assert.equal(pySigned(-3.4, 0), "-3");
  assert.equal(pyPercent(0.125), "12%");
  assert.equal(pyPercent(0.0049, 1), "0.5%");
});

test("median and percentiles like numpy", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const values = Array.from({ length: 11 }, (_, i) => i * 10);
  assert.deepEqual(percentiles(values, [0, 50, 95, 100]), [0, 50, 95, 100]);
  assert.deepEqual(percentiles([1, 2], [25]), [1.25]);
});

test("forward windows and centred average", () => {
  const x = [5, 1, 4, 2, 8, 3, 7, 0, 6, 9];
  // Values from scipy.ndimage / numpy on the same input.
  assert.deepEqual(Array.from(forwardMin(x, 3)), [1, 1, 2, 2, 3, 0, 0, 0]);
  assert.deepEqual(Array.from(forwardMin(x, 4)), [1, 1, 2, 2, 0, 0, 0]);
  assert.deepEqual(Array.from(forwardMean(x, 4)), [3, 3.75, 4.25, 5, 4.5, 4, 5.5]);
  const same = movingAverageSame(x, 4);
  assert.deepEqual(Array.from(same).map((v) => +v.toFixed(4)), [1.5, 2.5, 3, 3.75, 4.25, 5, 4.5, 4, 5.5, 3.75]);
});

test("Butterworth high-pass sections match scipy", () => {
  // scipy.signal.butter(4, 100, "highpass", fs=1000, output="sos")
  const expected = [
    [0.43284664499029174, -0.8656932899805835, 0.43284664499029174, 1, -1.0485995763626117, 0.2961403575616696],
    [1, -2, 1, 1, -1.320913430819426, 0.6327387928852761],
  ];
  butterHighpass(4, 100, 1000).forEach((section, s) =>
    section.forEach((value, k) => close(value, expected[s][k], 1e-12)));
});

test("zero-phase high-pass removes slow motion and keeps fast noise", () => {
  const fs = 1000;
  const slow = Float64Array.from({ length: 5000 }, (_, k) => 100 * Math.sin((2 * Math.PI * 3 * k) / fs));
  const fast = Float64Array.from({ length: 5000 }, (_, k) => 5 * Math.sin((2 * Math.PI * 250 * k) / fs));
  const out = sosFiltFilt(butterHighpass(4, 100, fs), slow.map((v, k) => v + fast[k]));
  for (let k = 500; k < 4500; k++) close(out[k], fast[k], 0.1);
});

test("welch: white noise has a flat density of sigma^2 / (fs / 2)", () => {
  const gauss = normal(3);
  const fs = 1000;
  const x = Float64Array.from({ length: 200000 }, () => gauss(2));
  const [freqs, psd] = welch(x, fs, 500);
  assert.equal(freqs.length, 251);
  assert.equal(freqs[250], 500);
  close(median(psd.subarray(1, 250)), 4 / 500, 0.0008);
});
