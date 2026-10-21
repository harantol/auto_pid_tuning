import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main } from "../../bin/auto-pid-tuning.js";
import { LogError, firmwareVersion, flightSizes, loadLog, longestFlight } from "../../app/core/blackbox.js";
import { decodeFlight } from "../../app/core/decoder.js";
import { analyseFile } from "../../app/core/index.js";
import { HEADERS_4_3, concat, encodeFlight, simulatedLog } from "./writer.js";

const bytesOf = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const MARKER = "H Product:Blackbox flight data recorder by Nicholas Sherlock\n";

// A short flight with values that exercise every encoding written: small and large deltas,
// negative motors offsets, a P-frame value that does not fit 16 bits on gyro.
function knownFlight(n = 300) {
  const times = Array.from({ length: n }, (_, k) => 1_000_000 + k * 500);
  const series = (f) => Int32Array.from({ length: n }, (_, k) => Math.round(f(k)));
  const signals = {
    "axisP[0]": series((k) => 30 * Math.sin(k / 7)),
    "axisP[1]": series((k) => (k % 50) - 25),
    "axisP[2]": series(() => 0),
    "axisD[0]": series((k) => ((k * 7919) % 41) - 20),
    "axisD[1]": series((k) => (k % 3) - 1),
    "setpoint[0]": series((k) => 400 * Math.sin(k / 30)),
    "setpoint[1]": series((k) => (k > 150 ? -700 : 2)),
    "setpoint[2]": series((k) => k % 9),
    "setpoint[3]": series((k) => 300 + k),
    "gyroADC[0]": series((k) => 390 * Math.sin((k - 3) / 30)),
    "gyroADC[1]": series((k) => (k === 100 ? 90000 : k > 150 ? -690 : 0)),
    "gyroADC[2]": series((k) => -k),
    "motor[0]": series((k) => 1000 + 300 * Math.sin(k / 11)),
    "motor[1]": series((k) => 158 + (k % 5)),
    "motor[2]": series(() => 2047),
    "motor[3]": series((k) => 1200 - k),
  };
  return { times, signals, bytes: encodeFlight({ times, signals, headers: HEADERS_4_3, motorCount: 4 }) };
}

test("the decoder reads back every value written", () => {
  const { times, signals, bytes } = knownFlight();
  const decoded = decodeFlight(bytes, 0, bytes.length, ["loopIteration", "time", ...Object.keys(signals)]);
  assert.equal(decoded.frames, times.length);
  assert.equal(decoded.corrupt, 0);
  assert.deepEqual(Array.from(decoded.columns.time), times);
  assert.deepEqual(Array.from(decoded.columns.loopIteration), times.map((_, k) => k));
  for (const [name, values] of Object.entries(signals)) {
    assert.deepEqual(Array.from(decoded.columns[name]), Array.from(values), name);
  }
});

test("events, slow frames and a log without end marker", () => {
  const { times, signals } = knownFlight();
  const flight = encodeFlight({ times, signals, headers: HEADERS_4_3, motorCount: 4, leadingEvent: true, endMarker: false });
  const decoded = decodeFlight(flight, 0, flight.length, ["time", "gyroADC[0]"]);
  assert.equal(decoded.frames, times.length);
  assert.deepEqual(Array.from(decoded.columns["gyroADC[0]"]), Array.from(signals["gyroADC[0]"]));
});

test("a corrupt stretch loses frames until the next I frame, not the rest of the flight", () => {
  const { times, bytes } = knownFlight();
  const damaged = Uint8Array.from(bytes);
  const middle = Math.floor(damaged.length / 2);
  damaged.fill(0xff, middle, middle + 40);
  const decoded = decodeFlight(damaged, 0, damaged.length, ["time"]);
  assert.ok(decoded.corrupt > 0);
  assert.ok(decoded.frames > times.length - 70 && decoded.frames < times.length);
  const kept = Array.from(decoded.columns.time);
  assert.ok(kept.every((t) => times.includes(t)), "only real frames are kept");
  assert.equal(kept.at(-1), times.at(-1));
});

test("a truncated log keeps what was written", () => {
  const { times, bytes } = knownFlight();
  const cut = bytes.subarray(0, bytes.length - 500);
  const decoded = decodeFlight(cut, 0, cut.length, ["time"]);
  assert.ok(decoded.frames > times.length / 2 && decoded.frames < times.length);
});

test("loading a simulated flight", () => {
  const log = loadLog(simulatedLog({ duration: 30, unfiltered: true }));
  assert.deepEqual(firmwareVersion(log.headers), [4, 3]);
  assert.ok(Math.abs(log.sampleRate - 1000) < 1e-6);
  assert.ok(Math.abs(log.duration - 30) < 0.01);
  assert.equal(log.setpoint.length, 3);
  assert.equal(log.motors.length, 4);
  for (const motor of log.motors) assert.ok(motor.every((v) => v >= 0 && v <= 1));
  assert.ok(log.throttle.every((v) => v > 0.25 && v < 0.55));
  assert.notEqual(log.gyroUnfiltered, null);
  assert.deepEqual(log.headers.rollPID, [45, 80, 40]);
  assert.equal(log.headers["Firmware revision"], "Betaflight 4.3.0 (fc8318f54) STM32F405");
  assert.equal(log.headers.dshot_bidir, 1);
});

test("gyro scaled debug is the unfiltered gyro from 4.3 on", () => {
  const debug = (extra) => {
    const { times, signals } = knownFlight();
    for (let i = 0; i < 3; i++) signals[`debug[${i}]`] = signals[`gyroADC[${i}]`];
    // debug fields are written as plain fields after the motors
    const fields = Object.keys(signals);
    const bytes = encodeFlight({ times, signals, headers: { ...HEADERS_4_3, ...extra }, motorCount: 4, extraFields: fields.filter((f) => f.startsWith("debug")) });
    return loadLog(bytes);
  };
  assert.notEqual(debug({ debug_mode: 6 }).gyroUnfiltered, null);
  assert.equal(debug({ debug_mode: 6, "Firmware revision": "Betaflight 4.2.0 (1) X" }).gyroUnfiltered, null);
  assert.equal(debug({ debug_mode: 3 }).gyroUnfiltered, null);
});

test("firmware version", () => {
  assert.deepEqual(firmwareVersion({ "Firmware revision": "Betaflight 4.3.0 (fc8318f54) STM32F405" }), [4, 3]);
  assert.deepEqual(firmwareVersion({ "Firmware revision": "INAV 6.0" }), [0, 0]);
  assert.deepEqual(firmwareVersion({}), [0, 0]);
});

test("flight sizes survive a truncated flight", () => {
  // A flash dump: a bench-test log cut in the middle of its header, then a real flight.
  const dump = bytesOf(`${MARKER}H Data ver${MARKER}H Data version:2\n${"x".repeat(500)}`);
  assert.deepEqual(flightSizes(dump), [MARKER.length + 10, MARKER.length + 17 + 500]);
  assert.equal(longestFlight(dump), 2);
  assert.throws(() => loadLog(dump, 1, "btfl_all.bbl"), (e) => e instanceof LogError && /Flight 1 of btfl_all.bbl/.test(e.message));
  assert.throws(() => loadLog(dump, 3, "btfl_all.bbl"), /no flight 3/);
});

test("flight sizes skip erased flash and reject other files", () => {
  const dump = concat(new Uint8Array(4096).fill(0xff), bytesOf(`${MARKER}H Data version:2\n`));
  assert.deepEqual(flightSizes(dump), [MARKER.length + 17]);
  assert.throws(() => flightSizes(bytesOf("not a blackbox log\n"), "notes.txt"), /notes.txt is not a blackbox log/);
});

test("the longest of several flights is analysed by default", () => {
  const short = simulatedLog({ duration: 3 });
  const file = concat(short, simulatedLog({ duration: 25 }), short);
  const report = analyseFile(file, "dump.bbl");
  assert.equal(report.log_count, 3);
  assert.equal(report.log_index, 2);
  assert.ok(Math.abs(report.duration - 25) < 0.01);
  assert.deepEqual(Object.keys(report.tunes), ["freestyle", "racing", "cinematic", "long_range"]);
  assert.equal(analyseFile(file, "dump.bbl", 1).log_index, 1);
  assert.throws(() => analyseFile(file, "dump.bbl", 4), /flight 4 does not exist/);
});

test("logs that cannot be tuned say why", () => {
  assert.throws(() => loadLog(simulatedLog({ duration: 0.05 })), /too few frames/);
  const noSetpoint = new TextDecoder("latin1").decode(simulatedLog({ duration: 1 })).replaceAll("setpoint[", "rcCommand[");
  assert.throws(() => loadLog(bytesOf(noSetpoint)), /missing the 'setpoint' fields/);
  assert.throws(() => loadLog(bytesOf(`${MARKER}H Data version:2\n`)), /header is truncated/);
});

function run(args) {
  let out = "";
  let err = "";
  const code = main(args, { write: (s) => { out += s; } }, { write: (s) => { err += s; } });
  return { code, out, err };
}

test("command line: text, JSON, output file and errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-pid-"));
  const path = join(dir, "flight.bbl");
  writeFileSync(path, concat(simulatedLog({ duration: 3 }), simulatedLog({ duration: 25, damping: 0.3 })));

  const text = run([path, "--style", "cinematic", "-o", join(dir, "tune.txt")]);
  assert.equal(text.code, 0);
  assert.ok(text.out.startsWith("Flight 2 of 2 in flight.bbl"));
  assert.ok(text.out.includes("Style    : cinematic"));
  assert.ok(text.out.trimEnd().endsWith("save"));
  assert.ok(readFileSync(join(dir, "tune.txt"), "utf8").trimEnd().endsWith("save"));

  const json = run([path, "--json", "--log-index", "1"]);
  assert.equal(json.code, 0);
  const payload = JSON.parse(json.out);
  assert.equal(payload.style, "freestyle");
  assert.deepEqual(Object.keys(payload.axes), ["roll", "pitch", "yaw"]);

  assert.equal(run([path, "--log-index", "9"]).code, 1);
  const missing = run([join(dir, "nope.bbl")]);
  assert.equal(missing.code, 1);
  assert.ok(missing.err.includes("not found"));
  assert.ok(run([path, "--style", "ballet"]).err.includes("Unknown flight style"));
});
